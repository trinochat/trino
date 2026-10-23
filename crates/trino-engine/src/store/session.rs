//! The store, wired to the open session (cifrado local CL-1b, design §12.3
//! and §13).
//!
//! An open session keeps its data in one of two places:
//!
//! - **`Storage::Store`**: `~/.trino/store/`, sealed under the data key the
//!   vault carries (`keys.rs`). Every account created from this version on,
//!   and every older one once the migration (CL-1c) moved it.
//! - **`Storage::Legacy`**: the files of earlier versions, for an account
//!   whose vault carries no data key yet: `config.json`, `friends.json`,
//!   `groups.json` and `group_invites.json` in clear, and `history.bin`,
//!   `ratchets.bin` and `profiles.bin` under keys derived from the identity.
//!   Unlocking moves such an account into the store first; only a migration
//!   that stopped before its commit leaves a session working on them, as
//!   earlier versions did, until the next unlock tries again.
//!
//! `StorageCell` holds it inside `InnerState` behind a lock of its own:
//! saving changes nothing the session shows, so it needs only `&InnerState`.
//! With no session it holds nothing, and nothing is written.
//!
//! What the store keeps (design §4.1):
//! - `account`: your profile (name, photo, relays, date), contacts, blocked
//!   contacts, groups and invitations, in one file, so a change to several of
//!   them is one write and a cut never leaves them half done;
//! - `prefs`: the account's preferences, which the unlock answer carries
//!   (`prefs_cmds`, CL-2a);
//! - `history`, `sessions` and `profiles`, as before but under the data key;
//! - one file per sticker, named by a keyed hash of the image, holding the
//!   sticker's id, its type and the image.

use super::disk::{Disk, RealDisk};
use super::envelope::Slot;
use super::files::{Store, StoreError};
use super::index::VaultHeader;
use super::keys::StoreKeys;
use super::report::{Action, Finding, IntegrityReport, What};
use crate::fsutil;
use crate::group::GroupRoster;
use crate::state::{ConfigFile, FriendRecord, FriendsFile, GroupInvite};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use zeroize::Zeroizing;

/// The store's folder in the data directory.
pub const STORE_DIR: &str = "store";
/// A store that belongs to another account is moved next to `store/`, under
/// this prefix, and never removed by itself (design §5.6).
pub const OTHER_STORE_PREFIX: &str = "store-aside-";

/// Why an account the migration has not moved yet keeps no preferences in
/// the store.
pub const NOT_MOVED: &str = "this account's data has not moved to the store yet";

/// What `account.bin` holds.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFile {
    pub handle: String,
    pub nostr_pub: String,
    pub relays: Vec<String>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default)]
    pub friends: Vec<FriendRecord>,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub groups: Vec<GroupRoster>,
    #[serde(default)]
    pub group_invites: Vec<GroupInvite>,
    /// The warning to a trusted contact, both sides (CE-6). Left out when
    /// there is none, as in every account from before.
    #[serde(default, skip_serializing_if = "crate::alert::AlertBook::is_empty")]
    pub alerts: crate::alert::AlertBook,
}

/// What a sticker's file holds. Its id is the start of the image's SHA-256,
/// as before: messages carry it (`sticker::<id>.<ext>`) and the recent
/// stickers list it, so only its name on disk changes (design §3.1).
#[derive(Clone, Serialize, Deserialize)]
pub struct StickerFile {
    pub id: String,
    pub mime: String,
    /// The image, in base64.
    pub data: String,
}

/// What the store gave one part of the session at unlock.
pub enum Found {
    /// Verified: the session starts with it.
    Ready(Zeroizing<Vec<u8>>),
    /// Not there: the session starts empty, and it is written when it
    /// changes.
    Absent,
    /// It waits for the user's choice, or could not be read now: the
    /// session starts empty, and the store does not write it until then.
    Held,
}

/// Where the account's preferences stand this session (CL-2a, design §5.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrefsImport {
    /// What this device kept for the account before the store (in the
    /// WebView's localStorage) was imported once already.
    Done,
    /// It has not been: the frontend sends it once (`prefs_import`).
    Pending,
    /// The account has not moved to the store yet, so there is nowhere
    /// sealed to keep its preferences: they stay where they were.
    Unavailable,
}

/// The store, as `SessionStore::open` found it.
pub struct OpenedStore {
    pub session: SessionStore,
    pub account: Found,
    pub history: Found,
    pub sessions: Found,
    pub profiles: Found,
}

/// The store of the open session.
pub struct SessionStore {
    store: Store<RealDisk>,
    /// What waits for the user's choice, by file, until `choose`.
    awaiting: BTreeMap<Slot, Zeroizing<Vec<u8>>>,
    /// What the store found at unlock, for the one dialog.
    report: IntegrityReport,
    /// The verified `prefs.bin`, as the unlock answer carries it.
    prefs: Option<Zeroizing<Vec<u8>>>,
    /// The stickers, by their name on disk.
    stickers: BTreeMap<String, StickerFile>,
}

/// Whether the vault's header is the one the index noted (design §4.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultCheck {
    /// The one noted.
    Same,
    /// Another, for a reason that needs no word: a re-seal noted as pending
    /// that finished, a newer signed prekey, or no header noted yet. The
    /// index takes it.
    Silent,
    /// Another, and nothing explains it: someone put another `vault.bin`
    /// here, or a version of Trino that does not note its re-seals sealed
    /// it. The index takes it, and the user is told.
    Changed,
}

/// The header of the vault in `bytes` as the index notes it, with `spk`,
/// the id of the signed prekey it holds. `None` if it is not a vault.
///
/// A version 3 vault keeps its salt for life (clave de emergencia, design
/// §3.3), so the index notes a digest of the whole vault in its place,
/// with the TOTP hint as its flags: every seal changes it, as every seal
/// changed the salt before, and a vault put back from before a new
/// passphrase is still told apart.
pub fn vault_header(bytes: &[u8], spk: u32) -> Option<VaultHeader> {
    if crate::vault_v3::vault_version(bytes).ok() == Some(3) {
        let hint = crate::vault_v3::vault_v3_requires_totp(bytes).ok()?;
        return Some(VaultHeader {
            version: 3,
            flags: u8::from(hint),
            salt: hex::encode(&crate::crypto::sha256(bytes)[..16]),
            spk,
        });
    }
    let sealed = crate::vault::decode_vault(bytes).ok()?;
    Some(VaultHeader {
        version: sealed.version,
        flags: sealed.flags,
        salt: hex::encode(sealed.salt),
        spk,
    })
}

