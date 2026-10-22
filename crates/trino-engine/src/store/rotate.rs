//! Rotating the data key once, as the vault moves to version 3 (clave de
//! emergencia CE-3, design §3.7 step 3; cifrado local design §3.3).
//!
//! The store of a version 2 vault is sealed under its first data key (DK,
//! `key_gen` 1), the one of the cifrado local stage. Moving to version 3,
//! the app makes a new DK of the next generation under the same
//! `id_vault`, so that no copy of the version 2 vault left on the disk,
//! with its key, opens anything saved from then on.
//!
//! In steps that a cut at any point cannot turn into a loss, as the
//! migration of CL-1c (`migrate.rs`):
//!
//! - **R1.** `store.new/` becomes a copy of `store/` under the new DK:
//!   every file that opens under the old one is sealed again under the new
//!   one, with the same `seq` and the same content, the index noting the
//!   version 3 vault; a file that does not open (one set aside, or damaged)
//!   is copied as it is. So the store reads after the rotation exactly as
//!   before, with the same findings. Then all of it is read back and
//!   compared.
//! - **The commit.** The version 3 vault, which carries the new DK, written
//!   in two phases (`vault_file.rs`). A cut before its first phase is done
//!   leaves the version 2 vault and its store untouched, and a `store.new/`
//!   of a newer generation that nothing opens: the next unlock discards it
//!   and rotates again.
//! - **R2.** `store/` goes and `store.new/` takes its place. A cut before
//!   that is finished at the next unlock (`migrate::settle`): `store.new/`
//!   opens under the vault's DK, and `store/` is of an older generation.
//!
//! The old store is removed, not overwritten (design §6.1 B2, RC-02):
//! nothing in it opens without the old DK, which no vault holds any more.

use super::disk::Disk;
use super::envelope::{self, Slot};
use super::index::{Index, VaultHeader};
use super::keys::StoreKeys;
use super::migrate::{move_new_store, NewVault, NEW_STORE_DIR, VAULT_FILE};
use super::session::STORE_DIR;
use std::io;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

const STICKERS_DIR: &str = "stickers";
const ASIDE_DIR: &str = "aside";

/// A rotation that did not finish. Not `committed`: the version 2 vault and
/// its store are as they were. `committed`: the vault may hold the new DK
/// already, and the next unlock finishes what is left.
#[derive(Debug)]
pub struct RotateError {
    pub committed: bool,
    pub error: io::Error,
}

/// R1 to R2 (see the module's comment): the store in `home`, under `old`,
/// moved under `new`, committed by `vault`, the version 3 vault that
/// carries `new`.
pub fn rotate<D: Disk>(
    disk: &D,
    home: &Path,
    old: &StoreKeys,
    new: &StoreKeys,
    vault: &NewVault,
) -> Result<(), RotateError> {
    let store = home.join(STORE_DIR);
    let next = home.join(NEW_STORE_DIR);
    let before = |error: io::Error| RotateError {
        committed: false,
        error,
    };
    // A store.new/ the vault never took: a rotation or a migration a cut
    // stopped. Nothing in it opens.
    disk.remove_dir_all(&next).map_err(before)?;
    if let Err(error) = rekey(disk, &store, &next, old, new, vault.header.as_ref()) {
        let _ = disk.remove_dir_all(&next);
        return Err(before(error));
    }
    let vault_path = home.join(VAULT_FILE);
    if let Err(error) = crate::vault_file::write_next(disk, &vault_path, vault.bytes) {
        let _ = disk.remove_dir_all(&next);
        return Err(before(error));
    }
    crate::vault_file::finish(disk, &vault_path, vault.bytes).map_err(|error| RotateError {
        committed: true,
        error,
    })?;
    // R2. If this fails, `settle` finishes it before the store opens.
    let _ = move_new_store(disk, home);
    Ok(())
}

/// What a file of `to` must read as once `rekey` wrote it.
enum Expected {
    Sealed {
        path: PathBuf,
        slot: Slot,
        seq: u64,
        content: Zeroizing<Vec<u8>>,
    },
    Raw {
        path: PathBuf,
        bytes: Vec<u8>,
    },
}

