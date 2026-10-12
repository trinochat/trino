//! What the store does to the disk, behind a trait so that tests can make
//! any read, write or removal fail, as another program holding a file or a
//! cut would.

use crate::fsutil;
use std::io;
use std::path::Path;

pub(crate) trait Disk {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// Replace `path` atomically (fsutil.rs), creating its directory.
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
    /// Move `from` to `to`, creating the directory of `to`.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// The names of the files in `dir`; none if it does not exist.
    fn list(&self, dir: &Path) -> io::Result<Vec<String>>;
}

/// The real disk.
pub(crate) struct RealDisk;

impl Disk for RealDisk {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        std::fs::read(path)
    }

    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        fsutil::atomic_write(path, bytes)
    }

    fn remove(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::rename(from, to)
    }

    fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
        let entries = match std::fs::read_dir(dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            entries => entries?,
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                names.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        names.sort();
        Ok(names)
    }
}

/// A real disk on which reads, writes or removals of chosen file names fail.
#[cfg(test)]
pub(crate) mod faulty {
    use super::{Disk, RealDisk};
    use std::cell::RefCell;
    use std::collections::BTreeSet;
    use std::io;
    use std::path::Path;
    use std::rc::Rc;

    #[derive(Default)]
    pub(crate) struct FaultyDisk {
        pub(crate) fail_reads: RefCell<BTreeSet<String>>,
        pub(crate) fail_writes: RefCell<BTreeSet<String>>,
        pub(crate) fail_removes: RefCell<BTreeSet<String>>,
    }

    fn hit(set: &RefCell<BTreeSet<String>>, path: &Path) -> io::Result<()> {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if set.borrow().contains(&name) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("{name} is held by another program"),
            ));
        }
        Ok(())
    }

    impl Disk for Rc<FaultyDisk> {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            hit(&self.fail_reads, path)?;
            RealDisk.read(path)
        }

        fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            hit(&self.fail_writes, path)?;
            RealDisk.write(path, bytes)
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            hit(&self.fail_removes, path)?;
            RealDisk.remove(path)
        }

        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            RealDisk.rename(from, to)
        }

        fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
            RealDisk.list(dir)
        }
    }
}
