//! Crash-safe writes for the files in the data directory.
//!
//! `std::fs::write` truncates a file and then fills it, so a crash, a power
//! cut or a full disk halfway through leaves it empty or half written. For
//! vault.bin that loses the identity for good. Here the new contents go to a
//! temporary file next to the target, which is flushed to disk and then
//! renamed over it, so the target always holds the old contents or the new
//! ones, never a mix.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Sits between a target's name and the unique part of its temporary files:
/// `.vault.bin.tmp-<pid>-<counter>-<nanos>`.
const TEMP_MARKER: &str = ".tmp-";

/// Attempts at the rename while another program holds the file, and the pause
/// before the first retry, doubled after each one (at most 310 ms in total).
const RENAME_ATTEMPTS: u32 = 6;
const FIRST_RENAME_PAUSE: Duration = Duration::from_millis(10);

/// Replace the contents of `path` with `bytes`, so that whatever happens
/// halfway the file holds either its old contents or the new ones.
///
/// The bytes go to a new, uniquely named file in the same directory, which is
/// synced to disk and then renamed over `path`. If any step fails, that
/// temporary file is removed and `path` is left as it was.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = temp_path_for(path)?;
    // Nothing to clean up if this fails: the file was never created.
    let file = create_temp(&temp)?;
    if let Err(error) = fill(file, bytes).and_then(|()| rename_over(&temp, path)) {
        // Best effort. `path` is untouched either way, and a wipe also
        // removes temporary files left behind (`leftover_temp_files`).
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    sync_dir_of(path);
    Ok(())
}

/// Temporary files `atomic_write` left next to `path`. That only happens if
/// the process died between creating one and renaming it into place, but such
/// a file holds a full copy of the data, so a wipe has to remove it as well.
pub fn leftover_temp_files(path: &Path) -> Vec<PathBuf> {
    let Some(name) = path.file_name() else {
        return Vec::new();
    };
    let prefix = temp_prefix(name);
    let prefix = prefix.to_string_lossy();
    let Ok(entries) = fs::read_dir(dir_of(path)) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&*prefix))
        .map(|entry| entry.path())
        .collect()
}

/// The start of every temporary file name for a target called `name`. The dot
/// keeps them out of plain directory listings on Unix.
fn temp_prefix(name: &OsStr) -> OsString {
    let mut prefix = OsString::from(".");
    prefix.push(name);
    prefix.push(TEMP_MARKER);
    prefix
}

/// A sibling of `path` that no other write can be using: the process id tells
/// processes apart, the counter tells writes within one process apart, and
/// the clock keeps a reused process id from meeting a file a crash left.
fn temp_path_for(path: &Path) -> io::Result<PathBuf> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let name = path.file_name().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("not a file path: {}", path.display()),
        )
    })?;
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    let mut temp = temp_prefix(name);
    temp.push(format!(
        "{}-{}-{nanos}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    Ok(path.with_file_name(temp))
}

/// Create the temporary file, never reusing an existing one. On Unix it is
/// readable by its owner only from the first moment, like the 0700 data
/// directory around it (`commands::harden_dir`); the rename keeps that mode.
fn create_temp(temp: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(temp)
}

/// Write `bytes` and wait until they are on disk. The file is closed on
/// return, before the rename, which some platforms need.
fn fill(mut file: File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

/// Rename `from` over `to`, replacing it.
///
/// On Windows a virus scanner or the search indexer may hold `to` (or the new
/// file) open for a moment without allowing deletes, and the rename then
/// fails with "access denied" or a sharing violation until it lets go. Those
/// failures are retried a few times with a growing pause.
fn rename_over(from: &Path, to: &Path) -> io::Result<()> {
    let mut pause = FIRST_RENAME_PAUSE;
    let mut attempt = 1;
    loop {
        match fs::rename(from, to) {
            Err(error) if attempt < RENAME_ATTEMPTS && may_clear_up(&error) => {
                std::thread::sleep(pause);
                pause *= 2;
                attempt += 1;
            }
            result => return result,
        }
    }
}

/// Whether a failed rename may succeed if tried again shortly: only on
/// Windows, where another program holding the file blocks it. Elsewhere a
/// rename never fails because of an open file.
fn may_clear_up(error: &io::Error) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_LOCK_VIOLATION: i32 = 33;
    cfg!(windows)
        && (error.kind() == io::ErrorKind::PermissionDenied
            || matches!(
                error.raw_os_error(),
                Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)
            ))
}

/// The directory `path` is in; `.` for a bare file name.
fn dir_of(path: &Path) -> &Path {
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    }
}

