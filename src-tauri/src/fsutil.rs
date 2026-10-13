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
    write_through_temp(path, bytes, |from, to| fs::rename(from, to))
}

/// `atomic_write`, and the rename is on the disk when this returns, so a
/// power cut right after cannot undo it.
///
/// On Windows `atomic_write` cannot promise that: NTFS journals the rename
/// but may not have flushed its journal yet, and "the very last rename may be
/// undone" (`sync_dir_of`). Here the rename goes through `MoveFileExW` with
/// `MOVEFILE_WRITE_THROUGH`, which returns only once the move is on the
/// disk. NTFS writes its journal in order, so every rename made before this
/// one is on the disk too. The migration of the local files writes the vault
/// that commits it this way, before it destroys anything (design §5.2).
pub fn atomic_write_durable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_through_temp(path, bytes, |from, to| move_on_disk(from, to, true))
}

/// Move the file or the directory `from` to `to`, which must not exist, and
/// return only once the move is on the disk (`atomic_write_durable`).
pub fn rename_durable(from: &Path, to: &Path) -> io::Result<()> {
    move_on_disk(from, to, false)?;
    sync_dir_of(to);
    if dir_of(from) != dir_of(to) {
        sync_dir_of(from);
    }
    Ok(())
}

/// `bytes` to a new temporary file next to `path`, synced, then moved over
/// `path` with `rename`. If any step fails, the temporary file is removed and
/// `path` is left as it was.
fn write_through_temp(
    path: &Path,
    bytes: &[u8],
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let temp = temp_path_for(path)?;
    // Nothing to clean up if this fails: the file was never created.
    let file = create_temp(&temp)?;
    if let Err(error) = fill(file, bytes).and_then(|()| rename_over(&temp, path, &rename)) {
        // Best effort. `path` is untouched either way, and a wipe also
        // removes temporary files left behind (`leftover_temp_files`).
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    sync_dir_of(path);
    Ok(())
}

/// Move `from` to `to` and return once the move is on the disk: through
/// `MoveFileExW` with `MOVEFILE_WRITE_THROUGH`, replacing a file at `to`
/// only with `replace`.
#[cfg(windows)]
fn move_on_disk(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    let wide =
        |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(Some(0)).collect() };
    let (from, to) = (wide(from), wide(to));
    let mut flags = MOVEFILE_WRITE_THROUGH;
    if replace {
        flags |= MOVEFILE_REPLACE_EXISTING;
    }
    // SAFETY: both arguments are NUL-terminated UTF-16 strings that live
    // until the call returns, and MoveFileExW keeps neither pointer.
    let moved = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) };
    if moved == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Elsewhere `rename` plus the directory sync (`sync_dir_of`) the callers do
/// after it; a rename would replace an empty directory, so `to` is checked
/// first when it must not be replaced.
#[cfg(not(windows))]
fn move_on_disk(from: &Path, to: &Path, replace: bool) -> io::Result<()> {
    if !replace && fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} exists", to.display()),
        ));
    }
    fs::rename(from, to)
}

/// Overwrite the file at `path` with random bytes of its length, sync it and
/// remove it. A file that is not there is no error. On an SSD the old bytes
/// may stay elsewhere (design §5.4); on a hard disk, and for the small files
/// NTFS keeps in its table, this is what removes them.
pub fn destroy_file(path: &Path) -> io::Result<()> {
    let mut file = match OpenOptions::new().write(true).open(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        file => file?,
    };
    let mut left = file.metadata()?.len();
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let size = chunk.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        for block in chunk[..size].chunks_mut(32) {
            let random: [u8; 32] = crate::crypto::random_array();
            block.copy_from_slice(&random[..block.len()]);
        }
        file.write_all(&chunk[..size])?;
        left -= size as u64;
    }
    file.sync_all()?;
    drop(file);
    fs::remove_file(path)
}

/// Asks Windows Search not to index `dir` nor what is in it now
/// (`FILE_ATTRIBUTE_NOT_CONTENT_INDEXED`, design §5.4 and §8); what is
/// created in it afterwards takes the mark from its folder. Links are not
/// followed, and the other attributes stay. A folder that is not there is
/// nothing to mark. Elsewhere nothing.
pub fn mark_not_indexed(dir: &Path) -> io::Result<()> {
    if !cfg!(windows) {
        return Ok(());
    }
    let kind = match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        metadata => metadata?.file_type(),
    };
    mark_one_not_indexed(dir)?;
    if kind.is_dir() {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                mark_not_indexed(&entry.path())?;
            } else {
                mark_one_not_indexed(&entry.path())?;
            }
        }
    }
    Ok(())
}

