use crate::command_error::{CommandError, ErrorCode};
use crate::events::EventSink;
use crate::group::FileRef;
use crate::nostr::{ready_gate, relay_connector, NostrFilter, TRINO_KIND};
use crate::state::{AppState, HistItem, InnerState};
use crate::totp_enrollment::TotpBeginResponse;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};
use trino_engine::groups;
pub(crate) use trino_engine::groups::{accept_invite, GroupInfo, GroupInviteInfo};
// What the commands stand on is the engine's (M4-0c), under the names the
// commands and their child modules have always used: opening the account,
// the session's core, sending and the session's storage.
pub(crate) use trino_engine::account::{self, *};
pub(crate) use trino_engine::send::{self, *};
pub(crate) use trino_engine::session::{self, *};
pub(crate) use trino_engine::storage::{self, persist_account, StickerInfo};
use trino_net::IsoKind;
use zeroize::Zeroizing;

const MAX_ICE_CONFIG_BYTES: usize = 16 * 1024;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CallIceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
pub struct CallConfigResponse {
    pub ice_servers: Vec<CallIceServer>,
}

// -- W8 -- Contacts (K7, K8), groups (K9, K10), "delete for me" (K11) and
// the shared profile (K12). Child modules, so they reach the helpers of this
// file (sessions, sending, persistence) without making them public.
#[path = "contacts_cmds.rs"]
pub(crate) mod contacts_cmds;
#[path = "groups_cmds.rs"]
pub(crate) mod groups_cmds;
#[path = "history_cmds.rs"]
pub(crate) mod history_cmds;
#[path = "profile.rs"]
pub(crate) mod profile;
// Cifrado local (CL-1b): where the session keeps its data.
#[path = "storage_cmds.rs"]
pub(crate) mod storage_cmds;
// Cifrado local (CL-2a): the account's preferences in the store.
#[path = "prefs_cmds.rs"]
pub(crate) mod prefs_cmds;
// Cifrado local (CL-6a): locking with the system, and renewing the window.
#[path = "lock_cmds.rs"]
pub(crate) mod lock_cmds;
// Tor (TOR-7): bridges, kept in the store and handed to Tor.
#[path = "bridges_cmds.rs"]
pub(crate) mod bridges_cmds;
// Tor (TOR-6): links open in the browser only here, after asking.
#[path = "links_cmds.rs"]
pub(crate) mod links_cmds;
// Cifrado local (CL-6b): copying without the clipboard history.
#[path = "clipboard_cmds.rs"]
pub(crate) mod clipboard_cmds;

#[derive(Serialize)]
pub struct NodeInfo {
    pub handle: String,
    pub fingerprint: String,
    pub has_session: bool,
    pub added_at: i64,
    /// The photo of the profile the contact shares (K12), or else the one
    /// in its contact code.
    pub avatar: Option<String>,
    pub blocked: bool,
    /// SHA-256 of the identity keys in full (K7); `None` if they do not decode.
    pub identity_digest: Option<String>,
    /// The fingerprint before the user replaced this contact's keys, and
    /// when, until the user acknowledges it (K8).
    pub previous_fingerprint: Option<String>,
    pub key_changed_at: Option<i64>,
    /// The name and "about" of the profile the contact shares (K12). That
    /// name never replaces `handle`, the one given here.
    pub profile_name: Option<String>,
    pub about: Option<String>,
    /// The contact's Trino announced that it reads profile messages, so
    /// this identity's profile reaches it (K12).
    pub profile_sync: bool,
}

#[tauri::command]
pub async fn status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    Ok(account::status(&*state.inner.lock().await))
}

/// Starts the relay connections of a session `open_session` just opened.
/// What they receive tells the UI through `events`, and sends the profile
/// again through `resend_profile`.
fn relay_starter(
    events: Arc<dyn EventSink>,
    resend_profile: profile::Resend,
    state: &AppState,
) -> impl FnOnce(RelayStart) {
    let inner = state.inner.clone();
    let net = Arc::clone(&state.net);
    move |start: RelayStart| {
        crate::diag::note_with(
            "session open, starting the relay connections",
            &[("relays", &start.relays.len())],
        );
        // The news' old minSeq goes to tor/seen.json (Tor design §7).
        crate::news_cmds::take_old_min_seq(&net, start.news_min_seq);
        // The store's private bridges go to Tor, which starts if it had not
        // (at unlock, or the account just made) and wakes (Tor design §2.6);
        // the relays wait for it to be ready.
        let waking = Arc::clone(&net);
        let bridges = start.bridges;
        tauri::async_runtime::spawn_blocking(move || crate::net_cmds::on_unlock(&waking, bridges));
        // One network session per unlock: nothing this one opens shares a
        // Tor circuit with the last one's (Tor design §2.6, §2.7).
        let connector = relay_connector(Arc::clone(&net), net.session(), IsoKind::RELAY);
        // The relays' task, on Tauri's runtime as before.
        tauri::async_runtime::spawn(session::connect_relays(
            events,
            resend_profile,
            inner,
            connector,
            ready_gate(Arc::clone(&net)),
            Arc::clone(&net),
            start.relays,
            start.nostr_pub,
            start.handle,
        ));
    }
}

/// Start setting up TOTP for a new identity: a fresh secret, in memory only,
/// to add to an authenticator app. Calling it again replaces the secret, and
/// any code that confirmed it. `label` names the account in the app; it is
/// the name the identity will get, so an empty one becomes "anon".
#[tauri::command]
pub async fn totp_begin(
    state: State<'_, AppState>,
    label: Option<String>,
) -> Result<TotpBeginResponse, CommandError> {
    let label = display_handle(label.as_deref().unwrap_or_default());
    Ok(state.inner.lock().await.totp_enrollment.begin(&label))
}

