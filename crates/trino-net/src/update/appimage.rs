//! Linux: the running AppImage replaced by a verified release (TOR-13),
//! only after the person's yes, and never with sudo.
//!
//! - **Which file** (`running_appimage`): AppImage's runtime puts the path
//!   of the file it runs from in `APPIMAGE` and mounts that file under a
//!   `.mount_…` folder, where Trino's program then runs. Only with both,
//!   and a full path, is there an AppImage to replace; as Tauri checks it
//!   too (`tauri_utils::Env`). Without them (a .deb, an .rpm, a variable
//!   set by hand) nothing is replaced and the release is saved in
//!   Downloads, as before.
//! - **Staged beside it** (`download_appimage`): in the AppImage's own
//!   folder, under a hidden name, so the rename that replaces it stays on
//!   one filesystem. The staged file is made, for its owner only, before
//!   anything is downloaded: a folder Trino cannot write is known first
//!   (`NotInPlace::NotWritable`), and so is an AppImage that is gone
//!   (`NotInPlace::Missing`); then the app saves the release in Downloads
//!   instead. The download is checked whole against its signature before a
//!   byte of it is written, then written, synced, and checked once more
//!   from disk while it is held (Windows) until the yes.
//! - **Replaced on the yes** (`StagedAppImage::replace`): checked once more
//!   from disk, whole, before anything else; given the old file's mode,
//!   with execute wherever it can be read (`executable_mode`); synced; and
//!   renamed over the AppImage. The rename swaps one directory entry, so
//!   until then the old AppImage is whole, and the Trino running keeps its
//!   mount of the old file even after. Then the folder is synced.
//! - **A crash** at any point before the rename leaves the old AppImage as
//!   it was. The staged file left behind goes the next time Trino opens
//!   (`remove_appimage_leftovers`), and one never installed goes when it
//!   is dropped.

use super::sig::{HeldInstaller, SigError, SignedComment, UpdateKey};
use super::{fetch_verified, may_download, Offer, Platform, Source, UpdateError};
use crate::news::Version;
use crate::{HttpClient, Session};
use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

/// The folder AppImage's runtime mounts an AppImage in, by the start of
/// its name (`$TMPDIR/.mount_<name><random>`).
const MOUNT_PREFIX: &str = ".mount_";

/// How a staged AppImage is named: `.<signed name>.part`.
const STAGED_SUFFIX: &str = ".part";

/// Why the AppImage cannot be replaced in place: the release is saved in
/// Downloads instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotInPlace {
    /// The AppImage Trino runs from is no longer there.
    Missing,
    /// Its folder is not Trino's to write (sudo is never asked for).
    NotWritable,
}

/// Why no AppImage was staged.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum AppImageError {
    /// It cannot be replaced in place; nothing was downloaded.
    #[error("the AppImage cannot be replaced in place")]
    NotInPlace(NotInPlace),
    /// The check or the download failed, as for any release.
    #[error(transparent)]
    Update(#[from] UpdateError),
}

/// The AppImage Trino runs from, given `APPIMAGE` and the program running
/// (`std::env::current_exe`): only a full path, and only when the program
/// runs from an AppImage's mount. Pure, so every platform tests it.
pub fn running_appimage(appimage: Option<&OsStr>, current_exe: Option<&Path>) -> Option<PathBuf> {
    let appimage = Path::new(appimage?);
    if !appimage.is_absolute() {
        return None;
    }
    let mounted = current_exe?.components().any(|part| match part {
        Component::Normal(name) => name
            .to_str()
            .is_some_and(|name| name.starts_with(MOUNT_PREFIX)),
        _ => false,
    });
    mounted.then(|| appimage.to_path_buf())
}

/// The mode the new AppImage gets from the old one's `mode`: its
/// permissions kept, execute added wherever it can be read (for its
/// owner always), and never set-user, set-group or sticky.
pub fn executable_mode(mode: u32) -> u32 {
    let kept = mode & 0o777;
    kept | 0o100 | ((kept & 0o044) >> 2)
}

/// Whether `name` is one of Trino's staged AppImages: `.`, the name of a
/// signed AppImage of Trino, then `.part`.
fn is_staged(name: &str) -> bool {
    name.strip_prefix('.')
        .and_then(|name| name.strip_suffix(STAGED_SUFFIX))
        .is_some_and(|signed| Platform::LinuxX64.version_in(signed).is_some())
}