/// Design §4.9: what the header the vault has now means against the one the
/// index noted, and the one being written when the index was last saved.
///
/// Every re-seal changes the salt, so a vault re-sealed by this version is
/// told apart by the note it leaves as pending first. One whose note never
/// reached the index (the index could not be written) still holds a newer
/// signed prekey under the same format and flags, which only this identity
/// can sign: a rotation, taken in silence. Versions older than the store
/// refuse a vault that carries the data key, so they no longer re-seal it.
pub fn check_vault(
    noted: Option<&VaultHeader>,
    pending: Option<&VaultHeader>,
    now: &VaultHeader,
) -> VaultCheck {
    let Some(noted) = noted else {
        return VaultCheck::Silent;
    };
    if now == noted {
        return VaultCheck::Same;
    }
    if pending == Some(now) {
        return VaultCheck::Silent;
    }
    let rotated = now.version == noted.version && now.flags == noted.flags && now.spk > noted.spk;
    if rotated {
        VaultCheck::Silent
    } else {
        VaultCheck::Changed
    }
}

fn to_io(error: StoreError) -> io::Error {
    match error {
        StoreError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    }
}

/// No store in `dir`: no file in it or in its stickers' folder. What else
/// may be there (`aside/`) is no store by itself.
fn is_empty_store(dir: &Path) -> io::Result<bool> {
    Ok(RealDisk.list(dir)?.is_empty() && RealDisk.list(&dir.join("stickers"))?.is_empty())
}

/// A name for `store/` moved aside whole, unique in `home`.
pub fn other_store_name() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    format!("{OTHER_STORE_PREFIX}{nanos:024}")
}

impl SessionStore {
    /// Create the store of a new account in `home`, with its account file.
    /// A store already there has no vault to open it (the caller checked):
    /// an account whose wipe was cut short, so it goes, as design §5.6 says.
    pub fn create(home: &Path, keys: StoreKeys, account: &[u8]) -> io::Result<()> {
        let dir = home.join(STORE_DIR);
        match std::fs::remove_dir_all(&dir) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let mut store = Store::create(&dir, keys, RealDisk).map_err(to_io)?;
        store.write(&Slot::Account, account).map_err(to_io)?;
        if store.is_behind() {
            // The account must be on disk before the vault that opens it.
            store.flush_for_lock().map_err(to_io)?;
        }
        Ok(())
    }

    /// Open the store in `home` with the keys in `record`, the vault's app
    /// data, and check the vault's header (`vault`) against the index. A
    /// store of another account is moved aside and a new one started; a
    /// store that is not there is reported.
    pub fn open(home: &Path, record: &[u8], vault: Option<VaultHeader>) -> io::Result<OpenedStore> {
        let keys = || StoreKeys::from_vault_app(record).map_err(io::Error::other);
        let dir = home.join(STORE_DIR);
        let mut report = IntegrityReport::default();
        let (mut store, mut loaded) = if is_empty_store(&dir)? {
            report.note("store", What::Missing, Action::Empty);
            let store = Store::create(&dir, keys()?, RealDisk).map_err(to_io)?;
            (store, Default::default())
        } else {
            match Store::open(&dir, keys()?, RealDisk) {
                Ok(opened) => opened,
                Err(StoreError::OtherAccount) => {
                    std::fs::rename(&dir, home.join(other_store_name()))?;
                    report.note("store", What::OtherAccount, Action::SetAside);
                    let store = Store::create(&dir, keys()?, RealDisk).map_err(to_io)?;
                    (store, Default::default())
                }
                Err(error) => return Err(to_io(error)),
            }
        };
        report.findings.append(&mut loaded.report.findings);

        if let Some(now) = vault {
            let index = store.index();
            let check = check_vault(index.vault.as_ref(), index.vault_pending.as_ref(), &now);
            let noted = check == VaultCheck::Same && index.vault_pending.is_none();
            if check == VaultCheck::Changed {
                report.note("vault", What::VaultChanged, Action::Notice);
            }
            if !noted {
                // Best effort: if the index cannot take it now, the next
                // unlock checks against the older note again.
                let _ = store.note_vault(Some(now), None);
            }
        }

        let unreadable: BTreeSet<String> = report
            .findings
            .iter()
            .filter(|finding| finding.what == What::Unreadable)
            .map(|finding| finding.file.clone())
            .collect();
        let mut found = |slot: Slot| match loaded.ready.remove(&slot) {
            Some(bytes) => Found::Ready(bytes),
            None if loaded.awaiting_choice.contains_key(&slot)
                || unreadable.contains(&slot.logical_name()) =>
            {
                Found::Held
            }
            None => Found::Absent,
        };
        let account = found(Slot::Account);
        let history = found(Slot::History);
        let sessions = found(Slot::Sessions);
        let profiles = found(Slot::Profiles);
        let prefs = match found(Slot::Prefs) {
            Found::Ready(bytes) => Some(bytes),
            _ => None,
        };

        let mut session = SessionStore {
            store,
            awaiting: std::mem::take(&mut loaded.awaiting_choice),
            report,
            prefs,
            stickers: BTreeMap::new(),
        };
        for (slot, bytes) in std::mem::take(&mut loaded.ready) {
            let Slot::Sticker(name) = &slot else { continue };
            match serde_json::from_slice::<StickerFile>(&bytes) {
                Ok(sticker) => {
                    session.stickers.insert(name.clone(), sticker);
                }
                Err(_) => session.hold(&slot),
            }
        }
        Ok(OpenedStore {
            session,
            account,
            history,
            sessions,
            profiles,
        })
    }

    /// What the store found at unlock, less the choices already made.
    pub fn report(&self) -> IntegrityReport {
        self.report.clone()
    }

    /// The verified `prefs.bin`, if there is one.
    pub fn prefs(&self) -> Option<&[u8]> {
        self.prefs.as_deref().map(Vec::as_slice)
    }

    /// Whether the preferences this device kept before the store were
    /// imported (`legacy.prefs_imported`).
    pub fn prefs_imported(&self) -> bool {
        self.store.index().legacy.prefs_imported
    }