/// Check a code from the authenticator app against the secret from
/// `totp_begin`. A valid one confirms that secret for `forge`.
#[tauri::command]
pub async fn totp_verify(state: State<'_, AppState>, code: String) -> Result<bool, CommandError> {
    let code = Zeroizing::new(code);
    state.inner.lock().await.totp_enrollment.verify(&code)
}

/// Create a new identity and open its session at once: the first-run screens
/// go on to the chats without an unlock in between.
///
/// The vault is sealed with `passphrase`, which must pass the policy, and,
/// with `use_totp`, with the TOTP secret confirmed through `totp_begin` and
/// `totp_verify`. An empty `handle` becomes "anon".
#[tauri::command]
pub async fn forge(
    app: AppHandle,
    state: State<'_, AppState>,
    handle: String,
    passphrase: String,
    use_totp: bool,
) -> Result<ForgeResponse, CommandError> {
    let totp = if use_totp {
        NewVaultTotp::Confirmed
    } else {
        NewVaultTotp::Off
    };
    let events = crate::events::sink(app.clone());
    let starter = relay_starter(events, profile::resend_through(app), &state);
    account::forge_identity(&state, starter, handle, passphrase, totp).await
}

/// "Conectar sin protección (solo esta vez)" (Tor design §2.8, §10.4;
/// decision 10), after its confirmation: everything goes without Tor until
/// Trino closes or "Volver a conectarse de forma privada". Nothing keeps
/// it: the permit lives in memory, and the next start goes through Tor.
/// The relays' sockets already open follow at once (`relay_options`).
/// This is the one place the session's permit is built (design test 2).
#[allow(clippy::disallowed_methods)]
pub(crate) fn connect_without_tor(
    net: &trino_net::Net,
) -> Result<trino_net::NetStatus, CommandError> {
    net.allow_direct(trino_net::DirectPermit::for_session())
        .map_err(|_| CommandError::internal("the session's permit was refused"))?;
    Ok(net.status_now())
}

/// "Conectar sin protección (solo esta vez)", once the person confirmed
/// it in its dialog (whose safe answer is Cancelar).
#[tauri::command]
pub async fn net_connect_without_tor(
    state: State<'_, AppState>,
) -> Result<trino_net::NetStatus, CommandError> {
    connect_without_tor(&state.net)
}

/// Open the vault with `passphrase` and, if it has TOTP, `totp_code` (empty
/// or blank counts as none), then open its session. If that session is open
/// already, this only checks the passphrase and the code again: no prekey
/// rotation, nothing loaded twice and no second set of relay connections.
#[tauri::command]
pub async fn unseal(
    app: AppHandle,
    state: State<'_, AppState>,
    passphrase: String,
    totp_code: Option<String>,
) -> Result<UnsealResponse, CommandError> {
    let events = crate::events::sink(app.clone());
    let starter = relay_starter(events, profile::resend_through(app.clone()), &state);
    // B3 of the emergency path (design §6.1): the download history and the
    // minidumps of the WebView, as every lock clears them.
    let clear_traces = move || {
        #[cfg(desktop)]
        crate::traces::clear(&app);
        #[cfg(not(desktop))]
        let _ = app;
    };
    account::unseal(&state, starter, clear_traces, passphrase, totp_code).await
}

/// Open read-only connections to the relays this device is ACTUALLY using and
/// stream back the metadata each one can see (`session::inspect_relays`).
#[tauri::command]
pub async fn relay_inspect_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    session::inspect_relays(&state, crate::events::sink(app)).await
}

#[tauri::command]
pub async fn relay_inspect_stop(state: State<'_, AppState>) -> Result<(), String> {
    session::stop_inspecting(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn share_bundle(state: State<'_, AppState>) -> Result<String, String> {
    account::share_bundle(&*state.inner.lock().await)
}

/// Add the contact of a code as `handle` (K8). A name another key holds is
/// `name_taken` unless `replace_existing`, which the UI passes only after
/// the user confirmed; the same keys under another name are
/// `already_contact`; a new name the chats would read as the channel or a
/// group, or that holds control, format or bidi characters or shows
/// nothing, is `invalid_name`. Callers from before K8 leave
/// `replace_existing` out.
#[tauri::command]
pub async fn probe_node(
    state: State<'_, AppState>,
    bundle_json: String,
    handle: String,
    replace_existing: Option<bool>,
) -> Result<NodeInfo, CommandError> {
    let code = contacts_cmds::parse_contact_code(&bundle_json)?;
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(contacts_cmds::sealed());
    }
    let now = chrono::Utc::now().timestamp();
    let replace = replace_existing.unwrap_or(false);
    let (handle, added) = contacts_cmds::add_contact(&mut inner, code, &handle, replace, now)?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    if added != contacts_cmds::Added::Refreshed {
        // The old session is gone, and what the old keys shared: the
        // replaced contact's, or what a contact removed before left under
        // this name.
        save_ratchets(&inner);
        save_history(&inner);
        profile::save(&inner);
    }
    let friend = inner
        .friends
        .get(&handle)
        .ok_or_else(|| CommandError::internal("the contact was not stored"))?;
    Ok(contacts_cmds::node_info(&inner, friend))
}

#[tauri::command]
pub async fn list_nodes(state: State<'_, AppState>) -> Result<Vec<NodeInfo>, String> {
    let inner = state.inner.lock().await;
    let mut out: Vec<NodeInfo> = inner
        .friends
        .values()
        .map(|f| contacts_cmds::node_info(&inner, f))
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.added_at));
    Ok(out)
}

