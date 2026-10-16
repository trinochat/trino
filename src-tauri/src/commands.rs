use crate::blossom;
use crate::call_signal::validate_call_signal;
use crate::command_error::{CommandError, ErrorCode};
use crate::envelope::{encode_envelope, Envelope};
use crate::events::EventSink;
use crate::fsutil;
use crate::group::{FileRef, GroupRoster};
use crate::identity::{create_identity, public_bundle_for, Identity};
use crate::nostr::{ready_gate, relay_connector, NostrClient, NostrEvent, NostrFilter, TRINO_KIND};
use crate::passphrase::validate_passphrase;
use crate::state::{
    config_path, default_relays, friends_path, group_invites_path, groups_path, history_path,
    ratchets_path, trino_home, vault_path, AppState, ConfigFile, FriendsFile, HistItem, InnerState,
};
use crate::store::envelope::Slot;
use crate::store::keys::{StoreKeys, VaultKeys};
use crate::store::report::{Action, IntegrityReport, What};
use crate::store::session::{AccountFile, Found, PrefsImport, SessionStore, STORE_DIR};
use crate::totp_enrollment::TotpBeginResponse;
use crate::vault::{
    decode_vault, encode_vault, seal_vault, unseal_vault, vault_requires_totp, UnsealedVault,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use storage_cmds::{
    apply_loaded, load_session, totp_flag_disagrees, write_vault_noted, LoadedSession,
};
use tauri::{AppHandle, State};
use trino_engine::groups;
pub(crate) use trino_engine::groups::{accept_invite, group_info, GroupInfo, GroupInviteInfo};
// The session's core is the engine's (M4-0c), under the names the
// commands and their child modules have always used.
pub(crate) use trino_engine::send::SendError;
pub(crate) use trino_engine::session::{self, *};
pub(crate) use trino_engine::storage::persist_account;
use trino_net::IsoKind;
use zeroize::{Zeroize, Zeroizing};

const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_STICKER_BYTES: usize = 5 * 1024 * 1024;
const MAX_ICE_CONFIG_BYTES: usize = 16 * 1024;
#[derive(Serialize)]
pub struct StatusResponse {
    pub has_vault: bool,
    pub is_unsealed: bool,
    pub handle: Option<String>,
    pub nostr_pub: Option<String>,
    pub home_dir: String,
    /// Whether unlocking will ask for a TOTP code, from the vault header
    /// (`totp_hint`): `None` with no vault, or one this version cannot read.
    pub totp_enabled: Option<bool>,
    /// Why the session locked, while it stays locked (CL-6a): the window
    /// that opens after the lock reads it for its unlock screen.
    pub lock_reason: Option<lock_cmds::LockReason>,
}

#[derive(Debug, Serialize)]
pub struct UnsealResponse {
    pub handle: String,
    pub fingerprint: String,
    pub nostr_pub: String,
    /// Whether this call started the relay connections: false when the
    /// session was open already, as the call that opened it started them.
    pub relay_connection_started: bool,
    /// The account's preferences, there before the chats show (design
    /// §5.3): `prefs.bin`, also when the session was open already.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefs: Option<serde_json::Value>,
    /// Where the one import of what the WebView kept for the account before
    /// the store stands (`prefs_cmds`).
    pub prefs_import: PrefsImport,
    /// `TRINO_HOME` is set: other data folders may share this WebView's
    /// localStorage, so the import leaves their entries where they are.
    pub custom_data_dir: bool,
    /// What changed on disk since the last session, for the one dialog at
    /// unlock (design §6.2); none when nothing did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrity: Option<IntegrityReport>,
    /// The one note after the migration moved the account of an earlier
    /// version into the store (design §11.5); none at any other unlock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub migration: Option<storage_cmds::MigrationNote>,
}

/// What `forge` returns: the session it opened, as `unseal` describes it, and
/// the new identity's bundle to share.
#[derive(Serialize)]
pub struct ForgeResponse {
    #[serde(flatten)]
    pub session: UnsealResponse,
    pub bundle_json: String,
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
    let inner = state.inner.lock().await;
    Ok(storage_cmds::status_of(
        &inner,
        &trino_home(),
        &vault_path(),
    ))
}

/// Where the data files of the identity are. Passed in rather than read from
/// `trino_home()` so tests can create and open an identity in a scratch
/// directory. The `.json` files, `history.bin`, `ratchets.bin`,
/// `profiles.bin` and `stickers/` are those of earlier versions, which the
/// migration moves to `store/` at the first unlock (CL-1c).
#[derive(Clone)]
pub(crate) struct DataFiles {
    pub(crate) home: PathBuf,
    pub(crate) vault: PathBuf,
    pub(crate) config: PathBuf,
    pub(crate) friends: PathBuf,
    pub(crate) groups: PathBuf,
    pub(crate) group_invites: PathBuf,
    pub(crate) history: PathBuf,
    pub(crate) ratchets: PathBuf,
    pub(crate) profiles: PathBuf,
    pub(crate) stickers: PathBuf,
}

impl DataFiles {
    fn in_trino_home() -> Self {
        let files = DataFiles::in_home(trino_home());
        debug_assert_eq!(files.vault, vault_path());
        debug_assert_eq!(files.config, config_path());
        debug_assert_eq!(files.friends, friends_path());
        debug_assert_eq!(files.groups, groups_path());
        debug_assert_eq!(files.group_invites, group_invites_path());
        debug_assert_eq!(files.history, history_path());
        debug_assert_eq!(files.ratchets, ratchets_path());
        files
    }

    pub(crate) fn in_home(home: PathBuf) -> Self {
        DataFiles {
            vault: home.join("vault.bin"),
            config: home.join("config.json"),
            friends: home.join("friends.json"),
            groups: home.join("groups.json"),
            group_invites: home.join("group_invites.json"),
            history: home.join("history.bin"),
            ratchets: home.join("ratchets.bin"),
            profiles: home.join(profile::PROFILES_FILE),
            stickers: home.join("stickers"),
            home,
        }
    }
}

/// Create the files of a new account: its store, with `account` in it under
/// `keys`, then the vault with `write`.
///
/// vault.bin goes LAST: `status` reports an identity as soon as it exists,
/// and the vault opens nothing without the store it carries the key to, so
/// an interruption halfway must never leave a vault without its store. If a
/// step fails, the store and the data dir that this call created are removed
/// again. Nothing else that was there is touched; a store already there has
/// no vault to open it, and goes (design §5.6).
fn create_identity_files(
    files: &DataFiles,
    keys: StoreKeys,
    account: &[u8],
    vault: &[u8],
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let home_existed = files.home.exists();
    std::fs::create_dir_all(&files.home)?;
    harden_dir(&files.home);
    // A store.new/ with no vault is a migration a cut stopped in an account
    // that is gone; nothing in it opens (design §5.6).
    match std::fs::remove_dir_all(files.home.join(crate::store::migrate::NEW_STORE_DIR)) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let undo = || {
        let _ = std::fs::remove_dir_all(files.home.join(STORE_DIR));
        if !home_existed {
            // Only succeeds while empty, so nothing else can go with it.
            let _ = std::fs::remove_dir(&files.home);
        }
    };
    let written =
        SessionStore::create(&files.home, keys, account).and_then(|()| write(&files.vault, vault));
    if written.is_err() {
        undo();
    }
    written
}

/// Whether opening the vault at `vault` will ask for a TOTP code, from its
/// header alone: `None` if there is no vault, or one this version cannot
/// read. Whoever can write the file can flip the answer, so it only decides
/// what the unlock screen shows; `unseal` still answers `totp_required`
/// whenever the sealed vault holds a secret.
fn totp_hint(vault: &Path) -> Option<bool> {
    let bytes = std::fs::read(vault).ok()?;
    vault_requires_totp(&bytes).ok()
}

/// The name an identity gets: what the user typed, trimmed, or "anon" if
/// that leaves nothing.
fn display_handle(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() { "anon" } else { trimmed }.to_string()
}

/// The TOTP code typed at unlock, if any. An empty or blank field is no code,
/// so a vault with TOTP answers `totp_required`, not `invalid_totp`.
pub(crate) fn submitted_code(code: Option<&str>) -> Option<&str> {
    code.map(str::trim).filter(|code| !code.is_empty())
}

/// Create a new identity in `files`, its vault sealed with `passphrase` and,
/// if given, `totp_secret`, and its store (cifrado local): the account
/// never touches a `.json` file. Returns the identity and the vault's app
/// data, the key to the store. Nothing is written if an identity exists
/// there already or if the passphrase fails the policy.
fn create_account(
    files: &DataFiles,
    handle: &str,
    passphrase: &str,
    totp_secret: Option<&[u8]>,
    write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<(Identity, Zeroizing<Vec<u8>>), CommandError> {
    if files.vault.exists() {
        return Err(CommandError::new(
            ErrorCode::VaultExists,
            "an identity already exists here; wipe it first",
        ));
    }
    validate_passphrase(passphrase)?;

    let identity = create_identity();
    let keys = StoreKeys::generate();
    let app = keys.to_vault_app();
    let sealed = seal_vault(&identity, totp_secret, Some(&app), passphrase)?;
    let account = AccountFile {
        handle: handle.to_string(),
        nostr_pub: hex::encode(identity.nostr.pub_bytes),
        relays: default_relays(),
        created_at: chrono::Utc::now().timestamp(),
        ..AccountFile::default()
    };
    let json = Zeroizing::new(
        serde_json::to_vec(&account).map_err(|e| CommandError::internal(e.to_string()))?,
    );
    create_identity_files(files, keys, &json, &encode_vault(&sealed), write)
        .map_err(|e| CommandError::io(&e))?;
    Ok((identity, app))
}

/// Open the vault at `vault` with `passphrase` and, if it holds a TOTP
/// secret, `totp_code`. Returns what it holds: the identity, that secret and
/// the app data. The settings open it too, to seal it again
/// (security_cmds.rs); every re-seal gives the app data back, since
/// trino-core seals only what it is given.
pub(crate) fn open_vault(
    vault: &Path,
    passphrase: &str,
    totp_code: Option<&str>,
) -> Result<UnsealedVault, CommandError> {
    let bytes = std::fs::read(vault).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            CommandError::new(ErrorCode::NoVault, "there is no identity on this device")
        }
        _ => CommandError::io(&error),
    })?;
    let blob = decode_vault(&bytes)?;
    Ok(unseal_vault(&blob, passphrase, totp_code)?)
}

