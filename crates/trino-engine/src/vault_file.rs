//! `vault.bin` on disk (clave de emergencia CE-3, design §3.6, §3.7 and
//! §4): opening every version the app reads, the two-phase write every
//! seal goes through, what the shared block carries for the app, and the
//! vault the open session keeps to seal it again.
//!
//! - **Opening.** A version 3 vault (trino-core `vault_v3`) opens with
//!   `unseal_vault_v3`; one of version 1 or 2 with `unseal_vault`, and the
//!   unlock moves it to version 3 (`account::unlock_files`).
//! - **The two-phase write** (design §3.6). The new bytes go to
//!   `vault.bin.next` and onto the disk; then over `vault.bin` in place, the
//!   same file, and onto the disk; then `vault.bin.next` is destroyed. A
//!   rename would leave every older vault whole in the free space; written
//!   in place, the live file holds only the newest. If a cut tears
//!   `vault.bin`, the next opening finds that it does not open, opens
//!   `vault.bin.next` with the same passphrase, and finishes the write. A
//!   second phase that another program keeps from `vault.bin` is tried
//!   again, and then undone if `vault.bin` is untouched, so the answer is
//!   always what the next opening finds (`write_with`).
//!   Every seal of the vault goes through it: a new account, the rotation
//!   of the signed prekey, the settings, the migrations and the shared
//!   block, so the way the vault is written never tells one from another.
//! - **The shared block** (design §3.2 and §6.5) carries, besides the TOTP
//!   secret that trino-core keeps in it, the account's name, when it was
//!   created and its security settings (`SharedApp`): what an empty
//!   account made by the emergency key inherits (CE-4).
//! - **The session's vault** (`VaultCell`). The open session keeps its
//!   version 3 vault, as it keeps the store's data key, to seal the shared
//!   block again when the name or a security setting changes, without
//!   asking for the passphrase. The settings put the vault they seal in its
//!   place under the same lock, so no two seals undo each other.

use crate::command_error::{CommandError, ErrorCode};
use crate::identity::Identity;
use crate::session::dbg_log;
use crate::state::InnerState;
use crate::store::disk::{Disk, RealDisk};
use crate::store::session::StorageCell;
use crate::vault::{decode_vault, unseal_vault, vault_requires_totp, UnsealedVault, VaultError};
use crate::vault_v3::{
    unseal_vault_v3, vault_v3_requires_totp, vault_version, EmergencyVault, OpenVault, Unlocked,
    MAX_SHARED_APP_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use zeroize::Zeroizing;

/// Where the new bytes of a two-phase write wait: `vault.bin.next`.
pub fn next_path(vault: &Path) -> PathBuf {
    let mut name = vault.file_name().map(OsString::from).unwrap_or_default();
    name.push(".next");
    vault.with_file_name(name)
}

/// Phase 1 of the two-phase write: `bytes` to `vault.bin.next`, on the disk
/// when it returns. If it fails, `vault.bin` is as it was.
pub fn write_next(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    disk.write_durable(&next_path(vault), bytes)
}

/// Phases 2 and 3: `bytes` over `vault.bin` in place, on the disk when it
/// returns, then `vault.bin.next` destroyed. Once phase 1 is done the new
/// vault is committed: if this fails, or a cut tears `vault.bin`, the next
/// opening finishes it from `vault.bin.next`. A `vault.bin.next` that cannot
/// be destroyed now goes at the next opening.
pub fn finish(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    disk.overwrite_durable(vault, bytes)?;
    let _ = disk.destroy(&next_path(vault));
    Ok(())
}

/// Attempts at the second phase while another program holds `vault.bin`,
/// and the pause before the first retry, doubled after each one (150 ms in
/// all, as `fsutil` waits for a rename).
const FINISH_ATTEMPTS: u32 = 5;
const FIRST_FINISH_PAUSE: std::time::Duration = std::time::Duration::from_millis(10);

/// The two-phase write on `disk` (design §3.6).
///
/// What it answers is what the next opening finds (CE-3's open end). If the
/// second phase keeps failing (another program holds `vault.bin`), it is
/// tried a few times; then:
/// - `vault.bin` holds the new bytes after all: written;
/// - it is as it was: the write is undone (`vault.bin.next` destroyed) and
///   fails, so the vault of before is the one, and a passphrase the write
///   was changing does not open a copy left behind;
/// - it is torn, so nothing can bring it back: the new vault is the one,
///   the next opening finishes it from `vault.bin.next`, and the write
///   counts as done.
pub fn write_with(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    let before = disk.read(vault).ok();
    write_next(disk, vault, bytes)?;
    let mut pause = FIRST_FINISH_PAUSE;
    let mut attempt = 1;
    let error = loop {
        match finish(disk, vault, bytes) {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= FINISH_ATTEMPTS => break error,
            Err(_) => {
                std::thread::sleep(pause);
                pause *= 2;
                attempt += 1;
            }
        }
    };
    let now = disk.read(vault).ok();
    if now.as_deref() == Some(bytes) {
        let _ = disk.destroy(&next_path(vault));
        return Ok(());
    }
    if now == before {
        // Undone. If even that fails, the copy waits and the next opening
        // with the new vault's passphrase finishes it: the error stands.
        let _ = disk.destroy(&next_path(vault));
        return Err(error);
    }
    Ok(())
}

/// The two-phase write on the real disk: how every vault is written.
pub fn write(vault: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(&RealDisk, vault, bytes)
}

/// Open the vault at `vault` with `open`, finishing a two-phase write a cut
/// stopped (design §3.6 and §6.4):
///
/// - `vault.bin` opens: what waits in `vault.bin.next` is not needed, and
///   goes;
/// - it does not (a wrong passphrase, or a torn file) and `vault.bin.next`
///   opens with the same passphrase and code: the write is finished from
///   it, and that is the vault;
/// - neither: nothing is written, and the error is that of
///   `vault.bin.next` if it is whole and `vault.bin` may be torn (a wrong
///   passphrase, or the code), else that of `vault.bin`.
///
/// A vault that asks for its code, or refuses the one given, opened its
/// slot: it is whole, and `vault.bin.next` is not tried.
pub fn open_with<T>(
    disk: &impl Disk,
    vault: &Path,
    open: impl Fn(&[u8]) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let bytes = disk.read(vault).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => {
            CommandError::new(ErrorCode::NoVault, "there is no identity on this device")
        }
        _ => CommandError::io(&error),
    })?;
    let next = next_path(vault);
    let error = match open(&bytes) {
        Ok(opened) => {
            if next.exists() {
                let _ = disk.destroy(&next);
            }
            return Ok(opened);
        }
        Err(error) if asks_for_the_code(&error) => return Err(error),
        Err(error) => error,
    };
    let Ok(waiting) = disk.read(&next) else {
        return Err(error);
    };
    match open(&waiting) {
        Ok(opened) => {
            finish(disk, vault, &waiting).map_err(|e| CommandError::io(&e))?;
            Ok(opened)
        }
        // The vault that waits is whole, and `vault.bin` may be torn: its
        // answer is the one to give (the code, or a wrong passphrase).
        Err(next_error) if is_whole(&next_error) => Err(next_error),
        Err(_) => Err(error),
    }
}

