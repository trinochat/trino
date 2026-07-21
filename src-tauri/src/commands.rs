use crate::blossom;
use crate::call_signal::validate_call_signal;
use crate::envelope::{decode_envelope, encode_envelope, Envelope};
use crate::group::{self, FileRef, GroupRoster, MemberBundle};
use crate::identity::{
    create_identity, decode_array_32, public_bundle_for, verify_bundle_binding, PublicBundle,
};
use crate::nostr::{build_and_sign_event, NostrClient, NostrEvent, NostrFilter, TRINO_KIND};
use crate::ratchet::{
    init_initiator, init_responder, ratchet_decrypt, ratchet_encrypt, EncryptedMessage,
    MessageHeader, RatchetError,
};
use crate::state::{
    config_path, default_relays, friends_path, groups_path, history_path, ratchets_path,
    trino_home, vault_path, AppState, ConfigFile, FriendRecord, FriendsFile, HistItem, InnerState,
};
use crate::totp::{generate_totp_secret, otpauth_uri};
use crate::vault::{decode_vault, encode_vault, seal_vault, unseal_vault};
use crate::x3dh::{initiate, respond, InitialMessage};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroize;

const MAX_INLINE_RASTER_BYTES: usize = 128 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_STICKER_BYTES: usize = 5 * 1024 * 1024;
const MAX_ICE_CONFIG_BYTES: usize = 16 * 1024;
/// How fresh an undecryptable event must be to be allowed to tear down a
/// session (see the auto-heal path). Wide enough to absorb clock skew between
/// peers, far tighter than the 24h catch-up window an attacker would replay
/// from. NOTE: if outgoing timestamps ever get jittered (NIP-17), this must be
/// >= that jitter or legitimate desyncs will stop healing.
const AUTO_HEAL_MAX_AGE_SECS: i64 = 600;

#[derive(Serialize)]
pub struct StatusResponse {
    pub has_vault: bool,
    pub is_unsealed: bool,
    pub handle: Option<String>,
    pub nostr_pub: Option<String>,
    pub home_dir: String,
}

#[derive(Serialize)]
pub struct ForgeResponse {
    pub handle: String,
    pub otpauth_uri: String,
    pub bundle_json: String,
    pub fingerprint: String,
}

#[derive(Serialize)]
pub struct UnsealResponse {
    pub handle: String,
    pub fingerprint: String,
    pub nostr_pub: String,
    pub relay_connection_started: bool,
}

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

#[derive(Serialize)]
pub struct NodeInfo {
    pub handle: String,
    pub fingerprint: String,
    pub has_session: bool,
    pub added_at: i64,
    pub avatar: Option<String>,
    pub blocked: bool,
}