/// R1: the store in `from` copied to `to` under `new`, then read back.
fn rekey<D: Disk>(
    disk: &D,
    from: &Path,
    to: &Path,
    old: &StoreKeys,
    new: &StoreKeys,
    vault: Option<&VaultHeader>,
) -> io::Result<()> {
    let mut expected = Vec::new();
    for dir in ["", STICKERS_DIR, ASIDE_DIR] {
        for name in disk.list(&from.join(dir))? {
            if is_temporary(&name) {
                continue;
            }
            let path = Path::new(dir).join(&name);
            // A file that cannot be read now stops the rotation: the next
            // unlock tries again.
            let bytes = disk.read(&from.join(&path))?;
            let opened = slot_of(dir, &name).and_then(|slot| {
                let file = envelope::open(old, &slot, &bytes).ok()?;
                Some((slot, file))
            });
            let (written, file) = match opened {
                Some((slot, file)) => {
                    let content = match slot {
                        Slot::Index => noting(file.content, vault),
                        _ => file.content,
                    };
                    let sealed =
                        envelope::seal(new, &slot, file.seq, &content).map_err(io::Error::other)?;
                    let file = Expected::Sealed {
                        path: path.clone(),
                        slot,
                        seq: file.seq,
                        content,
                    };
                    (sealed, file)
                }
                None => {
                    let file = Expected::Raw {
                        path: path.clone(),
                        bytes: bytes.clone(),
                    };
                    (bytes, file)
                }
            };
            disk.write(&to.join(&path), &written)?;
            expected.push(file);
        }
    }
    for file in expected {
        let same = match &file {
            Expected::Sealed {
                path,
                slot,
                seq,
                content,
            } => disk
                .read(&to.join(path))
                .ok()
                .and_then(|bytes| envelope::open(new, slot, &bytes).ok())
                .is_some_and(|read| read.seq == *seq && read.content[..] == content[..]),
            Expected::Raw { path, bytes } => disk
                .read(&to.join(path))
                .is_ok_and(|read| read[..] == bytes[..]),
        };
        if !same {
            return Err(io::Error::other(
                "the rotated store does not read back as it was written",
            ));
        }
    }
    Ok(())
}

/// The index in `content`, noting `vault` as the vault's header; as it is
/// if it is not an index this version reads.
fn noting(content: Zeroizing<Vec<u8>>, vault: Option<&VaultHeader>) -> Zeroizing<Vec<u8>> {
    let (Some(vault), Some(mut index)) = (vault, Index::from_json(&content)) else {
        return content;
    };
    index.vault = Some(vault.clone());
    index.vault_pending = None;
    index.to_json()
}

/// The slot a file of the store is sealed as, by where it is: `None` for
/// anything that is not a file of the store, which is copied as it is.
fn slot_of(dir: &str, name: &str) -> Option<Slot> {
    let stem = name.strip_suffix(".bin")?;
    match dir {
        "" if name == "index.bin" => Some(Slot::Index),
        "" => Slot::FIXED
            .into_iter()
            .find(|slot| slot.relative_path() == Path::new(name)),
        STICKERS_DIR => envelope::is_sticker_disk_name(stem).then(|| Slot::Sticker(stem.into())),
        // aside/: a copy set aside keeps its kind first (`files::set_aside`),
        // and a file of an earlier version kept sealed is `legacy.<name>`.
        _ => match stem.split_once('.')? {
            ("legacy", legacy) => Some(Slot::Legacy(legacy.into())),
            ("index", _) => Some(Slot::Index),
            (kind, _) => Slot::FIXED
                .into_iter()
                .find(|slot| slot.kind_name() == kind),
        },
    }
}

/// A temporary file of an `atomic_write` a cut interrupted.
fn is_temporary(name: &str) -> bool {
    name.starts_with('.') && name.contains(".tmp-")
}

/// How the files of a store in `dir` stand against `keys`, by the
/// generation their headers name (unauthenticated: it only tells a store a
/// rotation left from another, `migrate::settle`).
#[derive(Debug, PartialEq, Eq)]
pub enum Generation {
    /// Every file of this `id_vault` is of an older generation.
    Older,
    /// Every file of this `id_vault` is of a newer generation.
    Newer,
}