fn asks_for_the_code(error: &CommandError) -> bool {
    matches!(error.code, ErrorCode::TotpRequired | ErrorCode::InvalidTotp)
}

/// An error only a whole vault gives: it read, and the passphrase or the
/// code did not open it.
fn is_whole(error: &CommandError) -> bool {
    asks_for_the_code(error) || error.code == ErrorCode::WrongPassphrase
}

/// Whether opening the vault at `vault` will ask for a TOTP code, from its
/// header alone, of any version: `None` with no vault, or one this version
/// cannot read. A `vault.bin` a cut tore answers from `vault.bin.next`.
pub fn totp_hint(vault: &Path) -> Option<bool> {
    let hint = |path: &Path| std::fs::read(path).ok().and_then(|bytes| hint_of(&bytes));
    if !vault.exists() {
        return None;
    }
    hint(vault).or_else(|| hint(&next_path(vault)))
}

fn hint_of(bytes: &[u8]) -> Option<bool> {
    match vault_version(bytes) {
        Ok(3) => vault_v3_requires_totp(bytes).ok(),
        _ => vault_requires_totp(bytes).ok(),
    }
}

/// A vault opened with its passphrase: one of version 1 or 2, which the
/// unlock moves to version 3, or one of version 3, which seals itself again.
pub enum OpenedVault {
    Old(Box<UnsealedVault>),
    V3(Box<OpenVault>),
}

impl OpenedVault {
    pub fn identity(&self) -> &Identity {
        match self {
            OpenedVault::Old(old) => &old.identity,
            OpenedVault::V3(vault) => vault.identity(),
        }
    }

    pub fn totp_secret(&self) -> Option<&[u8]> {
        match self {
            OpenedVault::Old(old) => old.totp_secret.as_deref(),
            OpenedVault::V3(vault) => vault.totp_secret(),
        }
    }

    pub fn app(&self) -> Option<&[u8]> {
        match self {
            OpenedVault::Old(old) => old.app.as_deref().map(Vec::as_slice),
            OpenedVault::V3(vault) => vault.app(),
        }
    }

    /// What it holds, as a vault of version 2 gives it.
    pub fn into_unsealed(self) -> UnsealedVault {
        match self {
            OpenedVault::Old(old) => *old,
            OpenedVault::V3(vault) => UnsealedVault {
                identity: vault.identity().clone(),
                totp_secret: vault.totp_secret().map(<[u8]>::to_vec),
                app: vault.app().map(|app| Zeroizing::new(app.to_vec())),
            },
        }
    }
}

/// What the passphrase typed at the unlock screen opened: the account's
/// vault, or, with the emergency key, a version 3 vault's emergency slot
/// (design §5 and §6).
pub enum Unsealed {
    Vault(OpenedVault),
    Emergency(Box<EmergencyVault>),
}

/// Open the vault in `bytes`, of any version, with `passphrase` and
/// `code`, as the unlock screen does. Both keys answer the same: the same
/// errors, in the same order, from the same checks (design §5.3).
pub fn unseal_bytes(
    bytes: &[u8],
    passphrase: &str,
    code: Option<&str>,
) -> Result<Unsealed, CommandError> {
    if vault_version(bytes).ok() == Some(3) {
        return Ok(match unseal_vault_v3(bytes, passphrase, code)? {
            Unlocked::Real(vault) => Unsealed::Vault(OpenedVault::V3(vault)),
            Unlocked::Emergency(vault) => Unsealed::Emergency(vault),
        });
    }
    let sealed = decode_vault(bytes)?;
    Ok(Unsealed::Vault(OpenedVault::Old(Box::new(unseal_vault(
        &sealed, passphrase, code,
    )?))))
}

/// Open the vault in `bytes`, of any version, with `passphrase` and
/// `code`, for the settings. The emergency key works only at the unlock
/// screen (design §10): here it is a wrong passphrase, with its very error.
pub fn open_bytes(
    bytes: &[u8],
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    match unseal_bytes(bytes, passphrase, code)? {
        Unsealed::Vault(vault) => Ok(vault),
        Unsealed::Emergency(_) => Err(VaultError::DecryptionFailed.into()),
    }
}

/// Open the vault at `vault` on the real disk as the unlock screen does
/// (`unseal_bytes`, `open_with`).
pub fn open_for_unlock(
    vault: &Path,
    passphrase: &str,
    code: Option<&str>,
) -> Result<Unsealed, CommandError> {
    open_with(&RealDisk, vault, |bytes| {
        unseal_bytes(bytes, passphrase, code)
    })
}

/// Open the vault at `vault` on the real disk (`open_with`).
pub fn open(
    vault: &Path,
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    open_with(&RealDisk, vault, |bytes| {
        open_bytes(bytes, passphrase, code)
    })
}

