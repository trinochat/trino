//! The store on disk: how it is written and how it is read at unlock (design
//! §4.6 and §6).
//!
//! **Writing**, one file at a time and always in this order:
//! 1. the new `seq` is one more than the highest the store has handed out or
//!    seen, the index's included, so it never repeats even when an index
//!    write fails;
//! 2. the file is written with that `seq`, atomically;
//! 3. the index is written with the file's new `seq`.
//!
//! No two data files are ever written without the index in between, so a
//! cut leaves at most one file one step ahead. If the index cannot be
//! written, the next write tries it again first and, while it still fails,
//! the data waits in memory; at lock, `flush_for_lock` writes the waiting
//! data anyway, and the next unlock asks (design §4.6).
//!
//! **Removing** a file notes it in the index's `deleting` first, removes it,
//! and drops the note: a cut in between is finished in silence.
//!
//! **Reading at unlock** follows the table of design §4.6: a file at its
//! listed `seq` is verified; one file one step ahead is a cut, and the index
//! catches up in silence; an older copy, or anything the index cannot vouch
//! for (missing, broken, unreadable or behind), is not used and not written
//! until the user chooses, and sessions are never reused; a changed, planted
//! or unlisted file is set aside in `aside/`, unopened. Nothing here writes
//! over a file it refused.

use super::disk::Disk;
use super::envelope::{self, Slot};
use super::index::{Index, Legacy, VaultHeader};
use super::keys::StoreKeys;
use super::report::{action_for, Action, IntegrityReport, What};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The copies of each kind kept in `aside/`; older ones are removed.
pub(crate) const ASIDE_PER_KIND: usize = 3;
const INDEX_FILE: &str = "index.bin";
const ASIDE_DIR: &str = "aside";
const STICKERS_DIR: &str = "stickers";