pub fn generation_in(disk: &impl Disk, dir: &Path, keys: &StoreKeys) -> Option<Generation> {
    let generations: Vec<u32> = disk
        .list(dir)
        .ok()?
        .iter()
        .filter_map(|name| disk.read(&dir.join(name)).ok())
        .filter_map(|bytes| envelope::generation_of(&bytes))
        .filter(|(_, id_vault)| id_vault == keys.id_vault())
        .map(|(key_gen, _)| key_gen)
        .collect();
    if generations.is_empty() {
        None
    } else if generations.iter().all(|&key_gen| key_gen < keys.key_gen()) {
        Some(Generation::Older)
    } else if generations.iter().all(|&key_gen| key_gen > keys.key_gen()) {
        Some(Generation::Newer)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::disk::cut::CutDisk;
    use crate::store::disk::RealDisk;
    use crate::store::files::Store;
    use crate::store::keys::testing::keys;
    use crate::store::migrate::settle;
    use crate::store::session::{Found, SessionStore};

    const V2: &[u8] = b"the version 2 vault, with the first data key";
    const V3: &[u8] = b"the version 3 vault, with the rotated data key";

    /// What the store of the fixture holds, by file.
    fn written() -> Vec<(Slot, Vec<u8>)> {
        vec![
            (
                Slot::Account,
                br#"{"handle":"ana","nostrPub":"ab","relays":[],"createdAt":1}"#.to_vec(),
            ),
            (Slot::Prefs, br#"{"autolock":"5"}"#.to_vec()),
            (Slot::History, b"{\"bob\":[]}".to_vec()),
            (Slot::Sessions, b"{}".to_vec()),
            (
                Slot::Sticker("0123456789abcdef0123456789abcdef".into()),
                br#"{"id":"s","mime":"image/png","data":""}"#.to_vec(),
            ),
        ]
    }

    /// A store under `keys(1)` with every kind of file, one copy set aside
    /// sealed and one that does not open, and the version 2 vault.
    fn fixture(home: &Path) {
        let mut store = Store::create(&home.join(STORE_DIR), keys(1), RealDisk).unwrap();
        for (slot, content) in written() {
            store.write(&slot, &content).unwrap();
        }
        store
            .put_aside(&Slot::Legacy("config.json".into()), b"a file of before")
            .unwrap();
        store
            .put_aside_raw("legacy.history.bin", b"sealed by an older key")
            .unwrap();
        std::fs::write(home.join(VAULT_FILE), V2).unwrap();
    }

    fn new_keys() -> StoreKeys {
        StoreKeys::from_parts(2, *keys(1).id_vault(), [0x77; 32])
    }

    fn new_vault(record: &[u8]) -> NewVault<'_> {
        NewVault {
            record,
            bytes: V3,
            header: None,
        }
    }

    /// An unlock, as the app's does: the vault that opens says which key;
    /// a version 2 vault rotates again; then the store opens. Asserts that
    /// it reads as it was written, and that nothing was reported.
    fn unlock_and_check(home: &Path) {
        let new = new_keys();
        let record = new.to_vault_app();
        let vault = home.join(VAULT_FILE);
        if std::fs::read(&vault).unwrap() == V2 {
            // vault.bin opens: what waits in vault.bin.next goes
            // (vault_file::open_with), and the rotation runs again.
            let _ = std::fs::remove_file(crate::vault_file::next_path(&vault));
            rotate(&RealDisk, home, &keys(1), &new, &new_vault(&record)).unwrap();
        }
        assert_eq!(std::fs::read(&vault).unwrap(), V3);
        let settled = settle(&RealDisk, home, &record).unwrap();
        assert!(settled.findings.is_empty(), "{:?}", settled.findings.len());
        let opened = SessionStore::open(home, &record, None).unwrap();
        assert!(
            opened.session.report().is_empty(),
            "{:?}",
            opened.session.report()
        );
        let ready = |found: &Found| match found {
            Found::Ready(bytes) => bytes.to_vec(),
            _ => panic!("not ready"),
        };
        let all = written();
        assert_eq!(ready(&opened.account), all[0].1);
        assert_eq!(opened.session.prefs().unwrap(), &all[1].1[..]);
        assert_eq!(ready(&opened.history), all[2].1);
        assert_eq!(ready(&opened.sessions), all[3].1);
        assert_eq!(opened.session.stickers().len(), 1);
        assert!(!home.join(NEW_STORE_DIR).exists());
        let store = home.join(STORE_DIR);
        assert_eq!(
            generation_in(&RealDisk, &store, &keys(1)),
            Some(Generation::Newer)
        );
        // The sealed copy set aside moved too; the other is as it was.
        let aside = std::fs::read(store.join("aside").join("legacy.config.json.bin")).unwrap();
        let opened = envelope::open(&new, &Slot::Legacy("config.json".into()), &aside).unwrap();
        assert_eq!(&opened.content[..], b"a file of before");
        assert_eq!(
            std::fs::read(store.join("aside").join("legacy.history.bin")).unwrap(),
            b"sealed by an older key"
        );
    }

    #[test]
    fn a_rotation_moves_every_file_to_the_new_key_and_reads_the_same() {
        let scratch = ScratchDir::new("rotate-whole");
        fixture(scratch.path());
        let record = new_keys().to_vault_app();

        rotate(
            &RealDisk,
            scratch.path(),
            &keys(1),
            &new_keys(),
            &new_vault(&record),
        )
        .unwrap();

        unlock_and_check(scratch.path());
        // Nothing of the store opens under the old key any more.
        let store = scratch.path().join(STORE_DIR);
        let index = std::fs::read(store.join("index.bin")).unwrap();
        assert!(envelope::open(&keys(1), &Slot::Index, &index).is_err());
    }

    /// The steps of a whole rotation.
    fn whole_run() -> usize {
        let scratch = ScratchDir::new("rotate-steps");
        fixture(scratch.path());
        let disk = CutDisk::whole();
        let record = new_keys().to_vault_app();
        rotate(
            &disk,
            scratch.path(),
            &keys(1),
            &new_keys(),
            &new_vault(&record),
        )
        .unwrap();
        let steps = disk.steps.borrow().len();
        steps
    }

    /// A cut at every step, losing nothing, the last change not on the
    /// disk, or all of them: the next unlock always finds the account
    /// whole, under one key or the other.
    #[test]
    fn a_cut_at_every_step_of_the_rotation_loses_nothing() {
        let steps = whole_run();
        assert!(steps > 10, "{steps} steps");
        for at in 0..steps {
            for lose in [0, 1, usize::MAX] {
                let scratch = ScratchDir::new("rotate-cut");
                let home = scratch.path();
                fixture(home);
                let disk = CutDisk::cut_at(at);
                let record = new_keys().to_vault_app();
                // Past the commit, what is left (the copy destroyed, the
                // move) fails in silence: the next unlock finishes it.
                let _ = rotate(&disk, home, &keys(1), &new_keys(), &new_vault(&record));
                assert!(disk.is_cut(), "step {at} is past the end");
                disk.lose_last(lose.min(disk.unflushed()));
                unlock_and_check(home);
            }
        }
    }

    /// A rotation the vault never took, and could not clear away: the next
    /// unlock with the old key finds a newer `store.new/` and removes it,
    /// in silence.
    #[test]
    fn a_rotation_the_vault_never_took_is_removed_in_silence() {
        let scratch = ScratchDir::new("rotate-never-taken");
        let home = scratch.path();
        fixture(home);
        rekey(
            &RealDisk,
            &home.join(STORE_DIR),
            &home.join(NEW_STORE_DIR),
            &keys(1),
            &new_keys(),
            None,
        )
        .unwrap();

        let settled = settle(&RealDisk, home, &keys(1).to_vault_app()).unwrap();

        assert!(settled.findings.is_empty());
        assert!(!home.join(NEW_STORE_DIR).exists());
        let opened = SessionStore::open(home, &keys(1).to_vault_app(), None).unwrap();
        assert!(opened.session.report().is_empty());
    }
}
