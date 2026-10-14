//! Tor's folders (Tor design §2.5): the fixed `state/` and `cache/`, and,
//! with private bridges, a folder of the session's own (R-01).
//!
//! Arti keeps every bridge line it uses whole, the `cert=` of obfs4 and
//! the `url=` of WebTunnel included, in `cache/dir.sqlite3`, and the
//! bridges among its guards in `state/` (F47). A private bridge kept there
//! would give a seized computer the bridge itself and the proof that it
//! was used. So with private bridges Tor runs in `run-<random>/state` and
//! `run-<random>/cache`, made at each start and destroyed, file by file,
//! when it stops: at lock, quit and "Borrar todo". A `run-*` a cut left
//! behind is destroyed when Trino opens.
//!
//! Destroying a file is writing random bytes over it, syncing and removing
//! it; links are removed, never followed. On an SSD the old bytes may stay
//! elsewhere (cifrado local §5.4), as the app's text says (§10.2).

use super::TorDirs;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// The name of a session's folder starts so.
pub const RUN_PREFIX: &str = "run-";

impl TorDirs {
    /// A new folder for one session with private bridges, under
    /// `tor_home`, with its `state/` and `cache/` made. Returns the
    /// folders and the session's folder, which `destroy_tree` takes.
    pub(crate) fn session(tor_home: &Path) -> io::Result<(TorDirs, PathBuf)> {
        let random: [u8; 16] = rand::random();
        let name: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let run = tor_home.join(format!("{RUN_PREFIX}{name}"));
        let dirs = TorDirs {
            state: run.join("state"),
            cache: run.join("cache"),
        };
        fs::create_dir_all(&dirs.state)?;
        fs::create_dir_all(&dirs.cache)?;
        Ok((dirs, run))
    }
}

/// Destroy every file under `dir`, then the folders. Every file is tried;
/// the first error is returned. A folder that is not there is no error.
pub fn destroy_tree(dir: &Path) -> io::Result<()> {
    destroy_tree_with(dir, &mut |_| {})
}

/// `destroy_tree`, calling `overwritten` with each file once its bytes are
/// overwritten, before it is removed (tests).
pub(crate) fn destroy_tree_with(dir: &Path, overwritten: &mut dyn FnMut(&Path)) -> io::Result<()> {
    let kind = match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        metadata => metadata?.file_type(),
    };
    if !kind.is_dir() {
        // A file or a link given as the folder: removed, never followed.
        return fs::remove_file(dir);
    }
    let mut first = None;
    for entry in fs::read_dir(dir)? {
        let done = entry.and_then(|entry| {
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                destroy_tree_with(&path, overwritten)
            } else if kind.is_symlink() {
                fs::remove_file(&path).or_else(|_| fs::remove_dir(&path))
            } else {
                overwrite(&path, overwritten)
            }
        });
        if let Err(error) = done {
            first.get_or_insert(error);
        }
    }
    if let Some(error) = first {
        return Err(error);
    }
    fs::remove_dir(dir)
}

/// Write random bytes over the file at `path`, sync it, show it to
/// `overwritten` and remove it.
fn overwrite(path: &Path, overwritten: &mut dyn FnMut(&Path)) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).open(path)?;
    let mut left = file.metadata()?.len();
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let size = chunk.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut chunk[..size]);
        file.write_all(&chunk[..size])?;
        left -= size as u64;
    }
    file.sync_all()?;
    drop(file);
    overwritten(path);
    fs::remove_file(path)
}

/// Destroy every `run-*` folder in `tor_home` that a cut left behind.
/// Returns how many there were.
pub fn destroy_leftover_runs(tor_home: &Path) -> usize {
    let Ok(entries) = fs::read_dir(tor_home) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(RUN_PREFIX))
                && entry.file_type().is_ok_and(|kind| kind.is_dir())
        })
        .filter(|entry| destroy_tree(&entry.path()).is_ok())
        .count()
}