    /// The preferences imported once from this device (`json`), written
    /// with the note that they were in the same index write. Whether the
    /// index on disk has both now: false while it cannot be written, and
    /// the note goes out with its next write.
    pub fn import_prefs(&mut self, json: &[u8]) -> io::Result<bool> {
        let mut legacy = self.store.index().legacy.clone();
        legacy.prefs_imported = true;
        self.store
            .write_noting_legacy(&Slot::Prefs, json, legacy)
            .map_err(to_io)?;
        self.prefs = Some(Zeroizing::new(json.to_vec()));
        Ok(!self.store.is_behind())
    }

    /// The stores the index notes for removal (`Index::deleting_stores`).
    pub fn deleting_stores(&self) -> Vec<String> {
        self.store.index().deleting_stores.clone()
    }

    /// The migration's cleanup (M4, `migrate::settle`) ran to its end: the
    /// index says so, and the next unlock does not run it again. Best
    /// effort: if the index cannot take it now, M4 runs again, in silence.
    pub fn finish_cleanup(&mut self) {
        let mut legacy = self.store.index().legacy.clone();
        if !legacy.cleanup_pending {
            return;
        }
        legacy.cleanup_pending = false;
        let _ = self.store.set_legacy(legacy);
    }

    /// Findings of unlocking that are not the store's own (the migration's),
    /// for the one dialog.
    pub fn note_findings(&mut self, findings: Vec<Finding>) {
        self.report.findings.extend(findings);
    }

    /// The finding about `file` is settled: the dialog no longer shows it.
    pub fn forget_finding(&mut self, file: &str) {
        self.report.findings.retain(|finding| finding.file != file);
    }

    /// Keep a file of an earlier version that did not read in `aside/`,
    /// sealed if it was in clear (`migrate::keep_aside`).
    pub fn keep_aside(&self, unreadable: &super::migrate::Unreadable) -> io::Result<()> {
        super::migrate::keep_aside(&self.store, unreadable).map_err(to_io)
    }

    /// Never write `slot` this session: what it holds did not read, so it
    /// stays as it is, and the dialog says so.
    pub fn hold(&mut self, slot: &Slot) {
        self.store.hold(slot);
        self.awaiting.remove(slot);
        if *slot == Slot::Prefs {
            self.prefs = None;
        }
        let name = slot.logical_name();
        self.report.findings.retain(|finding| finding.file != name);
        self.report.push(slot, What::Unreadable);
    }

    /// The user's answer for a file that waits: with `use_it`, what it
    /// holds, for the session to take.
    pub fn choose(&mut self, slot: &Slot, use_it: bool) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
        self.store.choose(slot, use_it).map_err(to_io)?;
        let content = self.awaiting.remove(slot);
        let name = slot.logical_name();
        self.report.findings.retain(|finding| finding.file != name);
        if !use_it {
            return Ok(None);
        }
        if *slot == Slot::Prefs {
            self.prefs = content.clone();
        }
        Ok(content)
    }

    /// Keep a sticker, under a name that a keyed hash of `image` gives.
    pub fn put_sticker(&mut self, id: &str, mime: &str, image: &[u8]) -> io::Result<()> {
        let name = self.store.keys().sticker_disk_name(image);
        let sticker = StickerFile {
            id: id.to_string(),
            mime: mime.to_string(),
            data: base64::engine::general_purpose::STANDARD.encode(image),
        };
        let json = Zeroizing::new(serde_json::to_vec(&sticker).map_err(io::Error::other)?);
        self.write(&Slot::Sticker(name.clone()), &json)?;
        self.stickers.insert(name, sticker);
        Ok(())
    }

    pub fn stickers(&self) -> Vec<StickerFile> {
        self.stickers.values().cloned().collect()
    }

    /// Remove every sticker whose id is `id`.
    pub fn remove_sticker(&mut self, id: &str) -> io::Result<()> {
        let names: Vec<String> = self
            .stickers
            .iter()
            .filter(|(_, sticker)| sticker.id == id)
            .map(|(name, _)| name.clone())
            .collect();
        for name in names {
            self.store
                .delete(&Slot::Sticker(name.clone()))
                .map_err(to_io)?;
            self.stickers.remove(&name);
        }
        Ok(())
    }

    fn write(&mut self, slot: &Slot, bytes: &[u8]) -> io::Result<()> {
        self.store.write(slot, bytes).map_err(to_io)?;
        if *slot == Slot::Prefs {
            // What an unlock of the open session carries.
            self.prefs = Some(Zeroizing::new(bytes.to_vec()));
        }
        Ok(())
    }

    fn note_vault_pending(&mut self, header: &VaultHeader) {
        let noted = self.store.index().vault.clone();
        let _ = self.store.note_vault(noted, Some(header.clone()));
    }

    fn note_vault_written(&mut self, header: &VaultHeader) {
        let _ = self.store.note_vault(Some(header.clone()), None);
    }
}

/// The files of an account whose vault carries no data key yet, and the
/// keys earlier versions derived from the identity for them.
pub struct LegacyFiles {
    pub config: PathBuf,
    pub friends: PathBuf,
    pub groups: PathBuf,
    pub group_invites: PathBuf,
    pub history: PathBuf,
    pub ratchets: PathBuf,
    pub profiles: PathBuf,
    pub stickers: PathBuf,
    pub history_key: Zeroizing<[u8; 32]>,
    pub profiles_key: Zeroizing<[u8; 32]>,
    /// Files that were there at unlock and did not open: never written this
    /// session, so a damaged history is never replaced by an empty one (H2).
    pub held: BTreeSet<Slot>,
}