#[tauri::command]
pub async fn connect_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    session::connect(&state, handle).await
}

/// Force a fresh handshake with a peer, discarding any existing session. Unlike
/// connect_node this never early-returns on an existing ratchet — it's the
/// deterministic recovery path for auto-heal (both AEAD desync and no-session).
#[tauri::command]
pub async fn resync_session(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    session::resync(&state, handle).await
}

/// A text to a contact (K4). It counts as sent once a relay says OK, and is
/// stored with the time of that receipt, which says which relay took it.
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    handle: String,
    text: String,
) -> Result<SendReceipt, CommandError> {
    Ok(send_text(&state, &handle, text, ACK_WAIT).await?)
}

#[tauri::command]
pub async fn wipe(_app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // WebView2's download history and minidumps, outside the data folder
    // (design §5.7, step 7).
    #[cfg(desktop)]
    crate::traces::clear(&_app);
    account::wipe(&state).await
}

/// Lock the vault: drop all in-memory secrets (identity, keys, ratchets) and
/// disconnect the relays, but KEEP the encrypted files on disk. The UI returns
/// to the unseal screen; unlocking reloads everything. Used by "Bloquear",
/// Ctrl+L and the auto-lock, which say why (`reason`): the window is renewed
/// after the lock (cifrado local CL-6a), and the new one reads the reason
/// from the status.
#[tauri::command]
pub async fn lock_vault(
    app: AppHandle,
    state: State<'_, AppState>,
    reason: Option<lock_cmds::LockReason>,
) -> Result<(), String> {
    let window = lock_cmds::TauriMainWindow(app);
    lock_cmds::lock_and_renew(&state, &window, reason, lock_cmds::LockOrigin::Frontend).await;
    Ok(())
}

#[tauri::command]
pub async fn create_group(state: State<'_, AppState>, name: String) -> Result<GroupInfo, String> {
    groups::create(&mut *state.inner.lock().await, &name)
}

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> Result<Vec<GroupInfo>, String> {
    Ok(groups::list(&*state.inner.lock().await))
}

/// Add a contact to a group I administer (groups_cmds::add_member).
#[tauri::command]
pub async fn add_group_member(
    state: State<'_, AppState>,
    gid: String,
    friend_handle: String,
) -> Result<GroupInfo, CommandError> {
    groups::add_member(&state, &gid, &friend_handle, persist_account).await
}

/// A text to a group (K4). Every member is tried, whatever happens to the
/// others, and the receipt says whom it reached. `only` resends to the
/// members it names after a partial failure: the first send stored the
/// message, so a resend does not store it again.
#[tauri::command]
pub async fn send_group_message(
    state: State<'_, AppState>,
    gid: String,
    text: String,
    only: Option<Vec<String>>,
) -> Result<GroupSendReceipt, CommandError> {
    Ok(send_group_text(&state, &gid, text, only.as_deref(), ACK_WAIT).await?)
}

/// A file to a contact (K4): uploaded, then announced like a text, and sent
/// once a relay says OK. Answers with the file and its receipt together.
#[tauri::command]
pub async fn send_file(
    state: State<'_, AppState>,
    handle: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
) -> Result<SentFile, CommandError> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb, None).await?;
    Ok(announce_file(&state, &handle, file, ACK_WAIT).await?)
}

/// A file to a group (K4), like `send_group_message`: every member is
/// tried, `only` resends to the members it names and does not store it
/// again.
#[tauri::command]
pub async fn send_group_file(
    state: State<'_, AppState>,
    gid: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
    only: Option<Vec<String>>,
) -> Result<SentGroupFile, CommandError> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb, Some(&gid)).await?;
    Ok(announce_group_file(&state, &gid, file, only.as_deref(), ACK_WAIT).await?)
}

/// Download + verify + decrypt a file, returning a `data:` URL for the frontend.
/// The download goes through the app's `Net` (Tor design §3 B2). With
/// `max_bytes`, a file larger than that is refused while it downloads: a
/// sticker fetched by itself (TRN-APP-02).
#[tauri::command]
pub async fn fetch_file(
    state: State<'_, AppState>,
    url: String,
    key: String,
    sha256: String,
    mime: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    send::fetch_file(&state, &url, &key, &sha256, &mime, max_bytes).await
}

/// Forward an already-uploaded file (its FileRef) to another chat or group,
/// without re-encrypting or re-uploading the blob. With no relay up it is
/// `offline`, and nothing is sent or stored.
#[tauri::command]
pub async fn forward_file(
    state: State<'_, AppState>,
    target: String,
    is_group: bool,
    file: FileRef,
) -> Result<(), CommandError> {
    Ok(forward_to(&state, &target, is_group, file).await?)
}

/// Remove a contact and all its local state (contacts_cmds::remove_contact).
#[tauri::command]
pub async fn remove_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let profile_gone = contacts_cmds::remove_contact(&mut inner, &handle);
    persist_account(&inner)?;
    save_history(&inner);
    save_ratchets(&inner);
    // -- W8 (K12) --
    if profile_gone {
        profile::save(&inner);
    }
    Ok(())
}

/// Rename a contact's local handle, with all its local state
/// (contacts_cmds::rename_contact).
#[tauri::command]
pub async fn rename_node(
    state: State<'_, AppState>,
    old_handle: String,
    new_handle: String,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    let Some(profile_moved) = contacts_cmds::rename_contact(&mut inner, &old_handle, &new_handle)?
    else {
        return Ok(());
    };
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    save_history(&inner);
    save_ratchets(&inner);
    // -- W8 (K12) --
    if profile_moved {
        profile::save(&inner);
    }
    Ok(())
}