/// Rotate the signed prekey if it has aged out and expire retired ones; if
/// that changed anything, or `fix_flag` says the vault's TOTP flag is wrong
/// (design §4.9), seal the vault again, with the same passphrase, the same
/// TOTP secret or lack of one and the same app data, and save it with
/// `write`, which also gets the id of the signed prekey it holds. `None`
/// when nothing was due.
///
/// Without rotation, one leaked signed prekey would expose every initial
/// message ever sent to us; retention is what keeps peers holding an older
/// cached bundle (and their auto-heal re-handshakes) working across the
/// change. It runs at unlock, the only point where the identity and the
/// passphrase are both at hand.
fn reseal_if_needed(
    identity: &mut Identity,
    totp_secret: Option<&[u8]>,
    app: Option<&[u8]>,
    passphrase: &str,
    now: i64,
    fix_flag: bool,
    write: impl FnOnce(&[u8], u32) -> std::io::Result<()>,
) -> Option<Result<(), CommandError>> {
    let rotated = crate::identity::rotate_signed_prekey_if_due(identity, now);
    if !rotated && !fix_flag {
        return None;
    }
    let spk = identity.signed_prekey.id;
    Some(
        seal_vault(identity, totp_secret, app, passphrase)
            .map_err(CommandError::from)
            .and_then(|sealed| {
                write(&encode_vault(&sealed), spk).map_err(|e| CommandError::io(&e))
            }),
    )
}

/// What a session that was just opened connects to, as whom, and through
/// which private bridges, if its store keeps some (Tor design §2.6).
struct RelayStart {
    relays: Vec<String>,
    nostr_pub: String,
    handle: String,
    bridges: Option<Vec<trino_net::BridgeLine>>,
    /// The news' old `minSeq` from the store, for tor/seen.json.
    news_min_seq: Option<u64>,
}

/// Open the session of an identity whose vault was just opened in `inner`,
/// with what `load_session` read for it, then give `start_relays` what to
/// connect to. `unseal` and `forge` both end here, so the two always open a
/// session the same way.
///
/// If that identity's session is open already, nothing is loaded or started
/// again, and `loaded` is not needed: loading would throw away what changed
/// in memory since (sessions with contacts, contacts added), and a second
/// set of relay connections would deliver everything twice. Another
/// identity's session is never replaced.
async fn open_session(
    inner: &tokio::sync::Mutex<InnerState>,
    identity: Identity,
    totp_secret: Option<Zeroizing<Vec<u8>>>,
    loaded: Option<LoadedSession>,
    start_relays: impl FnOnce(RelayStart),
) -> Result<UnsealResponse, CommandError> {
    let fingerprint = fp(
        &identity.ik_sign.pub_bytes,
        &identity.ik_dh.pub_bytes,
        &identity.nostr.pub_bytes,
    );
    let nostr_pub = hex::encode(identity.nostr.pub_bytes);

    let mut inner = inner.lock().await;
    if let Some(open) = inner.identity.as_ref() {
        let open_fingerprint = fp(
            &open.ik_sign.pub_bytes,
            &open.ik_dh.pub_bytes,
            &open.nostr.pub_bytes,
        );
        if open_fingerprint != fingerprint {
            return Err(CommandError::internal(
                "another identity's session is open; lock it first",
            ));
        }
        // A reload of the WebView unlocks again: it needs the preferences
        // as the session has them now.
        let (prefs, prefs_import) = prefs_cmds::prefs_of(&inner);
        return Ok(UnsealResponse {
            handle: inner.handle.clone().unwrap_or_default(),
            fingerprint,
            nostr_pub,
            relay_connection_started: false,
            prefs,
            prefs_import,
            custom_data_dir: crate::state::custom_data_dir(),
            integrity: None,
            migration: None,
        });
    }
    let Some(LoadedSession {
        storage,
        account,
        history,
        sessions,
        profiles,
        prefs,
        report,
        migration,
    }) = loaded
    else {
        return Err(CommandError::internal("nothing was loaded for the session"));
    };

    inner.identity = Some(identity);
    // Moved out of its wrapper, which wipes what is left: an empty vector.
    inner.totp_secret = totp_secret.map(|mut secret| std::mem::take(&mut *secret));
    inner.storage.set(storage);
    let now = chrono::Utc::now().timestamp();
    apply_loaded(&mut inner, account, history, sessions, profiles, now);
    let (_, prefs_import) = prefs_cmds::prefs_of(&inner);
    let handle = inner.handle.clone().unwrap_or_default();
    let relays = crate::state::relays_to_use(&inner.relay_urls);
    drop(inner);
    // The private bridges go to Tor, never to the frontend.
    let bridges = bridges_cmds::stored_in(prefs.as_ref());
    let news_min_seq = crate::news_cmds::old_min_seq(prefs.as_ref());
    let prefs = prefs_cmds::for_frontend(prefs);

    start_relays(RelayStart {
        relays,
        nostr_pub: nostr_pub.clone(),
        handle: handle.clone(),
        bridges,
        news_min_seq,
    });

    Ok(UnsealResponse {
        handle,
        fingerprint,
        nostr_pub,
        relay_connection_started: true,
        prefs,
        prefs_import,
        custom_data_dir: crate::state::custom_data_dir(),
        integrity: (!report.is_empty()).then_some(report),
        migration,
    })
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

/// This identity's public bundle as contacts get it: the keys, the name and,
/// if there is one, the photo.
fn own_bundle_json(
    identity: &Identity,
    handle: &str,
    avatar: Option<&str>,
) -> Result<String, String> {
    let mut bundle =
        serde_json::to_value(public_bundle_for(identity)).map_err(|e| e.to_string())?;
    if let Some(fields) = bundle.as_object_mut() {
        fields.insert(
            "handle".to_string(),
            serde_json::Value::String(handle.to_string()),
        );
        if let Some(avatar) = avatar {
            fields.insert(
                "avatar".to_string(),
                serde_json::Value::String(avatar.to_string()),
            );
        }
    }
    serde_json::to_string(&bundle).map_err(|e| e.to_string())
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

/// Where `forge_identity` takes the new vault's TOTP secret from.
enum NewVaultTotp {
    /// No TOTP: the passphrase alone opens the vault.
    Off,
    /// The secret from `totp_begin`, once `totp_verify` has confirmed it.
    Confirmed,
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
    let resend_profile = profile::resend_through(app);
    forge_identity(events, resend_profile, &state, handle, passphrase, totp).await
}

/// `forge`, once it knows whether the vault gets the confirmed TOTP secret.
/// The session it opens tells the UI through `events` (`relay_starter`).
async fn forge_identity(
    events: Arc<dyn EventSink>,
    resend_profile: profile::Resend,
    state: &AppState,
    handle: String,
    passphrase: String,
    totp: NewVaultTotp,
) -> Result<ForgeResponse, CommandError> {
    // Wiped when dropped, whichever way this returns.
    let passphrase = Zeroizing::new(passphrase);
    let _gate = state.session_gate.lock().await;
    let totp_secret = {
        let inner = state.inner.lock().await;
        if inner.identity.is_some() {
            return Err(CommandError::new(
                ErrorCode::VaultExists,
                "an identity is open on this device",
            ));
        }
        match totp {
            NewVaultTotp::Off => None,
            NewVaultTotp::Confirmed => Some(Zeroizing::new(
                inner.totp_enrollment.verified_secret()?.to_vec(),
            )),
        }
    };
    let handle = display_handle(&handle);
    let files = DataFiles::in_trino_home();
    crate::diag::remove_stale_log(&files.home, crate::diag::Build::CURRENT);

    // PBKDF2 is slow on purpose: off the async runtime, as in `unseal`.
    let (identity, totp_secret, loaded) = tokio::task::spawn_blocking({
        let files = files.clone();
        let handle = handle.clone();
        move || {
            let secret = totp_secret.as_deref().map(Vec::as_slice);
            let (identity, app) =
                create_account(&files, &handle, &passphrase, secret, fsutil::atomic_write)?;
            let loaded = load_session(&files, &identity, Some(&app), None)?;
            Ok::<_, CommandError>((identity, totp_secret, loaded))
        }
    })
    .await
    .map_err(|_| CommandError::internal("identity creation worker failed"))??;

    // Sealed into the vault now. On failure it stays, so a retry needs no
    // new QR code.
    state.inner.lock().await.totp_enrollment.clear();
    let bundle_json = own_bundle_json(&identity, &handle, None).map_err(CommandError::internal)?;
    // A new session never inherits TURN credentials (lock and wipe clear them too).
    state.turn.clear();
    let starter = relay_starter(events, resend_profile, state);
    let session = open_session(&state.inner, identity, totp_secret, Some(loaded), starter).await?;
    // Private bridges pasted before the account existed (the first run's
    // "Conexión" step) are sealed in it now (Tor design §2.5).
    if bridges_cmds::keep_first_run_lines(&*state.inner.lock().await, &state.net).is_err() {
        crate::diag::note("the first run's bridges could not be sealed");
    }
    Ok(ForgeResponse {
        session,
        bundle_json,
    })
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
    // Wiped when dropped, whichever way this returns.
    let passphrase = Zeroizing::new(passphrase);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    let session_open = state.inner.lock().await.identity.is_some();
    let files = DataFiles::in_trino_home();
    crate::diag::remove_stale_log(&files.home, crate::diag::Build::CURRENT);

    let (identity, totp_secret, loaded) = tokio::task::spawn_blocking(move || {
        let code = submitted_code(totp_code.as_deref().map(String::as_str));
        let now = chrono::Utc::now().timestamp();
        unlock_files(&files, &passphrase, code, session_open, now)
    })
    .await
    .map_err(|_| CommandError::internal("vault unlock worker failed"))??;

    if !session_open {
        // A new session never inherits TURN credentials (lock and wipe clear them too).
        state.turn.clear();
    }
    let events = crate::events::sink(app.clone());
    let starter = relay_starter(events, profile::resend_through(app), &state);
    open_session(&state.inner, identity, totp_secret, loaded, starter).await
}

/// What `unlock_files` gives `open_session`: the identity, its TOTP secret,
/// and what was loaded for its session (nothing if it is open already).
pub(crate) type Unlocked = (Identity, Option<Zeroizing<Vec<u8>>>, Option<LoadedSession>);

/// What `unseal` does on disk, off the async runtime: open the vault in
/// `files` with `passphrase` and `code`; for an account of an earlier
/// version, whose vault carries no data key, move it into the store first
/// (CL-1c); load what the session needs; and seal the vault again if its
/// signed prekey is due. With `session_open` it only checks the passphrase
/// and the code, and loads nothing.
pub(crate) fn unlock_files(
    files: &DataFiles,
    passphrase: &str,
    code: Option<&str>,
    session_open: bool,
    now: i64,
) -> Result<Unlocked, CommandError> {
    let UnsealedVault {
        mut identity,
        totp_secret,
        app,
    } = open_vault(&files.vault, passphrase, code)?;
    let totp_secret = totp_secret.map(Zeroizing::new);
    if session_open {
        return Ok((identity, totp_secret, None));
    }
    let secret = totp_secret.as_deref().map(Vec::as_slice);
    let mut findings = Vec::new();
    let keys = VaultKeys::from_vault_app(app.as_deref().map(Vec::as_slice))
        .map_err(|e| CommandError::internal(e.to_string()))?;
    let app = match keys {
        VaultKeys::InVault(_) => app,
        // Into the store first. The vault the migration writes carries the
        // new keys; if it stopped before that, with proof that the files of
        // before are this account's, they open as they did and the next
        // unlock tries again.
        VaultKeys::New(keys) => storage_cmds::migrate_account(
            files, &identity, keys, secret, passphrase, now,
        )?
        .map(|migrated| {
            findings = migrated.findings;
            migrated.record
        }),
    };
    // The store opens before the vault is sealed again, so the re-seal is
    // noted in its index (design §4.9).
    let bytes = std::fs::read(&files.vault).ok();
    let app = app.as_deref().map(Vec::as_slice);
    let mut loaded = load_session(files, &identity, app, bytes.as_deref())?;
    storage_cmds::add_findings(&mut loaded, findings);
    let fix_flag = bytes
        .as_deref()
        .is_some_and(|bytes| totp_flag_disagrees(bytes, totp_secret.is_some()));
    if fix_flag {
        loaded.report.note("vault", What::TotpFlag, Action::Notice);
    }
    let storage = &mut loaded.storage;
    let save = |bytes: &[u8], spk: u32| write_vault_noted(Some(storage), &files.vault, bytes, spk);
    match reseal_if_needed(&mut identity, secret, app, passphrase, now, fix_flag, save) {
        None => {}
        Some(Ok(())) => crate::diag::note_with(
            "vault sealed again",
            &[
                ("spk_id", &identity.signed_prekey.id),
                ("retired", &identity.retired_signed_prekeys.len()),
            ],
        ),
        // Keep the session usable; we simply retry next unlock.
        Some(Err(_)) => dbg_log("the vault could not be sealed again"),
    }
    Ok((identity, totp_secret, Some(loaded)))
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
    let inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    own_bundle_json(
        identity,
        inner.handle.as_deref().unwrap_or_default(),
        inner.avatar.as_deref(),
    )
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

/// `send_message`, waiting up to `wait` for a relay's OK. A lock meanwhile
/// keeps nothing of it (`same_session`).
async fn send_text(
    state: &AppState,
    handle: &str,
    text: String,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    // Wiped whichever way this returns, unless they are kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let id = new_msg_id();
    let mut env = Zeroizing::new(encode_envelope(&Envelope::Text {
        body: text.to_string(),
        id: id.clone(),
    }));
    let session = session_key(&*state.inner.lock().await).ok_or(SendError::Sealed)?;
    let sent = send_acked(state, handle, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    remember_outgoing(&mut inner, handle, id, std::mem::take(&mut *env));
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: Some(std::mem::take(&mut *text)),
            file: None,
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(receipt)
}

#[tauri::command]
pub async fn wipe(_app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // WebView2's download history and minidumps, outside the data folder
    // (design §5.7, step 7).
    #[cfg(desktop)]
    crate::traces::clear(&_app);
    // An unlock in progress must not save the vault, or open a session, after
    // this deleted it.
    let _gate = state.session_gate.lock().await;
    let mut inner = state.inner.lock().await;
    // The data key goes with the session's storage first.
    forget_session(&mut inner, &state.turn);
    inner.lock_reason = None;
    drop(inner);

    // Tor last: stopped, then every file of tor/ destroyed (Tor design
    // §2.6, R-03).
    let mut disk = storage_cmds::RealWipe(Some(Arc::clone(&state.net)));
    let failures = storage_cmds::wipe_home(&trino_home(), &mut disk);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "memory cleared, but some files could not be deleted: {}",
            failures.join("; ")
        ))
    }
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
    groups_cmds::add_member(&state, &gid, &friend_handle, persist_account).await
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

/// `send_group_message`, waiting up to `wait` for each member's relay OK.
/// A lock meanwhile keeps nothing of it (`same_session`).
async fn send_group_text(
    state: &AppState,
    gid: &str,
    text: String,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    // Wiped whichever way this returns, unless it is kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::Group {
            gid: gid.to_string(),
            ep: roster.epoch,
            body: text.to_string(),
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    crate::diag::note_with("group send", &[("members", &targets.len())]);
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: Some(std::mem::take(&mut *text)),
                file: None,
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(receipt)
}

/// Encrypt file bytes, upload the ciphertext to Blossom, return the E2E reference.
/// When every file server fails, the error says why for each (`upload_failed`).
async fn prepare_file(
    state: &AppState,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<FileRef, CommandError> {
    let (identity, blob, file) =
        encrypt_attachment(state, name, mime, data_b64, thumb, gid).await?;
    let url = blossom::upload(&state.net, &identity, &blob, &file.sha256).await?;
    Ok(FileRef { url, ..file })
}

/// What `prepare_file` uploads: the identity that signs the upload, the
/// encrypted blob, and its reference, without the URL the upload gives it.
/// `gid` is the group it goes to, if any.
async fn encrypt_attachment(
    state: &AppState,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<(Identity, Vec<u8>, FileRef), CommandError> {
    let too_large = || CommandError::internal("attachment is too large (25 MB max)");
    if data_b64.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 4 {
        return Err(too_large());
    }
    let thumb = checked_inline_raster(thumb).map_err(CommandError::internal)?;
    if !announcement_fits(name, mime, data_b64, thumb.as_deref(), gid) {
        return Err(SendError::TooLong.into());
    }
    let identity = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?.clone();
        // With no relay to announce the file, the upload would be wasted (K4).
        if !inner.relays.iter().any(|relay| relay.is_connected()) {
            return Err(SendError::Offline.into());
        }
        identity
    };
    // Wiped when dropped, whichever way this returns.
    let data = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|_| CommandError::internal("bad base64"))?,
    );
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large());
    }
    let size = data.len() as u64;
    let enc = blossom::encrypt_file(&data)?;
    drop(data);
    let file = FileRef {
        url: String::new(),
        key: enc.key_hex,
        sha256: enc.sha256_hex,
        mime: mime.to_string(),
        name: name.to_string(),
        size,
        thumb,
    };
    Ok((identity, enc.blob, file))
}