/// The mark on one file or folder, keeping its other attributes.
#[cfg(windows)]
fn mark_one_not_indexed(path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetFileAttributesW(path: *const u16, attributes: u32) -> i32;
    }
    const NOT_CONTENT_INDEXED: u32 = 0x2000;
    // What SetFileAttributesW takes: read-only, hidden, system, archive,
    // temporary, offline and not indexed. The rest (a folder, a link) is
    // the file system's own.
    const SETTABLE: u32 = 0x1 | 0x2 | 0x4 | 0x20 | 0x100 | 0x1000 | NOT_CONTENT_INDEXED;

    let attributes = fs::symlink_metadata(path)?.file_attributes();
    if attributes & NOT_CONTENT_INDEXED != 0 {
        return Ok(());
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that lives until the
    // call returns, and SetFileAttributesW keeps no pointer to it.
    let set =
        unsafe { SetFileAttributesW(wide.as_ptr(), (attributes & SETTABLE) | NOT_CONTENT_INDEXED) };
    if set == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn mark_one_not_indexed(_path: &Path) -> io::Result<()> {
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

/// Rename `from` over `to` with `rename`, replacing it.
///
/// On Windows a virus scanner or the search indexer may hold `to` (or the new
/// file) open for a moment without allowing deletes, and the rename then
/// fails with "access denied" or a sharing violation until it lets go. Those
/// failures are retried a few times with a growing pause.
fn rename_over(
    from: &Path,
    to: &Path,
    rename: impl Fn(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let mut pause = FIRST_RENAME_PAUSE;
    let mut attempt = 1;
    loop {
        match rename(from, to) {
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

    /// Design §8: the data folder out of the search index. What NTFS gives a
    /// new file in a marked folder is checked too, since the writes of later
    /// rely on it.
    #[cfg(windows)]
    #[test]
    fn the_data_folder_and_what_is_in_it_are_not_indexed_and_what_comes_later_inherits() {
        use std::os::windows::fs::MetadataExt;
        const NOT_INDEXED: u32 = 0x2000;
        const READ_ONLY: u32 = 0x1;
        let attributes = |path: &Path| fs::symlink_metadata(path).unwrap().file_attributes();
        let dir = ScratchDir::new("not-indexed");
        let home = dir.path().join("home");
        fs::create_dir_all(home.join("store").join("stickers")).unwrap();
        fs::write(home.join("vault.bin"), b"v").unwrap();
        fs::write(home.join("store").join("stickers").join("a.bin"), b"s").unwrap();
        let read_only = home.join("store").join("index.bak");
        fs::write(&read_only, b"r").unwrap();
        let mut permissions = fs::metadata(&read_only).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&read_only, permissions).unwrap();

        mark_not_indexed(&home).unwrap();

        for path in [
            home.clone(),
            home.join("vault.bin"),
            home.join("store"),
            home.join("store").join("stickers"),
            home.join("store").join("stickers").join("a.bin"),
            read_only.clone(),
        ] {
            assert_ne!(attributes(&path) & NOT_INDEXED, 0, "{}", path.display());
        }
        assert_ne!(
            attributes(&read_only) & READ_ONLY,
            0,
            "the other attributes stay"
        );
        atomic_write(&home.join("store").join("account.bin"), b"later").unwrap();
        fs::create_dir(home.join("store").join("aside")).unwrap();
        for path in [
            home.join("store").join("account.bin"),
            home.join("store").join("aside"),
        ] {
            assert_ne!(attributes(&path) & NOT_INDEXED, 0, "{}", path.display());
        }
        let mut permissions = fs::metadata(&read_only).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&read_only, permissions).unwrap();
    }

    #[test]
    fn a_missing_folder_is_nothing_to_mark() {
        let dir = ScratchDir::new("not-indexed-none");
        mark_not_indexed(&dir.path().join("absent")).unwrap();
    }

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
    fn a_durable_write_creates_or_replaces_the_file_and_leaves_no_temporary() {
        let dir = ScratchDir::new("atomic-durable");
        let path = dir.path().join("vault.bin");

        atomic_write_durable(&path, b"first").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"first");
        atomic_write_durable(&path, b"second, longer").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"second, longer");
        assert_eq!(names_in(dir.path()), ["vault.bin"]);
    }

    #[test]
    fn a_durable_write_that_cannot_rename_leaves_the_file_as_it_was() {
        let dir = ScratchDir::new("atomic-durable-blocked");
        let path = dir.path().join("vault.bin");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("inside"), b"keep").unwrap();

        assert!(atomic_write_durable(&path, b"new").is_err());

        assert_eq!(names_in(dir.path()), ["vault.bin"]);
        assert_eq!(fs::read(path.join("inside")).unwrap(), b"keep");
    }

    #[cfg(windows)]
    #[test]
    fn a_durable_write_waits_for_another_program_to_let_go_of_the_file() {
        let dir = ScratchDir::new("atomic-durable-held");
        let path = dir.path().join("vault.bin");
        fs::write(&path, b"old").unwrap();
        let scanner = hold_like_a_scanner(&path);
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(40));
            drop(scanner);
        });

        let result = atomic_write_durable(&path, b"new");
        release.join().unwrap();

        result.unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
    }

    #[test]
    fn a_durable_rename_moves_a_directory_with_its_files() {
        let dir = ScratchDir::new("rename-durable");
        let from = dir.path().join("store.new");
        fs::create_dir_all(from.join("stickers")).unwrap();
        fs::write(from.join("index.bin"), b"index").unwrap();
        fs::write(from.join("stickers").join("a.bin"), b"sticker").unwrap();
        let to = dir.path().join("store");

        rename_durable(&from, &to).unwrap();

        assert!(!from.exists());
        assert_eq!(fs::read(to.join("index.bin")).unwrap(), b"index");
        assert_eq!(
            fs::read(to.join("stickers").join("a.bin")).unwrap(),
            b"sticker"
        );
    }

    #[test]
    fn a_durable_rename_never_replaces_what_is_there() {
        let dir = ScratchDir::new("rename-durable-exists");
        let from = dir.path().join("store.new");
        fs::create_dir(&from).unwrap();
        let to = dir.path().join("store");
        fs::create_dir(&to).unwrap();
        fs::write(to.join("index.bin"), b"keep").unwrap();

        assert!(rename_durable(&from, &to).is_err());

        assert!(from.exists());
        assert_eq!(fs::read(to.join("index.bin")).unwrap(), b"keep");
        assert!(rename_durable(&dir.path().join("missing"), &dir.path().join("x")).is_err());
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