/// Block or unblock a contact (by their nostr pubkey). Blocked senders' events
/// are dropped on arrival.
#[tauri::command]
pub async fn block_node(
    state: State<'_, AppState>,
    handle: String,
    blocked: bool,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let pubkey = inner
        .friends
        .get(&handle)
        .map(|f| f.bundle.nostr_pub.clone());
    if let Some(pk) = pubkey {
        if blocked {
            let entry = trino_engine::block::BlockedIdentity::before_ur2(pk, None, 0);
            inner.blocked.insert(entry);
        } else {
            inner.blocked.remove(&pk);
        }
        persist_account(&inner)?;
    }
    Ok(())
}

/// Delete self-destructed (expired) messages from history on disk. The TTL is
/// encoded in the frontend `trm1:` body envelope; we decode it and drop items
/// whose ts + ttl has passed.
#[tauri::command]
pub async fn prune_expired(state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    let mut inner = state.inner.lock().await;
    if prune_history(&mut inner.history, now) {
        save_history(&inner);
    }
    Ok(())
}

/// Drop from `history` what has expired at `now`; whether anything went.
/// A call (K13) goes with its chat's disappearing messages: its `ttl` is the
/// chat's timer when the call was recorded.
fn prune_history(history: &mut HashMap<String, Vec<HistItem>>, now: i64) -> bool {
    use base64::Engine as _;
    let mut changed = false;
    for items in history.values_mut() {
        let before = items.len();
        items.retain(|it| {
            if crate::call_log::expired(it, now) {
                return false;
            }
            let ttl = it.text.as_deref().and_then(|t| {
                let enc = t.strip_prefix("trm1:")?;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(enc)
                    .ok()?;
                let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                v.get("d").and_then(|d| d.as_i64())
            });
            match ttl {
                // `ts` and `ttl` are the contact's to choose: a timer that
                // would end past the last second there is never ends.
                Some(ttl) if ttl > 0 => it.ts.saturating_add(ttl) > now,
                _ => true,
            }
        });
        if items.len() != before {
            changed = true;
        }
    }
    changed
}

// ---- Sticker library ----

/// Keep a sticker: in the store, sealed under a name that does not give the
/// image away (H4), or as before for an account not moved yet. Needs the
/// open session.
#[tauri::command]
pub async fn import_sticker(
    state: State<'_, AppState>,
    data_b64: String,
    mime: String,
) -> Result<StickerInfo, String> {
    storage::import_sticker(&state, data_b64, mime).await
}

/// The stickers of the open session.
#[tauri::command]
pub async fn list_stickers(state: State<'_, AppState>) -> Result<Vec<StickerInfo>, String> {
    storage_cmds::list_stickers_in(&state.inner.lock().await.storage)
}

/// Remove the sticker `id` of the open session.
#[tauri::command]
pub async fn delete_sticker(state: State<'_, AppState>, id: String) -> Result<(), String> {
    storage_cmds::delete_sticker_in(&state.inner.lock().await.storage, &id)
}