/// `nonce ‖ ciphertext`, as earlier versions seal history.bin, ratchets.bin
/// and profiles.bin.
pub fn legacy_seal(key: &[u8; 32], plain: &[u8]) -> io::Result<Vec<u8>> {
    let (ciphertext, nonce) = crate::crypto::aes_gcm_encrypt(key, plain, None)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let mut blob = Vec::with_capacity(nonce.len() + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(blob)
}

/// What `legacy_seal` sealed with `key`, if it opens.
pub fn legacy_open(key: &[u8; 32], blob: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    if blob.len() < crate::crypto::NONCE_SIZE {
        return None;
    }
    let (nonce, ciphertext) = blob.split_at(crate::crypto::NONCE_SIZE);
    crate::crypto::aes_gcm_decrypt(key, ciphertext, nonce, None)
        .ok()
        .map(Zeroizing::new)
}

impl LegacyFiles {
    /// The four files earlier versions keep the account in, in clear.
    fn write_account(&self, account: &AccountFile) -> io::Result<()> {
        let config = ConfigFile {
            handle: account.handle.clone(),
            nostr_pub: account.nostr_pub.clone(),
            relays: account.relays.clone(),
            created_at: account.created_at,
            avatar: account.avatar.clone(),
        };
        let friends = FriendsFile {
            handle: account.handle.clone(),
            friends: account.friends.clone(),
            blocked: account.blocked.clone(),
        };
        fsutil::atomic_write(&self.config, &pretty(&config)?)?;
        fsutil::atomic_write(&self.friends, &pretty(&friends)?)?;
        fsutil::atomic_write(&self.groups, &pretty(&account.groups)?)?;
        fsutil::atomic_write(&self.group_invites, &pretty(&account.group_invites)?)
    }

    /// `plain`, sealed as earlier versions seal it, to `path`; never over a
    /// file that did not open at unlock.
    fn write_sealed(&self, slot: Slot, plain: &[u8]) -> io::Result<()> {
        if self.held.contains(&slot) {
            return Err(io::Error::other(format!(
                "{} did not open at unlock: it stays as it is",
                slot.logical_name()
            )));
        }
        let (key, path) = match slot {
            Slot::History => (&self.history_key, &self.history),
            Slot::Sessions => (&self.history_key, &self.ratchets),
            Slot::Profiles => (&self.profiles_key, &self.profiles),
            _ => return Err(io::Error::other("not a sealed legacy file")),
        };
        fsutil::atomic_write(path, &legacy_seal(key, plain)?)
    }
}

/// Pretty JSON, as earlier versions write their files.
fn pretty<T: Serialize + ?Sized>(value: &T) -> io::Result<Vec<u8>> {
    serde_json::to_vec_pretty(value).map_err(io::Error::other)
}

/// Where the open session keeps its data.
pub enum Storage {
    Store(Box<SessionStore>),
    Legacy(Box<LegacyFiles>),
}

impl Storage {
    /// Before the vault is sealed again: note the header it will have, so a
    /// cut before it is written is not taken for someone else's vault.
    pub fn note_vault_pending(&mut self, header: &VaultHeader) {
        if let Storage::Store(store) = self {
            store.note_vault_pending(header);
        }
    }

    /// After the vault was written: its header is the one noted.
    pub fn note_vault_written(&mut self, header: &VaultHeader) {
        if let Storage::Store(store) = self {
            store.note_vault_written(header);
        }
    }
}

/// The session's `Storage`, or nothing while no session is open. Clones
/// share it, so a worker that seals the vault can note it.
#[derive(Clone, Default)]
pub struct StorageCell(Arc<Mutex<Option<Storage>>>);

impl StorageCell {
    fn lock(&self) -> MutexGuard<'_, Option<Storage>> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set(&self, storage: Storage) {
        *self.lock() = Some(storage);
    }

    /// Take it out, as a lock does: dropping it wipes the data key.
    pub fn take(&self) -> Option<Storage> {
        self.lock().take()
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn is_open(&self) -> bool {
        self.lock().is_some()
    }

    /// Run `work` on the storage; `None` with no session.
    pub fn with<R>(&self, work: impl FnOnce(&mut Storage) -> R) -> Option<R> {
        self.lock().as_mut().map(work)
    }

    /// Save the account. With no session, nothing is written.
    pub fn write_account(&self, account: &AccountFile) -> io::Result<()> {
        self.with(|storage| match storage {
            Storage::Store(store) => {
                let json = Zeroizing::new(serde_json::to_vec(account).map_err(io::Error::other)?);
                store.write(&Slot::Account, &json)
            }
            Storage::Legacy(legacy) => legacy.write_account(account),
        })
        .unwrap_or(Ok(()))
    }

    pub fn write_history(&self, json: &[u8]) -> io::Result<()> {
        self.write_part(Slot::History, json)
    }

    pub fn write_sessions(&self, json: &[u8]) -> io::Result<()> {
        self.write_part(Slot::Sessions, json)
    }

    pub fn write_profiles(&self, json: &[u8]) -> io::Result<()> {
        self.write_part(Slot::Profiles, json)
    }

    /// The account's preferences (CL-2a). An account the migration has not
    /// moved yet has nowhere sealed to keep them.
    pub fn write_prefs(&self, json: &[u8]) -> io::Result<()> {
        self.with(|storage| match storage {
            Storage::Store(store) => store.write(&Slot::Prefs, json),
            Storage::Legacy(_) => Err(io::Error::other(NOT_MOVED)),
        })
        .unwrap_or(Ok(()))
    }

    /// The account's preferences as the session has them now, and where
    /// their import stands; `None` with no session.
    pub fn prefs_now(&self) -> Option<(Option<Zeroizing<Vec<u8>>>, PrefsImport)> {
        self.with(|storage| match storage {
            Storage::Store(store) => {
                let prefs = store.prefs().map(|json| Zeroizing::new(json.to_vec()));
                let state = if store.prefs_imported() {
                    PrefsImport::Done
                } else {
                    PrefsImport::Pending
                };
                (prefs, state)
            }
            Storage::Legacy(_) => (None, PrefsImport::Unavailable),
        })
    }

    /// The one import of the preferences this device kept before the store
    /// (`SessionStore::import_prefs`). An account not moved to the store
    /// yet has nowhere sealed to keep them.
    pub fn import_prefs(&self, json: &[u8]) -> io::Result<bool> {
        self.with(|storage| match storage {
            Storage::Store(store) => store.import_prefs(json),
            Storage::Legacy(_) => Err(io::Error::other(NOT_MOVED)),
        })
        .unwrap_or_else(|| Err(io::Error::other("no session is open")))
    }

    fn write_part(&self, slot: Slot, json: &[u8]) -> io::Result<()> {
        self.with(|storage| match storage {
            Storage::Store(store) => store.write(&slot, json),
            Storage::Legacy(legacy) => legacy.write_sealed(slot, json),
        })
        .unwrap_or(Ok(()))
    }

    /// Never write `slot` this session: what it held did not read.
    pub fn hold(&self, slot: &Slot) {
        self.with(|storage| match storage {
            Storage::Store(store) => store.hold(slot),
            Storage::Legacy(legacy) => {
                legacy.held.insert(slot.clone());
            }
        });
    }

    /// Write `bytes` as the file in `slot`, whatever they are.
    #[cfg(any(test, feature = "test-util"))]
    pub fn write_raw(&self, slot: &Slot, bytes: &[u8]) -> io::Result<()> {
        self.with(|storage| match storage {
            Storage::Store(store) => store.write(slot, bytes),
            Storage::Legacy(_) => Err(io::Error::other("legacy")),
        })
        .unwrap_or(Ok(()))
    }

    /// The highest `seq` the store's index holds: how many writes it took.
    #[cfg(any(test, feature = "test-util"))]
    pub fn index_seq(&self) -> Option<u64> {
        self.with(|storage| match storage {
            Storage::Store(store) => Some(store.store.index().seq),
            Storage::Legacy(_) => None,
        })
        .flatten()
    }

    /// The store `name` noted for removal is gone (clave de emergencia
    /// B2): its note leaves the index. Nothing with no session, or one
    /// that does not note it.
    pub fn forget_deleting_store(&self, name: &str) {
        self.with(|storage| {
            if let Storage::Store(store) = storage {
                let _ = store.store.forget_deleting_store(name);
            }
        });
    }

    /// At lock: write whatever waits for the index (design §4.6).
    pub fn flush_for_lock(&self) {
        self.with(|storage| {
            if let Storage::Store(store) = storage {
                let _ = store.store.flush_for_lock();
            }
        });
    }

    /// Before the vault is sealed again: note the header it will have, so a
    /// cut before it is written is not taken for someone else's vault.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn note_vault_pending(&self, header: &VaultHeader) {
        self.with(|storage| storage.note_vault_pending(header));
    }

    /// After the vault was written: its header is the one noted.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn note_vault_written(&self, header: &VaultHeader) {
        self.with(|storage| storage.note_vault_written(header));
    }
}

