//! Step B2 of the emergency path (clave de emergencia, design §6.1): the
//! store the empty account took the place of, removed in the background,
//! once the session opened.
//!
//! - **Only the store noted by name** in the index (`deleting_stores`,
//!   RC-11): a store CL set aside because it did not open stays, as it
//!   always has.
//! - **Removed, not overwritten** (RC-02): nothing in it opens without the
//!   data key the vault of before carried, and overwriting megabytes of
//!   history right after unlocking would be noise of the disk that no
//!   unlock makes. The small files in clear went in step E5.
//! - **A few files at a time, with a pause between.** A file that cannot
//!   go now (another program holds it) does not stop the rest; the note
//!   stays, and the next unlock tries again (design §6.4).
//! - **Without `session_gate`** (RC-13): a lock while it runs does not wait
//!   for it, and it goes on after the lock; dropping the note needs the
//!   session's store, so after a lock that waits for the next unlock.
//! - Silent: no line of the log, no notice.

use super::migrate::is_aside_name;
use super::session::StorageCell;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Files removed in a row before a pause.
pub const BATCH: usize = 16;
/// The pause between two batches.
pub const PAUSE: Duration = Duration::from_millis(20);

/// Remove the folder `dir` with everything in it, its files with
/// `remove_file`, `batch` at a time with `pause()` between two batches,
/// then its folders. A link is removed, never followed. Whether `dir` is
/// gone; a file that did not go keeps it, and the rest goes anyway.
pub fn remove_in_batches(
    dir: &Path,
    batch: usize,
    remove_file: &mut dyn FnMut(&Path) -> io::Result<()>,
    pause: &mut dyn FnMut(),
) -> bool {
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    collect(dir, &mut files, &mut dirs);
    for (at, chunk) in files.chunks(batch.max(1)).enumerate() {
        if at > 0 {
            pause();
        }
        for file in chunk {
            // What does not go now goes at the next unlock.
            let _ = remove_file(file);
        }
    }
    // The deepest first; one that is not empty stays.
    for folder in dirs.iter().rev() {
        let _ = std::fs::remove_dir(folder);
    }
    std::fs::symlink_metadata(dir).is_err()
}

/// The files (and links) under `dir` and its folders, `dir` first.
fn collect(dir: &Path, files: &mut Vec<PathBuf>, dirs: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    dirs.push(dir.to_path_buf());
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();
    for path in paths {
        match std::fs::symlink_metadata(&path).map(|meta| meta.file_type()) {
            Ok(kind) if kind.is_dir() && !kind.is_symlink() => collect(&path, files, dirs),
            _ => files.push(path),
        }
    }
}

/// Remove a link, whether to a file or to a folder, or a file.
fn remove_entry(path: &Path) -> io::Result<()> {
    match std::fs::remove_file(path) {
        // A link to a folder, on Windows.
        Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) => {
            std::fs::remove_dir(path)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        done => done,
    }
}

/// The stores an unlock found noted for removal (`Index::deleting_stores`),
/// in the data folder `home`.
pub struct Cleanup {
    pub home: PathBuf,
    pub stores: Vec<String>,
}

impl Cleanup {
    /// B2: remove each store, then drop its note from the index of the
    /// session's store in `storage`, if one is still open.
    pub fn run(self, storage: &StorageCell) {
        self.run_with(storage, &mut remove_entry, &mut || {
            std::thread::sleep(PAUSE)
        })
    }

    /// `run`, removing each file with `remove_file` and pausing with
    /// `pause`.
    pub fn run_with(
        self,
        storage: &StorageCell,
        remove_file: &mut dyn FnMut(&Path) -> io::Result<()>,
        pause: &mut dyn FnMut(),
    ) {
        for name in self.stores {
            // Only a store set aside, by its name, in this folder.
            if !is_aside_name(&name) {
                continue;
            }
            if remove_in_batches(&self.home.join(&name), BATCH, remove_file, pause) {
                storage.forget_deleting_store(&name);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;

    /// A store of `count` files, some of them in `stickers/` and `aside/`.
    fn old_store(dir: &Path, count: usize) {
        for sub in ["stickers", "aside"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        for i in 0..count {
            let sub = ["", "stickers", "aside"][i % 3];
            std::fs::write(dir.join(sub).join(format!("f{i:03}.bin")), b"sealed bytes").unwrap();
        }
    }

    /// Design §12.4b, test 62 (RC-02): the old store is removed, not
    /// overwritten (it opens with no key any longer, and megabytes written
    /// right after unlocking would be noise no unlock makes), a few files at
    /// a time with a pause between.
    #[test]
    fn the_cleanup_removes_the_old_store_without_overwriting_and_in_small_batches() {
        let scratch = ScratchDir::new("cleanup-batches");
        let dir = scratch.path().join("store-aside-1");
        old_store(&dir, 40);
        // A second name for one file: what a disk keeps after a removal.
        let link = scratch.path().join("link.bin");
        std::fs::hard_link(dir.join("f000.bin"), &link).unwrap();
        let mut events = Vec::new();
        let removed = std::cell::RefCell::new(Vec::new());

        let gone = remove_in_batches(
            &dir,
            BATCH,
            &mut |path| {
                removed.borrow_mut().push(path.to_path_buf());
                std::fs::remove_file(path)
            },
            &mut || events.push(removed.borrow().len()),
        );

        assert!(gone);
        assert!(!dir.exists());
        assert_eq!(removed.borrow().len(), 40);
        // A pause after each full batch, and only between batches.
        assert_eq!(events, [BATCH, 2 * BATCH]);
        assert_eq!(
            std::fs::read(&link).unwrap(),
            b"sealed bytes",
            "overwritten"
        );
    }

    /// Design §12.2, test 32: a file another program holds does not stop the
    /// cleanup; the rest goes, the store stays noted, and the next unlock
    /// tries again.
    #[test]
    fn a_held_file_does_not_stop_the_cleanup_and_the_next_try_ends_it() {
        let scratch = ScratchDir::new("cleanup-held");
        let dir = scratch.path().join("store-aside-1");
        old_store(&dir, 10);
        let held = dir.join("f003.bin");

        let gone = remove_in_batches(
            &dir,
            BATCH,
            &mut |path| {
                if path == held {
                    Err(io::Error::new(io::ErrorKind::PermissionDenied, "held"))
                } else {
                    std::fs::remove_file(path)
                }
            },
            &mut || {},
        );

        assert!(!gone);
        assert!(held.exists());
        let left: Vec<_> = walkdir(&dir);
        assert_eq!(left, std::slice::from_ref(&held));

        assert!(remove_in_batches(
            &dir,
            BATCH,
            &mut |path| std::fs::remove_file(path),
            &mut || {}
        ));
        assert!(!dir.exists());
    }

    fn walkdir(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walkdir(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    /// A link in the old store is removed, never followed: what it points to
    /// is not the store's.
    #[test]
    fn a_link_in_the_old_store_is_not_followed() {
        let scratch = ScratchDir::new("cleanup-link");
        let dir = scratch.path().join("store-aside-1");
        old_store(&dir, 3);
        let outside = scratch.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"not the store's").unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, dir.join("link"));
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&outside, dir.join("link"));
        if linked.is_err() {
            // Windows without the right to make links: nothing to check.
            return;
        }

        assert!(remove_in_batches(
            &dir,
            BATCH,
            &mut |path| std::fs::remove_file(path),
            &mut || {}
        ));

        assert_eq!(
            std::fs::read(outside.join("keep.txt")).unwrap(),
            b"not the store's"
        );
    }
}