/// The single source of the default STUN servers for direct calls. Calls are
/// protected (TURN relay only, see turn.rs) by default; STUN is used only in
/// direct mode, after the user explicitly agrees to reveal their IP. The
/// frontend has no copy: it gets them from `get_call_config`. Deployments can
/// replace them with `TRINO_ICE_SERVERS_JSON`; `[]` there means no STUN at all.
fn default_call_ice_servers() -> Vec<CallIceServer> {
    vec![
        CallIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        },
        CallIceServer {
            urls: vec!["stun:stun1.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        },
    ]
}

fn validate_ice_servers(servers: &[CallIceServer]) -> Result<(), String> {
    // An empty list is valid: calls then use only the candidates the peers
    // can find without a STUN server.
    if servers.len() > 8 {
        return Err("ICE configuration must contain at most 8 servers".to_string());
    }
    for server in servers {
        if server.urls.is_empty() || server.urls.len() > 8 {
            return Err("each ICE server must contain between 1 and 8 URLs".to_string());
        }
        let mut has_turn = false;
        for url in &server.urls {
            if url.len() > 512
                || !url.is_ascii()
                || !matches!(
                    url.split_once(':').map(|(scheme, _)| scheme),
                    Some("stun" | "stuns" | "turn" | "turns")
                )
            {
                return Err("ICE server URL is invalid".to_string());
            }
            has_turn |= url.starts_with("turn:") || url.starts_with("turns:");
        }
        if has_turn
            && (server.username.as_deref().unwrap_or_default().is_empty()
                || server.credential.as_deref().unwrap_or_default().is_empty())
        {
            return Err("TURN servers require a username and credential".to_string());
        }
        if server
            .username
            .as_ref()
            .is_some_and(|value| value.len() > 512)
            || server
                .credential
                .as_ref()
                .is_some_and(|value| value.len() > 512)
        {
            return Err("ICE credentials are too long".to_string());
        }
    }
    Ok(())
}

/// The ICE servers for calls: the `TRINO_ICE_SERVERS_JSON` override when it
/// is set, otherwise the backend defaults.
fn ice_servers_from_override(raw: Option<String>) -> Result<Vec<CallIceServer>, String> {
    let Some(raw) = raw else {
        return Ok(default_call_ice_servers());
    };
    if raw.len() > MAX_ICE_CONFIG_BYTES {
        return Err("ICE configuration is too large".to_string());
    }
    let parsed: Vec<CallIceServer> =
        serde_json::from_str(&raw).map_err(|_| "ICE configuration is invalid")?;
    validate_ice_servers(&parsed)?;
    Ok(parsed)
}

/// ICE servers for the direct (unprotected) path only. The frontend asks for
/// them only after `get_turn_servers` failed and the user explicitly agreed to
/// call directly, knowing the contact will see their IP; a protected call
/// never contacts these STUN servers. Deployment-specific STUN/TURN servers
/// can still come from `TRINO_ICE_SERVERS_JSON`, without shared production
/// credentials in the frontend bundle; TURN credentials there should be
/// short-lived. See docs/llamadas-turn.md.
#[tauri::command]
pub fn get_call_config() -> Result<CallConfigResponse, String> {
    let ice_servers = ice_servers_from_override(std::env::var("TRINO_ICE_SERVERS_JSON").ok())?;
    Ok(CallConfigResponse { ice_servers })
}

/// Send a WebRTC signaling payload (offer/answer/ICE/bye) to a peer, E2E-encrypted.
#[tauri::command]
pub async fn send_call_signal(
    state: State<'_, AppState>,
    handle: String,
    payload: String,
) -> Result<(), String> {
    send::call_signal(&state, &handle, payload).await
}

/// The frontend reports whether a call holds the microphone or camera, so
/// closing the window or quitting from the tray can hang it up first. A lock
/// of Windows during the call waited for its end (CL-6a): it happens now.
#[tauri::command]
pub fn set_call_active(app: AppHandle, state: State<'_, AppState>, active: bool) {
    if lock_cmds::call_flag_changed(&state.call_active, &state.lock_after_call, active) {
        lock_cmds::lock_from_backend(
            app,
            lock_cmds::LockReason::System {
                cause: lock_cmds::SystemCause::Session,
            },
        );
    }
}

/// What the frontend sends here is text, and the diagnostic log never holds
/// text (T3): it is dropped. The command stays so the frontend's calls still
/// succeed; in a debug build, its console (DevTools, or chrome://inspect on
/// Android) shows the same lines.
#[tauri::command]
pub fn dev_log(msg: String) {
    drop(msg);
}

// ---- the send path (K4) -----------------------------------------------------

/// Invitations waiting for the user, oldest first. The UI asks on start-up
/// because invites can arrive (catch-up window) before it listens for
/// `group-invite`.
#[tauri::command]
pub async fn list_group_invites(
    state: State<'_, AppState>,
) -> Result<Vec<GroupInviteInfo>, String> {
    Ok(groups::list_invites(&*state.inner.lock().await))
}

/// Join the group of a pending invite and add its members as contacts.
#[tauri::command]
pub async fn accept_group_invite(
    state: State<'_, AppState>,
    gid: String,
) -> Result<GroupInfo, String> {
    let mut inner = state.inner.lock().await;
    accept_invite(&mut inner, &gid, chrono::Utc::now().timestamp())
}

/// Drop a pending invite. Nothing is sent to the inviter.
#[tauri::command]
pub async fn decline_group_invite(state: State<'_, AppState>, gid: String) -> Result<(), String> {
    groups::decline_invite(&mut *state.inner.lock().await, &gid)
}

// ---- encrypted chat history -------------------------------------------------

/// Re-send the buffered outgoing messages to a peer on the current (freshly
/// re-established) session. The peer drops duplicates by message id, so this
/// recovers messages lost to a session desync without creating doubles.
#[tauri::command]
pub async fn resend_outbox(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    resend_buffered(&state, &handle).await;
    Ok(())
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
) -> Result<HashMap<String, Vec<HistItem>>, String> {
    let inner = state.inner.lock().await;
    Ok(inner.history.clone())
}

#[derive(Serialize)]
pub struct ProfileResponse {
    pub handle: String,
    pub avatar: Option<String>,
    pub fingerprint: String,
    pub nostr_pub: String,
    /// SHA-256 of this identity's keys in full (K7); `fingerprint` is its prefix.
    pub identity_digest: String,
    /// The "about" this identity shares (K12).
    pub about: String,
    /// The version of the profile messages this backend sends (K12).
    pub sync: u64,
}

/// What `get_profile` answers for the open session.
fn profile_of(inner: &InnerState) -> Result<ProfileResponse, String> {
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    let (ik_sign, ik_dh, nostr) = (
        &identity.ik_sign.pub_bytes,
        &identity.ik_dh.pub_bytes,
        &identity.nostr.pub_bytes,
    );
    Ok(ProfileResponse {
        handle: inner.handle.clone().unwrap_or_default(),
        avatar: inner.avatar.clone(),
        fingerprint: fp(ik_sign, ik_dh, nostr),
        nostr_pub: hex::encode(nostr),
        identity_digest: contacts_cmds::identity_digest(ik_sign, ik_dh, nostr),
        about: inner.profiles.about.clone(),
        sync: profile::PROFILE_V,
    })
}

#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>) -> Result<ProfileResponse, String> {
    profile_of(&*state.inner.lock().await)
}

