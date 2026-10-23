//! Moving an account of an earlier version into the store (cifrado local
//! CL-1c, design §5 and §12.4, with David's decision 2).
//!
//! Earlier versions keep the account in `~/.trino`: `config.json`,
//! `friends.json`, `groups.json` and `group_invites.json` in clear, the
//! stickers as plain images, and `history.bin`, `ratchets.bin` and
//! `profiles.bin` sealed with keys derived from the identity. Their vault
//! carries no data key. The first unlock with this version moves all of it
//! into `store/`, in steps that a power cut at any point cannot turn into a
//! loss:
//!
//! - **M0.** Before anything is written: proof that the files are this
//!   account's. One of the sealed files must open with a key of this
//!   identity, which nobody without the passphrase can make (design §4.8).
//!   Without it nothing is read: `.json` files someone planted are never
//!   sealed as if they were the user's, and the dialog offers to look at
//!   them, import them or remove them instead.
//! - **M1, M2.** A new data key, and `store.new/` written under it: the
//!   account, the history, the sessions, the profiles and the stickers. A
//!   file that does not read is kept in `store.new/aside/`, and one in clear
//!   is sealed first, so it never lies there in clear.
//! - **M3.** Everything read back and compared, then noted in the index as
//!   migrated, with the cleanup pending.
//! - **The commit.** The vault, sealed with the new key, is written so that
//!   it is on the disk when the write returns (`Disk::write_durable`), and
//!   then `store.new/` becomes `store/` the same way. Before the vault holds
//!   the key, a cut leaves the files of before untouched and `store.new/` a
//!   folder nothing can open, discarded at the next unlock; after, the next
//!   unlock finds the vault with its key and finishes the rest. Nothing old
//!   is touched before this step: on Windows the last rename may be undone
//!   by a cut, and a migration undone after its files were destroyed would
//!   lose them (design §5.2).
//! - **M4** (`settle`, at every unlock while the index says so). The files
//!   of before are overwritten, synced and removed, and the index says the
//!   cleanup is done.
//!
//! With the data key in the vault (decision 2) there is no `keys.bin` or
//! `keys.bak` (design §4.3): the vault is what commits the migration, and a
//! vault that carries the key means the account has its store, whatever
//! `.json` files appear later. Those are never read unless the user asks.

use super::disk::Disk;
use super::envelope::{self, Slot};
use super::files::{peek_index, Store, StoreError};
use super::index::{Legacy, VaultHeader};
use super::keys::StoreKeys;
use super::report::{Action, Finding, What};
use super::rotate::{generation_in, Generation};
use super::session::{legacy_open, other_store_name, AccountFile, StickerFile, STORE_DIR};
use crate::group::GroupRoster;
use crate::state::{ConfigFile, FriendsFile, GroupInvite};
use base64::Engine as _;
use serde::de::DeserializeOwned;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Where the migration writes the new store until the vault holds its key.
pub const NEW_STORE_DIR: &str = "store.new";
pub const VAULT_FILE: &str = "vault.bin";
/// The files earlier versions keep in clear.
pub const PLAIN_FILES: [&str; 4] = [
    "config.json",
    "friends.json",
    "groups.json",
    "group_invites.json",
];
/// The files earlier versions seal with keys derived from the identity.
pub const SEALED_FILES: [&str; 3] = ["history.bin", "ratchets.bin", "profiles.bin"];
/// Where earlier versions put a `profiles.bin` that did not open.
pub const DAMAGED_PROFILES: &str = "profiles.bin.damaged";
const STICKERS_DIR: &str = "stickers";

/// The keys earlier versions derived from the identity: `history.bin` and
/// `ratchets.bin` under the first, `profiles.bin` under the second.
pub struct LegacyKeys {
    pub history: Zeroizing<[u8; 32]>,
    pub profiles: Zeroizing<[u8; 32]>,
}

impl LegacyKeys {
    fn for_file(&self, name: &str) -> &[u8; 32] {
        if name == "profiles.bin" {
            &self.profiles
        } else {
            &self.history
        }
    }
}

/// A file of an earlier version that did not read.
pub struct Unreadable {
    /// Its name in `~/.trino`.
    pub name: String,
    pub bytes: Zeroizing<Vec<u8>>,
    /// In clear: it is sealed before it is kept.
    pub in_clear: bool,
}

/// A sticker as earlier versions keep it: `stickers/<id>.<ext>`.
pub struct LegacySticker {
    pub id: String,
    pub mime: String,
    pub image: Zeroizing<Vec<u8>>,
}

/// What the files of an earlier version hold, read as that version read
/// them.
#[derive(Default)]
pub struct LegacyRead {
    /// The four files in clear, as one account; none if none was there.
    pub account: Option<AccountFile>,
    pub history: Option<Zeroizing<Vec<u8>>>,
    pub sessions: Option<Zeroizing<Vec<u8>>>,
    pub profiles: Option<Zeroizing<Vec<u8>>>,
    pub stickers: Vec<LegacySticker>,
    pub unreadable: Vec<Unreadable>,
}

/// The vault the migration commits: sealed with the new keys (`record`, its
/// app data), and its header for the index (design §4.9).
pub struct NewVault<'a> {
    pub record: &'a [u8],
    pub bytes: &'a [u8],
    pub header: Option<VaultHeader>,
}

/// A migration that committed: with proof that the files of before were
/// this account's they moved, and without it the new store starts empty
/// and they stay as they were.
pub struct Migrated {
    /// For the one dialog: files that did not read and were kept aside, a
    /// store this vault could not open, or no data at all.
    pub findings: Vec<Finding>,
}

/// A migration that did not commit: the vault and the files of before are
/// as they were.
#[derive(Debug)]
pub struct MigrateError {
    /// Whether M0 found the proof, so the files of before may be used as
    /// earlier versions used them for this session.
    pub proof: bool,
    /// Whether the vault that holds the new key was committed: then the
    /// next opening finishes it, and the files of before are not used.
    pub committed: bool,
    pub error: io::Error,
}

/// What `settle` did before the store opened.
#[derive(Default)]
pub struct Settled {
    /// M4 ran to its end in this unlock: the session notes it in the index,
    /// and the user gets the one note about the migration.
    pub cleaned: bool,
    pub findings: Vec<Finding>,
}

/// M0: whether a file of before sealed with a key of this identity proves
/// that the files of before are this account's. Reads only. An error if
/// none proves it and one could not be read now.
pub fn has_proof(disk: &impl Disk, home: &Path, keys: &LegacyKeys) -> io::Result<bool> {
    let mut held = None;
    for name in SEALED_FILES {
        match read_file(disk, &home.join(name)) {
            Ok(Some(blob)) => {
                if legacy_open(keys.for_file(name), &blob).is_some() {
                    return Ok(true);
                }
            }
            Ok(None) => {}
            Err(error) => {
                held.get_or_insert(error);
            }
        }
    }
    held.map_or(Ok(false), Err)
}