/// The security preferences of `prefs.bin`: those that keep the device
/// protected, so an empty account made by the emergency key is no less so.
/// The shared block keeps them first (`SharedApp::new`).
pub const SECURITY_PREFS: [&str; 5] = [
    "autolock",
    "trino.pref.lockWithSystem",
    "trino.pref.notifPreview",
    "trino.pref.reinforced",
    "trino.pref.reinforcedBefore",
];
/// The consent record of the Ley 1581 (the frontend's `consent.ts`).
pub const CONSENT_PREF: &str = "trino.consent";
/// The entry of the consent record that names the key of the account that
/// accepted: the shared block keeps the record without it.
const CONSENT_KEY_FIELD: &str = "publicKey";
const SHARED_FORMAT: u32 = 1;
/// A name longer than this is cut (at a character): no name of the app
/// comes near it.
pub const MAX_SHARED_NAME_BYTES: usize = 256;
/// A preference that takes more than this in the JSON, its key included,
/// is not kept, but for the bridges: none of them comes near it.
const MAX_SHARED_PREF_BYTES: usize = 512;
/// The relays the shared block keeps, at most, and the room they take.
pub const MAX_SHARED_RELAYS: usize = 8;
const SHARED_RELAYS_ROOM: usize = 1024;
/// The room of the preferences, the bridges apart: the five security ones
/// and the consent record always fit. And the room of the bridges. With the
/// name at its worst (every byte escaped) and the rest of the JSON, the
/// whole stays under `MAX_SHARED_APP_LEN` (a test checks it).
const SHARED_PREFS_ROOM: usize = 6 * MAX_SHARED_PREF_BYTES;
const SHARED_BRIDGES_ROOM: usize = 2048;

/// Whether the shared block keeps the preference `key` of `prefs.bin`
/// (design §6.5, RC-05 and RC-06): every one of the account's that names
/// no contact, group or sticker. The settings, the consent record, what
/// was read of the news, the private bridges and "No volver a preguntar"
/// before a link; not the notes, verified marks, timers or muted groups,
/// the recent stickers, the retired entries, nor the screen before
/// unlocking's, which the device keeps.
pub fn is_inherited(key: &str) -> bool {
    if key == CONSENT_PREF || crate::prefs::BACKEND_PREFS.contains(&key) {
        return true;
    }
    crate::prefs::is_general(key)
        && !key.starts_with("trino.pref.groupMuted:")
        && key != "sticker-recents"
        && !crate::prefs::RETIRED_PREFS.contains(&key)
}

/// The room `key` and `value` take in the JSON of the block.
fn json_len(key: &str, value: &str) -> usize {
    let quoted = |text: &str| serde_json::to_string(text).map_or(usize::MAX / 4, |s| s.len());
    quoted(key) + quoted(value) + 2
}

/// The consent record in `value` without the key it names; none if it is
/// not a record.
fn consent_without_key(value: &str) -> Option<String> {
    let mut record = serde_json::from_str::<serde_json::Value>(value).ok()?;
    record.as_object_mut()?.remove(CONSENT_KEY_FIELD);
    serde_json::to_string(&record).ok()
}

/// What the shared block carries for the app, as JSON: what an empty
/// account made by the emergency key inherits (design §6.5).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedApp {
    pub v: u32,
    pub name: String,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relays: Vec<String>,
    #[serde(default)]
    pub prefs: BTreeMap<String, String>,
    /// The warning to a trusted contact, once its contact accepted (CE-6,
    /// design §7.2 step 4): what the emergency path sends. Never who the
    /// contact is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alert: Option<crate::alert::SharedAlert>,
}

impl SharedApp {
    /// The shared block of an account named `name`, created at
    /// `created_at`, that uses `relays`, with the preferences among `prefs`
    /// it keeps (`is_inherited`).
    ///
    /// Everything has a room (the block holds 8 KiB, and the core pads it
    /// to that size whatever it carries): the name is cut, the relays and
    /// the bridges' lines are kept while they fit, and the preferences too,
    /// the security ones first, then the consent record, then the rest.
    pub fn new(
        name: &str,
        created_at: i64,
        prefs: &BTreeMap<String, String>,
        relays: &[String],
    ) -> Self {
        let mut end = name.len().min(MAX_SHARED_NAME_BYTES);
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        let mut kept_relays = Vec::new();
        let mut room = SHARED_RELAYS_ROOM;
        for relay in relays.iter().take(MAX_SHARED_RELAYS) {
            let len = json_len("", relay);
            if len > room {
                break;
            }
            room -= len;
            kept_relays.push(relay.clone());
        }

        let inherited = |key: &str| prefs.get(key).filter(|_| is_inherited(key));
        let first: Vec<&str> = SECURITY_PREFS.into_iter().chain([CONSENT_PREF]).collect();
        let rest = prefs
            .keys()
            .map(String::as_str)
            .filter(|key| !first.contains(key) && *key != crate::prefs::NET_BRIDGES);
        let order: Vec<&str> = first.iter().copied().chain(rest).collect();
        let mut kept = BTreeMap::new();
        let mut room = SHARED_PREFS_ROOM;
        for key in order {
            let Some(value) = inherited(key) else {
                continue;
            };
            let value = if key == CONSENT_PREF {
                match consent_without_key(value) {
                    Some(record) => record,
                    None => continue,
                }
            } else {
                value.clone()
            };
            let len = json_len(key, &value);
            if len > MAX_SHARED_PREF_BYTES || len > room {
                continue;
            }
            room -= len;
            kept.insert(key.to_string(), value);
        }
        if let Some(bridges) = inherited(crate::prefs::NET_BRIDGES) {
            let mut lines = String::new();
            for line in bridges.lines() {
                let more = if lines.is_empty() {
                    line.to_string()
                } else {
                    format!("{lines}\n{line}")
                };
                if json_len(crate::prefs::NET_BRIDGES, &more) > SHARED_BRIDGES_ROOM {
                    break;
                }
                lines = more;
            }
            if !lines.is_empty() {
                kept.insert(crate::prefs::NET_BRIDGES.to_string(), lines);
            }
        }

        SharedApp {
            v: SHARED_FORMAT,
            name: name[..end].to_string(),
            created_at,
            relays: kept_relays,
            prefs: kept,
            alert: None,
        }
    }