/// Whether the announcement of a file can fit a relay whatever URL its
/// upload gives it (`blossom::MAX_URL_BYTES`), to a contact or to the group
/// `gid`. Checked before the upload, so a file that cannot be announced,
/// such as one with too large a preview, is never uploaded. The preview is
/// a checked data URL, which JSON writes as it is: a stand-in of its length
/// sizes it without copying it.
fn announcement_fits(
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<&str>,
    gid: Option<&str>,
) -> bool {
    let announcement = Envelope::File {
        file: FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            key: "0".repeat(64),
            sha256: "0".repeat(64),
            mime: mime.to_string(),
            name: name.to_string(),
            // The most bytes `data_b64` can hold.
            size: (data_b64.len() / 4 * 3 + 3) as u64,
            thumb: thumb.map(|thumb| "t".repeat(thumb.len())),
        },
        gid: gid.map(str::to_string),
        body: None,
    };
    largest_frame_bytes(&encode_envelope(&announcement), unix_now()) <= MAX_EVENT_BYTES
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

/// `send_file` once the file is uploaded: announce it to `handle`, waiting
/// up to `wait` for a relay's OK. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
async fn announce_file(
    state: &AppState,
    handle: &str,
    mut file: FileRef,
    wait: std::time::Duration,
) -> Result<SentFile, SendError> {
    let env = Zeroizing::new(encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: None,
        body: None,
    }));
    let session = session_key(&*state.inner.lock().await).ok_or(SendError::Sealed)?;
    let sent = match ensure_session(state, handle).await {
        Ok(()) => send_acked(state, handle, &env, unix_now(), wait).await,
        Err(error) => Err(error),
    };
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file.clone()),
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(SentFile { file, receipt })
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

/// `send_group_file` once the file is uploaded: announce it to the group as
/// `send_group_text` sends a text. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
async fn announce_group_file(
    state: &AppState,
    gid: &str,
    mut file: FileRef,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<SentGroupFile, SendError> {
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: Some(gid.to_string()),
            body: None,
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file.clone()),
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(SentGroupFile { file, receipt })
}

/// Download + verify + decrypt a file, returning a `data:` URL for the frontend.
/// The download goes through the app's `Net` (Tor design §3 B2).
#[tauri::command]
pub async fn fetch_file(
    state: State<'_, AppState>,
    url: String,
    key: String,
    sha256: String,
    mime: String,
) -> Result<String, String> {
    let blob = blossom::download(&state.net, &url, &sha256)
        .await
        .map_err(|e| e.to_string())?;
    let mut plain = blossom::decrypt_file(&blob, &key).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&plain);
    plain.zeroize();
    Ok(format!("data:{};base64,{}", mime, b64))
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

/// `forward_file`, to the contact or the group `target`. It waits for no
/// relay's OK and is stored as forwarded at once, so it needs a relay that
/// is up: otherwise it would only wait in the queues of relays that are
/// down, and be lost if the session locked first.
async fn forward_to(
    state: &AppState,
    target: &str,
    is_group: bool,
    file: FileRef,
) -> Result<(), SendError> {
    let file = sanitize_file_ref(file);
    let (handles, convo) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        if !inner.relays.iter().any(|relay| relay.is_connected()) {
            return Err(SendError::Offline);
        }
        if is_group {
            let my_ik = hex::encode(identity.ik_sign.pub_bytes);
            let roster = inner.groups.get(target).ok_or(SendError::UnknownGroup)?;
            let handles = member_handles(&inner, roster, &my_ik, None);
            (handles, group_convo(target))
        } else {
            (vec![target.to_string()], target.to_string())
        }
    };
    let env = encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: is_group.then(|| target.to_string()),
        body: None,
    });
    for handle in &handles {
        ensure_session(state, handle).await?;
        publish_sealed(state, handle, &env, None).await?;
    }
    let mut inner = state.inner.lock().await;
    record_history(
        &mut inner,
        convo,
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file),
            call: None,
            ts: unix_now(),
        },
    );
    Ok(())
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
            inner.blocked.insert(pk);
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