#[derive(Serialize, Clone)]
pub struct IncomingMessageEvent {
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct HandshakeNeededEvent {
    pub from_pubkey: String,
}

#[derive(Serialize, Clone)]
pub struct IncomingGroupMessageEvent {
    pub gid: String,
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct GroupUpdatedEvent {
    pub gid: String,
}

#[derive(Serialize, Clone)]
pub struct FileMessageEvent {
    pub from_handle: String,
    pub gid: Option<String>,
    pub file: FileRef,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct CallSignalEvent {
    pub from_handle: String,
    pub payload: String,
}

#[derive(Serialize)]
pub struct GroupInfo {
    pub gid: String,
    pub name: String,
    pub epoch: u64,
    pub is_admin: bool,
    pub member_count: usize,
    pub members: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct WirePayload {
    header: WireHeader,
    nonce: String,
    ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    handshake: Option<WireHandshake>,
}

#[derive(Serialize, Deserialize, Clone)]
struct WireHeader {
    #[serde(rename = "dhPub")]
    dh_pub: String,
    pn: u32,
    n: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct WireHandshake {
    #[serde(rename = "ikDhPub")]
    ik_dh_pub: String,
    #[serde(rename = "ekPub")]
    ek_pub: String,
    #[serde(rename = "spkId")]
    spk_id: u32,
    #[serde(rename = "opkId")]
    opk_id: Option<u32>,
}

/// Human-verifiable fingerprint bound to ALL three public keys (ik_sign, ik_dh,
/// nostr), so comparing it out-of-band actually detects a swapped DH/Nostr key.
fn fp(ik_sign: &[u8; 32], ik_dh: &[u8; 32], nostr: &[u8; 32]) -> String {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(ik_sign);
    input.extend_from_slice(ik_dh);
    input.extend_from_slice(nostr);
    let h = crate::crypto::sha256(&input);
    let hex = hex::encode(&h[..8]);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(".")
}

/// Append a diagnostic line to ~/.trino/trino-gui.log so silent failures in the
/// receive path leave a trace we can inspect after a live test.
fn dbg_log(msg: &str) {
    use std::io::Write;
    let line = format!(
        "[{}] {}\n",
        chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
        msg
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(trino_home().join("trino-gui.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

fn checked_inline_raster(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some((meta, payload)) = value.split_once(',') else {
        return Err("inline image must be a base64 data URL".to_string());
    };
    if !matches!(
        meta,
        "data:image/jpeg;base64"
            | "data:image/png;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
    ) {
        return Err("only inline jpeg/png/gif/webp images are allowed".to_string());
    }
    if payload.is_empty()
        || payload.len() > MAX_INLINE_RASTER_BYTES.div_ceil(3) * 4 + 4
        || payload.trim() != payload
    {
        return Err("inline image is empty or too large".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "inline image has invalid base64".to_string())?;
    if decoded.len() > MAX_INLINE_RASTER_BYTES {
        return Err("inline image is too large".to_string());
    }
    Ok(Some(value))
}

fn sanitized_inline_raster(value: Option<String>) -> Option<String> {
    checked_inline_raster(value).ok().flatten()
}

fn sanitize_file_ref(mut file: FileRef) -> FileRef {
    file.thumb = sanitized_inline_raster(file.thumb);
    file
}

fn sanitize_roster(mut roster: GroupRoster) -> GroupRoster {
    roster.photo = roster.photo.map(sanitize_file_ref);
    roster
}

fn zeroize_file_ref(file: &mut FileRef) {
    file.key.zeroize();
    if let Some(thumb) = file.thumb.as_mut() {
        thumb.zeroize();
    }
}

fn clear_sensitive_state(inner: &mut InnerState) {
    if let Some(secret) = inner.totp_secret.as_mut() {
        secret.zeroize();
    }
    inner.totp_secret = None;
    if let Some(key) = inner.history_key.as_mut() {
        key.zeroize();
    }
    inner.history_key = None;

    for ratchet in inner.ratchets.values_mut() {
        ratchet.zeroize_secrets();
    }
    inner.ratchets.clear();
    for ad in inner.associated_data.values_mut() {
        ad.zeroize();
    }
    inner.associated_data.clear();

    for items in inner.history.values_mut() {
        for item in items {
            if let Some(text) = item.text.as_mut() {
                text.zeroize();
            }
            if let Some(file) = item.file.as_mut() {
                zeroize_file_ref(file);
            }
        }
    }
    inner.history.clear();

    for items in inner.outbox.values_mut() {
        for (id, envelope, _) in items {
            id.zeroize();
            envelope.zeroize();
        }
    }
    inner.outbox.clear();

    if let Some(avatar) = inner.avatar.as_mut() {
        avatar.zeroize();
    }
    for friend in inner.friends.values_mut() {
        if let Some(avatar) = friend.avatar.as_mut() {
            avatar.zeroize();
        }
    }
    for roster in inner.groups.values_mut() {
        if let Some(photo) = roster.photo.as_mut() {
            zeroize_file_ref(photo);
        }
    }

    inner.identity = None;
    inner.handle = None;
    inner.avatar = None;
    inner.friends.clear();
    inner.groups.clear();
    inner.blocked.clear();
    inner.current_peer = None;
    inner.resync_at.clear();
    inner.clear_seen_ids();
}

fn remove_file_for_wipe(path: &std::path::Path, failures: &mut Vec<String>) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("{}: {}", path.display(), error));
        }
    }
}

fn remove_dir_for_wipe(path: &std::path::Path, failures: &mut Vec<String>) {
    if let Err(error) = std::fs::remove_dir_all(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("{}: {}", path.display(), error));
        }
    }
}

#[tauri::command]
pub async fn status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let inner = state.inner.lock().await;
    let has_vault = vault_path().exists();
    Ok(StatusResponse {
        has_vault,
        is_unsealed: inner.identity.is_some(),
        handle: inner.handle.clone(),
        nostr_pub: inner
            .identity
            .as_ref()
            .map(|i| hex::encode(i.nostr.pub_bytes)),
        home_dir: trino_home().to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn forge(handle: String, passphrase: String) -> Result<ForgeResponse, String> {
    if vault_path().exists() {
        return Err("vault already exists; wipe first".to_string());
    }
    if passphrase.is_empty() {
        return Err("passphrase required".to_string());
    }
    let trimmed = handle.trim();
    let handle = if trimmed.is_empty() { "anon" } else { trimmed }.to_string();

    let identity = create_identity();
    let totp_secret = generate_totp_secret();
    let sealed = seal_vault(&identity, &totp_secret, &passphrase).map_err(|e| e.to_string())?;

    std::fs::create_dir_all(trino_home()).map_err(|e| e.to_string())?;
    harden_home();
    std::fs::write(vault_path(), encode_vault(&sealed)).map_err(|e| e.to_string())?;
    let config = ConfigFile {
        handle: handle.clone(),
        nostr_pub: hex::encode(identity.nostr.pub_bytes),
        relays: default_relays(),
        created_at: chrono::Utc::now().timestamp(),
        avatar: None,
    };
    std::fs::write(
        config_path(),
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let friends = FriendsFile {
        handle: handle.clone(),
        friends: vec![],
        blocked: vec![],
    };
    std::fs::write(
        friends_path(),
        serde_json::to_string_pretty(&friends).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let bundle = public_bundle_for(&identity);
    let mut bundle_obj = serde_json::to_value(&bundle).map_err(|e| e.to_string())?;
    if let Some(obj) = bundle_obj.as_object_mut() {
        obj.insert(
            "handle".to_string(),
            serde_json::Value::String(handle.clone()),
        );
    }
    let bundle_json = serde_json::to_string(&bundle_obj).map_err(|e| e.to_string())?;

    Ok(ForgeResponse {
        handle: handle.clone(),
        otpauth_uri: otpauth_uri(&totp_secret, &handle, "trino"),
        bundle_json,
        fingerprint: fp(
            &identity.ik_sign.pub_bytes,
            &identity.ik_dh.pub_bytes,
            &identity.nostr.pub_bytes,
        ),
    })
}

fn start_relay_connections(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
    relays: Vec<String>,
    expected_nostr_pub: String,
    expected_handle: String,
) {
    let mut seen = std::collections::HashSet::new();
    for relay_url in relays {
        if !seen.insert(relay_url.clone()) {
            continue;
        }
        let app_for_task = app.clone();
        let state_for_task = state_inner.clone();
        let expected_pub_for_task = expected_nostr_pub.clone();
        let expected_handle_for_task = expected_handle.clone();
        tauri::async_runtime::spawn(async move {
            let app_for_events = app_for_task.clone();
            let state_for_events = state_for_task.clone();
            let on_event: Arc<dyn Fn(NostrEvent) + Send + Sync> =
                Arc::new(move |event: NostrEvent| {
                    let app = app_for_events.clone();
                    let inner = state_for_events.clone();
                    tokio::spawn(async move {
                        handle_incoming_event(app, inner, event).await;
                    });
                });

            match NostrClient::connect(&relay_url, on_event).await {
                Ok(client) => {
                    let _ = client
                        .subscribe(&NostrFilter {
                            kinds: Some(vec![TRINO_KIND]),
                            p_tag: Some(vec![expected_pub_for_task.clone()]),
                            // Catch up on messages sent while this device was
                            // offline. Duplicate event ids and ratchet state are
                            // checked before anything reaches the UI.
                            since: Some(chrono::Utc::now().timestamp() - 86_400),
                            ..Default::default()
                        })
                        .await;

                    let mut inner = state_for_task.lock().await;
                    let same_identity = inner.identity.as_ref().is_some_and(|identity| {
                        hex::encode(identity.nostr.pub_bytes) == expected_pub_for_task
                    }) && inner.handle.as_deref()
                        == Some(expected_handle_for_task.as_str());
                    if same_identity {
                        inner.relays.push(client);
                        dbg_log(&format!("  relay OK: {}", relay_url));
                    } else {
                        client.close();
                    }
                }
                Err(error) => {
                    dbg_log(&format!("  relay FAIL: {} -> {}", relay_url, error));
                }
            }
        });
    }
}

#[tauri::command]
pub async fn unseal(
    app: AppHandle,
    state: State<'_, AppState>,
    passphrase: String,
    totp_code: String,
) -> Result<UnsealResponse, String> {
    let (identity, totp_secret) = tokio::task::spawn_blocking(move || {
        let mut passphrase = passphrase;
        let mut totp_code = totp_code;
        let result = (|| {
            let bytes = std::fs::read(vault_path()).map_err(|_| "no vault".to_string())?;
            let blob = decode_vault(&bytes).map_err(|e| e.to_string())?;
            unseal_vault(&blob, &passphrase, totp_code.trim()).map_err(|e| e.to_string())
        })();
        passphrase.zeroize();
        totp_code.zeroize();
        result
    })
    .await
    .map_err(|_| "vault unlock worker failed".to_string())??;
    harden_home(); // tighten perms on existing installs too

    let cfg_bytes = std::fs::read(config_path()).map_err(|e| e.to_string())?;
    let mut cfg: ConfigFile = serde_json::from_slice(&cfg_bytes).map_err(|e| e.to_string())?;
    cfg.avatar = sanitized_inline_raster(cfg.avatar);

    let friends_bytes = std::fs::read(friends_path()).unwrap_or_else(|_| {
        serde_json::to_vec(&FriendsFile {
            handle: cfg.handle.clone(),
            friends: vec![],
            blocked: vec![],
        })
        .unwrap()
    });
    let mut friends_file: FriendsFile =
        serde_json::from_slice(&friends_bytes).map_err(|e| e.to_string())?;
    for friend in &mut friends_file.friends {
        friend.avatar = sanitized_inline_raster(friend.avatar.take());
    }

    let fingerprint = fp(
        &identity.ik_sign.pub_bytes,
        &identity.ik_dh.pub_bytes,
        &identity.nostr.pub_bytes,
    );
    let nostr_pub = hex::encode(identity.nostr.pub_bytes);

    let mut inner = state.inner.lock().await;
    inner.identity = Some(identity);
    inner.totp_secret = Some(totp_secret);
    inner.handle = Some(cfg.handle.clone());
    inner.avatar = cfg.avatar.clone();
    inner.friends.clear();
    for f in friends_file.friends {
        inner.friends.insert(f.handle.clone(), f);
    }
    inner.blocked = friends_file.blocked.into_iter().collect();
    inner.groups.clear();
    if let Ok(bytes) = std::fs::read(groups_path()) {
        if let Ok(list) = serde_json::from_slice::<Vec<GroupRoster>>(&bytes) {
            for r in list {
                let r = sanitize_roster(r);
                inner.groups.insert(r.group_id.clone(), r);
            }
        }
    }
    if let Some(id) = inner.identity.as_ref() {
        inner.history_key = Some(derive_history_key(id));
    }
    inner.history.clear();
    load_history(&mut inner);
    load_ratchets(&mut inner);

    let relays = if cfg.relays.is_empty() {
        default_relays()
    } else {
        cfg.relays.clone()
    };

    dbg_log(&format!(
        "UNSEAL handle='{}' nostr_pub={}.. starting {} relay connection(s)",
        cfg.handle,
        &nostr_pub[..16.min(nostr_pub.len())],
        relays.len()
    ));
    drop(inner);
    start_relay_connections(
        app,
        state.inner.clone(),
        relays,
        nostr_pub.clone(),
        cfg.handle.clone(),
    );

    Ok(UnsealResponse {
        handle: cfg.handle,
        fingerprint,
        nostr_pub,
        relay_connection_started: true,
    })
}

#[tauri::command]
pub async fn share_bundle(state: State<'_, AppState>) -> Result<String, String> {
    let inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    let handle = inner.handle.clone().unwrap_or_default();
    let bundle = public_bundle_for(identity);
    let mut v = serde_json::to_value(&bundle).map_err(|e| e.to_string())?;
    if let Some(o) = v.as_object_mut() {
        o.insert("handle".to_string(), serde_json::Value::String(handle));
        if let Some(av) = inner.avatar.clone() {
            o.insert("avatar".to_string(), serde_json::Value::String(av));
        }
    }
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn probe_node(
    state: State<'_, AppState>,
    bundle_json: String,
    handle: String,
) -> Result<NodeInfo, String> {
    let v: serde_json::Value = serde_json::from_str(&bundle_json).map_err(|e| e.to_string())?;
    let avatar = v
        .get("avatar")
        .and_then(|a| a.as_str())
        .map(|s| s.to_string());
    let avatar = sanitized_inline_raster(avatar);
    let bundle: PublicBundle = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if !verify_bundle_binding(&bundle) {
        return Err("bundle signature invalid (identity keys not bound)".to_string());
    }
    let trimmed = handle.trim().to_string();
    if trimmed.is_empty() {
        return Err("handle required".to_string());
    }
    let ik_pub = decode_array_32(&bundle.ik_sign_pub).map_err(|e| e.to_string())?;
    let ik_dh_pub = decode_array_32(&bundle.ik_dh_pub).map_err(|e| e.to_string())?;
    let nostr_pub = decode_array_32(&bundle.nostr_pub).map_err(|e| e.to_string())?;
    let fingerprint = fp(&ik_pub, &ik_dh_pub, &nostr_pub);

    let mut inner = state.inner.lock().await;
    let record = FriendRecord {
        handle: trimmed.clone(),
        bundle: bundle.clone(),
        added_at: chrono::Utc::now().timestamp(),
        avatar: avatar.clone(),
    };
    inner.friends.insert(trimmed.clone(), record.clone());
    persist_friends(&inner)?;

    Ok(NodeInfo {
        handle: trimmed,
        fingerprint,
        has_session: false,
        added_at: record.added_at,
        avatar,
        blocked: false,
    })
}

#[tauri::command]
pub async fn list_nodes(state: State<'_, AppState>) -> Result<Vec<NodeInfo>, String> {
    let inner = state.inner.lock().await;
    let mut out = vec![];
    for f in inner.friends.values() {
        let ik_pub = decode_array_32(&f.bundle.ik_sign_pub).unwrap_or([0u8; 32]);
        let ik_dh = decode_array_32(&f.bundle.ik_dh_pub).unwrap_or([0u8; 32]);
        let nostr = decode_array_32(&f.bundle.nostr_pub).unwrap_or([0u8; 32]);
        out.push(NodeInfo {
            handle: f.handle.clone(),
            fingerprint: fp(&ik_pub, &ik_dh, &nostr),
            has_session: inner.ratchets.contains_key(&f.handle),
            added_at: f.added_at,
            avatar: f.avatar.clone(),
            blocked: inner.blocked.contains(&f.bundle.nostr_pub),
        });
    }
    out.sort_by_key(|item| std::cmp::Reverse(item.added_at));
    Ok(out)
}

#[tauri::command]
pub async fn connect_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    if inner.ratchets.contains_key(&handle) {
        inner.current_peer = Some(handle);
        return Ok(());
    }

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    send_cipher_inner(&state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Force a fresh handshake with a peer, discarding any existing session. Unlike
/// connect_node this never early-returns on an existing ratchet — it's the
/// deterministic recovery path for auto-heal (both AEAD desync and no-session).
#[tauri::command]
pub async fn resync_session(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    inner.ratchets.remove(&handle);
    inner.associated_data.remove(&handle);

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    dbg_log(&format!(
        "RESYNC: forcing fresh handshake with '{}'",
        handle
    ));
    send_cipher_inner(&state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    handle: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let id = new_msg_id();
    let env = encode_envelope(&Envelope::Text {
        body: text.clone(),
        id: id.clone(),
    });
    send_cipher_inner(&state, &handle, &env, None)
        .await
        .map_err(|e| e.to_string())?;
    let mut inner = state.inner.lock().await;
    remember_outgoing(&mut inner, &handle, id, env);
    record_history(
        &mut inner,
        handle.clone(),
        HistItem {
            side: "me".into(),
            from: None,
            text: Some(text),
            file: None,
            ts: chrono::Utc::now().timestamp(),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn wipe(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    for r in inner.relays.drain(..) {
        r.close();
    }
    clear_sensitive_state(&mut inner);
    drop(inner);

    let mut failures = Vec::new();
    for path in [
        vault_path(),
        friends_path(),
        config_path(),
        groups_path(),
        history_path(),
        ratchets_path(),
        trino_home().join("trino-gui.log"),
    ] {
        remove_file_for_wipe(&path, &mut failures);
    }
    remove_dir_for_wipe(&stickers_dir(), &mut failures);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "memory cleared, but some files could not be deleted: {}",
            failures.join("; ")
        ))
    }
}

/// Launch trino on OS login so it's already running (and, once unsealed, can
/// receive in the background) without the user reopening it. Windows-only for
/// now (HKCU Run key); a no-op elsewhere so mobile/Linux builds still compile.
#[tauri::command]
pub fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let result = if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            std::process::Command::new("reg")
                .args([
                    "add",
                    KEY,
                    "/v",
                    "trino",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &exe.to_string_lossy(),
                    "/f",
                ])
                .output()
        } else {
            std::process::Command::new("reg")
                .args(["delete", KEY, "/v", "trino", "/f"])
                .output()
        };
        result.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = enable;
    Ok(())
}

/// Whether trino is registered to launch on login.
#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        std::process::Command::new("reg")
            .args(["query", KEY, "/v", "trino"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Lock the vault: drop all in-memory secrets (identity, keys, ratchets) and
/// disconnect the relays, but KEEP the encrypted files on disk. The UI returns
/// to the unseal screen; unlocking reloads everything. Used by auto-lock.
#[tauri::command]
pub async fn lock_vault(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    // Persist current session/history state before wiping it from memory.
    save_ratchets(&inner);
    save_history(&inner);
    for r in inner.relays.drain(..) {
        r.close();
    }
    clear_sensitive_state(&mut inner);
    dbg_log("vault LOCKED (auto-lock)");
    Ok(())
}

fn self_member_bundle(identity: &crate::identity::Identity, handle: &str) -> MemberBundle {
    let b = public_bundle_for(identity);
    MemberBundle {
        handle: handle.to_string(),
        ik_sign_pub: b.ik_sign_pub,
        ik_dh_pub: b.ik_dh_pub,
        nostr_pub: b.nostr_pub,
        spk_id: b.spk_id,
        spk_pub: b.spk_pub,
        spk_sig: b.spk_sig,
    }
}

fn group_info(roster: &GroupRoster, my_ik: &str) -> GroupInfo {
    GroupInfo {
        gid: roster.group_id.clone(),
        name: roster.name.clone(),
        epoch: roster.epoch,
        is_admin: roster.admin_pub == my_ik,
        member_count: roster.members.len(),
        members: roster.members.iter().map(|m| m.handle.clone()).collect(),
    }
}

/// Establish a pairwise session with `handle` (initiate + send handshake) if none.
async fn ensure_session_inner(state: &State<'_, AppState>, handle: &str) -> Result<(), String> {
    let handshake = {
        let mut inner = state.inner.lock().await;
        if inner.ratchets.contains_key(handle) {
            return Ok(());
        }
        let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
        let friend = inner.friends.get(handle).ok_or("unknown node")?.clone();
        let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
        let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
        let ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
        inner.ratchets.insert(handle.to_string(), ratchet);
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data.clone());
        save_ratchets(&inner);
        WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        }
    };
    send_cipher_inner(state, handle, b"__trino_handshake__", Some(handshake)).await
}

/// Send the signed roster to every member (except us) over their pairwise channel.
async fn distribute_roster(
    state: &State<'_, AppState>,
    roster: &GroupRoster,
    my_ik: &str,
) -> Result<(), String> {
    let targets: Vec<String> = {
        let inner = state.inner.lock().await;
        roster
            .members
            .iter()
            .filter(|m| m.ik_sign_pub != my_ik)
            .filter_map(|m| {
                inner
                    .friends
                    .values()
                    .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                    .map(|f| f.handle.clone())
            })
            .collect()
    };
    let env = encode_envelope(&Envelope::Roster {
        roster: roster.clone(),
    });
    for handle in targets {
        ensure_session_inner(state, &handle).await?;
        send_cipher_inner(state, &handle, &env, None).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_group(state: State<'_, AppState>, name: String) -> Result<GroupInfo, String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let handle = inner.handle.clone().unwrap_or_else(|| "me".to_string());
    let me = self_member_bundle(&identity, &handle);
    let roster = group::create_group(&identity, me, name.trim());
    inner.groups.insert(roster.group_id.clone(), roster.clone());
    persist_groups(&inner)?;
    Ok(group_info(&roster, &my_ik))
}

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> Result<Vec<GroupInfo>, String> {
    let inner = state.inner.lock().await;
    let my_ik = inner
        .identity
        .as_ref()
        .map(|i| hex::encode(i.ik_sign.pub_bytes))
        .unwrap_or_default();
    let mut out: Vec<GroupInfo> = inner
        .groups
        .values()
        .map(|r| group_info(r, &my_ik))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub async fn add_group_member(
    state: State<'_, AppState>,
    gid: String,
    friend_handle: String,
) -> Result<GroupInfo, String> {
    let (roster, my_ik) = {
        let mut inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let friend = inner
            .friends
            .get(&friend_handle)
            .ok_or("unknown friend")?
            .clone();
        let current = inner.groups.get(&gid).ok_or("unknown group")?.clone();
        let member = MemberBundle {
            handle: friend.handle.clone(),
            ik_sign_pub: friend.bundle.ik_sign_pub.clone(),
            ik_dh_pub: friend.bundle.ik_dh_pub.clone(),
            nostr_pub: friend.bundle.nostr_pub.clone(),
            spk_id: friend.bundle.spk_id,
            spk_pub: friend.bundle.spk_pub.clone(),
            spk_sig: friend.bundle.spk_sig.clone(),
        };
        let updated = group::add_member(&current, &identity, member).map_err(|e| e.to_string())?;
        inner.groups.insert(gid.clone(), updated.clone());
        persist_groups(&inner)?;
        (updated, my_ik)
    };
    distribute_roster(&state, &roster, &my_ik).await?;
    Ok(group_info(&roster, &my_ik))
}

#[tauri::command]
pub async fn send_group_message(
    state: State<'_, AppState>,
    gid: String,
    text: String,
) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("empty message".to_string());
    }
    let (targets, env) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(&gid).ok_or("unknown group")?.clone();
        let env = encode_envelope(&Envelope::Group {
            gid: gid.clone(),
            ep: roster.epoch,
            body: text.clone(),
        });
        let targets: Vec<String> = roster
            .members
            .iter()
            .filter(|m| m.ik_sign_pub != my_ik)
            .filter_map(|m| {
                inner
                    .friends
                    .values()
                    .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                    .map(|f| f.handle.clone())
            })
            .collect();
        (targets, env)
    };
    dbg_log(&format!(
        "GROUP SEND gid={} -> {} members",
        &gid[..8.min(gid.len())],
        targets.len()
    ));
    for handle in targets {
        ensure_session_inner(&state, &handle).await?;
        send_cipher_inner(&state, &handle, &env, None).await?;
    }
    let mut inner = state.inner.lock().await;
    record_history(
        &mut inner,
        group_convo(&gid),
        HistItem {
            side: "me".into(),
            from: None,
            text: Some(text),
            file: None,
            ts: chrono::Utc::now().timestamp(),
        },
    );
    Ok(())
}

/// Encrypt file bytes, upload the ciphertext to Blossom, return the E2E reference.
async fn prepare_file(
    state: &State<'_, AppState>,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
) -> Result<FileRef, String> {
    if data_b64.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 4 {
        return Err("attachment is too large (25 MB max)".to_string());
    }
    let mut data = base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|_| "bad base64".to_string())?;
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err("attachment is too large (25 MB max)".to_string());
    }
    let thumb = checked_inline_raster(thumb)?;
    let size = data.len() as u64;
    let enc = blossom::encrypt_file(&data).map_err(|e| e.to_string())?;
    data.zeroize();
    let identity = {
        let inner = state.inner.lock().await;
        inner.identity.as_ref().ok_or("vault sealed")?.clone()
    };
    let url = blossom::upload(&identity, &enc.blob, &enc.sha256_hex)
        .await
        .map_err(|e| e.to_string())?;
    Ok(FileRef {
        url,
        key: enc.key_hex,
        sha256: enc.sha256_hex,
        mime: mime.to_string(),
        name: name.to_string(),
        size,
        thumb,
    })
}

#[tauri::command]
pub async fn send_file(
    state: State<'_, AppState>,
    handle: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
) -> Result<FileRef, String> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb).await?;
    let env = encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: None,
        body: None,
    });
    ensure_session_inner(&state, &handle).await?;
    send_cipher_inner(&state, &handle, &env, None).await?;
    let mut inner = state.inner.lock().await;
    record_history(
        &mut inner,
        handle.clone(),
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file.clone()),
            ts: chrono::Utc::now().timestamp(),
        },
    );
    Ok(file)
}

#[tauri::command]
pub async fn send_group_file(
    state: State<'_, AppState>,
    gid: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
) -> Result<FileRef, String> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb).await?;
    let (targets, env) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(&gid).ok_or("unknown group")?.clone();
        let env = encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: Some(gid.clone()),
            body: None,
        });
        let targets: Vec<String> = roster
            .members
            .iter()
            .filter(|m| m.ik_sign_pub != my_ik)
            .filter_map(|m| {
                inner
                    .friends
                    .values()
                    .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                    .map(|f| f.handle.clone())
            })
            .collect();
        (targets, env)
    };
    for handle in targets {
        ensure_session_inner(&state, &handle).await?;
        send_cipher_inner(&state, &handle, &env, None).await?;
    }
    let mut inner = state.inner.lock().await;
    record_history(
        &mut inner,
        group_convo(&gid),
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file.clone()),
            ts: chrono::Utc::now().timestamp(),
        },
    );
    Ok(file)
}