#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreError {
    /// The index names another vault: this is another account's store.
    /// Nothing in it was touched.
    #[error("the store belongs to another account")]
    OtherAccount,
    /// `create` found a store already there.
    #[error("a store exists already")]
    Exists,
    /// The file, or the whole store, could not be read at unlock: it is not
    /// written in this session.
    #[error("{0} is not written in this session")]
    Frozen(String),
    /// The file waits for the user's choice, or the index does.
    #[error("{0} waits for a choice")]
    ChoicePending(String),
    /// `choose` on a file that waits for nothing.
    #[error("{0} waits for no choice")]
    NotPending(String),
    #[error("envelope: {0}")]
    Envelope(#[from] envelope::EnvelopeError),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// What `open` found, for the session.
#[derive(Default)]
pub(crate) struct Loaded {
    /// Files to use: verified, and stickers that need no check.
    pub(crate) ready: BTreeMap<Slot, Zeroizing<Vec<u8>>>,
    /// Files that wait for the user's choice (an older copy, or unverified):
    /// not to be used until `choose` says so.
    pub(crate) awaiting_choice: BTreeMap<Slot, Zeroizing<Vec<u8>>>,
    pub(crate) report: IntegrityReport,
}

/// The store of one account, open for the session.
pub(crate) struct Store<D: Disk> {
    dir: PathBuf,
    keys: StoreKeys,
    disk: D,
    /// What the store holds now; on disk once `index_saved`.
    index: Index,
    /// The highest `seq` handed out or seen. Only grows.
    seq: u64,
    index_saved: bool,
    /// The index on disk vouches for the files.
    index_trusted: bool,
    /// The index could not be read at unlock: nothing is written this
    /// session, so it is never written over.
    index_frozen: bool,
    /// Data waiting for the index to be written; one file at a time goes
    /// out, each followed by the index.
    waiting: BTreeMap<Slot, Zeroizing<Vec<u8>>>,
    /// Files that could not be read at unlock: never written this session.
    frozen: BTreeSet<Slot>,
    /// Files that wait for the user's choice, with the `seq` they hold.
    pending: BTreeMap<Slot, u64>,
}

/// What the index on disk turned out to be at unlock.
enum IndexState {
    Opened(Index),
    Missing,
    Altered,
    Unreadable,
}

impl<D: Disk> Store<D> {
    /// A new, empty store in `dir`, its index written. Never replaces a store
    /// that is there.
    pub(crate) fn create(dir: &Path, keys: StoreKeys, disk: D) -> Result<Self, StoreError> {
        if !disk.list(dir)?.is_empty() || !disk.list(&dir.join(STICKERS_DIR))?.is_empty() {
            return Err(StoreError::Exists);
        }
        let mut store = Store {
            dir: dir.to_path_buf(),
            keys,
            disk,
            index: Index::new(0),
            seq: 0,
            index_saved: false,
            index_trusted: true,
            index_frozen: false,
            waiting: BTreeMap::new(),
            frozen: BTreeSet::new(),
            pending: BTreeMap::new(),
        };
        store.bump_and_save_index()?;
        Ok(store)
    }

    /// Open the store in `dir` at unlock, following the read rules. Refuses
    /// a store whose index belongs to another vault, touching nothing.
    pub(crate) fn open(dir: &Path, keys: StoreKeys, disk: D) -> Result<(Self, Loaded), StoreError> {
        remove_temporaries(&disk, dir);
        remove_temporaries(&disk, &dir.join(STICKERS_DIR));
        let state = read_index(&disk, dir, &keys)?;
        let mut present = present_slots(&disk, dir)?;
        let mut report = IntegrityReport::default();
        let mut frozen = BTreeSet::new();

        // An empty folder is a store with nothing in it yet.
        let state = match state {
            IndexState::Missing if present.is_empty() => IndexState::Opened(Index::new(0)),
            state => state,
        };
        let (mut index, mut trusted) = match &state {
            IndexState::Opened(index) => (index.clone(), true),
            _ => (Index::new(0), false),
        };
        let mut dirty = false;
        let mut seen = index.seq;

        // Removals a cut left half done are finished, in silence.
        for name in std::mem::take(&mut index.deleting) {
            dirty = true;
            if let Some(slot) = Slot::from_logical_name(&name) {
                present.retain(|other| other != &slot);
                match disk.remove(&dir.join(slot.relative_path())) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                        index.deleting.push(name);
                        continue;
                    }
                    _ => {}
                }
            }
            index.files.remove(&name);
        }

        // Open every file; set aside what does not open.
        let mut opened = Vec::new();
        for slot in present {
            let path = dir.join(slot.relative_path());
            let listed = trusted && index.files.contains_key(&slot.logical_name());
            let bytes = match disk.read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    report.push(&slot, What::Unreadable);
                    frozen.insert(slot);
                    continue;
                }
            };
            match envelope::open(&keys, &slot, &bytes) {
                Ok(file) => {
                    seen = seen.max(file.seq);
                    opened.push((slot, file));
                }
                // An orphan of another account: a wipe that was cut short.
                Err(error) if error.is_other_vault() && trusted && !listed => {
                    let _ = disk.remove(&path);
                }
                Err(_) => {
                    report.push(&slot, What::Altered);
                    set_aside_or_freeze(&disk, dir, &slot, &mut frozen);
                    if index.files.remove(&slot.logical_name()).is_some() {
                        dirty = true;
                    }
                }
            }
        }

        let mut loaded = Loaded::default();
        let mut pending = BTreeMap::new();
        let mut unverified = Vec::new();
        if trusted {
            let mut verified = Vec::new();
            let mut older = Vec::new();
            let mut ahead = Vec::new();
            for (slot, file) in opened {
                match index.files.get(&slot.logical_name()).copied() {
                    Some(listed) if file.seq == listed => verified.push((slot, file)),
                    Some(listed) if file.seq < listed => older.push((slot, file)),
                    Some(_) => ahead.push((slot, file)),
                    None if file.seq > index.seq => ahead.push((slot, file)),
                    // Planted, or a removed file that came back: the index
                    // was already past it when it was written.
                    None => {
                        report.push(&slot, What::Unlisted);
                        set_aside_or_freeze(&disk, dir, &slot, &mut frozen);
                    }
                }
            }
            let cut = ahead.len() == 1 && ahead[0].1.seq == index.seq + 1;
            if ahead.is_empty() || cut {
                // A cut between writing a file and its index: catch up.
                if let Some((slot, file)) = ahead.pop() {
                    index.files.insert(slot.logical_name(), file.seq);
                    index.seq = file.seq;
                    dirty = true;
                    verified.push((slot, file));
                }
                for (slot, file) in verified {
                    loaded.ready.insert(slot, file.content);
                }
                for (slot, file) in older {
                    report.push(&slot, What::OlderCopy);
                    if action_for(&slot, What::OlderCopy) == Action::Ask {
                        pending.insert(slot.clone(), file.seq);
                        loaded.awaiting_choice.insert(slot, file.content);
                    } else {
                        set_aside_or_freeze(&disk, dir, &slot, &mut frozen);
                        index.files.remove(&slot.logical_name());
                        dirty = true;
                    }
                }
            } else {
                // The index is behind: someone put an older copy back, or it
                // could not be written. Nothing it says counts.
                report.push(&Slot::Index, What::Behind);
                trusted = false;
                unverified.extend(verified);
                unverified.extend(older);
                unverified.extend(ahead);
            }
        } else {
            match state {
                IndexState::Missing => report.push(&Slot::Index, What::Missing),
                IndexState::Altered => {
                    report.push(&Slot::Index, What::Altered);
                    let _ = set_aside(&disk, dir, &Slot::Index);
                }
                IndexState::Unreadable => report.push(&Slot::Index, What::Unreadable),
                IndexState::Opened(_) => unreachable!("an opened index is trusted"),
            }
            unverified = opened;
        }

        if !trusted {
            // A new index, written once nothing waits: it lists only what
            // is used, and continues past every seq seen.
            index = Index {
                seq: seen,
                files: BTreeMap::new(),
                deleting: Vec::new(),
                ..index
            };
            for (slot, file) in unverified {
                report.push(&slot, What::Unverified);
                match action_for(&slot, What::Unverified) {
                    Action::Use => {
                        index.files.insert(slot.logical_name(), file.seq);
                        loaded.ready.insert(slot, file.content);
                    }
                    Action::Ask => {
                        pending.insert(slot.clone(), file.seq);
                        loaded.awaiting_choice.insert(slot, file.content);
                    }
                    _ => set_aside_or_freeze(&disk, dir, &slot, &mut frozen),
                }
            }
        } else {
            // Listed files that are gone.
            for name in index.files.keys().cloned().collect::<Vec<_>>() {
                let gone = match Slot::from_logical_name(&name) {
                    Some(slot) => {
                        let here = loaded.ready.contains_key(&slot)
                            || pending.contains_key(&slot)
                            || frozen.contains(&slot);
                        if !here {
                            report.push(&slot, What::Missing);
                        }
                        !here
                    }
                    None => true,
                };
                if gone {
                    index.files.remove(&name);
                    dirty = true;
                }
            }
        }

        let index_frozen = matches!(state, IndexState::Unreadable);
        let mut store = Store {
            dir: dir.to_path_buf(),
            keys,
            disk,
            seq: seen.max(index.seq),
            index,
            index_saved: trusted && !dirty,
            index_trusted: trusted,
            index_frozen,
            waiting: BTreeMap::new(),
            frozen,
            pending,
        };
        if !store.index_saved && !store.index_blocked() && !index_frozen {
            // Best effort: a write retries it first if it fails now.
            let _ = store.bump_and_save_index();
        }
        loaded.report = report;
        Ok((store, loaded))
    }

    /// Write `content` as the file in `slot`. While the index cannot be
    /// written it waits in memory (`is_behind`), and the next write or
    /// `flush_for_lock` takes it.
    pub(crate) fn write(&mut self, slot: &Slot, content: &[u8]) -> Result<(), StoreError> {
        self.check_writable(slot)?;
        self.waiting
            .insert(slot.clone(), Zeroizing::new(content.to_vec()));
        self.drain()
    }

    /// Remove the file in `slot`, noted in the index while it goes.
    pub(crate) fn delete(&mut self, slot: &Slot) -> Result<(), StoreError> {
        self.check_writable(slot)?;
        self.waiting.remove(slot);
        let name = slot.logical_name();
        self.index.deleting.push(name.clone());
        if let Err(error) = self.bump_and_save_index() {
            self.index.deleting.retain(|noted| noted != &name);
            return Err(error);
        }
        match self.disk.remove(&self.path_of(slot)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                // The note stays: the next unlock finishes the removal.
                return Err(error.into());
            }
            _ => {}
        }
        self.index.deleting.retain(|noted| noted != &name);
        self.index.files.remove(&name);
        // If this fails, the note on disk finishes it in silence at unlock.
        let _ = self.bump_and_save_index();
        Ok(())
    }

    /// At lock: write whatever waits, even if the index still cannot be
    /// written. The next unlock will ask, but nothing is lost.
    pub(crate) fn flush_for_lock(&mut self) -> Result<(), StoreError> {
        if self.index_frozen {
            return Ok(());
        }
        if !self.index_saved {
            let _ = self.save_index();
        }
        while let Some(slot) = self.waiting.keys().next().cloned() {
            let content = self.waiting.remove(&slot).expect("it is waiting");
            if let Err(error) = self.write_data(&slot, &content) {
                self.waiting.insert(slot, content);
                return Err(error);
            }
            let _ = self.save_index();
        }
        Ok(())
    }

    /// The user's answer for a file that waits: use it, and it counts as
    /// verified from then on; or go on without it, and it is set aside.
    pub(crate) fn choose(&mut self, slot: &Slot, use_it: bool) -> Result<(), StoreError> {
        let Some(seq) = self.pending.remove(slot) else {
            return Err(StoreError::NotPending(slot.logical_name()));
        };
        if use_it {
            self.index.files.insert(slot.logical_name(), seq);
        } else {
            if let Err(error) = set_aside(&self.disk, &self.dir, slot) {
                self.pending.insert(slot.clone(), seq);
                return Err(error.into());
            }
            self.index.files.remove(&slot.logical_name());
        }
        if !self.index_blocked() && !self.index_frozen {
            // If this fails, the next write retries it first.
            let _ = self.bump_and_save_index();
        }
        Ok(())
    }

    /// Never write `slot` this session, as one that could not be read at
    /// unlock: what it holds did not read in this version, so it stays.
    pub(crate) fn hold(&mut self, slot: &Slot) {
        self.waiting.remove(slot);
        self.frozen.insert(slot.clone());
    }

    /// Note the vault's header (design §4.9): the one it has, and one being
    /// written. Best effort, like every index write: while the index cannot
    /// be written, the next unlock checks against the older note.
    pub(crate) fn note_vault(
        &mut self,
        vault: Option<VaultHeader>,
        pending: Option<VaultHeader>,
    ) -> Result<(), StoreError> {
        self.index.vault = vault;
        self.index.vault_pending = pending;
        if self.index_frozen {
            return Err(StoreError::Frozen("the store".into()));
        }
        if self.index_blocked() {
            // It goes out with the index once the choices are made.
            self.index_saved = false;
            return Ok(());
        }
        self.bump_and_save_index()
    }

    /// Note how far the migration from the files of earlier versions got
    /// (design §5.2), like any change of the index's own.
    #[cfg_attr(not(test), allow(dead_code))] // unseal uses it from the next commit
    pub(crate) fn set_legacy(&mut self, legacy: Legacy) -> Result<(), StoreError> {
        self.index.legacy = legacy;
        if self.index_frozen {
            return Err(StoreError::Frozen("the store".into()));
        }
        if self.index_blocked() {
            // It goes out with the index once the choices are made.
            self.index_saved = false;
            return Ok(());
        }
        self.bump_and_save_index()
    }

    /// Keep `content` in `aside/`, sealed as `slot` (a `Slot::Legacy`), out
    /// of the index: nothing reads `aside/` back, so it is never taken for a
    /// file of the store.
    #[cfg_attr(not(test), allow(dead_code))] // unseal uses it from the next commit
    pub(crate) fn put_aside(&self, slot: &Slot, content: &[u8]) -> Result<(), StoreError> {
        let sealed = envelope::seal(&self.keys, slot, 0, content)?;
        self.disk.write(&self.path_of(slot), &sealed)?;
        Ok(())
    }

    /// Keep `bytes` in `aside/` as they are, under `name`: a file of an
    /// earlier version that was sealed already and did not open.
    #[cfg_attr(not(test), allow(dead_code))] // unseal uses it from the next commit
    pub(crate) fn put_aside_raw(&self, name: &str, bytes: &[u8]) -> Result<(), StoreError> {
        self.disk
            .write(&self.dir.join(ASIDE_DIR).join(name), bytes)?;
        Ok(())
    }

    /// Whether data waits in memory or the index on disk is behind it.
    pub(crate) fn is_behind(&self) -> bool {
        !self.waiting.is_empty() || !self.index_saved
    }

    pub(crate) fn index(&self) -> &Index {
        &self.index
    }

    pub(crate) fn keys(&self) -> &StoreKeys {
        &self.keys
    }

    fn path_of(&self, slot: &Slot) -> PathBuf {
        self.dir.join(slot.relative_path())
    }

    /// One more than the highest `seq` handed out or seen.
    fn next_seq(&mut self) -> u64 {
        self.seq = self.seq.max(self.index.seq) + 1;
        self.seq
    }

    /// While the index cannot vouch for the files, a new one is written only
    /// once nothing waits for a choice and nothing is unreadable: written
    /// earlier, it would leave those files out, and the next unlock would
    /// set them aside as planted.
    fn index_blocked(&self) -> bool {
        !self.index_trusted && (!self.pending.is_empty() || !self.frozen.is_empty())
    }

    fn check_writable(&self, slot: &Slot) -> Result<(), StoreError> {
        if self.index_frozen {
            return Err(StoreError::Frozen("the store".into()));
        }
        if self.frozen.contains(slot) {
            return Err(StoreError::Frozen(slot.logical_name()));
        }
        if self.pending.contains_key(slot) {
            return Err(StoreError::ChoicePending(slot.logical_name()));
        }
        if self.index_blocked() {
            return Err(StoreError::ChoicePending("the index".into()));
        }
        Ok(())
    }

    /// Write what waits, one file at a time with the index after each, and
    /// stop while the index cannot be written.
    fn drain(&mut self) -> Result<(), StoreError> {
        loop {
            if !self.index_saved && self.save_index().is_err() {
                return Ok(());
            }
            let Some(slot) = self.waiting.keys().next().cloned() else {
                return Ok(());
            };
            let content = self.waiting.remove(&slot).expect("it is waiting");
            if let Err(error) = self.write_data(&slot, &content) {
                self.waiting.insert(slot, content);
                return Err(error);
            }
        }
    }

    /// Steps 1 and 2: the file with a new `seq`, and the index in memory.
    fn write_data(&mut self, slot: &Slot, content: &[u8]) -> Result<(), StoreError> {
        let seq = self.next_seq();
        let sealed = envelope::seal(&self.keys, slot, seq, content)?;
        self.disk.write(&self.path_of(slot), &sealed)?;
        let name = slot.logical_name();
        // Written again, it is no longer being removed.
        self.index.deleting.retain(|noted| noted != &name);
        self.index.files.insert(name, seq);
        self.index.seq = seq;
        self.index_saved = false;
        Ok(())
    }

    /// Step 3: the index as it is in memory.
    fn save_index(&mut self) -> Result<(), StoreError> {
        if self.index_frozen {
            return Err(StoreError::Frozen("the store".into()));
        }
        let sealed = envelope::seal(
            &self.keys,
            &Slot::Index,
            self.index.seq,
            &self.index.to_json(),
        )?;
        match self.disk.write(&self.dir.join(INDEX_FILE), &sealed) {
            Ok(()) => {
                self.index_saved = true;
                self.index_trusted = true;
                Ok(())
            }
            Err(error) => {
                self.index_saved = false;
                Err(error.into())
            }
        }
    }

    /// The index after a change of its own, under a new `seq`.
    fn bump_and_save_index(&mut self) -> Result<(), StoreError> {
        self.index.seq = self.next_seq();
        self.save_index()
    }
}