    /// The preferences of an account made from this block (step E2): the
    /// block's, with the consent record naming `nostr_pub`, the new
    /// account's key. It is the same person who accepted, so nothing asks
    /// again (RC-05), and the key of before is nowhere in the new account.
    pub fn prefs_for(&self, nostr_pub: &str) -> BTreeMap<String, String> {
        let mut prefs = self.prefs.clone();
        let record = prefs
            .get(CONSENT_PREF)
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok());
        match record {
            Some(serde_json::Value::Object(mut record)) => {
                record.insert(CONSENT_KEY_FIELD.to_string(), nostr_pub.into());
                let value = serde_json::Value::Object(record).to_string();
                prefs.insert(CONSENT_PREF.to_string(), value);
            }
            _ => {
                prefs.remove(CONSENT_PREF);
            }
        }
        prefs
    }

    /// The preferences of `prefs.bin` as the unlock reads them: the entries
    /// that are text.
    pub fn prefs_of(prefs: Option<&serde_json::Value>) -> BTreeMap<String, String> {
        prefs
            .and_then(serde_json::Value::as_object)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// This block with `alert`, the warning accepted (CE-6), which always
    /// finds its room: its relays and message are bounded
    /// (`contact_relays`, `clean_message`), and to make room the rest of
    /// the preferences yield first, the last ones first, then the last
    /// lines of the bridges. The security ones and the consent record stay.
    pub fn with_alert(mut self, alert: Option<crate::alert::SharedAlert>) -> Self {
        self.alert = alert
            .map(|alert| crate::alert::SharedAlert {
                relays: crate::alert::contact_relays(&alert.relays),
                msg: crate::alert::clean_message(&alert.msg),
                ..alert
            })
            .filter(|alert| !alert.relays.is_empty());
        let fixed: Vec<&str> = SECURITY_PREFS.into_iter().chain([CONSENT_PREF]).collect();
        let len = |block: &Self| serde_json::to_vec(block).map_or(usize::MAX, |bytes| bytes.len());
        while len(&self) > MAX_SHARED_APP_LEN {
            let rest = self
                .prefs
                .keys()
                .rev()
                .find(|key| !fixed.contains(&key.as_str()) && *key != crate::prefs::NET_BRIDGES)
                .cloned();
            if let Some(key) = rest {
                self.prefs.remove(&key);
                continue;
            }
            let Some(bridges) = self.prefs.get_mut(crate::prefs::NET_BRIDGES) else {
                break;
            };
            match bridges.rfind('\n') {
                Some(at) => bridges.truncate(at),
                None => {
                    self.prefs.remove(crate::prefs::NET_BRIDGES);
                }
            }
        }
        self
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let bytes = serde_json::to_vec(self).expect("the shared block always serializes");
        debug_assert!(bytes.len() <= MAX_SHARED_APP_LEN);
        bytes
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Self> {
        serde_json::from_slice(bytes).ok()
    }
}

/// The version 3 vault of the open session, and where it lives.
pub struct SessionVault {
    pub path: PathBuf,
    pub vault: Box<OpenVault>,
}

/// The session's `SessionVault`, or nothing while no session is open, or
/// while it opened from a vault of version 2 that could not move yet.
/// Clones share it, so a worker of the settings can put its vault in place.
#[derive(Clone, Default)]
pub struct VaultCell(Arc<Mutex<Option<SessionVault>>>);

impl VaultCell {
    /// Held by the settings for the whole of their seal, so the shared
    /// block is never sealed in between (`update_shared`).
    pub fn lock(&self) -> MutexGuard<'_, Option<SessionVault>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set(&self, vault: SessionVault) {
        *self.lock() = Some(vault);
    }

    /// Take it out, as a lock does: dropping it wipes the body key.
    pub fn take(&self) -> Option<SessionVault> {
        self.lock().take()
    }

    pub fn is_open(&self) -> bool {
        self.lock().is_some()
    }

    /// The shared block's app data the session's vault holds now.
    pub fn shared_app(&self) -> Option<Vec<u8>> {
        self.lock()
            .as_ref()
            .map(|session| session.vault.shared_app().to_vec())
    }

    /// Seal `shared` into the shared block of the session's vault and write
    /// it, noted in `storage`, unless that is what it holds. Whether it
    /// wrote. While the settings seal the vault this does nothing: their
    /// vault carries the shared block as the disk has it, and the next
    /// change, or the next unlock, brings it up to date.
    pub fn update_shared(
        &self,
        shared: &[u8],
        storage: &StorageCell,
    ) -> Result<bool, CommandError> {
        let mut guard = match self.0.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return Ok(false),
        };
        let Some(session) = guard.as_mut() else {
            return Ok(false);
        };
        if session.vault.shared_app() == shared {
            return Ok(false);
        }
        let before = session.vault.shared_app().to_vec();
        session.vault.set_shared_app(shared)?;
        let spk = session.vault.identity().signed_prekey.id;
        if let Err(error) =
            crate::storage::write_vault_noted_in(storage, &session.path, session.vault.bytes(), spk)
        {
            // As the disk has it, so the next change tries again.
            let _ = session.vault.set_shared_app(&before);
            return Err(CommandError::io(&error));
        }
        Ok(true)
    }
}