/// Download + verify + decrypt a file, returning a `data:` URL for the frontend.
#[tauri::command]
pub async fn fetch_file(
    url: String,
    key: String,
    sha256: String,
    mime: String,
) -> Result<String, String> {
    let blob = blossom::download(&url, &sha256)
        .await
        .map_err(|e| e.to_string())?;
    let mut plain = blossom::decrypt_file(&blob, &key).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&plain);
    plain.zeroize();
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Forward an already-uploaded file (its FileRef) to another chat or group,
/// without re-encrypting or re-uploading the blob.
#[tauri::command]
pub async fn forward_file(
    state: State<'_, AppState>,
    target: String,
    is_group: bool,
    file: FileRef,
) -> Result<(), String> {
    let file = sanitize_file_ref(file);
    if is_group {
        let (targets, env) = {
            let inner = state.inner.lock().await;
            let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
            let my_ik = hex::encode(identity.ik_sign.pub_bytes);
            let _roster = inner.groups.get(&target).ok_or("unknown group")?;
            let env = encode_envelope(&Envelope::File {
                file: file.clone(),
                gid: Some(target.clone()),
                body: None,
            });
            let targets: Vec<String> = _roster
                .members
                .iter()
                .filter(|m| m.ik_sign_pub != my_ik)
                .filter_map(|m| {
                    inner
                        .friends
                        .values()
                        .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                        .map(|f| f.handle.clone())
                })
                .collect();
            (targets, env)
        };
        for handle in targets {
            ensure_session_inner(&state, &handle).await?;
            send_cipher_inner(&state, &handle, &env, None).await?;
        }
        let mut inner = state.inner.lock().await;
        record_history(
            &mut inner,
            group_convo(&target),
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file),
                ts: chrono::Utc::now().timestamp(),
            },
        );
    } else {
        let env = encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: None,
            body: None,
        });
        ensure_session_inner(&state, &target).await?;
        send_cipher_inner(&state, &target, &env, None).await?;
        let mut inner = state.inner.lock().await;
        record_history(
            &mut inner,
            target,
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file),
                ts: chrono::Utc::now().timestamp(),
            },
        );
    }
    Ok(())
}