/// Stores for tests: the engine's, and the app's through `test-util`.
#[cfg(any(test, feature = "test-util"))]
pub mod testing {
    use super::*;
    use crate::store::keys::testing::keys;

    /// The vault's app data for the test keys `keys(byte)`.
    pub fn record(byte: u8) -> Zeroizing<Vec<u8>> {
        keys(byte).to_vault_app()
    }

    /// A storage cell over a new store in `home`, as a new account has it.
    pub fn store_cell(home: &Path) -> StorageCell {
        SessionStore::create(home, keys(1), &account_json("ana")).unwrap();
        let opened = SessionStore::open(home, &record(1), None).unwrap();
        let cell = StorageCell::default();
        cell.set(Storage::Store(Box::new(opened.session)));
        cell
    }

    /// The store in `home` opened again, as the next unlock does.
    pub fn reopen(home: &Path) -> OpenedStore {
        SessionStore::open(home, &record(1), None).unwrap()
    }

    pub fn ready(found: Found) -> Zeroizing<Vec<u8>> {
        match found {
            Found::Ready(bytes) => bytes,
            Found::Absent => panic!("absent"),
            Found::Held => panic!("held"),
        }
    }

    pub fn account(handle: &str) -> AccountFile {
        AccountFile {
            handle: handle.into(),
            nostr_pub: "ab".repeat(32),
            relays: vec!["wss://relay.example".into()],
            created_at: 1_760_000_000,
            ..AccountFile::default()
        }
    }