/// Save this identity's name, photo and, when given, "about" (K12). A blank
/// name keeps the current one, no photo removes it, and no `about` keeps the
/// current one, as callers from before K12 expect. A name or an "about" a
/// profile cannot carry (over 64 or 140 scalars, with a control, format or
/// bidi character, a name with nothing that shows) or such a new photo is
/// `profile_invalid`; the name and the photo already saved may stay as
/// they are.
///
/// When something changed, the profile's revision grows, and the profile
/// goes in the background to every contact that announced it reads
/// profiles: a failed send never fails this.
#[tauri::command]
pub async fn update_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    handle: String,
    avatar: Option<String>,
    about: Option<String>,
) -> Result<(), CommandError> {
    let about = about.as_deref().map(profile::check_about).transpose()?;
    let targets = {
        let mut inner = state.inner.lock().await;
        if inner.identity.is_none() {
            return Err(contacts_cmds::sealed());
        }
        profile::check_editable(&inner.profiles)?;
        let name = profile::check_name(&handle, inner.handle.as_deref())?;
        let avatar = profile::check_photo(avatar, inner.avatar.as_deref())?;
        let now = chrono::Utc::now().timestamp();
        let changed = profile::apply_update(&mut inner, name, avatar, about, now);
        if changed {
            // Saved before anything goes out: a revision sent but never
            // saved would come back older after a restart, and contacts
            // holding the newer one would look up to date.
            profile::try_save(&inner).map_err(|e| CommandError::io(&e))?;
        }

        // The name and the photo are saved with the rest of the account,
        // which keeps the Nostr key, the relays and the date.
        persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        if changed {
            profile::targets(&mut inner)
        } else {
            Vec::new()
        }
    };
    profile::send_in_background(&app, targets);
    Ok(())
}