/// Bring the shared block of the session's vault up to date with the
/// session's name, preferences, relays and warning accepted, after any
/// changed (design §3.5). Best effort: the next unlock does it again.
pub fn sync_shared(inner: &InnerState) {
    if !inner.vault.is_open() {
        return;
    }
    let Some(name) = inner.handle.as_deref() else {
        return;
    };
    let prefs = crate::prefs::current_map(inner);
    let shared = SharedApp::new(name, inner.created_at, &prefs, &inner.relay_urls)
        .with_alert(inner.alerts.shared())
        .to_bytes();
    if inner.vault.update_shared(&shared, &inner.storage).is_err() {
        dbg_log("the vault's shared block could not be sealed again");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::disk::cut::{CutDisk, Step};
    use std::io::{Read, Seek};

    const NEW: &[u8] = b"the vault as sealed now";
    const OLD: &[u8] = b"the vault as it was sealed before, longer";

    /// Opens `b"<passphrase>|..."` only with that passphrase: a stand-in
    /// for a vault, so these tests derive no key.
    fn opener(passphrase: &'static str) -> impl Fn(&[u8]) -> Result<Vec<u8>, CommandError> {
        move |bytes| {
            if bytes.starts_with(passphrase.as_bytes()) {
                Ok(bytes.to_vec())
            } else {
                Err(VaultError::DecryptionFailed.into())
            }
        }
    }

    /// Design §12.2, test 19: through `vault.bin.next`, then over the same
    /// file, then the copy destroyed.
    #[test]
    fn a_vault_write_goes_through_next_and_overwrites_in_place() {
        let scratch = ScratchDir::new("vault-two-phase");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, OLD).unwrap();
        let mut held = std::fs::File::open(&vault).unwrap();
        let disk = CutDisk::whole();

        write_with(&disk, &vault, NEW).unwrap();

        assert_eq!(
            *disk.steps.borrow(),
            [
                Step::WriteDurable(next_path(&vault)),
                Step::Overwrite(vault.clone()),
                Step::Destroy(next_path(&vault)),
            ]
        );
        assert_eq!(std::fs::read(&vault).unwrap(), NEW);
        assert!(!next_path(&vault).exists());
        // The same file: a handle opened before reads the new bytes, which
        // a rename over it would have left in another file.
        let mut through_handle = Vec::new();
        held.rewind().unwrap();
        held.read_to_end(&mut through_handle).unwrap();
        assert_eq!(through_handle, NEW);
    }

    /// A disk whose overwrite of `vault.bin` fails `fails` times, then
    /// works. With `tears`, each failure writes the first half of the new
    /// bytes before it fails, as a cut halfway would.
    struct HeldVault {
        fails: std::cell::Cell<usize>,
        tears: bool,
    }

    impl HeldVault {
        fn failing(fails: usize, tears: bool) -> Self {
            HeldVault {
                fails: std::cell::Cell::new(fails),
                tears,
            }
        }
    }

    impl Disk for HeldVault {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            RealDisk.read(path)
        }
        fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            RealDisk.write(path, bytes)
        }
        fn remove(&self, path: &Path) -> io::Result<()> {
            RealDisk.remove(path)
        }
        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            RealDisk.rename(from, to)
        }
        fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
            RealDisk.list(dir)
        }
        fn write_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            RealDisk.write_durable(path, bytes)
        }
        fn rename_durable(&self, from: &Path, to: &Path) -> io::Result<()> {
            RealDisk.rename_durable(from, to)
        }
        fn overwrite_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            if self.fails.get() == 0 {
                return RealDisk.overwrite_durable(path, bytes);
            }
            self.fails.set(self.fails.get() - 1);
            if self.tears {
                let mut torn = std::fs::read(path)?;
                let half = bytes.len().min(torn.len()) / 2;
                torn[..half].copy_from_slice(&bytes[..half]);
                std::fs::write(path, torn)?;
            }
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "vault.bin is held by another program",
            ))
        }
        fn destroy(&self, path: &Path) -> io::Result<()> {
            RealDisk.destroy(path)
        }
        fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
            RealDisk.remove_dir_all(dir)
        }
    }

    /// CE-3's open end: another program holding `vault.bin` for a moment
    /// does not fail the write; the second phase is tried again.
    #[test]
    fn a_second_phase_held_for_a_moment_is_tried_again() {
        let scratch = ScratchDir::new("vault-held-moment");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, OLD).unwrap();

        write_with(&HeldVault::failing(2, false), &vault, NEW).unwrap();

        assert_eq!(std::fs::read(&vault).unwrap(), NEW);
        assert!(!next_path(&vault).exists());
    }

    /// CE-3's open end: a second phase that keeps failing with `vault.bin`
    /// untouched is undone. The error the settings show is then the truth:
    /// the next opening finds the vault of before, and nothing waiting in
    /// `vault.bin.next` that the new passphrase would open.
    #[test]
    fn a_second_phase_that_keeps_failing_is_undone_while_the_vault_is_untouched() {
        let scratch = ScratchDir::new("vault-held-long");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"old|the vault of before").unwrap();

        let error = write_with(&HeldVault::failing(usize::MAX, false), &vault, b"new|x");

        assert!(error.is_err());
        assert_eq!(std::fs::read(&vault).unwrap(), b"old|the vault of before");
        assert!(!next_path(&vault).exists(), "the new vault still waits");
        let refused = open_with(&RealDisk, &vault, opener("new")).unwrap_err();
        assert_eq!(refused.code, ErrorCode::WrongPassphrase);
        assert!(open_with(&RealDisk, &vault, opener("old")).is_ok());
    }

    /// A second phase that fails after it tore `vault.bin` cannot be
    /// undone: the new vault is the one, and the write says so. The next
    /// opening finishes it from `vault.bin.next`.
    #[test]
    fn a_second_phase_that_tore_the_vault_counts_as_written() {
        let scratch = ScratchDir::new("vault-held-torn");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"old|the vault of before").unwrap();
        let new = b"new|the vault of now, as long".to_vec();

        // Only the whole vault opens: a torn one opens with nothing.
        let exact = |whole: Vec<u8>| {
            move |bytes: &[u8]| -> Result<Vec<u8>, CommandError> {
                if bytes == whole {
                    Ok(bytes.to_vec())
                } else {
                    Err(VaultError::DecryptionFailed.into())
                }
            }
        };

        write_with(&HeldVault::failing(usize::MAX, true), &vault, &new).unwrap();

        assert_eq!(std::fs::read(next_path(&vault)).unwrap(), new);
        let old = b"old|the vault of before".to_vec();
        let refused = open_with(&RealDisk, &vault, exact(old)).unwrap_err();
        assert_eq!(refused.code, ErrorCode::WrongPassphrase);
        assert_eq!(
            open_with(&RealDisk, &vault, exact(new.clone())).unwrap(),
            new
        );
        assert_eq!(std::fs::read(&vault).unwrap(), new);
        assert!(!next_path(&vault).exists());
    }

    #[test]
    fn the_real_disk_writes_a_new_vault_too() {
        let scratch = ScratchDir::new("vault-two-phase-new");
        let vault = scratch.path().join("vault.bin");
        write(&vault, NEW).unwrap();
        assert_eq!(std::fs::read(&vault).unwrap(), NEW);
        write(&vault, OLD).unwrap();
        write(&vault, NEW).unwrap();
        assert_eq!(std::fs::read(&vault).unwrap(), NEW, "the older tail stayed");
        assert!(!next_path(&vault).exists());
    }

    /// A cut before the copy is on the disk leaves `vault.bin` as it was.
    #[test]
    fn a_cut_in_the_first_phase_leaves_the_vault_as_it_was() {
        let scratch = ScratchDir::new("vault-two-phase-cut");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, OLD).unwrap();
        for at in 0..2 {
            let disk = CutDisk::cut_at(at);
            assert!(write_with(&disk, &vault, NEW).is_err());
            assert_eq!(std::fs::read(&vault).unwrap(), OLD, "cut at {at}");
        }
    }

    /// Design §12.2, test 20.
    #[test]
    fn a_torn_vault_with_a_valid_next_is_finished_at_open() {
        let scratch = ScratchDir::new("vault-torn");
        let vault = scratch.path().join("vault.bin");
        let whole = b"pass|the new vault".to_vec();
        std::fs::write(next_path(&vault), &whole).unwrap();
        let mut torn = whole.clone();
        torn[..4].copy_from_slice(b"\0\0\0\0");
        std::fs::write(&vault, &torn).unwrap();

        // Another passphrase opens neither: nothing is written.
        let error = open_with(&RealDisk, &vault, opener("nope")).unwrap_err();
        assert_eq!(error.code, ErrorCode::WrongPassphrase);
        assert_eq!(std::fs::read(&vault).unwrap(), torn);
        assert!(next_path(&vault).exists());

        let opened = open_with(&RealDisk, &vault, opener("pass")).unwrap();
        assert_eq!(opened, whole);
        assert_eq!(std::fs::read(&vault).unwrap(), whole);
        assert!(!next_path(&vault).exists());
    }

    /// A copy left by a cut after `vault.bin` was written goes once it opens.
    #[test]
    fn a_next_left_over_goes_once_the_vault_opens() {
        let scratch = ScratchDir::new("vault-next-left");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"pass|the vault").unwrap();
        std::fs::write(next_path(&vault), b"pass|the vault").unwrap();

        assert!(open_with(&RealDisk, &vault, opener("nope")).is_err());
        assert!(next_path(&vault).exists(), "a failed unlock wrote");
        open_with(&RealDisk, &vault, opener("pass")).unwrap();
        assert!(!next_path(&vault).exists());
        assert_eq!(std::fs::read(&vault).unwrap(), b"pass|the vault");
    }

    /// A torn vault whose copy asks for its code: the code is asked for,
    /// never "wrong passphrase", and nothing is written until it is given.
    #[test]
    fn a_torn_vault_whose_copy_asks_for_the_code_asks_for_it() {
        let scratch = ScratchDir::new("vault-torn-totp");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"torn").unwrap();
        std::fs::write(next_path(&vault), b"pass|with totp").unwrap();
        let asks = |bytes: &[u8]| -> Result<(), CommandError> {
            if bytes.starts_with(b"pass") {
                Err(VaultError::TotpRequired.into())
            } else {
                Err(VaultError::DecryptionFailed.into())
            }
        };
        let error = open_with(&RealDisk, &vault, asks).unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        assert_eq!(std::fs::read(&vault).unwrap(), b"torn");
    }

    #[test]
    fn opening_tells_a_missing_vault() {
        let scratch = ScratchDir::new("vault-missing");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(next_path(&vault), b"pass|a copy alone").unwrap();
        let error = open_with(&RealDisk, &vault, opener("pass")).unwrap_err();
        assert_eq!(error.code, ErrorCode::NoVault);
        assert_eq!(totp_hint(&vault), None);
    }

    fn map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn consent(public_key: &str) -> String {
        serde_json::json!({
            "format": 1,
            "acceptedAt": "2026-10-12T15:00:00.000Z",
            "publicKey": public_key,
            "lang": "es",
            "age": { "minimum": 18, "version": 1 },
            "privacyPolicy": { "version": 1, "url": "https://trinochat.org/privacidad/" },
        })
        .to_string()
    }

    fn relays(urls: &[&str]) -> Vec<String> {
        urls.iter().map(|url| url.to_string()).collect()
    }

    /// Design §6.5, RC-04, RC-05 and RC-06: the shared block keeps the
    /// name, the date, the relays and every preference of the account that
    /// names no contact, group or sticker: the security settings, the
    /// consent record (without the key it names), what was read of the
    /// news, the other settings and the private bridges.
    #[test]
    fn the_shared_block_keeps_what_names_nobody() {
        let old_key = "ab".repeat(32);
        let prefs = map(&[
            ("autolock", "15"),
            ("trino.pref.reinforced", "1"),
            ("trino.pref.reinforcedBefore", r#"{"autolock":"5"}"#),
            ("trino.pref.lockWithSystem", "1"),
            ("trino.pref.notifPreview", "none"),
            ("trino.pref.ringtone", "soft"),
            ("trino.pref.callsSeenAt", "1760000000"),
            ("updates.lastRead", "2026-10-01"),
            ("updates.muted", "1"),
            ("trino.consent", &consent(&old_key)),
            ("net.bridges", "obfs4 192.0.2.1:443 cert=x iat-mode=0"),
            ("net.linksNoAsk", "1"),
            // A contact's, a group's, the stickers', a retired one.
            ("note:bob", "a note about bob"),
            ("verified:bob", "call:ab12"),
            ("ttl:bob", "30"),
            ("ttl:grp:g1", "60"),
            ("trino.pref.groupMuted:g1", "1"),
            ("sticker-recents", r#"["s1"]"#),
            ("trino:announcements:minSeq", "7"),
            // The screen before unlocking's: the device keeps them.
            ("trino.pref.scanLines", "0"),
            ("trino.pref.textSize", "large"),
            ("trino.pref.blockCaptures", "1"),
        ]);
        let urls = relays(&["wss://mio.example", "wss://otro.example"]);

        let shared = SharedApp::new("Ana", 1_760_000_000, &prefs, &urls);

        assert_eq!(shared.name, "Ana");
        assert_eq!(shared.created_at, 1_760_000_000);
        assert_eq!(shared.relays, urls);
        assert_eq!(
            shared.prefs.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "autolock",
                "net.bridges",
                "net.linksNoAsk",
                "trino.consent",
                "trino.pref.callsSeenAt",
                "trino.pref.lockWithSystem",
                "trino.pref.notifPreview",
                "trino.pref.reinforced",
                "trino.pref.reinforcedBefore",
                "trino.pref.ringtone",
                "updates.lastRead",
                "updates.muted",
            ]
        );
        let bytes = shared.to_bytes();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("bob") && !text.contains("g1") && !text.contains("s1"));
        // The consent record without the key of the account that accepted:
        // whoever opens the block with the emergency key does not learn it.
        assert!(!text.contains(&old_key), "{text}");
        assert!(shared.prefs["trino.consent"].contains("acceptedAt"));
        assert_eq!(SharedApp::from_bytes(&bytes), Some(shared));
    }

    /// E2: the empty account's preferences are the block's, with the
    /// consent record naming the new account's key, as if it had accepted
    /// (RC-05): it is the same person, and nothing asks again.
    #[test]
    fn the_consent_goes_back_with_the_new_accounts_key() {
        let prefs = map(&[
            ("autolock", "15"),
            ("trino.consent", &consent(&"ab".repeat(32))),
        ]);
        let shared = SharedApp::new("Ana", 1, &prefs, &[]);
        let new_key = "cd".repeat(32);

        let inherited = shared.prefs_for(&new_key);

        assert_eq!(inherited["autolock"], "15");
        let record: serde_json::Value = serde_json::from_str(&inherited["trino.consent"]).unwrap();
        let expected: serde_json::Value = serde_json::from_str(&consent(&new_key)).unwrap();
        assert_eq!(record, expected);
        // What the empty account keeps gives back the same block.
        assert_eq!(SharedApp::new("Ana", 1, &inherited, &[]), shared);
        // A record that is not one is not kept.
        let odd = SharedApp::new("Ana", 1, &map(&[("trino.consent", "not json")]), &[]);
        assert!(odd.prefs.is_empty());
    }

    /// The worst a name, the relays, the preferences and the bridges can be
    /// still fits the shared block, the security settings and the consent
    /// first; what finds no room is left out.
    #[test]
    fn a_long_name_relays_prefs_or_bridges_still_fit_the_shared_block() {
        // Control characters: six bytes each in JSON.
        let name = "\u{1}".repeat(400);
        let mut prefs = BTreeMap::new();
        for key in SECURITY_PREFS {
            // Escaped, nearly the most a preference may take.
            prefs.insert(key.to_string(), "\"".repeat(MAX_SHARED_PREF_BYTES / 2 - 30));
        }
        prefs.insert("trino.consent".into(), consent(&"ab".repeat(32)));
        for i in 0..200 {
            prefs.insert(format!("trino.pref.x{i:03}"), "\"".repeat(100));
        }
        prefs.insert("autolock".into(), "y".repeat(MAX_SHARED_PREF_BYTES + 1));
        prefs.insert(
            "net.bridges".into(),
            "obfs4 192.0.2.1:443 cert=xx\n".repeat(200),
        );
        let urls: Vec<String> = (0..50)
            .map(|i| format!("wss://{}{i}.example", "r".repeat(200)))
            .collect();

        let shared = SharedApp::new(&name, 0, &prefs, &urls);

        assert!(shared.name.len() <= MAX_SHARED_NAME_BYTES);
        assert!(name.starts_with(&shared.name));
        assert!(!shared.relays.is_empty());
        assert!(shared.relays.len() <= MAX_SHARED_RELAYS);
        assert!(!shared.prefs.contains_key("autolock"), "over its limit");
        for key in &SECURITY_PREFS[1..] {
            assert!(shared.prefs.contains_key(*key), "{key}");
        }
        assert!(shared.prefs.contains_key("trino.consent"));
        let bridges = &shared.prefs["net.bridges"];
        assert!(!bridges.is_empty());
        assert!(bridges
            .lines()
            .all(|line| line == "obfs4 192.0.2.1:443 cert=xx"));
        assert!(shared.to_bytes().len() <= MAX_SHARED_APP_LEN);
    }

    fn alert(message: &str, relays: usize) -> crate::alert::SharedAlert {
        crate::alert::SharedAlert {
            k: "ab".repeat(32),
            id: "cd".repeat(16),
            relays: (0..relays)
                .map(|i| format!("wss://{}{i}.example", "r".repeat(80)))
                .collect(),
            msg: message.into(),
        }
    }

    /// CE-6 (design §7.2 step 4): the warning accepted rides in the block,
    /// whole, even when everything else is at its worst; what yields is
    /// the rest of the preferences, then the last bridge lines.
    #[test]
    fn the_warning_always_fits_the_shared_block() {
        let name = "\u{1}".repeat(400);
        let mut prefs = BTreeMap::new();
        for key in SECURITY_PREFS {
            prefs.insert(key.to_string(), "\"".repeat(MAX_SHARED_PREF_BYTES / 2 - 30));
        }
        prefs.insert("trino.consent".into(), consent(&"ab".repeat(32)));
        for i in 0..200 {
            prefs.insert(format!("trino.pref.x{i:03}"), "\"".repeat(100));
        }
        prefs.insert(
            "net.bridges".into(),
            "obfs4 192.0.2.1:443 cert=xx\n".repeat(200),
        );
        let urls: Vec<String> = (0..50)
            .map(|i| format!("wss://{}{i}.example", "r".repeat(200)))
            .collect();
        let warning = alert(&"\"🙂".repeat(140), 5);

        let shared = SharedApp::new(&name, 0, &prefs, &urls).with_alert(Some(warning.clone()));

        let bytes = shared.to_bytes();
        assert!(bytes.len() <= MAX_SHARED_APP_LEN, "{}", bytes.len());
        let back = SharedApp::from_bytes(&bytes).unwrap();
        let kept = back.alert.clone().unwrap();
        assert_eq!(kept.k, warning.k);
        assert_eq!(kept.msg, warning.msg);
        assert!(!kept.relays.is_empty());
        for key in &SECURITY_PREFS[..] {
            assert!(back.prefs.contains_key(*key), "{key}");
        }
        assert!(back.prefs.contains_key("trino.consent"));
        assert!(back.prefs.contains_key("net.bridges"), "some bridges stay");

        // With room, nothing yields; without the warning, there is none.
        let small = SharedApp::new("Ana", 1, &map(&[("autolock", "5")]), &[]);
        let with = small.clone().with_alert(Some(alert("hola", 1)));
        assert_eq!(with.prefs, small.prefs);
        assert_eq!(with.alert, Some(alert("hola", 1)));
        assert_eq!(small.clone().with_alert(None), small);
        assert!(!String::from_utf8(small.to_bytes())
            .unwrap()
            .contains("alert"));
    }

    /// The session puts the warning in the block once its contact accepts,
    /// and takes it out with "Ninguna" (`sync_shared`).
    #[test]
    fn the_session_seals_the_warning_into_the_block_and_out_of_it() {
        use crate::alert::{AlertState, OwnAlert};
        let scratch = ScratchDir::new("vault-alert");
        let path = scratch.path().join("vault.bin");
        let mut inner = InnerState {
            handle: Some("Ana".into()),
            created_at: 1,
            ..InnerState::default()
        };
        inner.vault.set(session_vault(&path));
        let block =
            |inner: &InnerState| SharedApp::from_bytes(&inner.vault.shared_app().unwrap()).unwrap();

        inner.alerts.mine = Some(OwnAlert {
            contact: "bb".repeat(32),
            id: "cd".repeat(16),
            key: "ab".repeat(32),
            state: AlertState::Waiting,
            relays: vec![],
            message: "hola".into(),
        });
        sync_shared(&inner);
        assert_eq!(block(&inner).alert, None, "not before it is accepted");

        let mine = inner.alerts.mine.as_mut().unwrap();
        mine.state = AlertState::Accepted;
        mine.relays = vec!["wss://bob.example".into()];
        sync_shared(&inner);
        let sealed = block(&inner).alert.unwrap();
        assert_eq!(sealed.relays, ["wss://bob.example"]);
        assert_eq!(sealed.msg, "hola");
        // On the disk too.
        let on_disk = std::fs::read(&path).unwrap();
        assert_eq!(
            inner.vault.lock().as_ref().unwrap().vault.bytes(),
            &on_disk[..]
        );
        // Never who the contact is.
        let text = String::from_utf8(inner.vault.shared_app().unwrap()).unwrap();
        assert!(!text.contains(&"bb".repeat(32)), "{text}");

        inner.alerts.clear();
        sync_shared(&inner);
        assert_eq!(block(&inner).alert, None);
    }

    fn session_vault(path: &Path) -> SessionVault {
        let identity = crate::identity::create_identity();
        let vault = crate::vault_v3::create_vault_v3(
            &crate::vault_v3::NewAccount {
                identity: &identity,
                app: Some(b"the key to the store"),
                shared_app: b"{}",
                id_vault: [1; 16],
            },
            None,
            "pass",
        )
        .unwrap();
        SessionVault {
            path: path.to_path_buf(),
            vault: Box::new(vault),
        }
    }

    /// The settings hold the session's vault while they seal it: the shared
    /// block waits, so neither seal undoes the other; then it goes out.
    #[test]
    fn the_shared_block_waits_while_the_settings_hold_the_vault() {
        let scratch = ScratchDir::new("vault-cell");
        let path = scratch.path().join("vault.bin");
        let cell = VaultCell::default();
        let storage = StorageCell::default();
        assert!(
            !cell.update_shared(b"{\"v\":1}", &storage).unwrap(),
            "no session"
        );
        cell.set(session_vault(&path));

        let held = cell.lock();
        assert!(!cell.update_shared(b"{\"v\":1}", &storage).unwrap());
        assert!(!path.exists());
        drop(held);

        assert!(cell.update_shared(b"{\"v\":1}", &storage).unwrap());
        assert_eq!(cell.shared_app().unwrap(), b"{\"v\":1}");
        let written = std::fs::read(&path).unwrap();
        assert_eq!(cell.lock().as_ref().unwrap().vault.bytes(), &written[..]);
        assert!(
            !cell.update_shared(b"{\"v\":1}", &storage).unwrap(),
            "unchanged"
        );
        assert!(cell.take().is_some());
        assert!(!cell.is_open());
    }
}