/// The index on disk, as far as it can be read. Another vault's index means
/// another account's store: an error, and nothing is touched.
fn read_index(disk: &impl Disk, dir: &Path, keys: &StoreKeys) -> Result<IndexState, StoreError> {
    let bytes = match disk.read(&dir.join(INDEX_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(IndexState::Missing)
        }
        Err(_) => return Ok(IndexState::Unreadable),
    };
    Ok(match envelope::open(keys, &Slot::Index, &bytes) {
        Ok(file) => match Index::from_json(&file.content) {
            Some(index) if index.seq == file.seq => IndexState::Opened(index),
            _ => IndexState::Altered,
        },
        Err(error) if error.is_other_vault() => return Err(StoreError::OtherAccount),
        Err(_) => IndexState::Altered,
    })
}

/// The index of the store in `dir` if it opens under `keys`, read and
/// nothing else: none if it is missing, does not open or cannot be read now.
#[cfg_attr(not(test), allow(dead_code))] // unseal uses it from the next commit
pub(crate) fn peek_index(disk: &impl Disk, dir: &Path, keys: &StoreKeys) -> Option<Index> {
    match read_index(disk, dir, keys) {
        Ok(IndexState::Opened(index)) => Some(index),
        _ => None,
    }
}

/// The data files in `dir`: the fixed ones, then the stickers. Anything else
/// there is not the store's and is left alone.
fn present_slots(disk: &impl Disk, dir: &Path) -> Result<Vec<Slot>, StoreError> {
    let root = disk.list(dir)?;
    let mut slots: Vec<Slot> = Slot::FIXED
        .into_iter()
        .filter(|slot| {
            let name = slot.relative_path();
            root.iter().any(|file| Path::new(file) == name)
        })
        .collect();
    for file in disk.list(&dir.join(STICKERS_DIR))? {
        if let Some(name) = file.strip_suffix(".bin") {
            if envelope::is_sticker_disk_name(name) {
                slots.push(Slot::Sticker(name.to_string()));
            }
        }
    }
    Ok(slots)
}