/// The files of before in `home`, read as earlier versions read them. An
/// error if one is there and cannot be read now.
pub fn read_legacy(
    disk: &impl Disk,
    home: &Path,
    keys: &LegacyKeys,
    nostr_pub: &str,
    now: i64,
) -> io::Result<LegacyRead> {
    let mut read = LegacyRead::default();
    let unreadable = &mut read.unreadable;
    let config = plain::<ConfigFile>(disk, home, "config.json", unreadable)?;
    let friends = plain::<FriendsFile>(disk, home, "friends.json", unreadable)?;
    let groups = plain::<Vec<GroupRoster>>(disk, home, "groups.json", unreadable)?;
    let invites = plain::<Vec<GroupInvite>>(disk, home, "group_invites.json", unreadable)?;
    let any_there = config.0 || friends.0 || groups.0 || invites.0;
    let (config, friends) = (config.1, friends.1);
    if any_there {
        // As earlier versions: the name is config.json's; without it the
        // contacts file's, or none ("anon", design §6.1).
        let handle = config
            .as_ref()
            .map(|config| config.handle.clone())
            .or_else(|| friends.as_ref().map(|friends| friends.handle.clone()))
            .filter(|handle| !handle.trim().is_empty())
            .unwrap_or_else(|| "anon".to_string());
        let (friends, blocked) = friends.map_or_else(Default::default, |friends| {
            (friends.friends, friends.blocked)
        });
        read.account = Some(AccountFile {
            handle,
            nostr_pub: nostr_pub.to_string(),
            relays: config
                .as_ref()
                .map(|config| config.relays.clone())
                .unwrap_or_default(),
            created_at: config.as_ref().map_or(now, |config| config.created_at),
            avatar: config.and_then(|config| config.avatar),
            friends,
            blocked,
            groups: groups.1.unwrap_or_default(),
            group_invites: invites.1.unwrap_or_default(),
            alerts: Default::default(),
        });
    }

    for name in SEALED_FILES {
        let Some(blob) = read_file(disk, &home.join(name))? else {
            continue;
        };
        let Some(json) = legacy_open(keys.for_file(name), &blob) else {
            read.unreadable.push(Unreadable {
                name: name.to_string(),
                bytes: Zeroizing::new(blob),
                in_clear: false,
            });
            continue;
        };
        match name {
            "history.bin" => read.history = Some(json),
            "ratchets.bin" => read.sessions = Some(json),
            _ => read.profiles = Some(json),
        }
    }
    if let Some(blob) = read_file(disk, &home.join(DAMAGED_PROFILES))? {
        read.unreadable.push(Unreadable {
            name: DAMAGED_PROFILES.to_string(),
            bytes: Zeroizing::new(blob),
            in_clear: false,
        });
    }

    let stickers = home.join(STICKERS_DIR);
    for file in disk.list(&stickers)? {
        let path = Path::new(&file);
        let id = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        if id.is_empty() || is_temporary(&file) {
            continue;
        }
        let ext = path
            .extension()
            .map(|ext| ext.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let Some(image) = read_file(disk, &stickers.join(&file))? else {
            continue;
        };
        read.stickers.push(LegacySticker {
            id,
            mime: sticker_mime_for_ext(&ext).to_string(),
            image: Zeroizing::new(image),
        });
    }
    Ok(read)
}

/// The file at `path`; none if it is not there.
fn read_file(disk: &impl Disk, path: &Path) -> io::Result<Option<Vec<u8>>> {
    match disk.read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// One of the files in clear: whether it is there, and what it holds if it
/// reads as `T`. One that does not read joins `unreadable`, to be sealed.
fn plain<T: DeserializeOwned>(
    disk: &impl Disk,
    home: &Path,
    name: &str,
    unreadable: &mut Vec<Unreadable>,
) -> io::Result<(bool, Option<T>)> {
    let Some(bytes) = read_file(disk, &home.join(name))? else {
        return Ok((false, None));
    };
    let bytes = Zeroizing::new(bytes);
    match serde_json::from_slice::<T>(&bytes) {
        Ok(value) => Ok((true, Some(value))),
        Err(_) => {
            unreadable.push(Unreadable {
                name: name.to_string(),
                bytes,
                in_clear: true,
            });
            Ok((true, None))
        }
    }
}

/// The temporary file of an `atomic_write` that a cut interrupted.
fn is_temporary(name: &str) -> bool {
    name.starts_with('.') && name.contains(".tmp-")
}

/// As earlier versions named the type of a sticker by its extension
/// (`commands.rs`, `sticker_mime_for_ext`).
fn sticker_mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

fn finding(file: &str, what: What, action: Action) -> Finding {
    Finding {
        file: file.to_string(),
        what,
        action,
    }
}

fn to_io(error: StoreError) -> io::Error {
    match error {
        StoreError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    }
}

/// Whether there is any file under `dir`, at any depth.
fn holds_files(dir: &Path) -> io::Result<bool> {
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        entries => entries?,
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || holds_files(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The files of earlier versions in `home`, with the temporaries a cut save
/// of them left and the stickers: what M4 destroys.
pub fn legacy_paths(disk: &impl Disk, home: &Path) -> io::Result<Vec<PathBuf>> {
    let names: Vec<&str> = PLAIN_FILES
        .iter()
        .chain(SEALED_FILES.iter())
        .copied()
        .chain([DAMAGED_PROFILES])
        .collect();
    let mut paths: Vec<PathBuf> = disk
        .list(home)?
        .into_iter()
        .filter(|file| {
            names.iter().any(|name| {
                file == name || (is_temporary(file) && file.starts_with(&format!(".{name}.tmp-")))
            })
        })
        .map(|file| home.join(file))
        .collect();
    let stickers = home.join(STICKERS_DIR);
    paths.extend(
        disk.list(&stickers)?
            .into_iter()
            .map(|file| stickers.join(file)),
    );
    Ok(paths)
}

/// M4, and "Borrarlos": overwrite, sync and remove every file of earlier
/// versions in `home`. Every one is tried; the first error is returned.
pub fn destroy_legacy(disk: &impl Disk, home: &Path) -> io::Result<()> {
    let mut first = None;
    for path in legacy_paths(disk, home)? {
        if let Err(error) = disk.destroy(&path) {
            first.get_or_insert(error);
        }
    }
    let stickers = home.join(STICKERS_DIR);
    if first.is_none() && stickers.is_dir() && !holds_files(&stickers)? {
        disk.remove_dir_all(&stickers)?;
    }
    first.map_or(Ok(()), Err)
}

/// M0 to the commit, for an account whose vault carries no data key: see
/// the module's comment. `vault` is that vault sealed again with the new
/// keys, which the caller made.
pub fn migrate<D: Disk + Clone>(
    disk: &D,
    home: &Path,
    legacy: &LegacyKeys,
    vault: &NewVault,
    nostr_pub: &str,
    now: i64,
) -> Result<Migrated, MigrateError> {
    // M0, before anything is written.
    let proof = has_proof(disk, home, legacy).map_err(|error| MigrateError {
        proof: false,
        committed: false,
        error,
    })?;
    let failed = |error: io::Error| MigrateError {
        proof,
        committed: false,
        error,
    };
    let data = if proof {
        read_legacy(disk, home, legacy, nostr_pub, now).map_err(failed)?
    } else {
        LegacyRead::default()
    };

    let mut findings = Vec::new();
    let new = home.join(NEW_STORE_DIR);
    let store = home.join(STORE_DIR);
    // A store.new/ the vault never took is a migration a cut stopped:
    // nothing in it opens.
    disk.remove_dir_all(&new).map_err(failed)?;
    // A store/ this vault has no key to may be the user's, under a vault put
    // back to a copy from before: never removed by itself (design §5.6).
    if holds_files(&store).map_err(failed)? {
        disk.rename(&store, &home.join(other_store_name()))
            .map_err(failed)?;
        findings.push(finding("store", What::OtherAccount, Action::SetAside));
    }
    // M1 to M3.
    if let Err(error) = write_new_store(disk, &new, &data, vault, proof) {
        let _ = disk.remove_dir_all(&new);
        return Err(failed(error));
    }
    // The commit, in two phases (vault_file.rs). Until vault.bin.next is
    // on the disk nothing changed; from then on the vault holds the key, or
    // the next opening finishes writing it from vault.bin.next.
    let vault_path = home.join(VAULT_FILE);
    if let Err(error) = crate::vault_file::write_next(disk, &vault_path, vault.bytes) {
        let _ = disk.remove_dir_all(&new);
        return Err(failed(error));
    }
    if let Err(error) = crate::vault_file::finish(disk, &vault_path, vault.bytes) {
        return Err(MigrateError {
            proof,
            committed: true,
            error,
        });
    }
    // The vault opens only the new store from here. If this fails, `settle`
    // finishes it before the store opens.
    let _ = move_new_store(disk, home);

    for unreadable in &data.unreadable {
        findings.push(finding(&unreadable.name, What::Altered, Action::SetAside));
    }
    let nothing_there = legacy_paths(disk, home).is_ok_and(|paths| paths.is_empty());
    if !proof && nothing_there {
        findings.push(finding("store", What::Missing, Action::Empty));
    }
    Ok(Migrated { findings })
}

/// M1 to M3: the new store in `dir` under the keys `vault` carries, with what
/// `data` holds, read back and compared, then noted as migrated.
fn write_new_store<D: Disk + Clone>(
    disk: &D,
    dir: &Path,
    data: &LegacyRead,
    vault: &NewVault,
    proof: bool,
) -> io::Result<()> {
    let keys = || StoreKeys::from_vault_app(vault.record).map_err(io::Error::other);
    let mut store = Store::create(dir, keys()?, disk.clone()).map_err(to_io)?;

    let mut written: BTreeMap<Slot, Zeroizing<Vec<u8>>> = BTreeMap::new();
    if let Some(account) = &data.account {
        written.insert(Slot::Account, json(account)?);
    }
    for (slot, part) in [
        (Slot::History, &data.history),
        (Slot::Sessions, &data.sessions),
        (Slot::Profiles, &data.profiles),
    ] {
        if let Some(content) = part {
            written.insert(slot, content.clone());
        }
    }
    for sticker in &data.stickers {
        let file = StickerFile {
            id: sticker.id.clone(),
            mime: sticker.mime.clone(),
            data: base64::engine::general_purpose::STANDARD.encode(&*sticker.image),
        };
        let name = store.keys().sticker_disk_name(&sticker.image);
        written.insert(Slot::Sticker(name), json(&file)?);
    }
    for (slot, content) in &written {
        store.write(slot, content).map_err(to_io)?;
    }
    for unreadable in &data.unreadable {
        keep_aside(&store, unreadable).map_err(to_io)?;
    }
    if store.is_behind() {
        return Err(io::Error::other(
            "the new store's index could not be written",
        ));
    }
    drop(store);

    // M3: everything read back as it was written.
    let (mut store, loaded) = Store::open(dir, keys()?, disk.clone()).map_err(to_io)?;
    let same = loaded.report.is_empty()
        && loaded.awaiting_choice.is_empty()
        && loaded.ready.len() == written.len()
        && written.iter().all(|(slot, content)| {
            loaded
                .ready
                .get(slot)
                .is_some_and(|read| read[..] == content[..])
        });
    let aside_same = data
        .unreadable
        .iter()
        .all(|unreadable| kept_aside(disk, dir, store.keys(), unreadable));
    if !same || !aside_same {
        return Err(io::Error::other(
            "the new store does not read back as it was written",
        ));
    }
    if let Some(header) = &vault.header {
        store
            .note_vault(Some(header.clone()), None)
            .map_err(to_io)?;
    }
    store
        .set_legacy(Legacy {
            migrated: true,
            cleanup_pending: proof,
            prefs_imported: false,
        })
        .map_err(to_io)
}

/// What goes into the store, as JSON.
fn json<T: serde::Serialize>(value: &T) -> io::Result<Zeroizing<Vec<u8>>> {
    serde_json::to_vec(value)
        .map(Zeroizing::new)
        .map_err(io::Error::other)
}

/// Keep a file that did not read in `aside/`: as it was if it was sealed
/// already, sealed under the data key if it was in clear.
pub fn keep_aside<D: Disk>(store: &Store<D>, unreadable: &Unreadable) -> Result<(), StoreError> {
    if unreadable.in_clear {
        store.put_aside(&Slot::Legacy(unreadable.name.clone()), &unreadable.bytes)
    } else {
        store.put_aside_raw(&raw_aside_name(&unreadable.name), &unreadable.bytes)
    }
}

/// The name in `aside/` of a file of before kept as it was.
fn raw_aside_name(name: &str) -> String {
    format!("legacy.{name}")
}

/// Whether `unreadable` reads back from `aside/` as it was.
fn kept_aside(disk: &impl Disk, dir: &Path, keys: &StoreKeys, unreadable: &Unreadable) -> bool {
    if unreadable.in_clear {
        let slot = Slot::Legacy(unreadable.name.clone());
        disk.read(&dir.join(slot.relative_path()))
            .ok()
            .and_then(|bytes| envelope::open(keys, &slot, &bytes).ok())
            .is_some_and(|opened| opened.content[..] == unreadable.bytes[..])
    } else {
        disk.read(&dir.join("aside").join(raw_aside_name(&unreadable.name)))
            .is_ok_and(|bytes| bytes[..] == unreadable.bytes[..])
    }
}

/// `store.new/` becomes `store/`, on the disk when it returns. Only an empty
/// `store/`, or one the vault no longer opens (a rotation's, `rotate.rs`),
/// can be in the way; it goes first.
pub(super) fn move_new_store(disk: &impl Disk, home: &Path) -> io::Result<()> {
    let store = home.join(STORE_DIR);
    if store.exists() {
        disk.remove_dir_all(&store)?;
    }
    disk.rename_durable(&home.join(NEW_STORE_DIR), &store)
}

/// Whether `name` is one a store set aside goes by, and only that: a single
/// name in the data folder, never a path out of it.
pub fn is_aside_name(name: &str) -> bool {
    name.strip_prefix(super::session::OTHER_STORE_PREFIX)
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// Whether every file in `dir` is a file of the store of another vault than
/// `keys`', and there is one at least: by their headers, which nothing
/// authenticates here, so it is only ever used to remove what no key this
/// vault holds could open anyway.
fn of_another_vault(disk: &impl Disk, dir: &Path, keys: &StoreKeys) -> bool {
    let Ok(names) = disk.list(dir) else {
        return false;
    };
    let ids: Vec<_> = names
        .iter()
        .filter_map(|name| disk.read(&dir.join(name)).ok())
        .map(|bytes| envelope::generation_of(&bytes).map(|(_, id_vault)| id_vault))
        .collect();
    !ids.is_empty()
        && ids
            .iter()
            .all(|id| id.is_some_and(|id_vault| &id_vault != keys.id_vault()))
}

/// Before the store of a vault that carries its key (`record`) opens: finish
/// what a cut left of the migration (the move of `store.new/`, M4), and tell
/// of files of earlier versions that are there without being read.
pub fn settle<D: Disk + Clone>(disk: &D, home: &Path, record: &[u8]) -> io::Result<Settled> {
    let keys = StoreKeys::from_vault_app(record).map_err(io::Error::other)?;
    let store = home.join(STORE_DIR);
    let new = home.join(NEW_STORE_DIR);
    let mut settled = Settled::default();
    if new.exists() {
        // The vault took the key of a migration or of a rotation that was
        // cut before store.new/ became store/: finish it. The store a
        // rotation left (an older generation of this one) opens with no key
        // any vault holds. A rotation the vault never took left a
        // store.new/ of a newer generation, which nothing opens: it goes.
        //
        // Clave de emergencia, design §6.4: the vault took the empty
        // account's store.new/, which names the store it takes the place
        // of (step E5): that store goes aside under the name, in silence,
        // to be removed. A store.new/ of another vault is one the
        // emergency path left when a cut stopped it before the vault step;
        // nothing opens it, and it goes. So does one with no file in it.
        //
        // Anything else there is not this vault's store, and is never
        // removed by itself.
        let new_index = peek_index(disk, &new, &keys);
        let opens = new_index.is_some();
        let replaces = new_index
            .and_then(|index| index.deleting_stores.into_iter().next())
            .filter(|name| is_aside_name(name) && !home.join(name).exists());
        let holds = holds_files(&store)?;
        let in_the_way = holds && generation_in(disk, &store, &keys) != Some(Generation::Older);
        let another_account = holds && peek_index(disk, &store, &keys).is_none();
        if let (true, Some(name)) = (opens && another_account, replaces) {
            disk.rename_durable(&store, &home.join(name))?;
            move_new_store(disk, home)?;
        } else if opens && !in_the_way {
            move_new_store(disk, home)?;
        } else if !opens
            && (generation_in(disk, &new, &keys) == Some(Generation::Newer)
                || of_another_vault(disk, &new, &keys)
                || !holds_files(&new).unwrap_or(true))
        {
            disk.remove_dir_all(&new)?;
        } else {
            disk.rename(&new, &home.join(other_store_name()))?;
            settled
                .findings
                .push(finding(NEW_STORE_DIR, What::OtherAccount, Action::SetAside));
        }
    }
    let pending = peek_index(disk, &store, &keys).is_some_and(|index| index.legacy.cleanup_pending);
    if pending {
        // M4. A file held by another program now is destroyed at the next
        // unlock; until then the index keeps the cleanup pending.
        settled.cleaned = destroy_legacy(disk, home).is_ok();
    } else if !legacy_paths(disk, home)?.is_empty() {
        // Never read without the user asking (design §4.8).
        settled
            .findings
            .push(finding("legacy", What::PlainFiles, Action::OfferImport));
    }
    Ok(settled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::state::FriendRecord;
    use crate::store::disk::cut::{CutDisk, Step};
    use crate::store::disk::faulty::FaultyDisk;
    use crate::store::disk::RealDisk;
    use crate::store::keys::testing::keys;
    use crate::store::session::{legacy_seal, Found, OpenedStore, SessionStore};
    use std::rc::Rc;

    const NOW: i64 = 1_760_000_000;
    const OLD_VAULT: &[u8] = b"the vault of an earlier version, with no data key";
    /// Words that must never be left in clear once the account migrated.
    const SECRETS: [&str; 6] = [
        "Ana Secreta",
        "Beto Secreto",
        "Grupo Secreto",
        "Invitacion Secreta",
        "wss://relay.secreto",
        "STICKER-IMAGE",
    ];

    fn nostr() -> String {
        "ab".repeat(32)
    }

    fn legacy_keys() -> LegacyKeys {
        LegacyKeys {
            history: Zeroizing::new([7; 32]),
            profiles: Zeroizing::new([8; 32]),
        }
    }

    /// Keys another identity would have derived.
    fn other_legacy_keys() -> LegacyKeys {
        LegacyKeys {
            history: Zeroizing::new([17; 32]),
            profiles: Zeroizing::new([18; 32]),
        }
    }

    /// One unlock's new keys and the vault sealed with them. Each unlock
    /// that migrates makes new ones, as `StoreKeys::generate` does.
    struct Attempt {
        record: Zeroizing<Vec<u8>>,
        vault: Vec<u8>,
    }

    fn attempt(byte: u8) -> Attempt {
        Attempt {
            record: keys(byte).to_vault_app(),
            vault: format!("a vault sealed with the store keys {byte}").into_bytes(),
        }
    }

    impl Attempt {
        fn new_vault(&self) -> NewVault<'_> {
            NewVault {
                record: &self.record,
                bytes: &self.vault,
                header: None,
            }
        }
    }

    /// The data key the vault in `home` carries, as `unseal` reads it.
    fn record_in(home: &Path) -> Option<Zeroizing<Vec<u8>>> {
        let vault = std::fs::read(home.join(VAULT_FILE)).unwrap();
        (1..=40)
            .map(attempt)
            .find(|attempt| attempt.vault == vault)
            .map(|attempt| attempt.record)
    }

    fn roster(id: &str, name: &str) -> GroupRoster {
        GroupRoster {
            group_id: id.into(),
            name: name.into(),
            photo: None,
            admin_pub: "cd".repeat(32),
            members: vec![],
            epoch: 3,
            signature: "00".repeat(64),
        }
    }

    fn sticker_id(image: &[u8]) -> String {
        hex::encode(&crate::crypto::sha256(image)[..8])
    }

    /// What the files of an earlier version held.
    struct Written {
        account: AccountFile,
        history: Vec<u8>,
        sessions: Vec<u8>,
        profiles: Vec<u8>,
        /// id, mime and image.
        stickers: Vec<(String, String, Vec<u8>)>,
    }

    /// An account of an earlier version in `home`: the four files in clear,
    /// the three sealed ones, two stickers, a temporary of a cut save, and
    /// a vault with no data key.
    fn legacy_account(home: &Path) -> Written {
        let config = ConfigFile {
            handle: "Ana Secreta".into(),
            nostr_pub: nostr(),
            relays: vec!["wss://relay.secreto".into()],
            created_at: 1_700_000_000,
            avatar: None,
        };
        let beto = FriendRecord {
            handle: "Beto Secreto".into(),
            bundle: crate::identity::public_bundle_for(&crate::identity::create_identity()),
            added_at: 1_700_000_100,
            avatar: None,
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
        };
        let friends = FriendsFile {
            handle: config.handle.clone(),
            friends: vec![beto],
            blocked: vec!["ef".repeat(32)],
        };
        let groups = vec![roster("g1", "Grupo Secreto")];
        let invites = vec![GroupInvite {
            roster: roster("g2", "Invitacion Secreta"),
            from_handle: "Beto Secreto".into(),
            received_at: 1_700_000_200,
        }];
        let write = |name: &str, bytes: &[u8]| std::fs::write(home.join(name), bytes).unwrap();
        write("config.json", &serde_json::to_vec_pretty(&config).unwrap());
        write(
            "friends.json",
            &serde_json::to_vec_pretty(&friends).unwrap(),
        );
        write("groups.json", &serde_json::to_vec_pretty(&groups).unwrap());
        write(
            "group_invites.json",
            &serde_json::to_vec_pretty(&invites).unwrap(),
        );
        let history = br#"{"Beto Secreto":[{"side":"me","text":"hola","ts":1}]}"#.to_vec();
        let sessions = br#"{"ratchets":{},"seen_events":["e1"]}"#.to_vec();
        let profiles = br#"{"own":{"about":"sobre mi"}}"#.to_vec();
        let keys = legacy_keys();
        write(
            "history.bin",
            &legacy_seal(&keys.history, &history).unwrap(),
        );
        write(
            "ratchets.bin",
            &legacy_seal(&keys.history, &sessions).unwrap(),
        );
        write(
            "profiles.bin",
            &legacy_seal(&keys.profiles, &profiles).unwrap(),
        );
        // What a cut save of friends.json left: a full copy, in clear.
        write(
            ".friends.json.tmp-1-2-3",
            &serde_json::to_vec(&friends).unwrap(),
        );
        std::fs::create_dir_all(home.join(STICKERS_DIR)).unwrap();
        let mut stickers = Vec::new();
        for (image, ext, mime) in [
            (b"STICKER-IMAGE one".to_vec(), "png", "image/png"),
            (b"STICKER-IMAGE two".to_vec(), "gif", "image/gif"),
        ] {
            let id = sticker_id(&image);
            std::fs::write(home.join(STICKERS_DIR).join(format!("{id}.{ext}")), &image).unwrap();
            stickers.push((id, mime.to_string(), image));
        }
        stickers.sort();
        write(VAULT_FILE, OLD_VAULT);
        Written {
            account: AccountFile {
                handle: config.handle,
                nostr_pub: nostr(),
                relays: config.relays,
                created_at: config.created_at,
                avatar: None,
                friends: friends.friends,
                blocked: friends.blocked,
                groups,
                group_invites: invites,
                alerts: Default::default(),
            },
            history,
            sessions,
            profiles,
            stickers,
        }
    }

    /// What an unlock found once the store opened.
    struct Unlocked {
        opened: OpenedStore,
        findings: Vec<Finding>,
        cleaned: bool,
    }

    impl Unlocked {
        fn report(&self) -> Vec<(String, What, Action)> {
            let mut all: Vec<Finding> = self.findings.clone();
            all.extend(self.opened.session.report().findings);
            all.into_iter()
                .map(|finding| (finding.file, finding.what, finding.action))
                .collect()
        }
    }

    /// What an unlock does with the files, as `unseal` and `load_session`
    /// do: migrate while the vault carries no data key, with the keys of
    /// `attempt`; then settle and open the store. `None` if the power went
    /// off on the way: nothing after it runs.
    fn unlock(disk: &Rc<CutDisk>, home: &Path, attempt: &Attempt) -> Option<Unlocked> {
        let mut findings = Vec::new();
        let record = match record_in(home) {
            Some(record) => record,
            None => {
                let migrated = migrate(
                    disk,
                    home,
                    &legacy_keys(),
                    &attempt.new_vault(),
                    &nostr(),
                    NOW,
                );
                if disk.is_cut() {
                    return None;
                }
                findings.extend(migrated.expect("the migration failed").findings);
                attempt.record.clone()
            }
        };
        let settled = settle(disk, home, &record);
        if disk.is_cut() {
            return None;
        }
        let settled = settled.unwrap();
        findings.extend(settled.findings);
        let mut opened = SessionStore::open(home, &record, None).unwrap();
        if settled.cleaned {
            opened.session.finish_cleanup();
        }
        Some(Unlocked {
            opened,
            findings,
            cleaned: settled.cleaned,
        })
    }

    fn unlock_whole(home: &Path, attempt_byte: u8) -> Unlocked {
        unlock(&CutDisk::whole(), home, &attempt(attempt_byte)).expect("not cut")
    }

    fn ready(found: &Found) -> &[u8] {
        match found {
            Found::Ready(bytes) => bytes,
            Found::Absent => panic!("absent"),
            Found::Held => panic!("held"),
        }
    }

    fn assert_reads_the_same(unlocked: &Unlocked, written: &Written) {
        let opened = &unlocked.opened;
        let account: AccountFile = serde_json::from_slice(ready(&opened.account)).unwrap();
        assert_eq!(
            serde_json::to_value(&account).unwrap(),
            serde_json::to_value(&written.account).unwrap()
        );
        assert_eq!(ready(&opened.history), written.history);
        assert_eq!(ready(&opened.sessions), written.sessions);
        assert_eq!(ready(&opened.profiles), written.profiles);
        let mut stickers: Vec<(String, String, Vec<u8>)> = opened
            .session
            .stickers()
            .into_iter()
            .map(|sticker| {
                let image = base64::engine::general_purpose::STANDARD
                    .decode(sticker.data)
                    .unwrap();
                (sticker.id, sticker.mime, image)
            })
            .collect();
        stickers.sort();
        assert_eq!(stickers, written.stickers);
    }

    /// Every file under `dir`, with its path.
    fn every_file(dir: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(every_file(&path));
            } else {
                files.push(path);
            }
        }
        files.sort();
        files
    }

    fn names_in(dir: &Path) -> Vec<String> {
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

    fn assert_nothing_in_clear(home: &Path) {
        for path in every_file(home) {
            let bytes = std::fs::read(&path).unwrap();
            let text = String::from_utf8_lossy(&bytes);
            for secret in SECRETS {
                assert!(
                    !text.contains(secret),
                    "{secret} in clear in {}",
                    path.display()
                );
            }
        }
    }

    fn assert_no_legacy_file(home: &Path) {
        let names = names_in(home);
        for name in PLAIN_FILES.iter().chain(SEALED_FILES.iter()) {
            assert!(!names.contains(&name.to_string()), "{name} is left");
        }
        assert!(
            !names.iter().any(|name| name.contains(".tmp-")),
            "{names:?}"
        );
        assert!(names_in(&home.join(STICKERS_DIR)).is_empty());
        assert!(!home.join(NEW_STORE_DIR).exists());
    }

    /// Design §12.4, test 29.
    #[test]
    fn a_legacy_account_migrates_and_reads_the_same() {
        let scratch = ScratchDir::new("migrate-same");
        let written = legacy_account(scratch.path());

        let unlocked = unlock_whole(scratch.path(), 1);

        assert_reads_the_same(&unlocked, &written);
        assert!(unlocked.report().is_empty(), "{:?}", unlocked.report());
        assert!(unlocked.cleaned, "the migration note is not shown");
        assert_eq!(record_in(scratch.path()), Some(attempt(1).record));
        assert_eq!(
            std::fs::read(scratch.path().join(VAULT_FILE)).unwrap(),
            attempt(1).vault
        );
    }

    /// Design §12.4, test 30: the acceptance criterion.
    #[test]
    fn after_migrating_no_json_or_plain_sticker_is_left() {
        let scratch = ScratchDir::new("migrate-nothing-left");
        legacy_account(scratch.path());

        drop(unlock_whole(scratch.path(), 1));

        assert_no_legacy_file(scratch.path());
        assert_nothing_in_clear(scratch.path());
        for path in every_file(scratch.path()) {
            let name = path.file_name().unwrap().to_string_lossy();
            assert!(
                !name.ends_with(".png") && !name.ends_with(".gif") && !name.ends_with(".json"),
                "{}",
                path.display()
            );
        }
    }

    /// The steps of an unlock that migrates the account, with nothing cut.
    fn whole_run() -> Vec<Step> {
        let scratch = ScratchDir::new("migrate-whole-run");
        legacy_account(scratch.path());
        let disk = CutDisk::whole();
        unlock(&disk, scratch.path(), &attempt(1)).unwrap();
        let steps = disk.steps.borrow().clone();
        steps
    }

    /// A cut at step `at`, losing the newest `lose` changes not on the disk
    /// yet (`usize::MAX`: all of them); then unlocks until the account is
    /// whole. Nothing may be lost.
    fn cut_and_recover(at: usize, lose: usize) {
        let scratch = ScratchDir::new("migrate-cut");
        let home = scratch.path();
        let written = legacy_account(home);
        let disk = CutDisk::cut_at(at);
        assert!(
            unlock(&disk, home, &attempt(1)).is_none(),
            "step {at} is past the end"
        );
        disk.lose_last(lose.min(disk.unflushed()));

        let unlocked = unlock_whole(home, 2);
        assert_reads_the_same(&unlocked, &written);
        assert!(
            unlocked.report().is_empty(),
            "cut at {at}, lost {lose}: {:?}",
            unlocked.report()
        );
        drop(unlocked);
        assert_no_legacy_file(home);
        assert_nothing_in_clear(home);

        // And it stays so.
        let again = unlock_whole(home, 3);
        assert_reads_the_same(&again, &written);
        assert!(again.report().is_empty(), "{:?}", again.report());
        assert!(!again.cleaned);
    }

    /// Clave de emergencia CE-3 (design §3.6): the migration commits its
    /// vault as every vault is written, through `vault.bin.next` first.
    #[test]
    fn the_migration_commits_its_vault_through_next() {
        let steps = whole_run();
        let next = steps
            .iter()
            .position(
                |step| matches!(step, Step::WriteDurable(path) if path.ends_with("vault.bin.next")),
            )
            .expect("the vault went through vault.bin.next");
        assert!(
            !steps
                .iter()
                .any(|step| matches!(step, Step::WriteDurable(path) if path.ends_with(VAULT_FILE))),
            "vault.bin was replaced by a rename"
        );
        let moved = steps
            .iter()
            .position(|step| matches!(step, Step::RenameDurable(_, to) if to.ends_with(STORE_DIR)))
            .unwrap();
        assert!(next < moved);
    }

    /// Design §12.4, test 31: a cut at every step.
    #[test]
    fn a_cut_at_every_step_loses_nothing() {
        let steps = whole_run().len();
        assert!(steps > 15, "{steps} steps");
        for at in 0..steps {
            cut_and_recover(at, 0);
        }
    }

    /// Design §12.4, test 62: a cut at every step that also undoes the last
    /// rename the disk had not made durable, or every one of them.
    #[test]
    fn a_lost_last_rename_before_cleanup_loses_nothing() {
        let steps = whole_run().len();
        for at in 0..steps {
            cut_and_recover(at, 1);
            cut_and_recover(at, usize::MAX);
        }
    }

    /// The test disk itself: what a cut loses is the newest changes since
    /// the last durable one.
    #[test]
    fn the_test_disk_loses_only_what_was_not_on_the_disk() {
        let scratch = ScratchDir::new("migrate-cut-disk");
        let dir = scratch.path();
        let disk = CutDisk::cut_at(4);
        disk.write(&dir.join("a"), b"a1").unwrap();
        disk.write_durable(&dir.join("b"), b"b1").unwrap();
        disk.write(&dir.join("a"), b"a2").unwrap();
        disk.rename(&dir.join("b"), &dir.join("c")).unwrap();
        assert!(disk.write(&dir.join("d"), b"d").is_err());
        assert!(disk.is_cut());
        assert!(disk.write(&dir.join("e"), b"e").is_err());
        assert_eq!(disk.unflushed(), 2);

        disk.lose_last(1);
        assert_eq!(names_in(dir), ["a", "b"]);
        disk.lose_last(1);
        assert_eq!(std::fs::read(dir.join("a")).unwrap(), b"a1");
        assert_eq!(std::fs::read(dir.join("b")).unwrap(), b"b1");
    }

    /// Design §12.4, test 32.
    #[test]
    fn migrating_twice_changes_nothing() {
        let scratch = ScratchDir::new("migrate-twice");
        let home = scratch.path();
        let written = legacy_account(home);
        drop(unlock_whole(home, 1));
        let store: Vec<(PathBuf, Vec<u8>)> = every_file(home)
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();

        let disk = CutDisk::whole();
        let again = unlock(&disk, home, &attempt(2)).unwrap();

        assert_reads_the_same(&again, &written);
        assert!(again.report().is_empty());
        assert!(disk.steps.borrow().is_empty(), "{:?}", disk.steps.borrow());
        drop(again);
        let after: Vec<(PathBuf, Vec<u8>)> = every_file(home)
            .into_iter()
            .map(|path| {
                let bytes = std::fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();
        assert_eq!(after, store, "the second unlock changed the files");
        assert_eq!(record_in(home), Some(attempt(1).record));
    }

    /// Design §12.4, test 33: files of before that appear once the vault
    /// carries its key are never read, not even when `store/` is gone.
    #[test]
    fn legacy_files_appearing_after_migration_are_never_read() {
        let scratch = ScratchDir::new("migrate-planted-after");
        let home = scratch.path();
        let planted_dir = ScratchDir::new("migrate-planted-source");
        legacy_account(planted_dir.path());
        legacy_account(home);
        drop(unlock_whole(home, 1));
        for name in PLAIN_FILES.iter().chain(SEALED_FILES.iter()) {
            std::fs::copy(planted_dir.path().join(name), home.join(name)).unwrap();
        }
        let planted: Vec<Vec<u8>> = PLAIN_FILES
            .iter()
            .map(|name| std::fs::read(home.join(name)).unwrap())
            .collect();

        // A disk on which reading any of them fails: settle must not read.
        let faulty = Rc::new(FaultyDisk::default());
        for name in PLAIN_FILES.iter().chain(SEALED_FILES.iter()) {
            faulty.fail_reads.borrow_mut().insert(name.to_string());
        }
        let settled = settle(&faulty, home, &attempt(1).record).unwrap();
        assert!(!settled.cleaned);
        let found: Vec<(String, What, Action)> = settled
            .findings
            .into_iter()
            .map(|finding| (finding.file, finding.what, finding.action))
            .collect();
        assert_eq!(
            found,
            [("legacy".to_string(), What::PlainFiles, Action::OfferImport)]
        );

        let unlocked = unlock_whole(home, 2);
        assert_eq!(
            unlocked.report(),
            [("legacy".to_string(), What::PlainFiles, Action::OfferImport)]
        );
        let account: AccountFile = serde_json::from_slice(ready(&unlocked.opened.account)).unwrap();
        assert_eq!(account.friends.len(), 1);
        drop(unlocked);
        // Left as they were, for the user to look at, import or remove.
        let after: Vec<Vec<u8>> = PLAIN_FILES
            .iter()
            .map(|name| std::fs::read(home.join(name)).unwrap())
            .collect();
        assert_eq!(after, planted);

        // With store/ gone as well, the vault still says the account moved:
        // nothing is migrated, and the data is missing.
        std::fs::remove_dir_all(home.join(STORE_DIR)).unwrap();
        let unlocked = unlock_whole(home, 3);
        assert!(matches!(unlocked.opened.account, Found::Absent));
        let report = unlocked.report();
        assert!(report.contains(&("store".to_string(), What::Missing, Action::Empty)));
        assert!(report.contains(&("legacy".to_string(), What::PlainFiles, Action::OfferImport)));
        assert_eq!(record_in(home), Some(attempt(1).record));
    }

    /// Design §12.4, test 34, the store's side: the files of before are read
    /// only by `read_legacy`, which nothing calls unless the user asks.
    #[test]
    fn legacy_files_are_imported_only_when_asked() {
        let scratch = ScratchDir::new("migrate-import-asked");
        let home = scratch.path();
        let written = legacy_account(home);
        std::fs::remove_file(home.join("history.bin")).unwrap();
        std::fs::remove_file(home.join("ratchets.bin")).unwrap();
        std::fs::remove_file(home.join("profiles.bin")).unwrap();
        drop(unlock_whole(home, 1));

        let read = read_legacy(&RealDisk, home, &legacy_keys(), &nostr(), NOW).unwrap();

        let account = read.account.unwrap();
        assert_eq!(
            serde_json::to_value(&account).unwrap(),
            serde_json::to_value(&written.account).unwrap()
        );
        assert_eq!(read.stickers.len(), 2);
        assert!(read.history.is_none());
        assert!(read.unreadable.is_empty());
        // "Borrarlos".
        destroy_legacy(&RealDisk, home).unwrap();
        assert_no_legacy_file(home);
        assert!(legacy_paths(&RealDisk, home).unwrap().is_empty());
    }

    /// Design §12.4, test 35.
    #[test]
    fn a_legacy_history_that_does_not_open_is_set_aside_and_the_rest_migrates() {
        let scratch = ScratchDir::new("migrate-history-damaged");
        let home = scratch.path();
        let written = legacy_account(home);
        let mut damaged = std::fs::read(home.join("history.bin")).unwrap();
        let last = damaged.len() - 1;
        damaged[last] ^= 1;
        std::fs::write(home.join("history.bin"), &damaged).unwrap();
        std::fs::write(
            home.join(DAMAGED_PROFILES),
            b"an older damaged profiles.bin",
        )
        .unwrap();

        let unlocked = unlock_whole(home, 1);

        assert!(matches!(unlocked.opened.history, Found::Absent));
        let account: AccountFile = serde_json::from_slice(ready(&unlocked.opened.account)).unwrap();
        assert_eq!(
            serde_json::to_value(&account).unwrap(),
            serde_json::to_value(&written.account).unwrap()
        );
        assert_eq!(ready(&unlocked.opened.sessions), written.sessions);
        let report = unlocked.report();
        assert!(report.contains(&("history.bin".to_string(), What::Altered, Action::SetAside)));
        assert!(report.contains(&(
            DAMAGED_PROFILES.to_string(),
            What::Altered,
            Action::SetAside
        )));
        let aside = home.join(STORE_DIR).join("aside");
        assert_eq!(
            std::fs::read(aside.join("legacy.history.bin")).unwrap(),
            damaged
        );
        assert_eq!(
            std::fs::read(aside.join(format!("legacy.{DAMAGED_PROFILES}"))).unwrap(),
            b"an older damaged profiles.bin"
        );
        drop(unlocked);
        assert_no_legacy_file(home);
        assert!(!home.join(DAMAGED_PROFILES).exists());
    }

    /// Whether `path` is in `store/` or `store.new/`.
    fn in_a_store(path: &Path) -> bool {
        path.ancestors().any(|dir| {
            dir.file_name()
                .is_some_and(|name| name == NEW_STORE_DIR || name == STORE_DIR)
        })
    }

    /// Design §12.4, test 36: each file of before is destroyed, never just
    /// removed (`fsutil::destroy_file` overwrites it first).
    #[test]
    fn legacy_files_are_overwritten_before_they_are_removed() {
        let steps = whole_run();
        let legacy: Vec<String> = PLAIN_FILES
            .iter()
            .chain(SEALED_FILES.iter())
            .map(|name| name.to_string())
            .collect();
        let mut destroyed = Vec::new();
        for step in &steps {
            match step {
                Step::Destroy(path) => {
                    destroyed.push(path.file_name().unwrap().to_string_lossy().into_owned())
                }
                // The store's own history.bin has a legacy name too.
                Step::Remove(path) | Step::Write(path) | Step::WriteDurable(path)
                    if !in_a_store(path) =>
                {
                    let name = path.file_name().unwrap().to_string_lossy().into_owned();
                    assert!(!legacy.contains(&name), "{step:?}");
                }
                _ => {}
            }
        }
        for name in &legacy {
            assert!(destroyed.contains(name), "{name} was not destroyed");
        }
        assert!(destroyed
            .iter()
            .any(|name| name.starts_with(".friends.json.tmp-")));
        assert_eq!(
            destroyed
                .iter()
                .filter(|name| name.ends_with(".png") || name.ends_with(".gif"))
                .count(),
            2
        );
    }

    /// Design §12.4, test 61: `.json` files with no proof that they are this
    /// account's are neither migrated nor noted as migrated.
    #[test]
    fn planted_legacy_files_without_store_are_not_migrated_silently() {
        for sealed_with_other_keys in [false, true] {
            let scratch = ScratchDir::new("migrate-no-proof");
            let home = scratch.path();
            legacy_account(home);
            for name in SEALED_FILES {
                std::fs::remove_file(home.join(name)).unwrap();
            }
            if sealed_with_other_keys {
                let other = other_legacy_keys();
                std::fs::write(
                    home.join("history.bin"),
                    legacy_seal(&other.history, b"{}").unwrap(),
                )
                .unwrap();
                std::fs::write(
                    home.join("profiles.bin"),
                    legacy_seal(&other.profiles, b"{}").unwrap(),
                )
                .unwrap();
            }
            let before: Vec<(PathBuf, Vec<u8>)> = every_file(home)
                .into_iter()
                .filter(|path| path.file_name().unwrap() != VAULT_FILE)
                .map(|path| {
                    let bytes = std::fs::read(&path).unwrap();
                    (path, bytes)
                })
                .collect();

            let unlocked = unlock_whole(home, 1);

            assert!(matches!(unlocked.opened.account, Found::Absent));
            assert!(matches!(unlocked.opened.history, Found::Absent));
            assert!(unlocked.opened.session.stickers().is_empty());
            assert!(!unlocked.cleaned, "the migration note would show");
            assert_eq!(
                unlocked.report(),
                [("legacy".to_string(), What::PlainFiles, Action::OfferImport)]
            );
            drop(unlocked);
            // Untouched, and nothing of them in the store.
            for (path, bytes) in &before {
                assert_eq!(&std::fs::read(path).unwrap(), bytes, "{}", path.display());
            }
            assert_nothing_in_clear(&home.join(STORE_DIR));
            // The vault carries a key now: the next unlock does not migrate.
            assert_eq!(record_in(home), Some(attempt(1).record));
            let again = unlock_whole(home, 2);
            assert!(matches!(again.opened.account, Found::Absent));
        }
    }

    /// Design §12.4, test 63: the files of before are touched only after
    /// the vault with the new key and the move of `store.new/` are on the
    /// disk.
    #[test]
    fn nothing_old_is_touched_before_the_disk_step() {
        let steps = whole_run();
        // The vault is written over in place, after its copy in
        // vault.bin.next (clave de emergencia CE-3, design §3.6).
        let vault = steps
            .iter()
            .position(|step| {
                matches!(step, Step::Overwrite(path) if path.file_name().unwrap() == VAULT_FILE)
            })
            .expect("the vault is not written durably");
        let moved = steps
            .iter()
            .position(|step| {
                matches!(step, Step::RenameDurable(from, to)
                    if from.file_name().unwrap() == NEW_STORE_DIR
                        && to.file_name().unwrap() == STORE_DIR)
            })
            .expect("store.new is not moved durably");
        assert!(
            vault < moved,
            "the store moved before the vault held its key"
        );
        let first_old = steps
            .iter()
            .position(|step| {
                let path = match step {
                    Step::Write(path)
                    | Step::WriteDurable(path)
                    | Step::Remove(path)
                    | Step::Overwrite(path)
                    | Step::Destroy(path)
                    | Step::RemoveDir(path) => path,
                    Step::Rename(from, _) | Step::RenameDurable(from, _) => from,
                };
                let name = path.file_name().unwrap().to_string_lossy();
                !in_a_store(path) && !name.starts_with(VAULT_FILE)
            })
            .expect("nothing old was destroyed");
        assert!(
            first_old > moved,
            "{:?} before the disk step",
            steps[first_old]
        );
    }

    /// Design §12.4, test 64.
    #[test]
    fn an_unreadable_plain_json_goes_aside_sealed_never_in_clear() {
        let scratch = ScratchDir::new("migrate-unreadable-json");
        let home = scratch.path();
        let written = legacy_account(home);
        let broken = b"{ \"handle\": \"Ana Secreta\", \"friends\": [ \"Beto Secreto\"".to_vec();
        std::fs::write(home.join("friends.json"), &broken).unwrap();

        let unlocked = unlock_whole(home, 1);

        assert!(unlocked.report().contains(&(
            "friends.json".to_string(),
            What::Altered,
            Action::SetAside
        )));
        let account: AccountFile = serde_json::from_slice(ready(&unlocked.opened.account)).unwrap();
        assert_eq!(account.handle, written.account.handle);
        assert!(account.friends.is_empty());
        assert_eq!(
            serde_json::to_value(&account.groups).unwrap(),
            serde_json::to_value(&written.account.groups).unwrap()
        );
        drop(unlocked);
        assert_nothing_in_clear(home);
        let slot = Slot::Legacy("friends.json".into());
        let kept = std::fs::read(home.join(STORE_DIR).join(slot.relative_path())).unwrap();
        let opened = envelope::open(&keys(1), &slot, &kept).unwrap();
        assert_eq!(&*opened.content, &broken[..]);
        assert_no_legacy_file(home);
    }

    #[test]
    fn a_store_new_the_vault_never_took_is_discarded_and_the_migration_starts_again() {
        let scratch = ScratchDir::new("migrate-leftover-new");
        let home = scratch.path();
        let written = legacy_account(home);
        // What a cut before the commit leaves: a whole store.new/ under keys
        // the vault never held.
        let leftover = home.join(NEW_STORE_DIR);
        Store::create(&leftover, keys(9), RealDisk)
            .unwrap()
            .write(&Slot::Account, b"{}")
            .unwrap();

        let unlocked = unlock_whole(home, 1);

        assert_reads_the_same(&unlocked, &written);
        assert!(unlocked.report().is_empty(), "{:?}", unlocked.report());
        assert!(!leftover.exists());
    }

    /// Design §5.6: a store this vault has no key to is never removed by
    /// itself; the vault may have been put back to a copy from before.
    #[test]
    fn a_store_this_vault_cannot_open_is_moved_aside_never_removed() {
        let scratch = ScratchDir::new("migrate-foreign-store");
        let home = scratch.path();
        let written = legacy_account(home);
        Store::create(&home.join(STORE_DIR), keys(9), RealDisk)
            .unwrap()
            .write(&Slot::Account, b"{}")
            .unwrap();

        let unlocked = unlock_whole(home, 1);

        assert_reads_the_same(&unlocked, &written);
        assert_eq!(
            unlocked.report(),
            [("store".to_string(), What::OtherAccount, Action::SetAside)]
        );
        let aside: Vec<String> = names_in(home)
            .into_iter()
            .filter(|name| name.starts_with(super::super::session::OTHER_STORE_PREFIX))
            .collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(
            names_in(&home.join(&aside[0])),
            ["account.bin", "index.bin"]
        );
    }

    /// A vault with no data key, and nothing of the account: the data are
    /// missing, and the account gets its store.
    #[test]
    fn a_vault_with_no_files_reports_the_data_missing() {
        let scratch = ScratchDir::new("migrate-nothing");
        let home = scratch.path();
        std::fs::write(home.join(VAULT_FILE), OLD_VAULT).unwrap();

        let unlocked = unlock_whole(home, 1);

        assert!(matches!(unlocked.opened.account, Found::Absent));
        assert_eq!(
            unlocked.report(),
            [("store".to_string(), What::Missing, Action::Empty)]
        );
        drop(unlocked);
        assert!(unlock_whole(home, 2).report().is_empty());
    }

    /// A file that cannot be read now (another program holds it) stops the
    /// migration before anything is written; the next unlock tries again.
    #[test]
    fn a_legacy_file_that_cannot_be_read_now_stops_the_migration_untouched() {
        for (held, proof) in [
            ("friends.json", true),
            ("history.bin", true),
            ("profiles.bin", true),
        ] {
            let scratch = ScratchDir::new("migrate-held");
            let home = scratch.path();
            let written = legacy_account(home);
            if held == "profiles.bin" {
                // The only proof, and it cannot be read now.
                std::fs::remove_file(home.join("history.bin")).unwrap();
                std::fs::remove_file(home.join("ratchets.bin")).unwrap();
            }
            let before = every_file(home);
            let faulty = Rc::new(FaultyDisk::default());
            faulty.fail_reads.borrow_mut().insert(held.to_string());
            let failed = migrate(
                &faulty,
                home,
                &legacy_keys(),
                &attempt(1).new_vault(),
                &nostr(),
                NOW,
            )
            .err()
            .unwrap_or_else(|| panic!("{held} held, and it migrated"));

            assert_eq!(failed.proof, proof && held != "profiles.bin", "{held}");
            assert_eq!(failed.error.kind(), io::ErrorKind::PermissionDenied);
            assert_eq!(every_file(home), before, "{held}");
            assert_eq!(std::fs::read(home.join(VAULT_FILE)).unwrap(), OLD_VAULT);
            if held == "profiles.bin" {
                continue;
            }
            let unlocked = unlock_whole(home, 2);
            assert_eq!(
                serde_json::to_value(
                    serde_json::from_slice::<AccountFile>(ready(&unlocked.opened.account)).unwrap()
                )
                .unwrap(),
                serde_json::to_value(&written.account).unwrap()
            );
        }
    }

    /// The index notes the vault the migration commits (design §4.9), so the
    /// next unlock does not take it for another one.
    #[test]
    fn the_index_notes_the_new_vault() {
        let scratch = ScratchDir::new("migrate-vault-note");
        let home = scratch.path();
        legacy_account(home);
        let attempt = attempt(1);
        let header = VaultHeader {
            version: 2,
            flags: 1,
            salt: hex::encode([5u8; 16]),
            spk: 4,
        };
        let vault = NewVault {
            header: Some(header.clone()),
            ..attempt.new_vault()
        };
        migrate(&RealDisk, home, &legacy_keys(), &vault, &nostr(), NOW).unwrap();

        let index = peek_index(&RealDisk, &home.join(STORE_DIR), &keys(1)).unwrap();
        assert_eq!(index.vault, Some(header.clone()));
        assert_eq!(
            index.legacy,
            Legacy {
                migrated: true,
                cleanup_pending: true,
                prefs_imported: false
            }
        );
        let opened = SessionStore::open(home, &attempt.record, Some(header)).unwrap();
        assert!(opened.session.report().is_empty());
    }

    /// M4 that ran, with its note to the index lost: the next unlock does it
    /// again, in silence.
    #[test]
    fn a_cleanup_whose_note_was_lost_is_done_again_in_silence() {
        let scratch = ScratchDir::new("migrate-cleanup-again");
        let home = scratch.path();
        let written = legacy_account(home);
        migrate(
            &RealDisk,
            home,
            &legacy_keys(),
            &attempt(1).new_vault(),
            &nostr(),
            NOW,
        )
        .unwrap();
        let settled = settle(&RealDisk, home, &attempt(1).record).unwrap();
        assert!(settled.cleaned);
        // The session never noted it.

        let unlocked = unlock_whole(home, 2);

        assert!(unlocked.cleaned);
        assert!(unlocked.report().is_empty(), "{:?}", unlocked.report());
        assert_reads_the_same(&unlocked, &written);
        drop(unlocked);
        assert!(!unlock_whole(home, 3).cleaned);
    }

    // ---- Clave de emergencia, design §6.4 ----

    /// A store in `dir` under `keys(byte)`, with an account in it.
    fn store_of(dir: &Path, byte: u8) -> Store<RealDisk> {
        let mut store = Store::create(dir, keys(byte), RealDisk).unwrap();
        store.write(&Slot::Account, b"{\"handle\":\"x\"}").unwrap();
        store
    }

    fn aside_dirs(home: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(home)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(super::super::session::OTHER_STORE_PREFIX))
            .collect();
        names.sort();
        names
    }

    /// Design §6.4, third row: a `store.new/` of another vault, which the
    /// emergency path leaves if it is cut before it changes the vault,
    /// goes in silence. Nothing opens it: the keys it was made with were
    /// only ever in memory.
    #[test]
    fn a_store_new_of_another_vault_goes_in_silence() {
        for empty in [false, true] {
            let scratch = ScratchDir::new("settle-other-new");
            let home = scratch.path();
            drop(store_of(&home.join(STORE_DIR), 1));
            if empty {
                // A cut before its first file reached the disk.
                std::fs::create_dir_all(home.join(NEW_STORE_DIR).join("stickers")).unwrap();
            } else {
                drop(store_of(&home.join(NEW_STORE_DIR), 2));
            }

            let settled = settle(&RealDisk, home, &keys(1).to_vault_app()).unwrap();

            assert!(settled.findings.is_empty(), "{:?}", settled.findings);
            assert!(!home.join(NEW_STORE_DIR).exists());
            assert!(peek_index(&RealDisk, &home.join(STORE_DIR), &keys(1)).is_some());
            assert!(aside_dirs(home).is_empty());
        }
    }

    /// Design §6.4, fourth row (step E5 a cut stopped): the `store.new/`
    /// the vault opens names the store it takes the place of. That store
    /// goes aside under the name, in silence, and `store.new/` becomes
    /// `store/`; a store CL set aside before stays where it is (RC-11).
    #[test]
    fn a_store_new_that_names_the_store_it_replaces_takes_its_place() {
        for moved_already in [false, true] {
            let scratch = ScratchDir::new("settle-replaces");
            let home = scratch.path();
            let aside = "store-aside-000000000000000000000002".to_string();
            let kept_by_cl = home.join("store-aside-000000000000000000000001");
            drop(store_of(&kept_by_cl, 9));
            let old_at = if moved_already {
                home.join(&aside)
            } else {
                home.join(STORE_DIR)
            };
            drop(store_of(&old_at, 1));
            let mut new = store_of(&home.join(NEW_STORE_DIR), 2);
            new.note_new_store(None, Legacy::default(), vec![aside.clone()])
                .unwrap();
            drop(new);

            let settled = settle(&RealDisk, home, &keys(2).to_vault_app()).unwrap();

            assert!(settled.findings.is_empty(), "{:?}", settled.findings);
            assert!(!home.join(NEW_STORE_DIR).exists());
            let index = peek_index(&RealDisk, &home.join(STORE_DIR), &keys(2)).unwrap();
            assert_eq!(index.deleting_stores, std::slice::from_ref(&aside));
            assert!(peek_index(&RealDisk, &home.join(&aside), &keys(1)).is_some());
            assert!(peek_index(&RealDisk, &kept_by_cl, &keys(9)).is_some());
            assert_eq!(
                aside_dirs(home),
                ["store-aside-000000000000000000000001", &aside]
            );
        }
    }
}