/// When Trino opens: the staged AppImages an earlier run left beside
/// `appimage` (a crash, or a power cut, before the rename) go. Only files
/// with exactly that name, never anything else.
pub fn remove_appimage_leftovers(appimage: &Path) {
    let Some(dir) = std::fs::canonicalize(appimage)
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .or_else(|| appimage.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let ours = entry.file_name().to_str().is_some_and(is_staged)
            && entry.file_type().is_ok_and(|kind| kind.is_file());
        if ours {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Make the staged file at `path`, new and for its owner only, after an
/// older one of the same name.
fn create_staged(path: &Path) -> std::io::Result<File> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn held_error(error: SigError) -> UpdateError {
    match error {
        SigError::Io => UpdateError::Io,
        _ => UpdateError::Signature,
    }
}

/// Download `offer`'s AppImage through `client`, within `session`, check
/// it against its signature, and stage it beside `appimage`, the one
/// running, held until the yes. Nothing is downloaded when `appimage`
/// cannot be replaced in place.
pub async fn download_appimage(
    client: &HttpClient,
    session: &Session,
    source: &Source,
    key: &UpdateKey,
    offer: &Offer,
    appimage: &Path,
) -> Result<StagedAppImage, AppImageError> {
    may_download(client, source, offer)?;
    // The file itself, wherever a link to it points from.
    let target = std::fs::canonicalize(appimage)
        .ok()
        .filter(|target| target.is_file())
        .ok_or(AppImageError::NotInPlace(NotInPlace::Missing))?;
    let dir = target
        .parent()
        .ok_or(AppImageError::NotInPlace(NotInPlace::Missing))?;
    let staged = dir.join(format!(".{}{STAGED_SUFFIX}", offer.signed().file()));
    let mut file =
        create_staged(&staged).map_err(|_| AppImageError::NotInPlace(NotInPlace::NotWritable))?;

    let written = match fetch_verified(client, session, source, key, offer).await {
        Ok(bytes) => file
            .write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| UpdateError::Io),
        Err(error) => Err(error),
    };
    drop(file);
    let held = written.and_then(|()| {
        key.hold_verified(offer.signed(), &staged)
            .map_err(held_error)
    });
    match held {
        Ok(held) => Ok(StagedAppImage {
            held: Some(held),
            signed: offer.signed().clone(),
            staged,
            target,
            replaced: false,
        }),
        Err(error) => {
            let _ = std::fs::remove_file(&staged);
            Err(error.into())
        }
    }
}

/// A verified AppImage staged beside the running one, waiting for the yes.
/// Dropped without `replace`, it is removed.
pub struct StagedAppImage {
    /// Held (Windows) until the yes, so nobody changes it meanwhile.
    held: Option<HeldInstaller>,
    signed: SignedComment,
    staged: PathBuf,
    /// The AppImage it replaces.
    target: PathBuf,
    replaced: bool,
}

impl StagedAppImage {
    pub fn version(&self) -> Version {
        self.signed.version()
    }

    /// Where it is staged.
    pub fn staged(&self) -> &Path {
        &self.staged
    }

    /// The AppImage it replaces.
    pub fn target(&self) -> &Path {
        &self.target
    }

    /// The yes: check it once more from disk, whole, against `key`; give
    /// it the old AppImage's mode and execute; sync it; and rename it over
    /// the AppImage, then sync the folder. Returns the AppImage replaced.
    /// On any failure the old AppImage is as it was and the staged file
    /// goes.
    pub fn replace(mut self, key: &UpdateKey) -> Result<PathBuf, UpdateError> {
        // Let go of it, so it can be renamed (Windows).
        drop(self.held.take());
        let old = std::fs::metadata(&self.target)
            .ok()
            .filter(|old| old.is_file())
            .ok_or(UpdateError::Io)?;
        // Before anything else: what replaces Trino is what was signed.
        let checked = key
            .hold_verified(&self.signed, &self.staged)
            .map_err(held_error)?;
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = executable_mode(old.permissions().mode());
            checked
                .file()
                .set_permissions(std::fs::Permissions::from_mode(mode))
                .and_then(|()| checked.file().sync_all())
                .map_err(|_| UpdateError::Io)?;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = old;
        drop(checked);
        std::fs::rename(&self.staged, &self.target).map_err(|_| UpdateError::Io)?;
        self.replaced = true;
        #[cfg(target_os = "linux")]
        if let Some(dir) = self.target.parent() {
            // The rename itself, kept across a power cut.
            let _ = File::open(dir).and_then(|dir| dir.sync_all());
        }
        Ok(self.target.clone())
    }
}

#[cfg(test)]
impl StagedAppImage {
    /// What Trino dying here leaves: the system closes its files, and
    /// nothing of Trino's runs, not even the drop.
    pub(crate) fn crash(mut self) {
        drop(self.held.take());
        std::mem::forget(self);
    }
}

impl Drop for StagedAppImage {
    fn drop(&mut self) {
        if !self.replaced {
            drop(self.held.take());
            let _ = std::fs::remove_file(&self.staged);
        }
    }
}

impl std::fmt::Debug for StagedAppImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StagedAppImage")
            .field("version", &self.signed.version())
            .finish()
    }
}