/// Remove a contact and all its local state (session, associated data, history).
#[tauri::command]
pub async fn remove_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    inner.friends.remove(&handle);
    inner.ratchets.remove(&handle);
    inner.associated_data.remove(&handle);
    inner.history.remove(&handle);
    if inner.current_peer.as_deref() == Some(handle.as_str()) {
        inner.current_peer = None;
    }
    persist_friends(&inner)?;
    save_history(&inner);
    save_ratchets(&inner);
    Ok(())
}

/// Rename a contact's local handle, migrating session/history/AD keyed by it.
#[tauri::command]
pub async fn rename_node(
    state: State<'_, AppState>,
    old_handle: String,
    new_handle: String,
) -> Result<(), String> {
    let new = new_handle.trim().to_string();
    if new.is_empty() {
        return Err("nombre vacío".into());
    }
    let mut inner = state.inner.lock().await;
    if old_handle == new {
        return Ok(());
    }
    if inner.friends.contains_key(&new) {
        return Err("ya existe un contacto con ese nombre".into());
    }
    let mut rec = inner
        .friends
        .remove(&old_handle)
        .ok_or("contacto no encontrado")?;
    rec.handle = new.clone();
    inner.friends.insert(new.clone(), rec);
    if let Some(r) = inner.ratchets.remove(&old_handle) {
        inner.ratchets.insert(new.clone(), r);
    }
    if let Some(ad) = inner.associated_data.remove(&old_handle) {
        inner.associated_data.insert(new.clone(), ad);
    }
    if let Some(h) = inner.history.remove(&old_handle) {
        inner.history.insert(new.clone(), h);
    }
    if inner.current_peer.as_deref() == Some(old_handle.as_str()) {
        inner.current_peer = Some(new.clone());
    }
    persist_friends(&inner)?;
    save_history(&inner);
    save_ratchets(&inner);
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
            inner.blocked.insert(pk);
        } else {
            inner.blocked.remove(&pk);
        }
        persist_friends(&inner)?;
    }
    Ok(())
}