/// Restrict the data dir to the owner (0700) on Unix so other local users can't
/// read the vault/history/log. No-op on Windows (uses NTFS ACLs by default).
fn harden_dir(dir: &Path) {
    // Out of the search index, with what is in it (design §5.4 and §8).
    // Best effort: the folder works the same without it.
    let _ = crate::fsutil::mark_not_indexed(dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
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

/// Keep a sticker: in the store, sealed under a name that does not give the
/// image away (H4), or as before for an account not moved yet. Needs the
/// open session.
#[tauri::command]
pub async fn import_sticker(
    state: State<'_, AppState>,
    data_b64: String,
    mime: String,
) -> Result<StickerInfo, String> {
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
    let inner = state.inner.lock().await;
    storage_cmds::import_sticker_into(&inner.storage, &bytes, &mime)
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
    validate_call_signal(&payload).map_err(str::to_string)?;
    ensure_session_inner(&state, &handle).await?;
    let env = encode_envelope(&Envelope::Call { call: payload });
    send_cipher_inner(&state, &handle, &env, None).await
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

/// How long a message waits for a relay to confirm it (K4).
const ACK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// A message one relay at least took (K4): its time, which is also the time
/// it is stored with, and the relays that took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SendReceipt {
    pub ts: i64,
    pub accepted_by: Vec<String>,
}

/// A group message (K4): every member is tried, whatever happens to the
/// others. `accepted` and `failed` are their handles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GroupSendReceipt {
    pub ts: i64,
    pub accepted: Vec<String>,
    pub failed: Vec<String>,
}

/// What `send_file` answers: the file with its receipt, in one object
/// (`SentFile` in src/lib/api.ts). When the UI hands it back to
/// `forward_file`, `FileRef` ignores the receipt's fields.
#[derive(Serialize)]
pub struct SentFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: SendReceipt,
}

/// What `send_group_file` answers, as `SentFile` does.
#[derive(Serialize)]
pub struct SentGroupFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: GroupSendReceipt,
}

/// The largest frame `plaintext` can make once `seal_for` seals it for any
/// contact, dated `ts`: with the longest profile announcement
/// `profile::with_caps` can add, and the widest counters a session can have.
/// A message for several contacts, and a file before its upload, are sized
/// with it, so one too large for the relays goes to nobody.
fn largest_frame_bytes(plaintext: &[u8], ts: i64) -> usize {
    let mut profiles = profile::Profiles::default();
    profiles.contacts.insert(
        String::new(),
        profile::ContactProfile {
            rev: u64::MAX,
            ..Default::default()
        },
    );
    let bare = br#"{"ty":"text"}"#;
    let announcement = profile::with_caps(&profiles, "", bare).len() - bare.len();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: "0".repeat(64),
            pn: u32::MAX,
            n: u32::MAX,
        },
        // AES-GCM, as `ratchet_encrypt` uses it: a 12-byte nonce, and the
        // plaintext with its 16-byte tag, both in hex.
        nonce: "0".repeat(24),
        ciphertext: "0".repeat((plaintext.len() + announcement + 16) * 2),
        handshake: None,
    };
    let event = NostrEvent {
        id: "0".repeat(64),
        pubkey: "0".repeat(64),
        created_at: ts,
        kind: TRINO_KIND,
        tags: vec![vec!["p".to_string(), "0".repeat(64)]],
        content: serde_json::to_string(&payload).unwrap_or_default(),
        sig: "0".repeat(128),
    };
    event_frame_bytes(&event)
}

/// Send `plaintext` to `handle` dated `ts`, and wait up to `wait` for the
/// first relay that takes it (K4).
async fn send_acked(
    state: &AppState,
    handle: &str,
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    let (event, relays) = seal_for(state, handle, plaintext, None, Some(ts), true).await?;
    let accepted_by = first_acceptance(&relays, &event, wait).await?;
    Ok(SendReceipt {
        ts: event.created_at,
        accepted_by,
    })
}

/// Publish `event` to the relays that are up and answer as soon as one of
/// them takes it. A relay that is down is not asked: a message the UI shows
/// as failed must not go out later by itself.
async fn first_acceptance(
    relays: &[Arc<NostrClient>],
    event: &NostrEvent,
    wait: std::time::Duration,
) -> Result<Vec<String>, SendError> {
    use futures_util::StreamExt;
    let mut answers: futures_util::stream::FuturesUnordered<_> = relays
        .iter()
        .filter(|relay| relay.is_connected())
        .map(|relay| async move { (relay.url(), relay.publish_acked(event, wait).await) })
        .collect();
    if answers.is_empty() {
        return Err(SendError::Offline);
    }
    while let Some((url, ack)) = answers.next().await {
        if ack == crate::nostr::Ack::Accepted {
            return Ok(vec![url.to_string()]);
        }
    }
    Err(SendError::NotAccepted)
}

/// The session a send starts in: its identity's Nostr key. `None` while
/// the vault is locked.
fn session_key(inner: &InnerState) -> Option<[u8; 32]> {
    inner
        .identity
        .as_ref()
        .map(|identity| identity.nostr.pub_bytes)
}

/// `state` locked again once a send has waited for its relays (K4), if the
/// session it started in (`session_key`) is open; `NoSession` if not.
///
/// A lock during that wait ends the session: `lock_vault` saves the history
/// without the message, wipes it, and leaves no storage to write with.
/// So a message a relay accepted while its session was locked is not kept
/// in the sender's history, nor in the outbox to replay, although its
/// contact may receive it: the send answers `no_session` and wipes its
/// text. An unlock of the same identity before the wait ends opens the
/// session again, and the message is kept there. The name is not compared,
/// so renaming this identity meanwhile loses nothing.
async fn same_session(
    state: &AppState,
    session: [u8; 32],
) -> Result<tokio::sync::MutexGuard<'_, InnerState>, SendError> {
    let inner = state.inner.lock().await;
    if session_key(&inner) == Some(session) {
        Ok(inner)
    } else {
        Err(SendError::NoSession)
    }
}

/// Whether any relay of the session is up.
async fn any_relay_up(state: &AppState) -> bool {
    let inner = state.inner.lock().await;
    inner.relays.iter().any(|relay| relay.is_connected())
}

/// The handles of `roster`'s members other than us that are contacts, in
/// roster order; with `only`, just the ones it names.
fn member_handles(
    inner: &InnerState,
    roster: &GroupRoster,
    my_ik: &str,
    only: Option<&[String]>,
) -> Vec<String> {
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
        .filter(|handle| only.is_none_or(|only| only.contains(handle)))
        .collect()
}

/// Send `plaintext` to each of `targets`, all dated `ts`, each waiting for
/// its own relay OK. Every member is tried whatever happens to the others:
/// the send used to stop at the first one that failed. A message too large
/// for the relays is refused before any member gets it; when nobody takes
/// it, `group_receipt` says why.
async fn fan_out(
    state: &AppState,
    targets: &[String],
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    if largest_frame_bytes(plaintext, ts) > MAX_EVENT_BYTES {
        return Err(SendError::TooLong);
    }
    if targets.is_empty() {
        return group_receipt(ts, Vec::new());
    }
    if !any_relay_up(state).await {
        return Err(SendError::Offline);
    }
    let sends = targets.iter().map(|handle| async move {
        let sent = match ensure_session(state, handle).await {
            Ok(()) => send_acked(state, handle, plaintext, ts, wait)
                .await
                .map(drop),
            Err(error) => Err(error),
        };
        (handle.clone(), sent)
    });
    group_receipt(ts, futures_util::future::join_all(sends).await)
}

/// What a group send dated `ts` answers once every member was tried: the
/// receipt, when one member at least took it (or there was nobody to send
/// to). When nobody did, why: the reason every member failed for, when it
/// is the same one (too large, offline, no session…), and `NotAccepted`
/// when they failed in different ways.
fn group_receipt(
    ts: i64,
    results: Vec<(String, Result<(), SendError>)>,
) -> Result<GroupSendReceipt, SendError> {
    let mut receipt = GroupSendReceipt {
        ts,
        accepted: Vec::new(),
        failed: Vec::new(),
    };
    let mut causes = Vec::new();
    for (handle, sent) in results {
        match sent {
            Ok(()) => receipt.accepted.push(handle),
            Err(error) => {
                receipt.failed.push(handle);
                causes.push(error);
            }
        }
    }
    let mut causes = causes.into_iter();
    let Some(first) = causes.next() else {
        return Ok(receipt);
    };
    if !receipt.accepted.is_empty() {
        return Ok(receipt);
    }
    if causes.all(|other| other == first) {
        Err(first)
    } else {
        Err(SendError::NotAccepted)
    }
}

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
    resend_buffered(&state, &handle).await;
    Ok(())
}

