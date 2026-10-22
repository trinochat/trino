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
//!   `vault.bin.next` with the same passphrase, and finishes the write.
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
    unseal_vault_v3, vault_v3_requires_totp, vault_version, OpenVault, Unlocked, MAX_SHARED_APP_LEN,
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

/// The two-phase write on `disk` (design §3.6).
pub fn write_with(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    write_next(disk, vault, bytes)?;
    finish(disk, vault, bytes)
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

/// Open the vault in `bytes`, of any version, with `passphrase` and
/// `code`.
///
/// The emergency key (CE-4) is not handled yet: nothing in this version
/// can set one, and a vault that answers to one answers as a wrong
/// passphrase, with its very error.
pub fn open_bytes(
    bytes: &[u8],
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    if vault_version(bytes).ok() == Some(3) {
        return match unseal_vault_v3(bytes, passphrase, code)? {
            Unlocked::Real(vault) => Ok(OpenedVault::V3(vault)),
            Unlocked::Emergency(_) => Err(VaultError::DecryptionFailed.into()),
        };
    }
    let sealed = decode_vault(bytes)?;
    Ok(OpenedVault::Old(Box::new(unseal_vault(
        &sealed, passphrase, code,
    )?)))
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

/// The preferences of `prefs.bin` that the shared block keeps (design §6.5):
/// those that keep the device protected, so an empty account made by the
/// emergency key is no less so, and nothing changes in sight. Relays,
/// consent, the other preferences and the private bridges come with the
/// emergency path (CE-4).
pub const SECURITY_PREFS: [&str; 5] = [
    "autolock",
    "trino.pref.lockWithSystem",
    "trino.pref.notifPreview",
    "trino.pref.reinforced",
    "trino.pref.reinforcedBefore",
];
const SHARED_FORMAT: u32 = 1;
/// A name longer than this is cut (at a character): no name of the app
/// comes near it.
pub const MAX_SHARED_NAME_BYTES: usize = 256;
/// A security preference longer than this is not kept: none of them comes
/// near it.
const MAX_SHARED_PREF_BYTES: usize = 512;

/// What the shared block carries for the app, as JSON.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedApp {
    pub v: u32,
    pub name: String,
    pub created_at: i64,
    #[serde(default)]
    pub prefs: BTreeMap<String, String>,
}

impl SharedApp {
    /// The shared block of an account named `name`, created at
    /// `created_at`, with the security preferences among `prefs`.
    pub fn new(name: &str, created_at: i64, prefs: &BTreeMap<String, String>) -> Self {
        let mut end = name.len().min(MAX_SHARED_NAME_BYTES);
        while !name.is_char_boundary(end) {
            end -= 1;
        }
        SharedApp {
            v: SHARED_FORMAT,
            name: name[..end].to_string(),
            created_at,
            prefs: prefs
                .iter()
                .filter(|(key, value)| {
                    SECURITY_PREFS.contains(&key.as_str()) && value.len() <= MAX_SHARED_PREF_BYTES
                })
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        }
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
/// session's name and security preferences, after either changed (design
/// §3.5). Best effort: the next unlock does it again.
pub fn sync_shared(inner: &InnerState) {
    if !inner.vault.is_open() {
        return;
    }
    let Some(name) = inner.handle.as_deref() else {
        return;
    };
    let prefs = crate::prefs::current_map(inner);
    let shared = SharedApp::new(name, inner.created_at, &prefs).to_bytes();
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

    #[test]
    fn the_shared_block_keeps_the_name_the_date_and_only_the_security_prefs() {
        let prefs: BTreeMap<String, String> = [
            ("autolock", "15"),
            ("trino.pref.reinforced", "1"),
            ("trino.pref.lockWithSystem", "1"),
            ("trino.pref.notifPreview", "hidden"),
            ("note:bob", "a note about bob"),
            ("verified:bob", "call:ab12"),
            ("net.bridges", "obfs4 192.0.2.1:443"),
            ("trino.pref.ringtone", "classic"),
        ]
        .into_iter()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();

        let shared = SharedApp::new("Ana", 1_760_000_000, &prefs);

        assert_eq!(shared.name, "Ana");
        assert_eq!(shared.created_at, 1_760_000_000);
        assert_eq!(
            shared.prefs.keys().map(String::as_str).collect::<Vec<_>>(),
            [
                "autolock",
                "trino.pref.lockWithSystem",
                "trino.pref.notifPreview",
                "trino.pref.reinforced"
            ]
        );
        let bytes = shared.to_bytes();
        assert!(!String::from_utf8_lossy(&bytes).contains("bob"));
        assert_eq!(SharedApp::from_bytes(&bytes), Some(shared));
    }

    #[test]
    fn a_long_name_or_preference_still_fits_the_shared_block() {
        let name = "ñ".repeat(400);
        let mut prefs = BTreeMap::new();
        for key in SECURITY_PREFS {
            prefs.insert(key.to_string(), "x".repeat(MAX_SHARED_PREF_BYTES));
        }
        prefs.insert("autolock".into(), "y".repeat(MAX_SHARED_PREF_BYTES + 1));
        let shared = SharedApp::new(&name, 0, &prefs);
        assert!(shared.name.len() <= MAX_SHARED_NAME_BYTES);
        assert!(name.starts_with(&shared.name));
        assert!(!shared.prefs.contains_key("autolock"));
        assert!(shared.to_bytes().len() <= MAX_SHARED_APP_LEN);
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