/// Delete self-destructed (expired) messages from history on disk. The TTL is
/// encoded in the frontend `trm1:` body envelope; we decode it and drop items
/// whose ts + ttl has passed.
#[tauri::command]
pub async fn prune_expired(state: State<'_, AppState>) -> Result<(), String> {
    use base64::Engine as _;
    let now = chrono::Utc::now().timestamp();
    let mut inner = state.inner.lock().await;
    let mut changed = false;
    for items in inner.history.values_mut() {
        let before = items.len();
        items.retain(|it| {
            let ttl = it.text.as_deref().and_then(|t| {
                let enc = t.strip_prefix("trm1:")?;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(enc)
                    .ok()?;
                let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                v.get("d").and_then(|d| d.as_i64())
            });
            match ttl {
                Some(ttl) if ttl > 0 => it.ts + ttl > now,
                _ => true,
            }
        });
        if items.len() != before {
            changed = true;
        }
    }
    if changed {
        save_history(&inner);
    }
    Ok(())
}

// ---- Sticker library (stored unencrypted in ~/.trino/stickers) ----

/// Restrict the data dir to the owner (0700) on Unix so other local users can't
/// read the vault/history/log. No-op on Windows (uses NTFS ACLs by default).
fn harden_home() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(trino_home(), std::fs::Permissions::from_mode(0o700));
    }
}

fn stickers_dir() -> std::path::PathBuf {
    crate::state::trino_home().join("stickers")
}
fn sticker_ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/gif" => "gif",
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    }
}
fn sticker_mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

#[derive(serde::Serialize)]
pub struct StickerInfo {
    pub id: String,
    pub mime: String,
    pub data_url: String,
}

#[tauri::command]
pub async fn import_sticker(data_b64: String, mime: String) -> Result<StickerInfo, String> {
    use base64::Engine as _;
    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    ) {
        return Err("only jpeg/png/gif/webp stickers are allowed".to_string());
    }
    if data_b64.len() > MAX_STICKER_BYTES.div_ceil(3) * 4 + 4 {
        return Err("sticker is too large (5 MB max)".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STICKER_BYTES {
        return Err("sticker is too large (5 MB max)".to_string());
    }
    let id = hex::encode(&crate::crypto::sha256(&bytes)[..8]);
    let ext = sticker_ext_for_mime(&mime);
    let dir = stickers_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{id}.{ext}")), &bytes).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(StickerInfo {
        id,
        mime: mime.clone(),
        data_url: format!("data:{mime};base64,{b64}"),
    })
}