#[allow(dead_code)]
fn build_filter_for_self(nostr_pub: &str) -> NostrFilter {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    m.insert("#p".to_string(), vec![nostr_pub.to_string()]);
    NostrFilter {
        kinds: Some(vec![TRINO_KIND]),
        p_tag: Some(vec![nostr_pub.to_string()]),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{create_identity, decode_array_32, public_bundle_for, Identity};
    use crate::nostr::NostrClient;
    use crate::ratchet::init_initiator;
    use crate::state::FriendRecord;
    use crate::x3dh::initiate;
    use base64::Engine;

    const NOW: i64 = 1_760_000_000;

    fn friend(id: &Identity, handle: &str) -> FriendRecord {
        FriendRecord {
            handle: handle.to_string(),
            bundle: public_bundle_for(id),
            added_at: 0,
            avatar: None,
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
        }
    }

    fn stun(url: &str) -> CallIceServer {
        CallIceServer {
            urls: vec![url.to_string()],
            username: None,
            credential: None,
        }
    }

    fn urls(servers: &[CallIceServer]) -> Vec<&str> {
        servers
            .iter()
            .flat_map(|s| s.urls.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn ice_config_accepts_an_empty_list_meaning_no_stun() {
        assert_eq!(validate_ice_servers(&[]), Ok(()));
        let servers = ice_servers_from_override(Some("[]".to_string()))
            .expect("an empty override must mean: no STUN, no TURN");
        assert!(servers.is_empty());
    }

    #[test]
    fn ice_config_without_override_is_the_backend_default() {
        // The frontend has no copy of these: this function is the only source.
        let servers = ice_servers_from_override(None).unwrap();
        assert_eq!(
            urls(&servers),
            [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        );
        assert_eq!(validate_ice_servers(&servers), Ok(()));
        assert_eq!(urls(&servers), urls(&default_call_ice_servers()));
    }

    #[test]
    fn ice_config_override_is_still_validated() {
        let nine: Vec<CallIceServer> = (0..9).map(|_| stun("stun:stun.example.net")).collect();
        assert!(validate_ice_servers(&nine).is_err());
        for bad in [
            r#"[{"urls":["http://stun.example.net"]}]"#,
            r#"[{"urls":[]}]"#,
            r#"[{"urls":["turn:turn.example.net"]}]"#,
            "not json",
        ] {
            assert!(
                ice_servers_from_override(Some(bad.to_string())).is_err(),
                "{bad}"
            );
        }
        let one = ice_servers_from_override(Some(
            r#"[{"urls":["stun:stun.example.net:3478"]}]"#.to_string(),
        ))
        .unwrap();
        assert_eq!(urls(&one), ["stun:stun.example.net:3478"]);
    }

    // ---- K4: a message counts as sent once a relay says OK ----

    use crate::nostr::test_relay::{Answer, TestRelay};

    /// How long these tests wait for an OK that will not come.
    const SHORT_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

    /// `contact` as `handle`, with a session open, as `connect_node` leaves it.
    fn add_session(inner: &mut InnerState, me: &Identity, contact: &Identity, handle: &str) {
        inner
            .friends
            .insert(handle.to_string(), friend(contact, handle));
        let bundle = public_bundle_for(contact);
        let init = initiate(me, &bundle).unwrap();
        let spk = decode_array_32(&bundle.spk_pub).unwrap();
        inner.ratchets.insert(
            handle.to_string(),
            init_initiator(init.master_secret, spk).unwrap(),
        );
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data);
    }

    /// The unlocked session of `me`, sending through `relays`. It has no
    /// storage, so nothing is ever written to the real data directory.
    async fn sending_state(me: &Identity, relays: Vec<Arc<NostrClient>>) -> AppState {
        let state = AppState::default();
        {
            let mut inner = state.inner.lock().await;
            inner.identity = Some(me.clone());
            inner.handle = Some("me".to_string());
            inner.relays = relays;
        }
        state
    }

    // ---- B2: a message too large for the relays goes to nobody ----

    // ---- B2: a lock while a message waits for its relays ----

    // ---- B2: what is shown as sent at once needs a relay up ----

    // ---- B1: what is kept under a contact's name stays with that contact ----

    /// The contact code of `id`, named `handle`, as `probe_node` reads it.
    fn pub_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    fn contact_code(id: &Identity, handle: &str) -> contacts_cmds::ContactCode {
        let mut bundle = serde_json::to_value(public_bundle_for(id)).unwrap();
        bundle["handle"] = serde_json::Value::String(handle.to_string());
        contacts_cmds::parse_contact_code(&bundle.to_string()).unwrap()
    }

    #[tokio::test]
    async fn a_contact_added_under_a_removed_contacts_name_gets_none_of_her_messages() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, ana, newcomer) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &ana, "ana");
        send_text(&state, "ana", "solo para Ana".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        {
            let mut inner = state.inner.lock().await;
            assert_eq!(
                inner.outbox.get("ana").map(Vec::len),
                Some(1),
                "kept to replay"
            );
            inner.resync_at.insert("ana".to_string(), NOW);

            contacts_cmds::remove_contact(&mut inner, "ana");
            let (_, added) = contacts_cmds::add_contact(
                &mut inner,
                contact_code(&newcomer, "ana"),
                "ana",
                false,
                NOW,
            )
            .unwrap();

            assert_eq!(added, contacts_cmds::Added::New);
            assert_eq!(
                inner.outbox.get("ana").map(Vec::len),
                None,
                "Ana's messages"
            );
            assert_eq!(inner.resync_at.get("ana"), None);
            // The newcomer's handshake opens a session, and the UI asks for
            // what was kept to be sent again (session-established).
            add_session(&mut inner, &me, &newcomer, "ana");
        }
        let before = relay.events().len();

        assert_eq!(
            resend_buffered(&state, "ana").await,
            0,
            "sent to the newcomer"
        );
        assert_eq!(relay.events().len(), before);
    }

    #[tokio::test]
    async fn the_messages_kept_for_a_contact_follow_it_when_it_is_renamed() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, ana, newcomer) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &ana, "ana");
        send_text(&state, "ana", "para Ana".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        {
            let mut inner = state.inner.lock().await;
            inner.resync_at.insert("ana".to_string(), NOW);

            contacts_cmds::rename_contact(&mut inner, "ana", "Ana trabajo").unwrap();

            assert_eq!(inner.outbox.get("Ana trabajo").map(Vec::len), Some(1));
            assert_eq!(inner.resync_at.get("Ana trabajo"), Some(&NOW));
            assert_eq!(inner.outbox.get("ana").map(Vec::len), None);
            assert_eq!(inner.resync_at.get("ana"), None);
            // Someone else under the name she had.
            contacts_cmds::add_contact(
                &mut inner,
                contact_code(&newcomer, "ana"),
                "ana",
                false,
                NOW,
            )
            .unwrap();
            add_session(&mut inner, &me, &newcomer, "ana");
        }

        assert_eq!(
            resend_buffered(&state, "ana").await,
            0,
            "sent to the newcomer"
        );
        assert_eq!(resend_buffered(&state, "Ana trabajo").await, 1);
        crate::nostr::test_relay::wait_until("the replay", || relay.events().len() == 2).await;
        assert_eq!(
            relay.events()[1].recipient(),
            Some(pub_hex(&ana).as_str()),
            "the replay goes to Ana"
        );
    }

    // ---- B1: a member is added only when the roster can reach the members ----

    // ---- I0: what goes out says that this Trino reads profiles (K12) ----

    // ---- K13: calls go with the chat's disappearing messages ----

    #[test]
    fn pruning_drops_the_calls_whose_timer_ran_out_and_keeps_the_rest() {
        use crate::call_log::{CallDirection, CallEvent, CallOutcome};
        let item = |ts: i64| HistItem {
            side: "them".to_string(),
            from: None,
            text: None,
            file: None,
            call: None,
            ts,
        };
        let call = |id: &str, ttl: Option<i64>| HistItem {
            call: Some(CallEvent {
                id: id.to_string(),
                direction: CallDirection::Incoming,
                video: false,
                outcome: CallOutcome::Missed,
                duration_sec: 0,
                ttl,
            }),
            ..item(NOW - 100)
        };
        // A disappearing text, as the frontend writes it.
        let timed_text = HistItem {
            text: Some(format!(
                "trm1:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"d":60,"t":"hola"}"#)
            )),
            ..item(NOW - 100)
        };
        let plain_text = HistItem {
            text: Some("hola".to_string()),
            ..item(NOW - 100)
        };
        let mut history = HashMap::from([(
            "ana".to_string(),
            vec![
                call("expired-call-00001", Some(60)),
                call("running-call-00001", Some(3_600)),
                call("no-timer-call-0001", None),
                timed_text,
                plain_text,
            ],
        )]);

        assert!(prune_history(&mut history, NOW));

        let calls: Vec<&str> = history["ana"]
            .iter()
            .filter_map(|it| it.call.as_ref().map(|c| c.id.as_str()))
            .collect();
        assert_eq!(calls, ["running-call-00001", "no-timer-call-0001"]);
        assert_eq!(
            history["ana"].len(),
            3,
            "the timed text went too, as before"
        );
        assert!(!prune_history(&mut history, NOW), "nothing left to drop");
    }

    #[test]
    fn a_timer_a_contact_chose_never_overflows_the_pruning() {
        // `ts` is the event's created_at and `d` comes from the contact's
        // `trm1:` text: both are theirs to choose.
        let timed = |ts: i64, d: i64| HistItem {
            side: "them".to_string(),
            from: None,
            text: Some(format!(
                "trm1:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .encode(format!(r#"{{"d":{d},"t":"hola"}}"#))
            )),
            file: None,
            call: None,
            ts,
        };
        let mut history = HashMap::from([(
            "ana".to_string(),
            vec![
                timed(NOW, i64::MAX),
                timed(i64::MAX, 1),
                timed(i64::MAX - 10, 60),
            ],
        )]);

        // Each would end past the last second there is: none has ended.
        assert!(!prune_history(&mut history, NOW));
        assert_eq!(history["ana"].len(), 3);
    }

    // ---- Tor design §2.8, §10.4 and test 15: "Conectar sin protección" ----

    /// A relay served on both ways out of `net`, Tor's and the direct one,
    /// counting each way's connections.
    fn relay_on_both_ways(tor: &trino_net::mock::Mock, direct: &trino_net::mock::Mock) {
        for mock in [tor, direct] {
            let mut listener = mock.listen("relay.trino.invalid", 80);
            tokio::spawn(async move {
                while let Some(io) = listener.accept().await {
                    tokio::spawn(async move {
                        if let Ok(mut ws) = tokio_tungstenite::accept_async(io).await {
                            use futures_util::StreamExt;
                            while let Some(Ok(_)) = ws.next().await {}
                        }
                    });
                }
            });
        }
    }

    /// Design test 15 in the app: "Conectar sin protección" goes without
    /// Tor for this process only, moving the session's relay sockets
    /// already open, and "Volver a conectarse de forma privada" moves them
    /// back. Nothing in it is kept.
    #[tokio::test]
    async fn without_tor_moves_the_open_relays_and_back_to_tor_moves_them_again() {
        use crate::nostr::test_relay::wait_until;
        let (tor, direct) = (trino_net::mock::Mock::new(), trino_net::mock::Mock::new());
        relay_on_both_ways(&tor, &direct);
        let net = trino_net::Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn trino_net::Transport>),
            Arc::clone(&direct) as Arc<dyn trino_net::Transport>,
        );
        let connector = relay_connector(Arc::clone(&net), net.session(), IsoKind::RELAY);
        let options = relay_options(
            "ws://relay.trino.invalid",
            &connector,
            &ready_gate(Arc::clone(&net)),
            &net,
            None,
        );
        let client = NostrClient::start("ws://relay.trino.invalid", Arc::new(|_| {}), options);
        wait_until("the relay through Tor", || client.is_connected()).await;
        assert_eq!(
            (tor.connections().len(), direct.connections().len()),
            (1, 0)
        );

        let status = connect_without_tor(&net).unwrap();
        assert_eq!(status, trino_net::NetStatus::Direct);
        wait_until("the relay without Tor", || direct.connections().len() == 1).await;
        wait_until("it to be up", || client.is_connected()).await;

        let status = crate::net_cmds::back_to_tor(&net);
        assert!(status.is_ready(), "{status:?}");
        assert_eq!(net.mode(), trino_net::Mode::Tor);
        wait_until("the relay through Tor again", || {
            tor.connections().len() == 2
        })
        .await;
        wait_until("it to be up again", || client.is_connected()).await;
        assert_eq!(direct.connections().len(), 1, "it went without Tor again");
        client.close();
    }
    /// Only "Conectar sin protección" builds the session's permit, and only
    /// here (design test 2): the command's own function.
    #[test]
    fn the_escape_is_the_sessions_permit_and_never_the_updaters() {
        let net = trino_net::Net::new();
        assert_eq!(
            connect_without_tor(&net).unwrap(),
            trino_net::NetStatus::Direct
        );
        assert_eq!(net.mode(), trino_net::Mode::Direct);
        // Asked again, it stays as it is.
        assert_eq!(
            connect_without_tor(&net).unwrap(),
            trino_net::NetStatus::Direct
        );
    }

    // ---- M4-0c: the engine's logic lives in the engine ----

    /// The functions of the four clusters M4-0c moved into trino-engine
    /// (the session and its receive loop, sending, groups and handshakes,
    /// opening the account) are defined there and nowhere in the app: a
    /// copy here would be a second engine, which the phones would not get.
    /// The app's commands call them, under the same names.
    #[test]
    fn the_engines_logic_is_not_defined_in_the_app() {
        const MOVED: [&str; 24] = [
            "handle_incoming_event",
            "connect_relays",
            "start_relay_connections",
            "seal_for",
            "publish_sealed",
            "ensure_session",
            "save_ratchets",
            "record_history",
            "send_text",
            "send_group_text",
            "fan_out",
            "announce_file",
            "forward_to",
            "admit_event",
            "judge_handshake",
            "respond_to_handshake",
            "ingest_incoming_roster",
            "merge_group_members",
            "apply_and_send",
            "open_session",
            "create_account",
            "unlock_files",
            "forge_identity",
            "load_session",
        ];
        fn sources(dir: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, found);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    found.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), &mut files);
        assert!(files.len() > 20, "the sources were not found");
        for file in files {
            let source = std::fs::read_to_string(&file).unwrap();
            let code: String = source.split_whitespace().collect();
            for name in MOVED {
                assert!(
                    !code.contains(&format!("fn{name}(")),
                    "{} defines {name}, the engine's",
                    file.display()
                );
            }
        }
        // And the engine does define each of them.
        let engine = root.join("../crates/trino-engine/src");
        let mut engine_files = Vec::new();
        sources(&engine, &mut engine_files);
        let engine: String = engine_files
            .iter()
            .map(|file| std::fs::read_to_string(file).unwrap())
            .collect::<String>()
            .split_whitespace()
            .collect();
        for name in MOVED
            .into_iter()
            .filter(|name| *name != "start_relay_connections")
        {
            assert!(
                engine.contains(&format!("fn{name}(")),
                "the engine lost {name}"
            );
        }
    }
}
