//! Opening the account (M4-0c): a new identity with its store and its
//! vault (`create_account`, `forge_identity`), the vault opened at unlock
//! (`unlock_files`, `unseal`), and the session filled with what was loaded
//! (`open_session`); what the unlock screen reads before (`status`), and
//! the wipe of everything (`wipe`).
//!
//! The host starts the relays of a session that opened (`RelayStart`):
//! the desktop app wakes Tor and spawns `session::connect_relays` on its
//! runtime.

use crate::command_error::{CommandError, ErrorCode};
use crate::fsutil;
use crate::identity::{create_identity, public_bundle_for, Identity};
use crate::passphrase::validate_passphrase;
use crate::session::{dbg_log, forget_session, fp};
use crate::state::{
    config_path, default_relays, friends_path, group_invites_path, groups_path, history_path,
    ratchets_path, trino_home, vault_path, InnerState,
};
use crate::storage::{
    add_findings, apply_loaded, harden_dir, load_session, migrate_account, status_of,
    totp_flag_disagrees, wipe_home, write_vault_noted, LoadedSession, MigrationNote, RealWipe,
};
use crate::store::keys::{StoreKeys, VaultKeys};
use crate::store::report::{Action, IntegrityReport, What};
use crate::store::session::{AccountFile, PrefsImport, SessionStore, STORE_DIR};
use crate::vault::{
    decode_vault, encode_vault, seal_vault, unseal_vault, vault_requires_totp, UnsealedVault,
};
use crate::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use zeroize::Zeroizing;

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
    pub lock_reason: Option<crate::lock::LockReason>,
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
    pub migration: Option<MigrationNote>,
}

/// What `forge` returns: the session it opened, as `unseal` describes it, and
/// the new identity's bundle to share.
#[derive(Serialize)]
pub struct ForgeResponse {
    #[serde(flatten)]
    pub session: UnsealResponse,
    pub bundle_json: String,
}

/// Where the data files of the identity are. Passed in rather than read from
/// `trino_home()` so tests can create and open an identity in a scratch
/// directory. The `.json` files, `history.bin`, `ratchets.bin`,
/// `profiles.bin` and `stickers/` are those of earlier versions, which the
/// migration moves to `store/` at the first unlock (CL-1c).
#[derive(Clone)]
pub struct DataFiles {
    pub home: PathBuf,
    pub vault: PathBuf,
    pub config: PathBuf,
    pub friends: PathBuf,
    pub groups: PathBuf,
    pub group_invites: PathBuf,
    pub history: PathBuf,
    pub ratchets: PathBuf,
    pub profiles: PathBuf,
    pub stickers: PathBuf,
}