/// Temporary files of an `atomic_write` that a cut interrupted.
fn remove_temporaries(disk: &impl Disk, dir: &Path) {
    let Ok(names) = disk.list(dir) else { return };
    for name in names {
        if name.starts_with('.') && name.contains(".tmp-") {
            let _ = disk.remove(&dir.join(name));
        }
    }
}

/// Move the file in `slot` to `aside/` as it is, unopened, keeping the
/// newest `ASIDE_PER_KIND` copies of its kind.
fn set_aside(disk: &impl Disk, dir: &Path, slot: &Slot) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let kind = slot.kind_name();
    let aside = dir.join(ASIDE_DIR);
    let name = format!(
        "{kind}.{nanos:024}-{:08}.bin",
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    disk.rename(&dir.join(slot.relative_path()), &aside.join(name))?;

    let prefix = format!("{kind}.");
    let mut copies: Vec<String> = disk
        .list(&aside)?
        .into_iter()
        .filter(|name| name.starts_with(&prefix))
        .collect();
    copies.sort();
    let extra = copies.len().saturating_sub(ASIDE_PER_KIND);
    for old in &copies[..extra] {
        let _ = disk.remove(&aside.join(old));
    }
    Ok(())
}

/// Set the file aside; if even that fails, it stays where it is and is not
/// written this session, so nothing is ever written over it.
fn set_aside_or_freeze(disk: &impl Disk, dir: &Path, slot: &Slot, frozen: &mut BTreeSet<Slot>) {
    if set_aside(disk, dir, slot).is_err() {
        frozen.insert(slot.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::disk::faulty::FaultyDisk;
    use crate::store::disk::RealDisk;
    use crate::store::keys::tests::keys;

    use std::rc::Rc;

    fn dir_in(scratch: &ScratchDir) -> PathBuf {
        scratch.path().join("store")
    }

    fn created(dir: &Path) -> Store<RealDisk> {
        Store::create(dir, keys(1), RealDisk).unwrap()
    }

    fn reopen(dir: &Path) -> (Store<RealDisk>, Loaded) {
        Store::open(dir, keys(1), RealDisk).unwrap()
    }

    fn sticker(byte: u8) -> Slot {
        Slot::Sticker(hex::encode([byte; 16]))
    }

    fn path(dir: &Path, slot: &Slot) -> PathBuf {
        dir.join(slot.relative_path())
    }

    fn bytes(dir: &Path, slot: &Slot) -> Vec<u8> {
        std::fs::read(path(dir, slot)).unwrap()
    }

    fn put(dir: &Path, slot: &Slot, bytes: &[u8]) {
        let path = path(dir, slot);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn aside_names(dir: &Path) -> Vec<String> {
        RealDisk.list(&dir.join(ASIDE_DIR)).unwrap()
    }

    fn ready(loaded: &Loaded, slot: &Slot) -> Option<Vec<u8>> {
        loaded.ready.get(slot).map(|content| content.to_vec())
    }

    fn what(loaded: &Loaded, slot: &Slot) -> Option<(What, Action)> {
        loaded
            .report
            .find(&slot.logical_name())
            .map(|finding| (finding.what, finding.action))
    }

    /// Every file of a store that was written and locked normally opens
    /// verified, with nothing to report.
    #[test]
    fn written_files_open_verified_and_nothing_is_reported() {
        let scratch = ScratchDir::new("store-normal");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::Prefs, b"prefs").unwrap();
        store.write(&sticker(1), b"image").unwrap();
        store.write(&Slot::Account, b"ana 2").unwrap();
        assert!(!store.is_behind());

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(
            ready(&loaded, &Slot::Account).as_deref(),
            Some(&b"ana 2"[..])
        );
        assert_eq!(ready(&loaded, &Slot::Prefs).as_deref(), Some(&b"prefs"[..]));
        assert_eq!(ready(&loaded, &sticker(1)).as_deref(), Some(&b"image"[..]));
        assert!(loaded.awaiting_choice.is_empty());
    }

    #[test]
    fn a_new_store_never_replaces_one_that_exists() {
        let scratch = ScratchDir::new("store-create");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();

        let error = Store::create(&dir, keys(1), RealDisk).err().unwrap();

        assert!(matches!(error, StoreError::Exists));
        let (_, loaded) = reopen(&dir);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
    }

    #[test]
    fn the_seq_only_grows() {
        let scratch = ScratchDir::new("store-seq");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        let mut last = store.index().seq;
        for slot in [Slot::Account, Slot::Prefs, Slot::Account, sticker(2)] {
            store.write(&slot, b"x").unwrap();
            let listed = store.index().files[&slot.logical_name()];
            assert!(listed > last, "{slot:?} got {listed} after {last}");
            last = listed;
        }
        store.delete(&sticker(2)).unwrap();
        assert!(
            store.index().seq > last,
            "the index moves on after a removal"
        );
        // A reopened store continues past everything it saw.
        let (mut store, _) = reopen(&dir);
        let before = store.index().seq;
        store.write(&Slot::History, b"h").unwrap();
        assert!(store.index().files["history"] > before);
    }

    /// Design §12.2, test 10.
    #[test]
    fn a_file_rolled_back_to_an_older_copy_is_not_used_nor_written_and_is_reported() {
        let scratch = ScratchDir::new("store-older");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store
            .write(&Slot::Account, b"before you blocked someone")
            .unwrap();
        let older = bytes(&dir, &Slot::Account);
        store.write(&Slot::Account, b"after").unwrap();
        put(&dir, &Slot::Account, &older);

        let (mut store, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Account), None, "used without asking");
        assert_eq!(
            loaded.awaiting_choice[&Slot::Account].as_slice(),
            b"before you blocked someone"
        );
        assert_eq!(
            what(&loaded, &Slot::Account),
            Some((What::OlderCopy, Action::Ask))
        );
        assert!(loaded.report.asks());
        let refused = store.write(&Slot::Account, b"new").unwrap_err();
        assert!(matches!(refused, StoreError::ChoicePending(_)));
        assert_eq!(bytes(&dir, &Slot::Account), older, "written over");
    }

    #[test]
    fn an_older_sessions_file_is_never_reused() {
        let scratch = ScratchDir::new("store-older-sessions");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Sessions, b"ratchets 1").unwrap();
        let older = bytes(&dir, &Slot::Sessions);
        store.write(&Slot::Sessions, b"ratchets 2").unwrap();
        put(&dir, &Slot::Sessions, &older);

        let (mut store, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Sessions), None);
        assert!(!loaded.awaiting_choice.contains_key(&Slot::Sessions));
        assert_eq!(
            what(&loaded, &Slot::Sessions),
            Some((What::OlderCopy, Action::NewSessions))
        );
        assert!(!loaded.report.asks());
        assert!(!path(&dir, &Slot::Sessions).exists(), "set aside");
        assert_eq!(aside_names(&dir).len(), 1);
        store.write(&Slot::Sessions, b"new sessions").unwrap();
    }

    #[test]
    fn choosing_an_older_copy_uses_it_from_then_on_and_declining_sets_it_aside() {
        let scratch = ScratchDir::new("store-choose");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        for slot in [Slot::Account, Slot::History] {
            store.write(&slot, b"old").unwrap();
        }
        let older = (bytes(&dir, &Slot::Account), bytes(&dir, &Slot::History));
        store.write(&Slot::Account, b"new").unwrap();
        store.write(&Slot::History, b"new").unwrap();
        put(&dir, &Slot::Account, &older.0);
        put(&dir, &Slot::History, &older.1);

        let (mut store, loaded) = reopen(&dir);
        assert_eq!(loaded.awaiting_choice.len(), 2);
        store.choose(&Slot::Account, true).unwrap();
        store.choose(&Slot::History, false).unwrap();
        assert!(matches!(
            store.choose(&Slot::History, true),
            Err(StoreError::NotPending(_))
        ));
        store.write(&Slot::Prefs, b"p").unwrap();

        assert!(!path(&dir, &Slot::History).exists(), "set aside");
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"old"[..]));
        assert_eq!(ready(&loaded, &Slot::History), None);
    }

    /// Design §12.2, test 11.
    #[test]
    fn one_file_one_step_ahead_is_a_cut_and_the_index_catches_up_in_silence() {
        let scratch = ScratchDir::new("store-cut");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        let index = bytes(&dir, &Slot::Index);
        // The cut: prefs written, its index entry never.
        store.write(&Slot::Prefs, b"prefs").unwrap();
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &Slot::Prefs).as_deref(), Some(&b"prefs"[..]));
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
        let (_, again) = reopen(&dir);
        assert!(again.report.is_empty(), "the index caught up");
    }

    #[test]
    fn a_new_sticker_cut_before_its_index_entry_is_kept_in_silence() {
        let scratch = ScratchDir::new("store-cut-new");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        let index = bytes(&dir, &Slot::Index);
        store.write(&sticker(4), b"image").unwrap();
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &sticker(4)).as_deref(), Some(&b"image"[..]));
    }

    /// Design §12.2, test 12.
    #[test]
    fn two_files_ahead_or_one_two_steps_ahead_verifies_nothing_and_asks() {
        // Two files ahead.
        let scratch = ScratchDir::new("store-ahead-two");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::History, b"h").unwrap();
        let index = bytes(&dir, &Slot::Index);
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert!(loaded.ready.is_empty(), "verified something");
        for slot in [Slot::Account, Slot::Prefs, Slot::History] {
            assert_eq!(what(&loaded, &slot), Some((What::Unverified, Action::Ask)));
            assert!(loaded.awaiting_choice.contains_key(&slot));
        }
        assert_eq!(
            loaded.report.find("index").map(|f| f.what),
            Some(What::Behind)
        );

        // One file, two steps ahead.
        let scratch = ScratchDir::new("store-ahead-far");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"1").unwrap();
        let index = bytes(&dir, &Slot::Index);
        store.write(&Slot::Account, b"2").unwrap();
        store.write(&Slot::Account, b"3").unwrap();
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Account), None);
        assert_eq!(
            what(&loaded, &Slot::Account),
            Some((What::Unverified, Action::Ask))
        );
    }

    /// Design §12.2, test 54.
    #[test]
    fn an_index_behind_asks_before_using_account() {
        let scratch = ScratchDir::new("store-behind-account");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store
            .write(&Slot::Account, b"with the contact you removed")
            .unwrap();
        let index = bytes(&dir, &Slot::Index);
        let older_account = bytes(&dir, &Slot::Account);
        store.write(&Slot::Account, b"without").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        // The index and account rolled back together; prefs gives it away.
        put(&dir, &Slot::Index, &index);
        put(&dir, &Slot::Account, &older_account);

        let (mut store, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Account), None);
        assert_eq!(
            what(&loaded, &Slot::Account),
            Some((What::Unverified, Action::Ask))
        );
        let refused = store.write(&Slot::Account, b"x").unwrap_err();
        assert!(matches!(refused, StoreError::ChoicePending(_)));
        // Once everything is answered, a new index vouches for the choice.
        store.choose(&Slot::Account, true).unwrap();
        store.choose(&Slot::Prefs, true).unwrap();
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(
            ready(&loaded, &Slot::Account).as_deref(),
            Some(&b"with the contact you removed"[..])
        );
    }

    /// Design §12.2, test 13.
    #[test]
    fn a_listed_file_that_is_missing_is_reported() {
        let scratch = ScratchDir::new("store-missing");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::History, b"chats").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        std::fs::remove_file(path(&dir, &Slot::History)).unwrap();
        std::fs::remove_file(path(&dir, &Slot::Prefs)).unwrap();

        let (_, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
        assert_eq!(
            what(&loaded, &Slot::History),
            Some((What::Missing, Action::Empty))
        );
        assert_eq!(
            what(&loaded, &Slot::Prefs),
            Some((What::Missing, Action::Defaults))
        );
        assert!(!loaded.report.asks());
    }

    /// Design §12.2, test 14.
    #[test]
    fn an_unlisted_file_of_this_vault_is_set_aside_and_reported() {
        let scratch = ScratchDir::new("store-unlisted");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&sticker(1), b"kept").unwrap();
        let removed = bytes(&dir, &sticker(1));
        store.delete(&sticker(1)).unwrap();
        store.write(&Slot::Account, b"ana").unwrap();
        // A removed sticker that came back, and one planted with an old seq
        // by someone with the key.
        put(&dir, &sticker(1), &removed);
        let planted = envelope::seal(&keys(1), &sticker(2), 1, b"planted").unwrap();
        put(&dir, &sticker(2), &planted);

        let (_, loaded) = reopen(&dir);

        for slot in [sticker(1), sticker(2)] {
            assert_eq!(ready(&loaded, &slot), None, "{slot:?} was used");
            assert_eq!(
                what(&loaded, &slot),
                Some((What::Unlisted, Action::SetAside))
            );
            assert!(!path(&dir, &slot).exists(), "{slot:?} is still in place");
        }
        assert_eq!(aside_names(&dir).len(), 2);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
    }

    /// Design §12.2, test 15.
    #[test]
    fn an_unlisted_file_of_another_vault_is_removed_in_silence() {
        let scratch = ScratchDir::new("store-orphan");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        let orphan = envelope::seal(&keys(2), &sticker(3), 1, b"theirs").unwrap();
        put(&dir, &sticker(3), &orphan);

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert!(!path(&dir, &sticker(3)).exists());
        assert!(aside_names(&dir).is_empty());
    }

    #[test]
    fn another_vaults_file_in_a_listed_place_is_set_aside_as_altered() {
        let scratch = ScratchDir::new("store-other-in-place");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        let theirs = envelope::seal(&keys(2), &Slot::Account, 1, b"theirs").unwrap();
        put(&dir, &Slot::Account, &theirs);

        let (_, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Account), None);
        assert_eq!(
            what(&loaded, &Slot::Account),
            Some((What::Altered, Action::SetAside))
        );
        assert_eq!(aside_names(&dir).len(), 1);
    }

    #[test]
    fn a_changed_file_is_set_aside_unopened_and_reported() {
        let scratch = ScratchDir::new("store-altered");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::History, b"chats").unwrap();
        let mut changed = bytes(&dir, &Slot::History);
        let last = changed.len() - 1;
        changed[last] ^= 1;
        put(&dir, &Slot::History, &changed);

        let (_, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::History), None);
        assert_eq!(
            what(&loaded, &Slot::History),
            Some((What::Altered, Action::SetAside))
        );
        let aside = aside_names(&dir);
        assert_eq!(aside.len(), 1);
        assert_eq!(
            std::fs::read(dir.join(ASIDE_DIR).join(&aside[0])).unwrap(),
            changed,
            "set aside as it was"
        );
        let (_, again) = reopen(&dir);
        assert!(again.report.is_empty(), "reported once: {:?}", again.report);
    }

    #[test]
    fn at_most_three_copies_of_a_kind_are_kept_aside() {
        let scratch = ScratchDir::new("store-aside-three");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Prefs, b"p").unwrap();
        drop(store);
        for round in 0..5u8 {
            put(&dir, &Slot::Account, &[round; 100]);
            let (_, loaded) = reopen(&dir);
            assert_eq!(
                what(&loaded, &Slot::Account),
                Some((What::Altered, Action::SetAside))
            );
        }
        let aside = aside_names(&dir);
        assert_eq!(aside.len(), ASIDE_PER_KIND, "{aside:?}");
        // The newest stay.
        let newest = std::fs::read(dir.join(ASIDE_DIR).join(aside.last().unwrap())).unwrap();
        assert_eq!(newest, [4; 100]);
    }

    /// Design §12.2, test 16: the known limit, kept in a test.
    #[test]
    fn a_whole_folder_rolled_back_together_is_not_detected() {
        let scratch = ScratchDir::new("store-whole");
        let dir = dir_in(&scratch);
        let copy = scratch.path().join("copy");
        let mut store = created(&dir);
        store.write(&Slot::Account, b"then").unwrap();
        store.write(&sticker(1), b"image").unwrap();
        copy_dir(&dir, &copy);
        store.write(&Slot::Account, b"now").unwrap();
        drop(store);
        std::fs::remove_dir_all(&dir).unwrap();
        copy_dir(&copy, &dir);

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty());
        assert_eq!(
            ready(&loaded, &Slot::Account).as_deref(),
            Some(&b"then"[..])
        );
    }

    fn copy_dir(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap() {
            let entry = entry.unwrap();
            let target = to.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }

    fn store_with_every_kind(dir: &Path) {
        let mut store = created(dir);
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        store.write(&Slot::Sessions, b"ratchets").unwrap();
        store.write(&sticker(1), b"image").unwrap();
    }

    fn assert_nothing_verified_and_one_question(dir: &Path, loaded: &Loaded) {
        for slot in [Slot::Account, Slot::Prefs] {
            assert_eq!(ready(loaded, &slot), None, "{slot:?} was used");
            assert_eq!(what(loaded, &slot), Some((What::Unverified, Action::Ask)));
        }
        // Design §6.1: a sticker opens only under its own name, so it is used.
        assert_eq!(ready(loaded, &sticker(1)).as_deref(), Some(&b"image"[..]));
        // Sessions are never reused unverified.
        assert_eq!(ready(loaded, &Slot::Sessions), None);
        assert!(!loaded.awaiting_choice.contains_key(&Slot::Sessions));
        assert_eq!(
            what(loaded, &Slot::Sessions),
            Some((What::Unverified, Action::NewSessions))
        );
        assert!(!path(dir, &Slot::Sessions).exists());
        // One question: the dialog asks once for everything that waits.
        assert!(loaded.report.asks());
        let asks = loaded
            .report
            .findings
            .iter()
            .filter(|finding| finding.action == Action::Ask)
            .count();
        assert_eq!(asks, loaded.awaiting_choice.len());
    }

    /// Design §12.2, test 17.
    #[test]
    fn a_missing_or_broken_index_verifies_nothing_and_asks_once() {
        // Missing.
        let scratch = ScratchDir::new("store-no-index");
        let dir = dir_in(&scratch);
        store_with_every_kind(&dir);
        std::fs::remove_file(path(&dir, &Slot::Index)).unwrap();

        let (mut store, loaded) = reopen(&dir);

        assert_nothing_verified_and_one_question(&dir, &loaded);
        assert_eq!(
            loaded.report.find("index").map(|f| f.what),
            Some(What::Missing)
        );
        // Nothing is written while the choice waits: a new index now would
        // drop the files that wait.
        assert!(matches!(
            store.write(&Slot::History, b"h"),
            Err(StoreError::ChoicePending(_))
        ));
        store.choose(&Slot::Account, true).unwrap();
        store.choose(&Slot::Prefs, false).unwrap();
        store.write(&Slot::Sessions, b"new").unwrap();
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
        assert_eq!(ready(&loaded, &sticker(1)).as_deref(), Some(&b"image"[..]));
        assert_eq!(ready(&loaded, &Slot::Prefs), None);

        // Broken: one byte changed.
        let scratch = ScratchDir::new("store-broken-index");
        let dir = dir_in(&scratch);
        store_with_every_kind(&dir);
        let mut index = bytes(&dir, &Slot::Index);
        index[HEADER_BYTE_INSIDE] ^= 1;
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert_nothing_verified_and_one_question(&dir, &loaded);
        assert_eq!(
            loaded.report.find("index").map(|f| (f.what, f.action)),
            Some((What::Altered, Action::Notice))
        );
        assert!(!path(&dir, &Slot::Index).exists(), "the index set aside");
    }

    /// A byte of the index's ciphertext.
    const HEADER_BYTE_INSIDE: usize = envelope::HEADER_LEN + 3;

    /// Design §12.2, test 53.
    #[test]
    fn a_corrupt_index_never_reuses_an_old_sessions_file() {
        let scratch = ScratchDir::new("store-index-sessions");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Sessions, b"old ratchets").unwrap();
        let older = bytes(&dir, &Slot::Sessions);
        store.write(&Slot::Sessions, b"ratchets").unwrap();
        put(&dir, &Slot::Sessions, &older);
        let mut index = bytes(&dir, &Slot::Index);
        index[HEADER_BYTE_INSIDE] ^= 1;
        put(&dir, &Slot::Index, &index);

        let (_, loaded) = reopen(&dir);

        assert_eq!(ready(&loaded, &Slot::Sessions), None);
        assert!(!loaded.awaiting_choice.contains_key(&Slot::Sessions));
        assert_eq!(
            what(&loaded, &Slot::Sessions).map(|(_, action)| action),
            Some(Action::NewSessions)
        );
    }

    #[test]
    fn a_store_of_another_account_is_left_untouched() {
        let scratch = ScratchDir::new("store-other-account");
        let dir = dir_in(&scratch);
        store_with_every_kind(&dir);
        let before = RealDisk.list(&dir).unwrap();

        let error = Store::open(&dir, keys(2), RealDisk).err().unwrap();

        assert!(matches!(error, StoreError::OtherAccount));
        assert_eq!(RealDisk.list(&dir).unwrap(), before);
        assert!(aside_names(&dir).is_empty());
    }

    /// Design §12.2, test 18, like `profile.rs`.
    #[test]
    fn a_file_that_cannot_be_read_now_is_kept_and_never_written() {
        let scratch = ScratchDir::new("store-unreadable");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        let account = bytes(&dir, &Slot::Account);
        drop(store);
        let disk = Rc::new(FaultyDisk::default());
        disk.fail_reads.borrow_mut().insert("account.bin".into());

        let (mut store, loaded) = Store::open(&dir, keys(1), disk.clone()).unwrap();

        assert_eq!(
            what(&loaded, &Slot::Account),
            Some((What::Unreadable, Action::KeepForLater))
        );
        assert_eq!(ready(&loaded, &Slot::Prefs).as_deref(), Some(&b"p"[..]));
        assert!(matches!(
            store.write(&Slot::Account, b"empty"),
            Err(StoreError::Frozen(_))
        ));
        store.write(&Slot::Prefs, b"p2").unwrap();
        assert_eq!(bytes(&dir, &Slot::Account), account, "written over");
        // Once the other program lets go, it opens verified.
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));
    }

    #[test]
    fn an_index_that_cannot_be_read_now_freezes_the_store() {
        let scratch = ScratchDir::new("store-index-unreadable");
        let dir = dir_in(&scratch);
        store_with_every_kind(&dir);
        let index = bytes(&dir, &Slot::Index);
        let disk = Rc::new(FaultyDisk::default());
        disk.fail_reads.borrow_mut().insert(INDEX_FILE.into());

        let (mut store, loaded) = Store::open(&dir, keys(1), disk.clone()).unwrap();

        assert_eq!(
            loaded.report.find("index").map(|f| (f.what, f.action)),
            Some((What::Unreadable, Action::KeepForLater))
        );
        assert!(loaded.report.asks());
        assert!(matches!(
            store.write(&Slot::History, b"h"),
            Err(StoreError::Frozen(_))
        ));
        assert_eq!(bytes(&dir, &Slot::Index), index);
    }

    /// Design §12.2, test 55.
    #[test]
    fn a_failed_index_write_never_leaves_two_files_ahead() {
        let scratch = ScratchDir::new("store-index-fails");
        let dir = dir_in(&scratch);
        let disk = Rc::new(FaultyDisk::default());
        let mut store = Store::create(&dir, keys(1), disk.clone()).unwrap();
        store.write(&Slot::History, b"h").unwrap();
        disk.fail_writes.borrow_mut().insert(INDEX_FILE.into());

        store.write(&Slot::Account, b"ana").unwrap();
        let account_on_disk = bytes(&dir, &Slot::Account);
        store.write(&Slot::Prefs, b"p").unwrap();
        store.write(&Slot::Account, b"ana 2").unwrap();

        assert!(store.is_behind());
        assert!(!path(&dir, &Slot::Prefs).exists(), "a second file ahead");
        assert_eq!(bytes(&dir, &Slot::Account), account_on_disk);
        // What a cut now would leave: one file one step ahead, a cut.
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(ready(&loaded, &Slot::Account).as_deref(), Some(&b"ana"[..]));

        // Once the index can be written, what waited follows, in order.
        let mut store = Store::open(&dir, keys(1), disk.clone()).unwrap().0;
        store.write(&Slot::Account, b"ana 3").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();
        disk.fail_writes.borrow_mut().clear();
        store.write(&Slot::History, b"h 2").unwrap();
        assert!(!store.is_behind());
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert_eq!(
            ready(&loaded, &Slot::Account).as_deref(),
            Some(&b"ana 3"[..])
        );
        assert_eq!(ready(&loaded, &Slot::Prefs).as_deref(), Some(&b"p"[..]));
        assert_eq!(ready(&loaded, &Slot::History).as_deref(), Some(&b"h 2"[..]));
    }

    #[test]
    fn at_lock_waiting_data_is_written_even_without_the_index_and_the_next_unlock_asks() {
        let scratch = ScratchDir::new("store-lock-flush");
        let dir = dir_in(&scratch);
        let disk = Rc::new(FaultyDisk::default());
        let mut store = Store::create(&dir, keys(1), disk.clone()).unwrap();
        disk.fail_writes.borrow_mut().insert(INDEX_FILE.into());
        store.write(&Slot::Account, b"ana").unwrap();
        store.write(&Slot::Prefs, b"p").unwrap();

        store.flush_for_lock().unwrap();

        assert!(path(&dir, &Slot::Prefs).exists(), "lost at lock");
        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.asks());
        assert_eq!(loaded.awaiting_choice[&Slot::Prefs].as_slice(), b"p");
    }

    /// Design §12.2, test 56: a cut before the removal, and one after it.
    #[test]
    fn a_file_marked_for_deletion_is_removed_in_silence() {
        for removed_before_the_cut in [false, true] {
            let scratch = ScratchDir::new("store-deleting");
            let dir = dir_in(&scratch);
            let mut store = created(&dir);
            store.write(&sticker(5), b"image").unwrap();
            store.write(&Slot::Account, b"ana").unwrap();
            // The index as the removal noted it, before dropping the note.
            let mut noted = store.index().clone();
            noted.seq += 1;
            noted.deleting.push(sticker(5).logical_name());
            let sealed =
                envelope::seal(store.keys(), &Slot::Index, noted.seq, &noted.to_json()).unwrap();
            drop(store);
            put(&dir, &Slot::Index, &sealed);
            if removed_before_the_cut {
                std::fs::remove_file(path(&dir, &sticker(5))).unwrap();
            }

            let (_, loaded) = reopen(&dir);

            assert!(loaded.report.is_empty(), "{:?}", loaded.report);
            assert_eq!(ready(&loaded, &sticker(5)), None);
            assert!(!path(&dir, &sticker(5)).exists());
            let (store, again) = reopen(&dir);
            assert!(again.report.is_empty());
            assert!(store.index().deleting.is_empty());
            assert!(!store.index().files.contains_key(&sticker(5).logical_name()));
        }
    }

    #[test]
    fn a_removal_whose_file_is_held_finishes_at_the_next_unlock() {
        let scratch = ScratchDir::new("store-delete-held");
        let dir = dir_in(&scratch);
        let disk = Rc::new(FaultyDisk::default());
        let mut store = Store::create(&dir, keys(1), disk.clone()).unwrap();
        store.write(&sticker(6), b"image").unwrap();
        let name = format!("{}.bin", hex::encode([6u8; 16]));
        disk.fail_removes.borrow_mut().insert(name);

        assert!(store.delete(&sticker(6)).is_err());

        let (_, loaded) = reopen(&dir);
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert!(!path(&dir, &sticker(6)).exists());
    }

    #[test]
    fn temporary_files_of_a_cut_write_are_removed() {
        let scratch = ScratchDir::new("store-temps");
        let dir = dir_in(&scratch);
        let mut store = created(&dir);
        store.write(&sticker(1), b"image").unwrap();
        std::fs::write(dir.join(".account.bin.tmp-1-2-3"), b"half").unwrap();
        std::fs::write(dir.join(STICKERS_DIR).join(".x.bin.tmp-1-2-3"), b"half").unwrap();

        let (_, loaded) = reopen(&dir);

        assert!(loaded.report.is_empty());
        assert_eq!(RealDisk.list(&dir).unwrap(), [INDEX_FILE]);
        assert_eq!(
            RealDisk.list(&dir.join(STICKERS_DIR)).unwrap(),
            [format!("{}.bin", hex::encode([1u8; 16]))]
        );
    }
}