#[tauri::command]
pub async fn list_stickers() -> Result<Vec<StickerInfo>, String> {
    use base64::Engine as _;
    let dir = stickers_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mime = sticker_mime_for_ext(&ext).to_string();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            out.push(StickerInfo {
                id,
                mime: mime.clone(),
                data_url: format!("data:{mime};base64,{b64}"),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_sticker(id: String) -> Result<(), String> {
    let dir = stickers_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            if path.file_stem().and_then(|s| s.to_str()) == Some(id.as_str()) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

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
    if servers.is_empty() || servers.len() > 8 {
        return Err("ICE configuration must contain between 1 and 8 servers".to_string());
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

/// Load deployment-specific STUN/TURN servers without embedding shared
/// production credentials in the frontend bundle. TURN credentials supplied
/// here should be short-lived.
#[tauri::command]
pub fn get_call_config() -> Result<CallConfigResponse, String> {
    let ice_servers = match std::env::var("TRINO_ICE_SERVERS_JSON") {
        Ok(raw) => {
            if raw.len() > MAX_ICE_CONFIG_BYTES {
                return Err("ICE configuration is too large".to_string());
            }
            let parsed: Vec<CallIceServer> =
                serde_json::from_str(&raw).map_err(|_| "ICE configuration is invalid")?;
            validate_ice_servers(&parsed)?;
            parsed
        }
        Err(_) => default_call_ice_servers(),
    };
    Ok(CallConfigResponse { ice_servers })
}

/// Send a WebRTC signaling payload (offer/answer/ICE/bye) to a peer, E2E-encrypted.
#[tauri::command]
pub async fn send_call_signal(
    state: State<'_, AppState>,
    handle: String,
    payload: String,
) -> Result<(), String> {
    validate_call_signal(&payload).map_err(str::to_string)?;
    ensure_session_inner(&state, &handle).await?;
    let env = encode_envelope(&Envelope::Call { call: payload });
    send_cipher_inner(&state, &handle, &env, None).await
}

/// Frontend → trino-gui.log bridge. The Android WebView doesn't forward
/// console.log to logcat, so this lets us see the JS call flow on device.
#[tauri::command]
pub fn dev_log(msg: String) {
    dbg_log(&format!("FE: {}", msg));
}

async fn send_cipher_inner(
    state: &State<'_, AppState>,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(handle).ok_or("unknown node")?.clone();
    let relays = inner.relays.clone();
    if relays.is_empty() {
        return Err("network is still connecting".to_string());
    }
    let ad = inner.associated_data.get(handle).ok_or("no AD")?.clone();
    let ratchet = inner
        .ratchets
        .get_mut(handle)
        .ok_or("no session — run connect first")?;

    let ct: EncryptedMessage =
        ratchet_encrypt(ratchet, plaintext, &ad).map_err(|e| e.to_string())?;
    save_ratchets(&inner); // sending chain advanced — persist it

    let is_handshake = handshake.is_some();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: ct.header.dh_pub,
            pn: ct.header.pn,
            n: ct.header.n,
        },
        nonce: ct.nonce,
        ciphertext: ct.ciphertext,
        handshake,
    };
    let payload_json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;

    let event = build_and_sign_event(
        &identity.nostr.priv_bytes,
        &identity.nostr.pub_bytes,
        TRINO_KIND,
        &payload_json,
        vec![vec!["p".to_string(), friend.bundle.nostr_pub.clone()]],
        None,
    )
    .map_err(|e| e.to_string())?;

    drop(inner);
    dbg_log(&format!(
        "SEND to '{}' (handshake={}) event_id={} -> {} relay(s)",
        handle,
        is_handshake,
        &event.id[..8.min(event.id.len())],
        relays.len()
    ));
    for r in &relays {
        let _ = r.publish(&event).await;
    }
    Ok(())
}

async fn handle_incoming_event(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<crate::state::InnerState>>,
    event: NostrEvent,
) {
    dbg_log(&format!(
        "RECV event id={} from={} content_len={}",
        &event.id[..8.min(event.id.len())],
        &event.pubkey[..16.min(event.pubkey.len())],
        event.content.len()
    ));
    let mut inner = state_inner.lock().await;
    if !inner.remember_event(event.id.clone()) {
        dbg_log("  skip: duplicate event (already seen from another relay)");
        return;
    }
    // Persist the event id before processing. On restart this prevents a
    // replayed handshake event from replacing a newer live session.
    save_ratchets(&inner);
    if inner.blocked.contains(&event.pubkey) {
        dbg_log("  DROP: sender is blocked");
        return;
    }
    let identity = match &inner.identity {
        Some(i) => i.clone(),
        None => {
            dbg_log("  DROP: vault sealed (no identity in memory)");
            return;
        }
    };

    let friend = inner
        .friends
        .values()
        .find(|f| f.bundle.nostr_pub == event.pubkey)
        .cloned();
    let friend = match friend {
        Some(f) => f,
        None => {
            dbg_log(&format!(
                "  DROP: sender not a known friend (have {} friends) -> emitting handshake-needed",
                inner.friends.len()
            ));
            let _ = app.emit(
                "handshake-needed",
                HandshakeNeededEvent {
                    from_pubkey: event.pubkey.clone(),
                },
            );
            return;
        }
    };
    dbg_log(&format!("  friend matched: '{}'", friend.handle));

    let payload: WirePayload = match serde_json::from_str(&event.content) {
        Ok(p) => p,
        Err(e) => {
            dbg_log(&format!("  DROP: payload JSON parse failed: {}", e));
            return;
        }
    };

    if let Some(hs) = &payload.handshake {
        // PINNING (TOFU): the identity DH key in an incoming handshake must match
        // the one we pinned when we added this contact. The ik_dh_pub is stable
        // (only ek/spk rotate), so a legit re-handshake or auto-heal always
        // matches — a mismatch means someone is trying to silently replace the
        // session with a different identity. Reject it.
        if hs.ik_dh_pub != friend.bundle.ik_dh_pub {
            dbg_log(&format!(
                "  DROP: handshake ik_dh_pub does not match pinned bundle for '{}' (impersonation?)",
                friend.handle
            ));
            return;
        }
        let have_session = inner.ratchets.contains_key(&friend.handle);
        // Glare resolution: if BOTH peers initiated a handshake at the same time we
        // end up with two incompatible sessions. Deterministic tie-break: the
        // session initiated by the LOWER nostr pubkey wins. So if the peer's pubkey
        // sorts below ours, we YIELD — accept their handshake and replace our own.
        let my_pub = hex::encode(identity.nostr.pub_bytes);
        let peer_wins = friend.bundle.nostr_pub.as_str() < my_pub.as_str();
        dbg_log(&format!(
            "  handshake present (spkId={}); has_session={} peer_wins={}",
            hs.spk_id, have_session, peer_wins
        ));
        if !have_session || peer_wins {
            let mut id_for_respond = identity.clone();
            let resp = match respond(
                &mut id_for_respond,
                &InitialMessage {
                    ik_dh_pub: hs.ik_dh_pub.clone(),
                    ek_pub: hs.ek_pub.clone(),
                    spk_id: hs.spk_id,
                    opk_id: hs.opk_id,
                },
            ) {
                Ok(r) => r,
                Err(e) => {
                    dbg_log(&format!("  DROP: X3DH respond() failed: {}", e));
                    return;
                }
            };
            inner.identity = Some(id_for_respond.clone());
            let spk_kp = id_for_respond.signed_prekey.keypair.clone();
            inner.ratchets.insert(
                friend.handle.clone(),
                init_responder(resp.master_secret, spk_kp),
            );
            inner
                .associated_data
                .insert(friend.handle.clone(), resp.associated_data);
            save_ratchets(&inner);
            dbg_log(&format!(
                "  responder ratchet established for '{}'",
                friend.handle
            ));
            // Fresh session: replay any buffered outgoing so messages the peer
            // lost during the desync get re-delivered (deduped by id).
            let _ = app.emit("session-established", friend.handle.clone());
        }
    }

    let ad = match inner.associated_data.get(&friend.handle).cloned() {
        Some(a) => a,
        None => {
            dbg_log("  DROP: no associated_data (no session) — auto-healing");
            trigger_resync(&mut inner, &app, &friend.handle);
            return;
        }
    };
    let has_ratchet = inner.ratchets.contains_key(&friend.handle);
    if !has_ratchet {
        dbg_log("  DROP: no ratchet for friend — auto-healing");
        trigger_resync(&mut inner, &app, &friend.handle);
        return;
    }
    let ratchet = inner.ratchets.get_mut(&friend.handle).unwrap();
    let msg = EncryptedMessage {
        header: MessageHeader {
            dh_pub: payload.header.dh_pub,
            pn: payload.header.pn,
            n: payload.header.n,
        },
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
    };
    let plain = match ratchet_decrypt(ratchet, &msg, &ad) {
        Ok(p) => p,
        Err(RatchetError::Replay { .. }) => {
            dbg_log(&format!(
                "  skip: replayed ciphertext (dhPub={}.. n={} pn={})",
                &msg.header.dh_pub[..8.min(msg.header.dh_pub.len())],
                msg.header.n,
                msg.header.pn
            ));
            return;
        }
        Err(e) => {
            dbg_log(&format!(
                "  DROP: ratchet_decrypt failed (dhPub={}.. n={} pn={}): {}",
                &msg.header.dh_pub[..8.min(msg.header.dh_pub.len())],
                msg.header.n,
                msg.header.pn,
                e
            ));
            // AUTO-HEAL: a decrypt failure means our ratchet diverged from the
            // peer's (a lost message, a crash mid-save, call-signal flooding…).
            // Drop the broken session and ask the UI to re-handshake. The
            // deterministic pubkey tie-break then reconverges both sides on one
            // session. Rate-limited so a burst of undecryptable events (or a
            // hostile sender) can't trigger a re-handshake storm.
            //
            // FRESHNESS GATE (anti-DoS): only a RECENT undecryptable message may
            // tear down a session. Relay traffic is public, so anyone could
            // record an old ciphertext of ours, flood `seen_events` until its id
            // is evicted, and replay it — it is too old to be caught by the
            // replay detector, fails AEAD, and would wipe the session. Repeat
            // forever = permanent loss of service. Genuine desyncs surface on
            // live messages; stale ones from the 24h catch-up window are just
            // dropped.
            let now = chrono::Utc::now().timestamp();
            let age = now - event.created_at;
            if !(-AUTO_HEAL_MAX_AGE_SECS..=AUTO_HEAL_MAX_AGE_SECS).contains(&age) {
                dbg_log(&format!(
                    "  stale undecryptable event ({}s old) — dropped without auto-heal",
                    age
                ));
                return;
            }
            let last = *inner.resync_at.get(&friend.handle).unwrap_or(&0);
            if now - last > 20 {
                inner.resync_at.insert(friend.handle.clone(), now);
                inner.ratchets.remove(&friend.handle);
                inner.associated_data.remove(&friend.handle);
                save_ratchets(&inner);
                dbg_log(&format!(
                    "  AUTO-HEAL: cleared desynced session with '{}', requesting resync",
                    friend.handle
                ));
                let _ = app.emit("resync-needed", friend.handle.clone());
            }
            return;
        }
    };
    save_ratchets(&inner); // receiving chain advanced — persist it
    if plain == b"__trino_handshake__" {
        dbg_log("  OK: handshake message decrypted (no UI emit)");
        return;
    }

    match decode_envelope(&plain) {
        Envelope::Text { body, id } => {
            // Drop duplicates (a resend after auto-heal replays the same id).
            if !id.is_empty() && !inner.remember_message_id(id.clone()) {
                dbg_log(&format!(
                    "  skip: duplicate message id {} from '{}'",
                    id, friend.handle
                ));
                return;
            }
            save_ratchets(&inner);
            dbg_log(&format!(
                "  OK: text from '{}' ({} chars)",
                friend.handle,
                body.len()
            ));
            record_history(
                &mut inner,
                friend.handle.clone(),
                HistItem {
                    side: "them".into(),
                    from: None,
                    text: Some(body.clone()),
                    file: None,
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "message-received",
                IncomingMessageEvent {
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Group { gid, ep: _, body } => {
            let allowed = inner
                .groups
                .get(&gid)
                .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                .unwrap_or(false);
            if !allowed {
                dbg_log(&format!(
                    "  DROP: group msg from non-member '{}' for gid={}",
                    friend.handle,
                    &gid[..8.min(gid.len())]
                ));
                return;
            }
            dbg_log(&format!(
                "  OK: group msg gid={} from '{}'",
                &gid[..8.min(gid.len())],
                friend.handle
            ));
            record_history(
                &mut inner,
                group_convo(&gid),
                HistItem {
                    side: "them".into(),
                    from: Some(friend.handle.clone()),
                    text: Some(body.clone()),
                    file: None,
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "group-message",
                IncomingGroupMessageEvent {
                    gid,
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Roster { roster } => {
            accept_incoming_roster(&app, &mut inner, &identity, roster);
        }
        Envelope::File { file, gid, body: _ } => {
            let file = sanitize_file_ref(file);
            if let Some(g) = &gid {
                let allowed = inner
                    .groups
                    .get(g)
                    .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                    .unwrap_or(false);
                if !allowed {
                    dbg_log("  DROP: group file from non-member");
                    return;
                }
            }
            dbg_log(&format!(
                "  OK: file '{}' from '{}'",
                file.name, friend.handle
            ));
            let convo = match &gid {
                Some(g) => group_convo(g),
                None => friend.handle.clone(),
            };
            let from = gid.as_ref().map(|_| friend.handle.clone());
            record_history(
                &mut inner,
                convo,
                HistItem {
                    side: "them".into(),
                    from,
                    text: None,
                    file: Some(file.clone()),
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "file-message",
                FileMessageEvent {
                    from_handle: friend.handle.clone(),
                    gid,
                    file,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Call { call } => {
            // Call signals (SDP offer/answer, ICE) are only meaningful in real
            // time. The 24h catch-up window replays them on reconnect, so a
            // stale offer would occupy the call state and make live calls read
            // as "busy". Drop stale/future-dated and malformed signals.
            let age = chrono::Utc::now().timestamp() - event.created_at;
            if !(-60..=60).contains(&age) {
                dbg_log(&format!(
                    "  stale call signal from '{}' ({}s old) — ignored",
                    friend.handle, age
                ));
            } else if let Err(reason) = validate_call_signal(&call) {
                dbg_log(&format!(
                    "  invalid call signal from '{}' ({}) — ignored",
                    friend.handle, reason
                ));
            } else {
                dbg_log(&format!("  call signal from '{}'", friend.handle));
                let _ = app.emit(
                    "call-signal",
                    CallSignalEvent {
                        from_handle: friend.handle.clone(),
                        payload: call,
                    },
                );
            }
        }
    }
}

/// Validate & store an incoming signed roster, auto-registering its members as
/// pairwise friends so we can fan-out to them. Rejects forged/rolled-back rosters.
fn accept_incoming_roster(
    app: &AppHandle,
    inner: &mut crate::state::InnerState,
    identity: &crate::identity::Identity,
    roster: GroupRoster,
) {
    if !group::verify_roster(&roster) {
        dbg_log("  DROP: roster signature invalid");
        return;
    }
    let roster = sanitize_roster(roster);
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    if !group::is_member(&roster, &my_ik) {
        dbg_log("  DROP: roster does not include us");
        return;
    }
    let gid = roster.group_id.clone();
    let accept = match inner.groups.get(&gid) {
        Some(cur) => group::accept_roster_update(cur, &roster),
        None => true,
    };
    if !accept {
        dbg_log("  skip: roster not newer / mismatched admin");
        return;
    }
    auto_add_members(inner, &roster, &my_ik);
    inner.groups.insert(gid.clone(), roster);
    let _ = persist_groups(inner);
    dbg_log(&format!(
        "  OK: roster stored gid={}",
        &gid[..8.min(gid.len())]
    ));
    let _ = app.emit("group-updated", GroupUpdatedEvent { gid });
}

fn member_to_public_bundle(m: &MemberBundle) -> PublicBundle {
    PublicBundle {
        ik_sign_pub: m.ik_sign_pub.clone(),
        ik_dh_pub: m.ik_dh_pub.clone(),
        nostr_pub: m.nostr_pub.clone(),
        spk_id: m.spk_id,
        spk_pub: m.spk_pub.clone(),
        spk_sig: m.spk_sig.clone(),
        opk_id: None,
        opk_pub: None,
        // Group members are integrity-protected by the signed roster, not a
        // per-member id_sig; verify_bundle (spk-only) is used for them.
        id_sig: String::new(),
    }
}

/// Ensure every group member (except us) exists as a friend, so the 1:1 fan-out
/// infrastructure can reach them. Keyed by handle; skips identities already known.
fn auto_add_members(inner: &mut crate::state::InnerState, roster: &GroupRoster, my_ik: &str) {
    for m in &roster.members {
        if m.ik_sign_pub == my_ik {
            continue;
        }
        let already = inner
            .friends
            .values()
            .any(|f| f.bundle.ik_sign_pub == m.ik_sign_pub);
        if already {
            continue;
        }
        let mut handle = m.handle.clone();
        if handle.is_empty() || inner.friends.contains_key(&handle) {
            handle = format!(
                "{}-{}",
                m.handle,
                &m.ik_sign_pub[..4.min(m.ik_sign_pub.len())]
            );
        }
        inner.friends.insert(
            handle.clone(),
            FriendRecord {
                handle,
                bundle: member_to_public_bundle(m),
                added_at: chrono::Utc::now().timestamp(),
                avatar: None,
            },
        );
    }
    let _ = persist_friends(inner);
}

fn persist_groups(inner: &crate::state::InnerState) -> Result<(), String> {
    let groups: Vec<&GroupRoster> = inner.groups.values().collect();
    std::fs::write(
        groups_path(),
        serde_json::to_string_pretty(&groups).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

// ---- encrypted chat history -------------------------------------------------

const HISTORY_CAP: usize = 500; // keep last N per conversation (bounds the file)

fn derive_history_key(identity: &crate::identity::Identity) -> [u8; 32] {
    let okm = crate::crypto::hkdf_expand(
        &identity.ik_sign.priv_bytes,
        &[0u8; 32],
        b"trino-history-key-v1",
        32,
    )
    .unwrap_or_else(|_| vec![0u8; 32]);
    let mut k = [0u8; 32];
    k.copy_from_slice(&okm[..32]);
    k
}

fn save_history(inner: &InnerState) {
    let Some(key) = inner.history_key else {
        return;
    };
    let Ok(json) = serde_json::to_vec(&inner.history) else {
        return;
    };
    let Ok((ct, nonce)) = crate::crypto::aes_gcm_encrypt(&key, &json, None) else {
        return;
    };
    let mut blob = Vec::with_capacity(nonce.len() + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    let _ = std::fs::write(history_path(), blob);
}

fn load_history(inner: &mut InnerState) {
    let Some(key) = inner.history_key else {
        return;
    };
    let Ok(blob) = std::fs::read(history_path()) else {
        return;
    };
    if blob.len() < 12 {
        return;
    }
    let (nonce, ct) = blob.split_at(12);
    if let Ok(json) = crate::crypto::aes_gcm_decrypt(&key, ct, nonce, None) {
        if let Ok(mut h) = serde_json::from_slice::<HashMap<String, Vec<HistItem>>>(&json) {
            for items in h.values_mut() {
                for item in items {
                    if let Some(file) = item.file.take() {
                        item.file = Some(sanitize_file_ref(file));
                    }
                }
            }
            inner.history = h;
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct RatchetsFile {
    ratchets: HashMap<String, crate::ratchet::RatchetState>,
    #[serde(default)]
    associated_data: HashMap<String, Vec<u8>>,
    #[serde(default)]
    seen_events: Vec<String>,
    #[serde(default)]
    seen_msg_ids: Vec<String>,
}

/// Persist the Double Ratchet sessions (+ associated data) ENCRYPTED to disk so
/// they survive app restarts. Without this, every restart forces a fresh X3DH
/// handshake and desyncs the peer (messages silently fail to decrypt).
fn save_ratchets(inner: &InnerState) {
    let Some(key) = inner.history_key else {
        return;
    };
    let file = RatchetsFile {
        ratchets: inner.ratchets.clone(),
        associated_data: inner.associated_data.clone(),
        seen_events: inner.seen_event_order.iter().cloned().collect(),
        seen_msg_ids: inner.seen_msg_id_order.iter().cloned().collect(),
    };
    let Ok(json) = serde_json::to_vec(&file) else {
        return;
    };
    let Ok((ct, nonce)) = crate::crypto::aes_gcm_encrypt(&key, &json, None) else {
        return;
    };
    let mut blob = Vec::with_capacity(nonce.len() + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    let _ = std::fs::write(ratchets_path(), blob);
}

fn load_ratchets(inner: &mut InnerState) {
    let Some(key) = inner.history_key else {
        return;
    };
    let Ok(blob) = std::fs::read(ratchets_path()) else {
        return;
    };
    if blob.len() < 12 {
        return;
    }
    let (nonce, ct) = blob.split_at(12);
    if let Ok(json) = crate::crypto::aes_gcm_decrypt(&key, ct, nonce, None) {
        if let Ok(f) = serde_json::from_slice::<RatchetsFile>(&json) {
            inner.ratchets = f.ratchets;
            inner.associated_data = f.associated_data;
            inner.clear_seen_ids();
            for id in f.seen_events {
                inner.remember_event(id);
            }
            for id in f.seen_msg_ids {
                inner.remember_message_id(id);
            }
        }
    }
}

/// Auto-heal a broken/absent session: drop it and ask the UI to re-handshake
/// (rate-limited per peer). Covers both decrypt failures (AEAD) and the
/// "peer thinks we have a session but we don't" case. The tie-break reconverges
/// and buffered messages get replayed, so nothing is lost.
fn trigger_resync(inner: &mut InnerState, app: &AppHandle, handle: &str) {
    let now = chrono::Utc::now().timestamp();
    let last = *inner.resync_at.get(handle).unwrap_or(&0);
    if now - last <= 20 {
        return;
    }
    inner.resync_at.insert(handle.to_string(), now);
    inner.ratchets.remove(handle);
    inner.associated_data.remove(handle);
    save_ratchets(inner);
    dbg_log(&format!("  AUTO-HEAL: requesting resync with '{}'", handle));
    let _ = app.emit("resync-needed", handle.to_string());
}

/// Unique-enough message id for dedup (ts + a process counter, hashed).
fn new_msg_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = chrono::Utc::now().timestamp_millis();
    let h = crate::crypto::sha256(format!("{ts}:{n}").as_bytes());
    hex::encode(&h[..8])
}

/// Buffer a just-sent text envelope so it can be replayed after an auto-heal.
/// Capped to the last 20 messages / 10 minutes per peer.
fn remember_outgoing(inner: &mut InnerState, handle: &str, id: String, env: Vec<u8>) {
    let now = chrono::Utc::now().timestamp();
    let buf = inner.outbox.entry(handle.to_string()).or_default();
    buf.push((id, env, now));
    buf.retain(|(_, _, ts)| now - *ts < 600);
    if buf.len() > 20 {
        let excess = buf.len() - 20;
        buf.drain(0..excess);
    }
}

/// Re-send the buffered outgoing messages to a peer on the current (freshly
/// re-established) session. The peer drops duplicates by message id, so this
/// recovers messages lost to a session desync without creating doubles.
#[tauri::command]
pub async fn resend_outbox(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let items: Vec<Vec<u8>> = {
        let inner = state.inner.lock().await;
        inner
            .outbox
            .get(&handle)
            .map(|v| v.iter().map(|(_, e, _)| e.clone()).collect())
            .unwrap_or_default()
    };
    if items.is_empty() {
        return Ok(());
    }
    dbg_log(&format!(
        "RESEND {} buffered msg(s) to '{}'",
        items.len(),
        handle
    ));
    for env in items {
        let _ = send_cipher_inner(&state, &handle, &env, None).await;
    }
    Ok(())
}

fn record_history(inner: &mut InnerState, convo: String, item: HistItem) {
    let v = inner.history.entry(convo).or_default();
    v.push(item);
    if v.len() > HISTORY_CAP {
        let excess = v.len() - HISTORY_CAP;
        v.drain(0..excess);
    }
    save_history(inner);
}

fn group_convo(gid: &str) -> String {
    format!("grp:{}", gid)
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
}

#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>) -> Result<ProfileResponse, String> {
    let inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    Ok(ProfileResponse {
        handle: inner.handle.clone().unwrap_or_default(),
        avatar: inner.avatar.clone(),
        fingerprint: fp(
            &identity.ik_sign.pub_bytes,
            &identity.ik_dh.pub_bytes,
            &identity.nostr.pub_bytes,
        ),
        nostr_pub: hex::encode(identity.nostr.pub_bytes),
    })
}

#[tauri::command]
pub async fn update_profile(
    state: State<'_, AppState>,
    handle: String,
    avatar: Option<String>,
) -> Result<(), String> {
    let avatar = checked_inline_raster(avatar)?;
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err("vault sealed".to_string());
    }
    let trimmed = handle.trim();
    let new_handle = if trimmed.is_empty() {
        inner.handle.clone().unwrap_or_else(|| "anon".to_string())
    } else {
        trimmed.to_string()
    };
    inner.handle = Some(new_handle.clone());
    inner.avatar = avatar.clone();

    // Persist to config.json (keep nostr_pub / relays / created_at).
    let cfg_bytes = std::fs::read(config_path()).map_err(|e| e.to_string())?;
    let mut cfg: ConfigFile = serde_json::from_slice(&cfg_bytes).map_err(|e| e.to_string())?;
    cfg.handle = new_handle;
    cfg.avatar = avatar;
    std::fs::write(
        config_path(),
        serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // friends.json also stores our own handle at the top level.
    persist_friends(&inner)?;
    Ok(())
}

fn persist_friends(inner: &crate::state::InnerState) -> Result<(), String> {
    let file = FriendsFile {
        handle: inner.handle.clone().unwrap_or_default(),
        friends: inner.friends.values().cloned().collect(),
        blocked: inner.blocked.iter().cloned().collect(),
    };
    std::fs::write(
        friends_path(),
        serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
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