impl DataFiles {
    pub fn in_trino_home() -> Self {
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

    pub fn in_home(home: PathBuf) -> Self {
        DataFiles {
            vault: home.join("vault.bin"),
            config: home.join("config.json"),
            friends: home.join("friends.json"),
            groups: home.join("groups.json"),
            group_invites: home.join("group_invites.json"),
            history: home.join("history.bin"),
            ratchets: home.join("ratchets.bin"),
            profiles: home.join(crate::profile::PROFILES_FILE),
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
pub fn create_identity_files(
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
pub fn totp_hint(vault: &Path) -> Option<bool> {
    let bytes = std::fs::read(vault).ok()?;
    vault_requires_totp(&bytes).ok()
}

/// The name an identity gets: what the user typed, trimmed, or "anon" if
/// that leaves nothing.
pub fn display_handle(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() { "anon" } else { trimmed }.to_string()
}

/// The TOTP code typed at unlock, if any. An empty or blank field is no code,
/// so a vault with TOTP answers `totp_required`, not `invalid_totp`.
pub fn submitted_code(code: Option<&str>) -> Option<&str> {
    code.map(str::trim).filter(|code| !code.is_empty())
}

/// Create a new identity in `files`, its vault sealed with `passphrase` and,
/// if given, `totp_secret`, and its store (cifrado local): the account
/// never touches a `.json` file. Returns the identity and the vault's app
/// data, the key to the store. Nothing is written if an identity exists
/// there already or if the passphrase fails the policy.
pub fn create_account(
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
pub fn open_vault(
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
pub fn reseal_if_needed(
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
pub struct RelayStart {
    pub relays: Vec<String>,
    pub nostr_pub: String,
    pub handle: String,
    pub bridges: Option<Vec<trino_net::BridgeLine>>,
    /// The news' old `minSeq` from the store, for tor/seen.json.
    pub news_min_seq: Option<u64>,
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
pub async fn open_session(
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
        let (prefs, prefs_import) = crate::prefs::prefs_of(&inner);
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
    let (_, prefs_import) = crate::prefs::prefs_of(&inner);
    let handle = inner.handle.clone().unwrap_or_default();
    let relays = crate::state::relays_to_use(&inner.relay_urls);
    drop(inner);
    // The private bridges go to Tor, never to the frontend.
    let bridges = crate::bridges::stored_in(prefs.as_ref());
    let news_min_seq = crate::prefs::old_min_seq(prefs.as_ref());
    let prefs = crate::prefs::for_frontend(prefs);

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

/// This identity's public bundle as contacts get it: the keys, the name and,
/// if there is one, the photo.
pub fn own_bundle_json(
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

/// Where `forge_identity` takes the new vault's TOTP secret from.
pub enum NewVaultTotp {
    /// No TOTP: the passphrase alone opens the vault.
    Off,
    /// The secret from `totp_begin`, once `totp_verify` has confirmed it.
    Confirmed,
}

/// `forge`, once it knows whether the vault gets the confirmed TOTP secret.
/// The session it opens starts its relays through `start_relays` (the
/// host's `relay_starter`).
pub async fn forge_identity(
    state: &Engine,
    start_relays: impl FnOnce(RelayStart),
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
    let session = open_session(
        &state.inner,
        identity,
        totp_secret,
        Some(loaded),
        start_relays,
    )
    .await?;
    // Private bridges pasted before the account existed (the first run's
    // "Conexión" step) are sealed in it now (Tor design §2.5).
    if crate::bridges::keep_first_run_lines(&*state.inner.lock().await, &state.net).is_err() {
        crate::diag::note("the first run's bridges could not be sealed");
    }
    Ok(ForgeResponse {
        session,
        bundle_json,
    })
}

/// What `unlock_files` gives `open_session`: the identity, its TOTP secret,
/// and what was loaded for its session (nothing if it is open already).
pub type Unlocked = (Identity, Option<Zeroizing<Vec<u8>>>, Option<LoadedSession>);

/// What `unseal` does on disk, off the async runtime: open the vault in
/// `files` with `passphrase` and `code`; for an account of an earlier
/// version, whose vault carries no data key, move it into the store first
/// (CL-1c); load what the session needs; and seal the vault again if its
/// signed prekey is due. With `session_open` it only checks the passphrase
/// and the code, and loads nothing.
pub fn unlock_files(
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
        VaultKeys::New(keys) => migrate_account(files, &identity, keys, secret, passphrase, now)?
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
    add_findings(&mut loaded, findings);
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

/// What the unlock screen gets (`status`).
pub fn status(inner: &InnerState) -> StatusResponse {
    status_of(inner, &trino_home(), &vault_path())
}

/// `unseal`: open the vault with `passphrase` and, if it has TOTP,
/// `totp_code` (empty or blank counts as none), then open its session,
/// whose relays start through `start_relays`. If that session is open
/// already, this only checks the passphrase and the code again: no prekey
/// rotation, nothing loaded twice and no second set of relay connections.
pub async fn unseal(
    state: &Engine,
    start_relays: impl FnOnce(RelayStart),
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
    open_session(&state.inner, identity, totp_secret, loaded, start_relays).await
}

/// `share_bundle`: this identity's bundle as contacts get it.
pub fn share_bundle(inner: &InnerState) -> Result<String, String> {
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    own_bundle_json(
        identity,
        inner.handle.as_deref().unwrap_or_default(),
        inner.avatar.as_deref(),
    )
}

/// `wipe`, after the host cleared what it keeps outside the data folder:
/// the session dropped from memory, then every file of the account
/// destroyed, Tor's last (design §5.7).
pub async fn wipe(state: &Engine) -> Result<(), String> {
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
    let mut disk = RealWipe(Some(Arc::clone(&state.net)));
    let failures = wipe_home(&trino_home(), &mut disk);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "memory cleared, but some files could not be deleted: {}",
            failures.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    //! M4-0c: from the app's commands.rs.

    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::passphrase::MIN_PASSPHRASE_CHARS;
    use crate::session::tests::{friend, NOW};
    use crate::state::{ConfigFile, FriendsFile};
    use crate::totp::{generate_totp_secret, totp_now};
    use crate::vault::SealedVault;

    fn data_files_in(home: PathBuf) -> DataFiles {
        DataFiles::in_home(home)
    }

    /// Every data file is replaced through `fsutil::atomic_write`: a plain
    /// `std::fs::write` truncates the file first, so a crash halfway would
    /// leave it empty or half written.
    #[test]
    fn data_files_are_only_written_atomically() {
        // The code that wrote them in commands.rs is the engine's since
        // M4-0c: opening the account, and its store.
        let source: String = [include_str!("account.rs"), include_str!("storage.rs")]
            .concat()
            .split_whitespace()
            .collect();
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
        let loaded = load_session(&files, &identity, Some(&app), None).unwrap();
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
}