    pub fn account_json(handle: &str) -> Vec<u8> {
        serde_json::to_vec(&account(handle)).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::keys::testing::keys;

    fn header(salt: u8, spk: u32) -> VaultHeader {
        VaultHeader {
            version: 2,
            flags: 1,
            salt: hex::encode([salt; 16]),
            spk,
        }
    }

    fn files_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    #[test]
    fn a_new_store_holds_the_account_and_nothing_in_clear() {
        let scratch = ScratchDir::new("session-create");
        SessionStore::create(scratch.path(), keys(1), &account_json("Ana Secreta")).unwrap();

        let store = scratch.path().join(STORE_DIR);
        assert_eq!(files_in(&store), ["account.bin", "index.bin"]);
        let raw = std::fs::read(store.join("account.bin")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Ana Secreta"));

        let opened = reopen(scratch.path());
        let back: AccountFile = serde_json::from_slice(&ready(opened.account)).unwrap();
        assert_eq!(back.handle, "Ana Secreta");
        assert!(matches!(opened.history, Found::Absent));
        assert!(matches!(opened.sessions, Found::Absent));
        assert!(matches!(opened.profiles, Found::Absent));
        assert!(opened.session.report().is_empty());
        assert_eq!(opened.session.prefs(), None);
    }

    /// Design §5.6: a store with no vault is an account whose wipe was cut
    /// short, and a new account removes it; nothing of it opens without
    /// its vault anyway.
    #[test]
    fn creating_a_store_removes_one_left_without_a_vault() {
        let scratch = ScratchDir::new("session-create-leftover");
        SessionStore::create(scratch.path(), keys(2), &account_json("old")).unwrap();
        let sticker = scratch.path().join(STORE_DIR).join("stickers");
        std::fs::create_dir_all(&sticker).unwrap();
        std::fs::write(sticker.join(format!("{}.bin", "ab".repeat(16))), b"x").unwrap();

        SessionStore::create(scratch.path(), keys(1), &account_json("new")).unwrap();

        let opened = reopen(scratch.path());
        assert!(opened.session.report().is_empty());
        let back: AccountFile = serde_json::from_slice(&ready(opened.account)).unwrap();
        assert_eq!(back.handle, "new");
        assert_eq!(
            files_in(&scratch.path().join(STORE_DIR)),
            ["account.bin", "index.bin"]
        );
        assert!(files_in(&sticker).is_empty());
        assert!(!files_in(scratch.path())
            .iter()
            .any(|name| name.starts_with(OTHER_STORE_PREFIX)));
    }

    #[test]
    fn every_part_is_written_and_read_back_under_the_data_key() {
        let scratch = ScratchDir::new("session-parts");
        let cell = store_cell(scratch.path());

        cell.write_account(&account("Beto")).unwrap();
        cell.write_history(br#"{"ana":[]}"#).unwrap();
        cell.write_sessions(br#"{"ratchets":{}}"#).unwrap();
        cell.write_profiles(br#"{"about":"hola"}"#).unwrap();

        let opened = reopen(scratch.path());
        let back: AccountFile = serde_json::from_slice(&ready(opened.account)).unwrap();
        assert_eq!(back.handle, "Beto");
        assert_eq!(&*ready(opened.history), br#"{"ana":[]}"#);
        assert_eq!(&*ready(opened.sessions), br#"{"ratchets":{}}"#);
        assert_eq!(&*ready(opened.profiles), br#"{"about":"hola"}"#);
        assert!(opened.session.report().is_empty());
        for name in files_in(&scratch.path().join(STORE_DIR)) {
            let raw = std::fs::read(scratch.path().join(STORE_DIR).join(&name)).unwrap();
            let text = String::from_utf8_lossy(&raw);
            for secret in ["Beto", "ana", "ratchets", "hola"] {
                assert!(!text.contains(secret), "{secret} in the clear in {name}");
            }
        }
    }

    #[test]
    fn without_a_session_nothing_is_written() {
        let cell = StorageCell::default();
        assert!(!cell.is_open());
        cell.write_account(&account("ana")).unwrap();
        cell.write_history(b"{}").unwrap();
        cell.write_sessions(b"{}").unwrap();
        cell.write_profiles(b"{}").unwrap();
        cell.flush_for_lock();
        assert!(cell.with(|_| ()).is_none());
    }

    /// Design §12.3, test 25.
    #[test]
    fn lock_forgets_the_data_key_and_every_kind_key() {
        let scratch = ScratchDir::new("session-forget");
        let cell = store_cell(scratch.path());
        assert!(cell.is_open());

        // The store holds the DK; every kind key is derived from it when
        // needed and wiped after. Taking it out drops it, and the DK is a
        // `Zeroizing` buffer.
        drop(cell.take());

        assert!(!cell.is_open());
        cell.write_history(b"{}").unwrap();
        let opened = reopen(scratch.path());
        assert!(
            matches!(opened.history, Found::Absent),
            "written after lock"
        );
    }

    /// Design §12.3, test 21 (H3).
    #[test]
    fn history_and_sessions_cannot_be_swapped() {
        let scratch = ScratchDir::new("session-swap");
        let cell = store_cell(scratch.path());
        cell.write_history(br#"{"ana":[]}"#).unwrap();
        cell.write_sessions(br#"{"ratchets":{}}"#).unwrap();
        drop(cell.take());
        let store = scratch.path().join(STORE_DIR);
        let history = std::fs::read(store.join("history.bin")).unwrap();
        let sessions = std::fs::read(store.join("sessions.bin")).unwrap();
        std::fs::write(store.join("history.bin"), &sessions).unwrap();
        std::fs::write(store.join("sessions.bin"), &history).unwrap();

        let opened = reopen(scratch.path());

        assert!(matches!(opened.history, Found::Absent));
        assert!(matches!(opened.sessions, Found::Absent));
        let report = opened.session.report();
        assert_eq!(report.find("history").unwrap().what, What::Altered);
        assert_eq!(report.find("sessions").unwrap().what, What::Altered);
        // Both are kept aside as they were, never opened as the other.
        let aside = files_in(&store.join("aside"));
        assert_eq!(aside.len(), 2, "{aside:?}");
    }

    /// Design §12.3, test 20 (H2): a history that does not open is set
    /// aside as it was, and a new one never takes its bytes.
    #[test]
    fn a_history_that_does_not_open_is_never_overwritten() {
        let scratch = ScratchDir::new("session-history-damaged");
        let cell = store_cell(scratch.path());
        cell.write_history(br#"{"ana":[]}"#).unwrap();
        drop(cell.take());
        let path = scratch.path().join(STORE_DIR).join("history.bin");
        let mut damaged = std::fs::read(&path).unwrap();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        std::fs::write(&path, &damaged).unwrap();

        let opened = reopen(scratch.path());
        assert!(matches!(opened.history, Found::Absent));
        let finding = opened.session.report().find("history").cloned().unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::Altered, Action::SetAside)
        );
        let cell = StorageCell::default();
        cell.set(Storage::Store(Box::new(opened.session)));
        cell.write_history(br#"{"new":[]}"#).unwrap();

        let aside = scratch.path().join(STORE_DIR).join("aside");
        let kept: Vec<Vec<u8>> = files_in(&aside)
            .iter()
            .map(|name| std::fs::read(aside.join(name)).unwrap())
            .collect();
        assert_eq!(kept, [damaged], "the damaged history is not kept as it was");
        assert_eq!(&*ready(reopen(scratch.path()).history), br#"{"new":[]}"#);
    }

    /// Design §12.3, test 58: the sticker keeps its id, and its name on
    /// disk is the keyed hash, not the id.
    #[test]
    fn a_sticker_keeps_its_id_when_its_disk_name_changes() {
        let scratch = ScratchDir::new("session-sticker");
        let image = b"\x89PNG a sticker".to_vec();
        let id = hex::encode(&crate::crypto::sha256(&image)[..8]);
        let cell = store_cell(scratch.path());

        cell.with(|storage| match storage {
            Storage::Store(store) => store.put_sticker(&id, "image/png", &image).unwrap(),
            Storage::Legacy(_) => unreachable!(),
        });
        drop(cell.take());

        let dir = scratch.path().join(STORE_DIR).join("stickers");
        let names = files_in(&dir);
        assert_eq!(
            names,
            [format!("{}.bin", keys(1).sticker_disk_name(&image))]
        );
        assert!(!names[0].contains(&id));
        let raw = std::fs::read(dir.join(&names[0])).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains(&id));

        let mut opened = reopen(scratch.path());
        let stickers = opened.session.stickers();
        assert_eq!(stickers.len(), 1);
        assert_eq!(stickers[0].id, id);
        assert_eq!(stickers[0].mime, "image/png");
        use base64::Engine as _;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&stickers[0].data)
            .unwrap();
        assert_eq!(data, image);

        // The same image again is the same file; removing it by its id
        // removes the file.
        opened
            .session
            .put_sticker(&id, "image/png", &image)
            .unwrap();
        assert_eq!(files_in(&dir).len(), 1);
        opened.session.remove_sticker(&id).unwrap();
        assert!(files_in(&dir).is_empty());
        assert!(opened.session.stickers().is_empty());
        assert!(reopen(scratch.path()).session.stickers().is_empty());
    }

    #[test]
    fn a_store_of_another_account_is_moved_aside_and_reported() {
        let scratch = ScratchDir::new("session-other-account");
        SessionStore::create(scratch.path(), keys(2), &account_json("someone")).unwrap();

        let opened = SessionStore::open(scratch.path(), &record(1), None).unwrap();

        assert!(matches!(opened.account, Found::Absent));
        let finding = opened.session.report().find("store").cloned().unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::OtherAccount, Action::SetAside)
        );
        let aside: Vec<String> = files_in(scratch.path())
            .into_iter()
            .filter(|name| name.starts_with(OTHER_STORE_PREFIX))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            files_in(&scratch.path().join(&aside[0])),
            ["account.bin", "index.bin"],
            "the other account's store was not kept as it was"
        );
        // This account's new store is there, empty.
        assert_eq!(files_in(&scratch.path().join(STORE_DIR)), ["index.bin"]);
    }

    #[test]
    fn a_store_that_is_not_there_is_reported() {
        let scratch = ScratchDir::new("session-missing");

        let opened = SessionStore::open(scratch.path(), &record(1), None).unwrap();

        assert!(matches!(opened.account, Found::Absent));
        let finding = opened.session.report().find("store").cloned().unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::Missing, Action::Empty)
        );
        // Reported once: the next unlock finds the store it started.
        assert!(reopen(scratch.path()).session.report().is_empty());
    }

    #[test]
    fn an_older_account_waits_for_the_choice_and_is_given_once_chosen() {
        let scratch = ScratchDir::new("session-choose");
        let cell = store_cell(scratch.path());
        drop(cell.take());
        let path = scratch.path().join(STORE_DIR).join("account.bin");
        let older = std::fs::read(&path).unwrap();
        let cell = StorageCell::default();
        cell.set(Storage::Store(Box::new(reopen(scratch.path()).session)));
        cell.write_account(&account("newer")).unwrap();
        drop(cell.take());
        std::fs::write(&path, &older).unwrap();

        let mut opened = reopen(scratch.path());
        assert!(matches!(opened.account, Found::Held));
        assert_eq!(
            opened.session.report().find("account").unwrap().action,
            Action::Ask
        );
        let given = opened.session.choose(&Slot::Account, true).unwrap();

        let back: AccountFile = serde_json::from_slice(&given.unwrap()).unwrap();
        assert_eq!(back.handle, "ana");
        assert!(opened.session.report().find("account").is_none());
        // Chosen, it counts as verified from then on.
        let again = reopen(scratch.path());
        assert!(again.session.report().is_empty());
        let back: AccountFile = serde_json::from_slice(&ready(again.account)).unwrap();
        assert_eq!(back.handle, "ana");
    }

    #[test]
    fn going_on_without_an_older_copy_gives_nothing_and_sets_it_aside() {
        let scratch = ScratchDir::new("session-choose-without");
        let cell = store_cell(scratch.path());
        drop(cell.take());
        let path = scratch.path().join(STORE_DIR).join("account.bin");
        let older = std::fs::read(&path).unwrap();
        let cell = StorageCell::default();
        cell.set(Storage::Store(Box::new(reopen(scratch.path()).session)));
        cell.write_account(&account("newer")).unwrap();
        drop(cell.take());
        std::fs::write(&path, &older).unwrap();

        let mut opened = reopen(scratch.path());
        assert!(opened
            .session
            .choose(&Slot::Account, false)
            .unwrap()
            .is_none());

        assert!(!path.exists());
        assert!(matches!(reopen(scratch.path()).account, Found::Absent));
    }

    #[test]
    fn content_that_does_not_read_is_held_and_never_written() {
        let scratch = ScratchDir::new("session-hold");
        let cell = store_cell(scratch.path());
        cell.write_history(b"not what this version reads").unwrap();
        cell.with(|storage| match storage {
            Storage::Store(store) => store.hold(&Slot::History),
            Storage::Legacy(_) => unreachable!(),
        });

        assert!(cell.write_history(br#"{"ana":[]}"#).is_err());
        let finding = cell
            .with(|storage| match storage {
                Storage::Store(store) => store.report().find("history").cloned(),
                Storage::Legacy(_) => unreachable!(),
            })
            .flatten()
            .unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::Unreadable, Action::KeepForLater)
        );
        drop(cell.take());
        assert_eq!(
            &*ready(reopen(scratch.path()).history),
            b"not what this version reads"
        );
    }

    /// Design §12.3, test 24.
    #[test]
    fn a_vault_header_unlike_the_index_is_reported_and_a_reseal_in_progress_is_not() {
        let noted = header(1, 10);
        // Nothing noted yet: a new store, or one from before the check.
        assert_eq!(check_vault(None, None, &noted), VaultCheck::Silent);
        assert_eq!(check_vault(Some(&noted), None, &noted), VaultCheck::Same);
        // A re-seal that noted its header and wrote the vault, cut before it
        // noted the end; and one cut before the vault was written.
        let resealed = header(2, 10);
        assert_eq!(
            check_vault(Some(&noted), Some(&resealed), &resealed),
            VaultCheck::Silent
        );
        assert_eq!(
            check_vault(Some(&noted), Some(&resealed), &noted),
            VaultCheck::Same
        );
        // Another salt with the same or an older signed prekey: another
        // vault.bin, such as a copy from before a passphrase change.
        assert_eq!(
            check_vault(Some(&noted), None, &header(3, 10)),
            VaultCheck::Changed
        );
        assert_eq!(
            check_vault(Some(&noted), None, &header(3, 9)),
            VaultCheck::Changed
        );
        let mut other_flags = noted.clone();
        other_flags.flags = 0;
        assert_eq!(
            check_vault(Some(&noted), None, &other_flags),
            VaultCheck::Changed
        );
    }

    /// Design §12.3, test 57. Older versions refuse a vault that carries
    /// the data key (trino-core's version 2), so they can no longer re-seal
    /// it; a newer signed prekey under the same salt or another one is a
    /// re-seal of this identity whose note did not reach the index.
    #[test]
    fn a_vault_with_a_newer_spk_updates_the_index_in_silence() {
        let noted = header(1, 10);
        assert_eq!(
            check_vault(Some(&noted), None, &header(1, 11)),
            VaultCheck::Silent
        );
        assert_eq!(
            check_vault(Some(&noted), None, &header(4, 11)),
            VaultCheck::Silent
        );
    }

    #[test]
    fn the_vault_check_runs_at_open_and_tells_once() {
        let scratch = ScratchDir::new("session-vault-check");
        SessionStore::create(scratch.path(), keys(1), &account_json("ana")).unwrap();
        let opened = SessionStore::open(scratch.path(), &record(1), Some(header(1, 10))).unwrap();
        assert!(
            opened.session.report().is_empty(),
            "first header noted in silence"
        );
        drop(opened);

        // A re-seal that notes its header is not reported.
        let cell = StorageCell::default();
        let opened = SessionStore::open(scratch.path(), &record(1), Some(header(1, 10))).unwrap();
        cell.set(Storage::Store(Box::new(opened.session)));
        cell.note_vault_pending(&header(2, 10));
        cell.note_vault_written(&header(2, 10));
        drop(cell.take());
        let opened = SessionStore::open(scratch.path(), &record(1), Some(header(2, 10))).unwrap();
        assert!(opened.session.report().is_empty());
        drop(opened);

        // Another vault.bin is, once.
        let opened = SessionStore::open(scratch.path(), &record(1), Some(header(1, 10))).unwrap();
        let finding = opened.session.report().find("vault").cloned().unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::VaultChanged, Action::Notice)
        );
        drop(opened);
        let opened = SessionStore::open(scratch.path(), &record(1), Some(header(1, 10))).unwrap();
        assert!(opened.session.report().is_empty());
    }

    #[test]
    fn the_vault_header_is_read_from_the_vault_bytes() {
        let identity = crate::identity::create_identity();
        let sealed = crate::vault::seal_vault(
            &identity,
            None,
            Some(&record(1)),
            "una frase larga de prueba",
        )
        .unwrap();
        let bytes = crate::vault::encode_vault(&sealed);

        let header = vault_header(&bytes, 7).unwrap();

        assert_eq!(header.version, sealed.version);
        assert_eq!(header.flags, sealed.flags);
        assert_eq!(header.salt, hex::encode(sealed.salt));
        assert_eq!(header.spk, 7);
        assert_eq!(vault_header(b"not a vault", 7), None);
    }

    #[test]
    fn legacy_files_seal_as_earlier_versions_did() {
        let key = [7u8; 32];
        let blob = legacy_seal(&key, b"{\"ana\":[]}").unwrap();
        assert_eq!(&*legacy_open(&key, &blob).unwrap(), b"{\"ana\":[]}");
        assert!(legacy_open(&[8u8; 32], &blob).is_none());
        assert!(legacy_open(&key, b"short").is_none());
        // Earlier versions: nonce ‖ ciphertext, no associated data.
        let (nonce, ciphertext) = blob.split_at(crate::crypto::NONCE_SIZE);
        let plain = crate::crypto::aes_gcm_decrypt(&key, ciphertext, nonce, None).unwrap();
        assert_eq!(plain, b"{\"ana\":[]}");
    }

    #[test]
    fn a_legacy_account_is_written_to_its_four_files() {
        let scratch = ScratchDir::new("session-legacy");
        let home = scratch.path();
        let legacy = LegacyFiles {
            config: home.join("config.json"),
            friends: home.join("friends.json"),
            groups: home.join("groups.json"),
            group_invites: home.join("group_invites.json"),
            history: home.join("history.bin"),
            ratchets: home.join("ratchets.bin"),
            profiles: home.join("profiles.bin"),
            stickers: home.join("stickers"),
            history_key: Zeroizing::new([7; 32]),
            profiles_key: Zeroizing::new([8; 32]),
            held: BTreeSet::new(),
        };
        let cell = StorageCell::default();
        cell.set(Storage::Legacy(Box::new(legacy)));
        let mut written = account("ana");
        written.blocked = vec!["ff".repeat(32)];

        cell.write_account(&written).unwrap();
        cell.write_history(b"{}").unwrap();

        let config: ConfigFile =
            serde_json::from_slice(&std::fs::read(home.join("config.json")).unwrap()).unwrap();
        assert_eq!(config.handle, "ana");
        assert_eq!(config.relays, ["wss://relay.example"]);
        assert_eq!(config.created_at, 1_760_000_000);
        let friends: FriendsFile =
            serde_json::from_slice(&std::fs::read(home.join("friends.json")).unwrap()).unwrap();
        assert_eq!(friends.blocked, written.blocked);
        assert_eq!(std::fs::read(home.join("groups.json")).unwrap(), b"[]");
        assert_eq!(
            std::fs::read(home.join("group_invites.json")).unwrap(),
            b"[]"
        );
        let history = std::fs::read(home.join("history.bin")).unwrap();
        assert_eq!(&*legacy_open(&[7; 32], &history).unwrap(), b"{}");
        assert!(!home.join(STORE_DIR).exists());
    }

    /// H2 for an account not moved yet: a history.bin that did not open at
    /// unlock is never replaced by what the session holds.
    #[test]
    fn a_legacy_file_that_did_not_open_is_never_written() {
        let scratch = ScratchDir::new("session-legacy-held");
        let home = scratch.path();
        std::fs::write(home.join("history.bin"), b"damaged").unwrap();
        let legacy = LegacyFiles {
            config: home.join("config.json"),
            friends: home.join("friends.json"),
            groups: home.join("groups.json"),
            group_invites: home.join("group_invites.json"),
            history: home.join("history.bin"),
            ratchets: home.join("ratchets.bin"),
            profiles: home.join("profiles.bin"),
            stickers: home.join("stickers"),
            history_key: Zeroizing::new([7; 32]),
            profiles_key: Zeroizing::new([8; 32]),
            held: BTreeSet::from([Slot::History]),
        };
        let cell = StorageCell::default();
        cell.set(Storage::Legacy(Box::new(legacy)));

        assert!(cell.write_history(b"{}").is_err());
        assert_eq!(std::fs::read(home.join("history.bin")).unwrap(), b"damaged");
        cell.write_sessions(b"{}").unwrap();
        assert!(home.join("ratchets.bin").exists());
    }
}