/// Make the rename itself durable: on Unix a new directory entry is only
/// certain to be on disk once the directory has been synced. Best effort,
/// because the new contents are already in place and some file systems
/// cannot sync a directory.
#[cfg(unix)]
fn sync_dir_of(path: &Path) {
    if let Ok(dir) = File::open(dir_of(path)) {
        let _ = dir.sync_all();
    }
}

/// No directory sync elsewhere. NTFS journals the rename, so after a crash
/// the file is still the old version or the new one, although the very last
/// rename may be undone.
#[cfg(not(unix))]
fn sync_dir_of(_path: &Path) {}

/// Scratch directories for tests that touch the disk.
#[cfg(test)]
pub(crate) mod scratch {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// An empty directory under the system temp dir, unique to this test run
    /// and removed again when dropped.
    pub(crate) struct ScratchDir(PathBuf);

    impl ScratchDir {
        pub(crate) fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "trino-gui-test-{label}-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("create scratch dir");
            ScratchDir(path)
        }

        pub(crate) fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::scratch::ScratchDir;
    use super::*;
    use std::fs;

    /// The names in `dir`, sorted, so a test can check nothing else is there.
    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn creates_a_file_that_did_not_exist() {
        let dir = ScratchDir::new("atomic-new");
        let path = dir.path().join("config.json");

        atomic_write(&path, b"{\"handle\":\"ana\"}").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"{\"handle\":\"ana\"}");
    }

    #[test]
    fn replaces_every_byte_of_an_existing_file() {
        let dir = ScratchDir::new("atomic-replace");
        let path = dir.path().join("friends.json");
        fs::write(&path, b"a much longer previous version of the file").unwrap();

        atomic_write(&path, b"short").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"short");
    }

    #[test]
    fn leaves_no_temporary_files_behind() {
        let dir = ScratchDir::new("atomic-clean");
        let path = dir.path().join("history.bin");

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();

        assert_eq!(names_in(dir.path()), ["history.bin"]);
    }

    #[test]
    fn a_rename_that_cannot_happen_fails_without_leaving_a_temporary_file() {
        let dir = ScratchDir::new("atomic-blocked");
        // A non-empty directory where the file should go: no rename can
        // replace it, on any platform.
        let path = dir.path().join("ratchets.bin");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inside"), b"keep").unwrap();

        assert!(atomic_write(&path, b"new").is_err());

        assert_eq!(names_in(dir.path()), ["ratchets.bin"]);
        assert_eq!(fs::read(path.join("inside")).unwrap(), b"keep");
    }

    /// Like a virus scanner: a handle without FILE_SHARE_DELETE blocks any
    /// rename over the file until it is closed.
    #[cfg(windows)]
    fn hold_like_a_scanner(path: &Path) -> fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn waits_for_another_program_to_let_go_of_the_file() {
        let dir = ScratchDir::new("atomic-held-briefly");
        let path = dir.path().join("groups.json");
        fs::write(&path, b"old").unwrap();
        let scanner = hold_like_a_scanner(&path);
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            drop(scanner);
        });

        let result = atomic_write(&path, b"new");
        release.join().unwrap();

        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(names_in(dir.path()), ["groups.json"]);
    }

    #[cfg(windows)]
    #[test]
    fn keeps_the_old_contents_while_the_file_stays_locked() {
        let dir = ScratchDir::new("atomic-held");
        let path = dir.path().join("vault.bin");
        fs::write(&path, b"old").unwrap();
        let scanner = hold_like_a_scanner(&path);

        let result = atomic_write(&path, b"new");
        drop(scanner);

        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(names_in(dir.path()), ["vault.bin"]);
    }

    #[cfg(unix)]
    #[test]
    fn written_files_are_readable_by_their_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScratchDir::new("atomic-mode");
        let path = dir.path().join("vault.bin");

        atomic_write(&path, b"sealed").unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn finds_the_temporary_files_a_crash_left_next_to_a_file() {
        let dir = ScratchDir::new("atomic-leftovers");
        let path = dir.path().join("friends.json");
        // What a crash between creating and renaming would leave behind.
        let crashed = temp_path_for(&path).unwrap();
        fs::write(&crashed, b"[]").unwrap();
        for unrelated in [
            "friends.json",
            "friends.json.bak",
            ".friends.json.bak",
            ".groups.json.tmp-1-2-3",
        ] {
            fs::write(dir.path().join(unrelated), b"x").unwrap();
        }

        assert_eq!(leftover_temp_files(&path), [crashed]);
    }
}