/// `resend_outbox`: how many buffered messages it sent again.
async fn resend_buffered(state: &AppState, handle: &str) -> usize {
    let items: Vec<Vec<u8>> = {
        let inner = state.inner.lock().await;
        inner
            .outbox
            .get(handle)
            .map(|v| v.iter().map(|(_, e, _)| e.clone()).collect())
            .unwrap_or_default()
    };
    if items.is_empty() {
        return 0;
    }
    crate::diag::note_with("RESEND buffered messages", &[("count", &items.len())]);
    for env in &items {
        let _ = send_cipher_inner(state, handle, env, None).await;
    }
    items.len()
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
    use crate::envelope::decode_envelope;
    use crate::fsutil::scratch::ScratchDir;
    use crate::group;
    use crate::group::MemberBundle;
    use crate::identity::decode_array_32;
    use crate::identity::Identity;
    use crate::passphrase::MIN_PASSPHRASE_CHARS;
    use crate::ratchet::RatchetState;
    use crate::ratchet::{init_initiator, ratchet_decrypt, EncryptedMessage, MessageHeader};
    use crate::state::FriendRecord;
    use crate::state::FriendsFile;
    use crate::totp::{generate_totp_secret, totp_now};
    use crate::turn::TurnGate;
    use crate::vault::{SealedVault, UnsealedVault};
    use crate::x3dh::initiate;
    use trino_engine::groups::respond_to_handshake;

    const NOW: i64 = 1_760_000_000;

    /// Design §5.4 and §8: hardening the data folder, as a new account and
    /// every unlock do, keeps it and what is in it out of the search index.
    #[cfg(windows)]
    #[test]
    fn the_data_folder_is_kept_out_of_the_search_index() {
        use std::os::windows::fs::MetadataExt;
        let dir = ScratchDir::new("harden-not-indexed");
        let home = dir.path().join(".trino");
        std::fs::create_dir_all(home.join("store")).unwrap();
        std::fs::write(home.join("store").join("index.bin"), b"i").unwrap();
        harden_dir(&home);
        for path in [
            home.clone(),
            home.join("store"),
            home.join("store").join("index.bin"),
        ] {
            let attributes = std::fs::metadata(&path).unwrap().file_attributes();
            assert_ne!(attributes & 0x2000, 0, "{}", path.display());
        }
    }

    fn ik(id: &Identity) -> String {
        hex::encode(id.ik_sign.pub_bytes)
    }

    fn member(id: &Identity, handle: &str) -> MemberBundle {
        MemberBundle::from_public_bundle(handle, &public_bundle_for(id))
    }

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

    /// A roster built by the admin's honest client.
    fn roster_of(admin: &Identity, others: &[(&Identity, &str)]) -> GroupRoster {
        let mut roster = group::create_group(admin, member(admin, "admin"), "amigos").unwrap();
        for (id, handle) in others {
            roster = group::add_member(&roster, admin, member(id, handle)).unwrap();
        }
        roster
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

    fn data_files_in(home: PathBuf) -> DataFiles {
        DataFiles::in_home(home)
    }

    /// Every data file is replaced through `fsutil::atomic_write`: a plain
    /// `std::fs::write` truncates the file first, so a crash halfway would
    /// leave it empty or half written.
    #[test]
    fn data_files_are_only_written_atomically() {
        let source: String = include_str!("commands.rs").split_whitespace().collect();
        let plain_writes: Vec<&str> = [
            "vault_path",
            "config_path",
            "friends_path",
            "groups_path",
            "group_invites_path",
            "history_path",
            "ratchets_path",
        ]
        .into_iter()
        .filter(|path_fn| {
            source.contains(&format!("fs::write({path_fn}()"))
                || source.contains(&format!("fs::write(&{path_fn}()"))
        })
        .collect();
        assert!(
            plain_writes.is_empty(),
            "written with fs::write: {plain_writes:?}"
        );
    }

    // ---- Creating and opening the identity (R3.3) ----

    // Each seal or unseal is a full PBKDF2 run, which takes seconds in a debug
    // build: the tests below use as few as they can.
    const PASSPHRASE: &str = "correct horse battery staple";

    /// Open `vault` with a code from `secret`, computed just before. The code
    /// is only checked after the slow key derivation; should that take it past
    /// its window, a fresh code gets one more try.
    fn open_with_code(vault: &Path, secret: &[u8]) -> Result<UnsealedVault, CommandError> {
        match open_vault(vault, PASSPHRASE, Some(&totp_now(secret))) {
            Err(error) if error.code == ErrorCode::InvalidTotp => {
                open_vault(vault, PASSPHRASE, Some(&totp_now(secret)))
            }
            opened => opened,
        }
    }

    #[test]
    fn status_reads_whether_totp_is_on_from_the_vault_header() {
        let scratch = ScratchDir::new("totp-hint");
        let vault = scratch.path().join("vault.bin");
        assert_eq!(totp_hint(&vault), None, "no vault");

        let header = |version: u8, flags: u8| {
            encode_vault(&SealedVault {
                version,
                flags,
                salt: [7; 16],
                nonce: [9; 12],
                ciphertext: vec![1; 48],
            })
        };
        for (bytes, expected) in [
            (header(1, 0b00), Some(true)),
            (header(1, 0b01), Some(false)),
            (header(1, 0b10), None),
            (header(2, 0b00), Some(true)),
            (header(2, 0b01), Some(false)),
            (header(3, 0b00), None),
            (b"not a vault".to_vec(), None),
        ] {
            fsutil::atomic_write(&vault, &bytes).unwrap();
            assert_eq!(totp_hint(&vault), expected, "{bytes:?}");
        }
    }

    #[test]
    fn an_empty_name_becomes_anon() {
        assert_eq!(display_handle("  ana  "), "ana");
        assert_eq!(display_handle(""), "anon");
        assert_eq!(display_handle(" \t "), "anon");
    }

    #[test]
    fn an_empty_or_blank_code_is_no_code() {
        assert_eq!(submitted_code(None), None);
        assert_eq!(submitted_code(Some("")), None);
        assert_eq!(submitted_code(Some("   ")), None);
        assert_eq!(submitted_code(Some(" 123456 ")), Some("123456"));
    }

    #[test]
    fn a_new_identity_with_totp_cannot_be_opened_without_its_code() {
        let scratch = ScratchDir::new("forge-totp");
        let files = data_files_in(scratch.path().join("home"));
        let secret = generate_totp_secret();

        let (identity, app) = create_account(
            &files,
            "ana",
            PASSPHRASE,
            Some(&secret),
            fsutil::atomic_write,
        )
        .unwrap();

        // The account is in the store the vault carries the key to.
        let loaded = storage_cmds::load_session(&files, &identity, Some(&app), None).unwrap();
        assert_eq!(loaded.account.unwrap().handle, "ana");
        assert_eq!(totp_hint(&files.vault), Some(true));
        let error = open_vault(&files.vault, PASSPHRASE, None)
            .map(drop)
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        let opened = open_with_code(&files.vault, &secret).unwrap();
        assert_eq!(
            opened.identity.ik_sign.pub_bytes,
            identity.ik_sign.pub_bytes
        );
        assert_eq!(opened.totp_secret.as_deref(), Some(secret.as_slice()));
    }

    #[test]
    fn a_new_identity_without_totp_opens_with_the_passphrase_alone() {
        let scratch = ScratchDir::new("forge-no-totp");
        let files = data_files_in(scratch.path().join("home"));

        let (identity, _) =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap();

        assert_eq!(totp_hint(&files.vault), Some(false));
        let opened = open_vault(&files.vault, PASSPHRASE, None).unwrap();
        assert_eq!(
            opened.identity.ik_sign.pub_bytes,
            identity.ik_sign.pub_bytes
        );
        assert_eq!(opened.totp_secret, None);
    }

    #[test]
    fn a_new_identity_needs_a_passphrase_that_passes_the_policy() {
        let scratch = ScratchDir::new("forge-policy");
        let files = data_files_in(scratch.path().join("home"));

        let short = create_account(&files, "ana", "corta", None, fsutil::atomic_write).unwrap_err();
        assert_eq!(
            (short.code, short.min),
            (ErrorCode::PassphraseTooShort, Some(MIN_PASSPHRASE_CHARS))
        );
        let common =
            create_account(&files, "ana", "Contraseña123", None, fsutil::atomic_write).unwrap_err();
        assert_eq!(common.code, ErrorCode::PassphraseTooCommon);
        assert!(!files.home.exists(), "something was written");
    }

    #[test]
    fn a_new_identity_never_replaces_one_that_exists() {
        let scratch = ScratchDir::new("forge-exists");
        let files = data_files_in(scratch.path().to_path_buf());
        fsutil::atomic_write(&files.vault, b"the vault already here").unwrap();

        let error =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap_err();

        assert_eq!(error.code, ErrorCode::VaultExists);
        assert_eq!(
            std::fs::read(&files.vault).unwrap(),
            b"the vault already here"
        );
        assert!(!files.home.join(STORE_DIR).exists());
    }

    #[test]
    fn opening_tells_a_missing_vault_from_a_damaged_one() {
        let scratch = ScratchDir::new("open-missing");
        let vault = scratch.path().join("vault.bin");
        let missing = open_vault(&vault, PASSPHRASE, None).map(drop).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NoVault);
        fsutil::atomic_write(&vault, b"not a vault").unwrap();
        let damaged = open_vault(&vault, PASSPHRASE, None).map(drop).unwrap_err();
        assert_eq!(damaged.code, ErrorCode::Internal);
    }

    /// Runs `reseal_if_needed` and returns what it would have saved.
    fn reseal_capturing(
        identity: &mut Identity,
        totp_secret: Option<&[u8]>,
        now: i64,
    ) -> (Option<Result<(), CommandError>>, Option<Vec<u8>>) {
        reseal_capturing_with_app(identity, totp_secret, None, now)
    }

    fn reseal_capturing_with_app(
        identity: &mut Identity,
        totp_secret: Option<&[u8]>,
        app: Option<&[u8]>,
        now: i64,
    ) -> (Option<Result<(), CommandError>>, Option<Vec<u8>>) {
        let mut saved = None;
        let outcome = reseal_if_needed(
            identity,
            totp_secret,
            app,
            PASSPHRASE,
            now,
            false,
            |bytes, _| {
                saved = Some(bytes.to_vec());
                Ok(())
            },
        );
        (outcome, saved)
    }

    #[test]
    fn a_prekey_rotation_keeps_the_app_data() {
        // The app data is the key to store/: a rotation that sealed the
        // vault without it would lose every contact and chat.
        let mut identity = create_identity();
        let due = identity.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;
        let app: &[u8] = b"the key to the local data";

        let (outcome, saved) = reseal_capturing_with_app(&mut identity, None, Some(app), due);

        assert_eq!(outcome, Some(Ok(())));
        let saved = decode_vault(&saved.expect("the rotated vault was saved")).unwrap();
        let opened = crate::vault::unseal_vault(&saved, PASSPHRASE, None).unwrap();
        assert_eq!(opened.app.as_deref().map(Vec::as_slice), Some(app));
    }

    #[test]
    fn a_prekey_rotation_keeps_totp_on() {
        // Rotation seals the vault again. Sealing it without the secret would
        // turn TOTP off for good, without anyone asking for it. The header
        // says which: `seal_vault` sets it from the secret it was given.
        let mut identity = create_identity();
        let rotated_from = identity.signed_prekey.id;
        let due = identity.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;
        let secret = generate_totp_secret();

        let (outcome, saved) = reseal_capturing(&mut identity, Some(&secret), due);

        assert_eq!(outcome, Some(Ok(())));
        assert_ne!(identity.signed_prekey.id, rotated_from);
        let saved = saved.expect("the rotated vault was saved");
        assert!(vault_requires_totp(&saved).unwrap(), "the vault lost TOTP");
    }

    #[test]
    fn a_prekey_rotation_keeps_totp_off() {
        let mut identity = create_identity();
        let due = identity.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;

        let (outcome, saved) = reseal_capturing(&mut identity, None, due);

        assert_eq!(outcome, Some(Ok(())));
        assert!(!vault_requires_totp(&saved.unwrap()).unwrap());
    }

    #[test]
    fn a_prekey_that_is_not_due_leaves_the_vault_alone() {
        let mut identity = create_identity();
        let soon = identity.signed_prekey.created_at + 60;

        let (outcome, saved) = reseal_capturing(&mut identity, None, soon);

        assert_eq!(outcome, None);
        assert_eq!(saved, None);
    }

    /// The config.json and friends.json an account of an earlier version
    /// starts with: one whose vault carries no key to a store yet.
    fn write_profile(files: &DataFiles, identity: &Identity, handle: &str) {
        let config = ConfigFile {
            handle: handle.to_string(),
            nostr_pub: hex::encode(identity.nostr.pub_bytes),
            relays: vec!["wss://relay.example".to_string()],
            created_at: NOW,
            avatar: None,
        };
        let friends = FriendsFile {
            handle: handle.to_string(),
            friends: vec![],
            blocked: vec![],
        };
        std::fs::create_dir_all(&files.home).unwrap();
        fsutil::atomic_write(&files.config, &serde_json::to_vec(&config).unwrap()).unwrap();
        fsutil::atomic_write(&files.friends, &serde_json::to_vec(&friends).unwrap()).unwrap();
    }

    /// Open the session of `identity` as `unseal` does, from the files of an
    /// account of an earlier version: loaded only when no session is open.
    async fn open_from(
        inner: &tokio::sync::Mutex<InnerState>,
        files: &DataFiles,
        identity: Identity,
        start_relays: impl FnOnce(RelayStart),
    ) -> Result<UnsealResponse, CommandError> {
        let loaded = if inner.lock().await.identity.is_some() {
            None
        } else {
            Some(load_session(files, &identity, None, None)?)
        };
        open_session(inner, identity, None, loaded, start_relays).await
    }

    #[tokio::test]
    async fn opening_the_open_session_again_starts_no_second_set_of_connections() {
        let scratch = ScratchDir::new("session-reuse");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        write_profile(&files, &me, "ana");
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let mut starts = Vec::new();

        let first = open_from(&inner, &files, me.clone(), |start| starts.push(start))
            .await
            .unwrap();

        assert!(first.relay_connection_started);
        assert_eq!(first.handle, "ana");
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].relays, ["wss://relay.example"]);
        assert_eq!(starts[0].nostr_pub, hex::encode(me.nostr.pub_bytes));
        assert_eq!(starts[0].handle, "ana");

        // The session moves on: a contact that so far exists in memory only.
        let bob = create_identity();
        inner
            .lock()
            .await
            .friends
            .insert("bob".to_string(), friend(&bob, "bob"));

        let second = open_from(&inner, &files, me.clone(), |start| starts.push(start))
            .await
            .unwrap();

        assert!(!second.relay_connection_started);
        assert_eq!(second.handle, "ana");
        assert_eq!(second.fingerprint, first.fingerprint);
        assert_eq!(starts.len(), 1, "the relay connections were started twice");
        assert!(
            inner.lock().await.friends.contains_key("bob"),
            "the open session was loaded again from disk"
        );
    }

    #[tokio::test]
    async fn another_identity_cannot_take_over_the_open_session() {
        let scratch = ScratchDir::new("session-other");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        write_profile(&files, &me, "ana");
        let inner = tokio::sync::Mutex::new(InnerState::default());
        open_from(&inner, &files, me.clone(), |_| {}).await.unwrap();

        let error = open_from(&inner, &files, create_identity(), |_| {
            panic!("connections started for another identity")
        })
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        let open = inner.lock().await;
        assert_eq!(
            open.identity.as_ref().map(|id| id.ik_sign.pub_bytes),
            Some(me.ik_sign.pub_bytes)
        );
    }

    #[tokio::test]
    async fn a_vault_without_its_config_opens_no_session() {
        let scratch = ScratchDir::new("session-no-config");
        let files = data_files_in(scratch.path().to_path_buf());
        let inner = tokio::sync::Mutex::new(InnerState::default());

        let error = open_from(&inner, &files, create_identity(), |_| {
            panic!("connections started without a session")
        })
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert!(inner.lock().await.identity.is_none());
    }

    #[test]
    fn the_own_bundle_carries_the_name_and_any_photo() {
        let me = create_identity();
        let parse = |json: String| serde_json::from_str::<serde_json::Value>(&json).unwrap();

        let plain = parse(own_bundle_json(&me, "ana", None).unwrap());
        assert_eq!(plain["handle"], "ana");
        assert_eq!(plain["ikSignPub"], hex::encode(me.ik_sign.pub_bytes));
        assert!(plain.get("avatar").is_none());

        let photo = "data:image/png;base64,iVBORw0KGgo=";
        let with_photo = parse(own_bundle_json(&me, "ana", Some(photo)).unwrap());
        assert_eq!(with_photo["avatar"], photo);
    }

    #[test]
    fn forge_answers_like_unseal_plus_the_bundle() {
        let created = ForgeResponse {
            session: UnsealResponse {
                handle: "ana".to_string(),
                fingerprint: "ab12.cd34".to_string(),
                nostr_pub: "ff".to_string(),
                relay_connection_started: true,
                prefs: None,
                prefs_import: PrefsImport::Pending,
                custom_data_dir: false,
                integrity: None,
                migration: None,
            },
            bundle_json: "{}".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::json!({
                "handle": "ana",
                "fingerprint": "ab12.cd34",
                "nostr_pub": "ff",
                "relay_connection_started": true,
                "prefs_import": "pending",
                "custom_data_dir": false,
                "bundle_json": "{}",
            })
        );
    }

    // ---- K4: a message counts as sent once a relay says OK ----

    use crate::nostr::test_relay::{unreachable_client, Answer, TestRelay};

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

    /// How many messages the session with `handle` has sent.
    async fn sent_so_far(state: &AppState, handle: &str) -> u32 {
        state.inner.lock().await.ratchets[handle].sending_msg_number
    }

    fn pub_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    #[tokio::test]
    async fn a_message_counts_as_sent_once_a_relay_says_ok() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let receipt = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted_by, std::slice::from_ref(&relay.url));
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].created_at, receipt.ts);
        assert_eq!(events[0].recipient(), Some(pub_hex(&bob).as_str()));
        let inner = state.inner.lock().await;
        let stored = inner.history["bob"].last().unwrap();
        assert_eq!(stored.ts, receipt.ts, "stored with the time of the receipt");
        assert_eq!(stored.text.as_deref(), Some("hola"));
        assert_eq!(stored.side, "me");
    }

    #[tokio::test]
    async fn a_message_no_relay_takes_is_not_accepted_and_not_stored() {
        let refusing = TestRelay::start(Answer::Reject).await;
        let silent = TestRelay::start(Answer::Silent).await;
        let (me, bob) = (create_identity(), create_identity());
        let relays = vec![refusing.client().await, silent.client().await];
        let state = sending_state(&me, relays).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert_eq!((refusing.events().len(), silent.events().len()), (1, 1));
        assert!(!state.inner.lock().await.history.contains_key("bob"));
    }

    #[tokio::test]
    async fn without_a_relay_up_nothing_is_encrypted_or_sent() {
        let (me, bob) = (create_identity(), create_identity());
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

            let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
                .await
                .unwrap_err();

            assert_eq!(CommandError::from(error).code, ErrorCode::Offline);
            assert_eq!(sent_so_far(&state, "bob").await, 0, "the session moved on");
        }
    }

    #[tokio::test]
    async fn a_message_too_big_for_the_relays_is_refused_without_a_ratchet_step() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        // About 80 KB once encrypted and hex-encoded: relays drop it unseen.
        let error = send_text(&state, "bob", "x".repeat(40_000), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(sent_so_far(&state, "bob").await, 0);
        assert!(relay.events().is_empty());
        // About 40 KB fits, on the same session.
        send_text(&state, "bob", "x".repeat(20_000), SHORT_WAIT)
            .await
            .unwrap();
        assert_eq!(sent_so_far(&state, "bob").await, 1);
    }

    #[tokio::test]
    async fn a_message_to_a_contact_without_a_session_says_so() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        state
            .inner
            .lock()
            .await
            .friends
            .insert("bob".to_string(), friend(&bob, "bob"));

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NoSession);
        assert!(relay.events().is_empty());
    }

    /// Me, admin of a group with bob, carol and dave, all with sessions.
    async fn group_of_three(state: &AppState, me: &Identity, others: &[Identity; 3]) -> String {
        let mut inner = state.inner.lock().await;
        let handles = ["bob", "carol", "dave"];
        for (who, handle) in others.iter().zip(handles) {
            add_session(&mut inner, me, who, handle);
        }
        let members: Vec<(&Identity, &str)> = others.iter().zip(handles).collect();
        let roster = roster_of(me, &members);
        let gid = roster.group_id.clone();
        inner.groups.insert(gid.clone(), roster);
        gid
    }

    #[tokio::test]
    async fn a_group_message_reaches_every_member_it_can_whatever_happens_to_one() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::RejectTo(pub_hex(&others[1]))).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let receipt = send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["bob", "dave"]);
        assert_eq!(receipt.failed, ["carol"]);
        let events = relay.events();
        assert_eq!(events.len(), 3, "every member was tried");
        assert!(events.iter().all(|e| e.created_at == receipt.ts));
        let inner = state.inner.lock().await;
        let stored = inner.history[&group_convo(&gid)].last().unwrap();
        assert_eq!(stored.ts, receipt.ts);
        assert_eq!(stored.text.as_deref(), Some("hola grupo"));
    }

    #[tokio::test]
    async fn a_resend_goes_only_to_the_members_named_and_is_not_stored_again() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        let only = ["carol".to_string()];

        let receipt = send_group_text(&state, &gid, "hola".to_string(), Some(&only), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["carol"]);
        assert!(receipt.failed.is_empty());
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].recipient(), Some(pub_hex(&others[1]).as_str()));
        assert!(
            !state
                .inner
                .lock()
                .await
                .history
                .contains_key(&group_convo(&gid)),
            "the first send stored it already"
        );
    }

    #[tokio::test]
    async fn a_group_message_no_member_takes_is_not_accepted() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Reject).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let error = send_group_text(&state, &gid, "hola".to_string(), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    fn sample_file() -> FileRef {
        FileRef {
            url: "https://blossom.band/abc".to_string(),
            key: "00".repeat(32),
            sha256: "ab".repeat(32),
            mime: "image/png".to_string(),
            name: "foto.png".to_string(),
            size: 3,
            thumb: None,
        }
    }

    #[test]
    fn the_ui_receives_the_receipts_in_the_contract_shape() {
        // `SendReceipt`, `GroupSendReceipt` and `SentFile` in src/lib/api.ts.
        let receipt = SendReceipt {
            ts: NOW,
            accepted_by: vec!["wss://relay.damus.io".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted_by": ["wss://relay.damus.io"] })
        );
        let group = GroupSendReceipt {
            ts: NOW,
            accepted: vec!["bob".to_string()],
            failed: vec!["carol".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&group).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted": ["bob"], "failed": ["carol"] })
        );
        let sent = SentFile {
            file: sample_file(),
            receipt,
        };
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            serde_json::json!({
                "url": "https://blossom.band/abc",
                "key": "00".repeat(32),
                "sha256": "ab".repeat(32),
                "mime": "image/png",
                "name": "foto.png",
                "size": 3,
                "ts": NOW,
                "accepted_by": ["wss://relay.damus.io"],
            })
        );
        let sent_to_group = SentGroupFile {
            file: sample_file(),
            receipt: group,
        };
        let value = serde_json::to_value(&sent_to_group).unwrap();
        assert_eq!(value["accepted"], serde_json::json!(["bob"]));
        assert_eq!(value["failed"], serde_json::json!(["carol"]));
        assert_eq!(value["name"], "foto.png");
    }

    #[test]
    fn a_sent_file_given_back_to_forward_file_is_just_the_file() {
        // The UI forwards the `SentFile` it got from `send_file`.
        let sent = serde_json::to_value(SentFile {
            file: sample_file(),
            receipt: SendReceipt {
                ts: NOW,
                accepted_by: vec!["wss://nos.lol".to_string()],
            },
        })
        .unwrap();

        let file: FileRef = serde_json::from_value(sent).expect("extra fields are ignored");

        assert_eq!(file, sample_file());
        let forwarded = encode_envelope(&Envelope::File {
            file,
            gid: None,
            body: None,
        });
        let forwarded: serde_json::Value = serde_json::from_slice(&forwarded).unwrap();
        assert!(forwarded["file"].get("ts").is_none());
        assert!(forwarded["file"].get("accepted_by").is_none());
    }

    #[test]
    fn send_errors_reach_the_ui_with_their_codes_and_the_old_texts() {
        for (error, code) in [
            (SendError::Sealed, ErrorCode::NoVault),
            (SendError::NoSession, ErrorCode::NoSession),
            (SendError::NoRelays, ErrorCode::Offline),
            (SendError::Offline, ErrorCode::Offline),
            (SendError::NotAccepted, ErrorCode::NotAccepted),
            (SendError::TooLong, ErrorCode::MessageTooLong),
            (SendError::UnknownContact, ErrorCode::Internal),
            (SendError::UnknownGroup, ErrorCode::Internal),
            (SendError::Empty, ErrorCode::Internal),
        ] {
            assert_eq!(CommandError::from(error).code, code);
        }
        // The commands that still answer with a string keep their texts.
        assert_eq!(SendError::Sealed.to_string(), "vault sealed");
        assert_eq!(SendError::UnknownContact.to_string(), "unknown node");
        assert_eq!(
            SendError::NoRelays.to_string(),
            "network is still connecting"
        );
        assert_eq!(
            SendError::NoSession.to_string(),
            "no session — run connect first"
        );
    }

    // ---- B2: a message too large for the relays goes to nobody ----

    /// A preview `chars` characters long, as the UI sends a sticker's data
    /// URL with a file.
    fn preview_of(chars: usize) -> String {
        format!("data:image/png;base64,{}", "A".repeat(chars))
    }

    /// Whether the session with each of `handles` is where it started.
    async fn no_session_moved_on(state: &AppState, handles: &[&str]) -> bool {
        for handle in handles {
            if sent_so_far(state, handle).await != 0 {
                return false;
            }
        }
        true
    }

    #[tokio::test]
    async fn a_group_text_too_large_for_the_relays_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        // About 80 KB once encrypted and hex-encoded, as for one contact.
        let error = send_group_text(&state, &gid, "x".repeat(40_000), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(CommandError::from(error).code, ErrorCode::MessageTooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    #[tokio::test]
    async fn a_group_file_whose_preview_is_too_large_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        // A sticker whose 40,000-character data URL goes as its preview.
        let file = FileRef {
            thumb: Some(preview_of(40_000)),
            ..sample_file()
        };

        let Err(error) = announce_group_file(&state, &gid, file, None, SHORT_WAIT).await else {
            panic!("announced");
        };

        assert_eq!(error, SendError::TooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
    }

    #[tokio::test]
    async fn a_file_whose_announcement_cannot_fit_is_refused_before_its_upload() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let data = base64::engine::general_purpose::STANDARD.encode(b"a small sticker");
        let gid = "ab".repeat(32);

        for to_group in [None, Some(gid.as_str())] {
            let encrypted = encrypt_attachment(
                &state,
                "sticker.png",
                "image/png",
                &data,
                Some(preview_of(40_000)),
                to_group,
            )
            .await;

            // Refused here, it never reaches a file server.
            let Err(error) = encrypted else {
                panic!("it would be uploaded, to group {to_group:?}");
            };
            assert_eq!(error.code, ErrorCode::MessageTooLong, "{to_group:?}");
        }
        // A preview that fits goes on to the upload.
        let (_, _, file) = encrypt_attachment(
            &state,
            "sticker.png",
            "image/png",
            &data,
            Some(preview_of(8_000)),
            Some(&gid),
        )
        .await
        .unwrap();
        assert_eq!(file.thumb, Some(preview_of(8_000)));
    }

    #[test]
    fn every_preview_the_app_makes_fits_an_announcement() {
        // fitThumb (src/lib/media.ts) shrinks a photo's or a video's preview
        // until its data URL is at most THUMB_MAX_CHARS, and a sticker goes
        // with its picture inline only up to the same length
        // (sticker-limits.ts). Should that drift past what an announcement
        // holds, send_file would answer message_too_long for every such file
        // before its upload, and the composer offers to try again.
        let media = include_str!("../../src/lib/media.ts");
        let max: usize = media
            .lines()
            .find_map(|line| line.trim().strip_prefix("export const THUMB_MAX_CHARS = "))
            .and_then(|value| value.trim_end().strip_suffix(';'))
            .map(|value| value.trim().replace('_', "").parse().expect("a number"))
            .expect("THUMB_MAX_CHARS in media.ts");
        // The longest name a file system gives (255 UTF-16 units, 3 bytes
        // each here), a long type, a file of 25 MiB and a group.
        let name = "字".repeat(255);
        let mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        let data = "A".repeat(25 * 1024 * 1024 / 3 * 4 + 4);
        let gid = "ab".repeat(32);
        let fits = |chars: usize| {
            announcement_fits(&name, mime, &data, Some(&"t".repeat(chars)), Some(&gid))
        };
        assert!(fits(max), "a preview of {max} characters");
        // The check can fail: a preview a fifth longer does not fit.
        assert!(!fits(max * 6 / 5));
    }

    #[tokio::test]
    async fn the_largest_frame_of_a_message_bounds_the_event_sealed_for_it() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        {
            let mut inner = state.inner.lock().await;
            add_session(&mut inner, &me, &bob, "bob");
            // The longest announcement a profile revision can make.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: u64::MAX,
                    ..Default::default()
                },
            );
        }
        let file = FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            thumb: Some(preview_of(8_000)),
            ..sample_file()
        };
        for envelope in [
            Envelope::Text {
                body: String::new(),
                id: new_msg_id(),
            },
            Envelope::Text {
                body: "ñandú \"citado\" \u{1}".repeat(500),
                id: new_msg_id(),
            },
            Envelope::Group {
                gid: "ab".repeat(32),
                ep: u64::MAX,
                body: "x".repeat(20_000),
            },
            Envelope::File {
                file,
                gid: Some("ab".repeat(32)),
                body: None,
            },
        ] {
            let plaintext = encode_envelope(&envelope);
            let ts = unix_now();

            let (event, _) = seal_for(&state, "bob", &plaintext, None, Some(ts), true)
                .await
                .unwrap();

            let sealed = event_frame_bytes(&event);
            let largest = largest_frame_bytes(&plaintext, ts);
            assert!(sealed <= largest, "{sealed} > {largest}");
            // Only the counters of the session can be shorter than the
            // widest: up to nine digits each.
            assert!(largest - sealed <= 18, "{largest} - {sealed}");
        }
    }

    #[test]
    fn when_no_member_takes_a_group_message_the_answer_says_why() {
        let failed = |errors: Vec<SendError>| -> Vec<(String, Result<(), SendError>)> {
            let names = ["bob", "carol", "dave"].map(String::from);
            names.into_iter().zip(errors.into_iter().map(Err)).collect()
        };
        // Every member failed the same way: that is the answer.
        let causes: [fn() -> SendError; 6] = [
            || SendError::TooLong,
            || SendError::Offline,
            || SendError::NoSession,
            || SendError::Sealed,
            || SendError::NotAccepted,
            || SendError::Failed("bad prekey".to_string()),
        ];
        for cause in causes {
            let all = failed(vec![cause(), cause(), cause()]);
            assert_eq!(group_receipt(NOW, all), Err(cause()));
        }
        // Different ways: no relay took it for anyone.
        let mixed = failed(vec![
            SendError::TooLong,
            SendError::NotAccepted,
            SendError::Offline,
        ]);
        assert_eq!(group_receipt(NOW, mixed), Err(SendError::NotAccepted));
        // One member at least took it: the receipt says who did not.
        let partly = vec![
            ("bob".to_string(), Ok(())),
            ("carol".to_string(), Err(SendError::TooLong)),
            ("dave".to_string(), Ok(())),
        ];
        assert_eq!(
            group_receipt(NOW, partly),
            Ok(GroupSendReceipt {
                ts: NOW,
                accepted: vec!["bob".to_string(), "dave".to_string()],
                failed: vec!["carol".to_string()],
            })
        );
    }

    // ---- B2: a lock while a message waits for its relays ----

    /// What `lock_vault` does to the session, as a test can do it.
    fn lock(inner: &mut InnerState) {
        forget_session(inner, &TurnGate::default());
    }

    /// Me, with a session with bob, sending through a relay that holds its
    /// OK until `release` is told; and that relay's client.
    async fn held_ok_to_bob(
        release: &Arc<tokio::sync::Notify>,
    ) -> (Arc<AppState>, TestRelay, Arc<NostrClient>) {
        let relay = TestRelay::start(Answer::AcceptWhenReleased(Arc::clone(release))).await;
        let (me, bob) = (create_identity(), create_identity());
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");
        (state, relay, client)
    }

    /// The user locks just as the relay's OK comes in: `lock_vault` holds
    /// the session when the send has its OK, and wipes it.
    async fn lock_as_the_ok_comes_in(
        state: &AppState,
        relay: &TestRelay,
        client: &NostrClient,
        release: &tokio::sync::Notify,
    ) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the event to reach the relay", || relay.events().len() == 1).await;
        let mut locking = state.inner.lock().await;
        release.notify_one();
        wait_until("the OK", || client.awaiting_ok() == 0).await;
        lock(&mut locking);
    }

    /// What a locked session must not hold of a message sent during the lock.
    async fn kept_nothing(state: &AppState) {
        let inner = state.inner.lock().await;
        assert!(inner.history.is_empty(), "in the locked session's history");
        assert!(inner.outbox.is_empty(), "kept to replay");
    }

    #[tokio::test]
    async fn a_message_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move { send_text(&state, "bob", "texto secreto".to_string(), wait).await }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_file_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move {
                announce_file(&state, "bob", sample_file(), wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    /// Me in a group with bob, carol and dave, sending through a relay that
    /// takes bob's and carol's events at once and never answers dave's.
    async fn group_waiting_for_dave() -> (Arc<AppState>, String, TestRelay, Arc<NostrClient>) {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::SilentTo(pub_hex(&others[2]))).await;
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        let gid = group_of_three(&state, &me, &others).await;
        (state, gid, relay, client)
    }

    /// The user locks once bob's and carol's OKs are in, while the send
    /// still waits for dave's.
    async fn lock_while_waiting_for_dave(
        state: &AppState,
        relay: &TestRelay,
        client: &NostrClient,
    ) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the three events", || relay.events().len() == 3).await;
        wait_until("bob's and carol's OKs", || client.awaiting_ok() == 1).await;
        lock(&mut *state.inner.lock().await);
    }

    #[tokio::test]
    async fn a_group_message_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                let text = "texto secreto del grupo".to_string();
                send_group_text(&state, &gid, text, None, wait).await
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_group_file_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                announce_group_file(&state, &gid, sample_file(), None, wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    // ---- B2: what is shown as sent at once needs a relay up ----

    #[tokio::test]
    async fn a_forward_with_no_relay_up_answers_offline_and_keeps_nothing() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let state = sending_state(&me, vec![unreachable_client(Arc::default())]).await;
        let gid = group_of_three(&state, &me, &others).await;

        for (target, is_group) in [("bob", false), (gid.as_str(), true)] {
            let error = forward_to(&state, target, is_group, sample_file())
                .await
                .unwrap_err();

            assert_eq!(error, SendError::Offline, "{target}");
            assert_eq!(CommandError::from(error).code, ErrorCode::Offline);
        }
        assert!(
            state.inner.lock().await.history.is_empty(),
            "shown as forwarded"
        );
        assert!(
            no_session_moved_on(&state, &["bob", "carol", "dave"]).await,
            "sealed to wait in a queue"
        );
    }

    #[tokio::test]
    async fn a_forward_goes_to_the_contact_or_every_member_and_is_kept() {
        use crate::nostr::test_relay::wait_until;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        forward_to(&state, "bob", false, sample_file())
            .await
            .unwrap();
        forward_to(&state, &gid, true, sample_file()).await.unwrap();

        wait_until("bob's and the group's", || relay.events().len() == 4).await;
        let inner = state.inner.lock().await;
        assert_eq!(inner.history["bob"].len(), 1);
        assert_eq!(inner.history[&group_convo(&gid)].len(), 1);
    }

    // ---- B1: what is kept under a contact's name stays with that contact ----

    /// The contact code of `id`, named `handle`, as `probe_node` reads it.
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

    #[tokio::test]
    async fn a_member_is_not_added_while_no_relay_is_up() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            let gid = group_of_three(&state, &me, &others).await;
            let before = {
                let mut inner = state.inner.lock().await;
                inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
                inner.groups[&gid].clone()
            };
            let mut saved = false;

            let added = groups_cmds::add_member(&state, &gid, "eve", |_| {
                saved = true;
                Ok(())
            })
            .await;

            let Err(error) = added else {
                panic!("added with no relay up");
            };
            assert_eq!(error.code, ErrorCode::Offline);
            assert_eq!(state.inner.lock().await.groups[&gid], before, "stored");
            assert!(!saved, "groups.json was written");
        }
    }

    #[tokio::test]
    async fn a_member_that_cannot_be_reached_does_not_stop_the_others() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        {
            let mut inner = state.inner.lock().await;
            inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
            // bob, the first member the roster goes to, cannot be reached:
            // his session is gone, and the prekey kept for him no longer
            // verifies, so no new one can start.
            let first = inner.groups[&gid]
                .members
                .iter()
                .find(|m| m.ik_sign_pub != ik(&me));
            assert_eq!(first.unwrap().ik_sign_pub, ik(&others[0]));
            inner.ratchets.remove("bob");
            inner.associated_data.remove("bob");
            inner.friends.get_mut("bob").unwrap().bundle.spk_sig = "00".repeat(64);
        }

        let info = groups_cmds::add_member(&state, &gid, "eve", |_| Ok(()))
            .await
            .unwrap();

        assert!(info.members.contains(&"eve".to_string()));
        assert!(group::is_member(
            &state.inner.lock().await.groups[&gid],
            &ik(&eve)
        ));
        // carol and dave get the roster; eve gets the handshake that opens
        // her session, then the roster.
        crate::nostr::test_relay::wait_until("the rosters", || relay.events().len() == 4).await;
        let mut reached: Vec<String> = relay
            .events()
            .iter()
            .filter_map(|event| event.recipient().map(str::to_string))
            .collect();
        reached.sort();
        let mut expected = vec![
            pub_hex(&others[1]),
            pub_hex(&others[2]),
            pub_hex(&eve),
            pub_hex(&eve),
        ];
        expected.sort();
        assert_eq!(reached, expected);
    }

    // ---- I0: what goes out says that this Trino reads profiles (K12) ----

    /// `add_session`, plus the contact's own side of that session, so a test
    /// reads what was sent as the contact's Trino would.
    fn add_session_read_by(
        inner: &mut InnerState,
        me: &Identity,
        contact: &Identity,
        handle: &str,
    ) -> (RatchetState, Vec<u8>) {
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
        let handshake = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };
        let (_, ratchet, associated_data) = respond_to_handshake(contact, &handshake).unwrap();
        (ratchet, associated_data)
    }

    /// What `event` carries, decrypted by its recipient's side of the session.
    fn opened_by(event: &NostrEvent, ratchet: &mut RatchetState, ad: &[u8]) -> Vec<u8> {
        let payload: WirePayload = serde_json::from_str(&event.content).unwrap();
        let message = EncryptedMessage {
            header: MessageHeader {
                dh_pub: payload.header.dh_pub,
                pn: payload.header.pn,
                n: payload.header.n,
            },
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
        };
        ratchet_decrypt(ratchet, &message, ad).unwrap()
    }

    #[tokio::test]
    async fn text_group_and_file_messages_say_that_this_trino_reads_profiles() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        let (mut bob_side, ad, gid) = {
            let mut inner = state.inner.lock().await;
            let (bob_side, ad) = add_session_read_by(&mut inner, &me, &bob, "bob");
            // Revision 7 of bob's profile is the one kept here.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: 7,
                    ..Default::default()
                },
            );
            let roster = roster_of(&me, &[(&bob, "bob")]);
            let gid = roster.group_id.clone();
            inner.groups.insert(gid.clone(), roster);
            (bob_side, ad, gid)
        };
        let file = Envelope::File {
            file: sample_file(),
            gid: None,
            body: None,
        };

        send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();
        send_acked(
            &state,
            "bob",
            &encode_envelope(&file),
            unix_now(),
            SHORT_WAIT,
        )
        .await
        .unwrap();

        let events = relay.events();
        assert_eq!(events.len(), 3);
        let opened: Vec<Vec<u8>> = events
            .iter()
            .map(|event| opened_by(event, &mut bob_side, &ad))
            .collect();
        // Each is still the message sent,
        assert!(
            matches!(decode_envelope(&opened[0]), Envelope::Text { body, .. } if body == "hola")
        );
        assert!(matches!(
            decode_envelope(&opened[1]),
            Envelope::Group { gid: to, body, .. } if to == gid && body == "hola grupo"
        ));
        assert_eq!(decode_envelope(&opened[2]), file);
        // and it says that this Trino reads profiles and which revision of
        // bob's it holds, which bob's Trino records.
        let mut bobs_profiles = profile::Profiles::default();
        for (event, plain) in events.iter().zip(&opened) {
            let fields: serde_json::Value = serde_json::from_slice(plain).unwrap();
            assert_eq!(
                fields["prof"],
                serde_json::json!({ "v": 1, "have": 7 }),
                "{fields}"
            );
            profile::receive(&mut bobs_profiles, "me", plain, event.created_at);
            assert_eq!(bobs_profiles.contacts["me"].caps, profile::PROFILE_V);
            assert_eq!(bobs_profiles.contacts["me"].have, 7);
        }
    }

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
}
