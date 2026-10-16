use crate::command_error::{CommandError, ErrorCode};
use crate::events::EventSink;
use crate::fsutil;
use crate::group::FileRef;
use crate::identity::{create_identity, public_bundle_for, Identity};
use crate::nostr::{ready_gate, relay_connector, NostrFilter, TRINO_KIND};
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
pub(crate) use trino_engine::groups::{accept_invite, GroupInfo, GroupInviteInfo};
// The session's core is the engine's (M4-0c), under the names the
// commands and their child modules have always used.
pub(crate) use trino_engine::send::{self, *};
pub(crate) use trino_engine::session::{self, *};
pub(crate) use trino_engine::storage::persist_account;
use trino_net::IsoKind;
use zeroize::Zeroizing;

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
/// The download goes through the app's `Net` (Tor design §3 B2).
#[tauri::command]
pub async fn fetch_file(
    state: State<'_, AppState>,
    url: String,
    key: String,
    sha256: String,
    mime: String,
) -> Result<String, String> {
    send::fetch_file(&state, &url, &key, &sha256, &mime).await
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
    use crate::fsutil::scratch::ScratchDir;
    use crate::identity::decode_array_32;
    use crate::identity::Identity;
    use crate::nostr::NostrClient;
    use crate::passphrase::MIN_PASSPHRASE_CHARS;
    use crate::ratchet::init_initiator;
    use crate::state::FriendRecord;
    use crate::state::FriendsFile;
    use crate::totp::{generate_totp_secret, totp_now};
    use crate::vault::{SealedVault, UnsealedVault};
    use crate::x3dh::initiate;

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
}
