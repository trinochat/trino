//! What the store does to the disk, behind a trait so that tests can make
//! any read, write or removal fail, as another program holding a file or a
//! cut would.

use crate::fsutil;
use std::io;
use std::path::Path;

pub trait Disk {
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
    /// Replace `path` atomically (fsutil.rs), creating its directory.
    fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    fn remove(&self, path: &Path) -> io::Result<()>;
    /// Move `from` to `to`, creating the directory of `to`.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// The names of the files in `dir`; none if it does not exist.
    fn list(&self, dir: &Path) -> io::Result<Vec<String>>;
    /// `write`, on the disk when it returns: a power cut cannot undo it, nor
    /// anything written before it (`fsutil::atomic_write_durable`).
    fn write_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    /// Move the file or directory `from` to `to`, which must not exist, on
    /// the disk when it returns (`fsutil::rename_durable`).
    fn rename_durable(&self, from: &Path, to: &Path) -> io::Result<()>;
    /// Write `bytes` over the file at `path` in place, the same file, on
    /// the disk when it returns (`fsutil::overwrite_durable`): the second
    /// phase of the vault's write (vault_file.rs).
    fn overwrite_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()>;
    /// Overwrite the file at `path`, sync it and remove it; one that is not
    /// there is no error (`fsutil::destroy_file`).
    fn destroy(&self, path: &Path) -> io::Result<()>;
    /// Remove the directory `dir` with everything in it; one that is not
    /// there is no error.
    fn remove_dir_all(&self, dir: &Path) -> io::Result<()>;
}

/// The real disk.
#[derive(Clone, Copy)]
pub struct RealDisk;

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

    fn write_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        fsutil::atomic_write_durable(path, bytes)
    }

    fn rename_durable(&self, from: &Path, to: &Path) -> io::Result<()> {
        fsutil::rename_durable(from, to)
    }

    fn overwrite_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        fsutil::overwrite_durable(path, bytes)
    }

    fn destroy(&self, path: &Path) -> io::Result<()> {
        fsutil::destroy_file(path)
    }

    fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
        match std::fs::remove_dir_all(dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            done => done,
        }
    }
}

/// A real disk on which reads, writes or removals of chosen file names fail.
#[cfg(any(test, feature = "test-util"))]
pub mod faulty {
    use super::{Disk, RealDisk};
    use std::cell::RefCell;
    use std::collections::BTreeSet;
    use std::io;
    use std::path::Path;
    use std::rc::Rc;

    #[derive(Default)]
    pub struct FaultyDisk {
        pub fail_reads: RefCell<BTreeSet<String>>,
        pub fail_writes: RefCell<BTreeSet<String>>,
        pub fail_removes: RefCell<BTreeSet<String>>,
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

        fn write_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            hit(&self.fail_writes, path)?;
            RealDisk.write_durable(path, bytes)
        }

        fn rename_durable(&self, from: &Path, to: &Path) -> io::Result<()> {
            RealDisk.rename_durable(from, to)
        }

        fn overwrite_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            hit(&self.fail_writes, path)?;
            RealDisk.overwrite_durable(path, bytes)
        }

        fn destroy(&self, path: &Path) -> io::Result<()> {
            hit(&self.fail_removes, path)?;
            RealDisk.destroy(path)
        }

        fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
            RealDisk.remove_dir_all(dir)
        }
    }
}

/// A real disk that a power cut can stop after any number of changes, and
/// that then loses the changes it had not put on the disk yet, as NTFS may
/// (design §5.2, tests 31 and 62).
///
/// Every change counts as one step: a write, a rename, an overwrite, a
/// removal. Once the
/// steps run out the disk is cut: that change and every one after it fail,
/// as nothing more reaches the disk of a computer that lost its power. Then
/// `lose_last` undoes the newest changes that a durable write or rename
/// (`write_durable`, `rename_durable`) had not put on the disk, newest
/// first: a write brings the file back as it was before, a rename moves it
/// back, and a destroyed file comes back with the random bytes it was
/// overwritten with. NTFS writes its journal in order, so what it loses is
/// always the newest changes.
#[cfg(any(test, feature = "test-util"))]
pub mod cut {
    use super::{Disk, RealDisk};
    use std::cell::{Cell, RefCell};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    /// What a step did, for tests that check the order of the steps.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum Step {
        Write(PathBuf),
        WriteDurable(PathBuf),
        Remove(PathBuf),
        Rename(PathBuf, PathBuf),
        RenameDurable(PathBuf, PathBuf),
        Overwrite(PathBuf),
        Destroy(PathBuf),
        RemoveDir(PathBuf),
    }

    /// How to undo a change the disk had not made durable.
    enum Undo {
        /// Put the bytes back at the path, or remove it if it was not there.
        Restore(PathBuf, Option<Vec<u8>>),
        /// Move `to` back to `from`.
        Rename { from: PathBuf, to: PathBuf },
    }

    #[derive(Default)]
    pub struct CutDisk {
        /// Steps left before the cut; none, no cut.
        left: Cell<Option<usize>>,
        cut: Cell<bool>,
        pub steps: RefCell<Vec<Step>>,
        unflushed: RefCell<Vec<Undo>>,
        trash: Cell<u64>,
    }

    impl CutDisk {
        /// A disk that is never cut.
        pub fn whole() -> Rc<CutDisk> {
            Rc::new(CutDisk::default())
        }

        /// A disk cut at its step number `steps`, counted from 0: that step
        /// and every one after it fail.
        pub fn cut_at(steps: usize) -> Rc<CutDisk> {
            let disk = CutDisk::default();
            disk.left.set(Some(steps));
            Rc::new(disk)
        }

        pub fn is_cut(&self) -> bool {
            self.cut.get()
        }

        /// How many changes are not on the disk yet.
        pub fn unflushed(&self) -> usize {
            self.unflushed.borrow().len()
        }

        /// The power cut: undo the newest `count` changes that are not on
        /// the disk yet.
        pub fn lose_last(&self, count: usize) {
            let mut unflushed = self.unflushed.borrow_mut();
            for _ in 0..count {
                let Some(undo) = unflushed.pop() else { break };
                match undo {
                    Undo::Restore(path, Some(before)) => std::fs::write(&path, before).unwrap(),
                    Undo::Restore(path, None) => {
                        let _ = std::fs::remove_file(&path);
                    }
                    Undo::Rename { from, to } => {
                        if let Some(dir) = from.parent() {
                            std::fs::create_dir_all(dir).unwrap();
                        }
                        std::fs::rename(&to, &from).unwrap();
                    }
                }
            }
        }

        fn step(&self, step: Step) -> io::Result<()> {
            if self.cut.get() {
                return Err(io::Error::other("the power is off"));
            }
            match self.left.get() {
                Some(0) => {
                    self.cut.set(true);
                    return Err(io::Error::other("the power went off"));
                }
                Some(left) => self.left.set(Some(left - 1)),
                None => {}
            }
            self.steps.borrow_mut().push(step);
            Ok(())
        }

        fn unflushed_change(&self, undo: Undo) {
            self.unflushed.borrow_mut().push(undo);
        }

        fn flushed(&self) {
            self.unflushed.borrow_mut().clear();
        }
    }

    fn before(path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }

    impl Disk for Rc<CutDisk> {
        fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
            RealDisk.read(path)
        }

        fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            self.step(Step::Write(path.to_path_buf()))?;
            let before = before(path);
            RealDisk.write(path, bytes)?;
            self.unflushed_change(Undo::Restore(path.to_path_buf(), before));
            Ok(())
        }

        fn remove(&self, path: &Path) -> io::Result<()> {
            self.step(Step::Remove(path.to_path_buf()))?;
            let before = before(path);
            RealDisk.remove(path)?;
            self.unflushed_change(Undo::Restore(path.to_path_buf(), before));
            Ok(())
        }

        fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.step(Step::Rename(from.to_path_buf(), to.to_path_buf()))?;
            RealDisk.rename(from, to)?;
            self.unflushed_change(Undo::Rename {
                from: from.to_path_buf(),
                to: to.to_path_buf(),
            });
            Ok(())
        }

        fn list(&self, dir: &Path) -> io::Result<Vec<String>> {
            RealDisk.list(dir)
        }

        fn write_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            self.step(Step::WriteDurable(path.to_path_buf()))?;
            RealDisk.write_durable(path, bytes)?;
            self.flushed();
            Ok(())
        }

        fn rename_durable(&self, from: &Path, to: &Path) -> io::Result<()> {
            self.step(Step::RenameDurable(from.to_path_buf(), to.to_path_buf()))?;
            RealDisk.rename_durable(from, to)?;
            self.flushed();
            Ok(())
        }

        /// One step, all or nothing: this disk does not tear a file; the
        /// vault's tests tear one by hand (vault_file.rs).
        fn overwrite_durable(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
            self.step(Step::Overwrite(path.to_path_buf()))?;
            RealDisk.overwrite_durable(path, bytes)?;
            self.flushed();
            Ok(())
        }

        fn destroy(&self, path: &Path) -> io::Result<()> {
            self.step(Step::Destroy(path.to_path_buf()))?;
            let len = before(path).map(|bytes| bytes.len());
            RealDisk.destroy(path)?;
            // The random bytes reached the disk; the removal may not have.
            if let Some(len) = len {
                let garbage = (0..len).map(|i| (i as u8) ^ 0xa5).collect();
                self.unflushed_change(Undo::Restore(path.to_path_buf(), Some(garbage)));
            }
            Ok(())
        }

        fn remove_dir_all(&self, dir: &Path) -> io::Result<()> {
            self.step(Step::RemoveDir(dir.to_path_buf()))?;
            if !dir.exists() {
                return Ok(());
            }
            // Moved out of the way rather than removed, so a cut can bring
            // it back.
            let n = self.trash.get() + 1;
            self.trash.set(n);
            let name = format!(
                ".cut-trash-{n}-{}",
                dir.file_name().unwrap().to_string_lossy()
            );
            let trash = dir.with_file_name(name);
            std::fs::rename(dir, &trash)?;
            self.unflushed_change(Undo::Rename {
                from: dir.to_path_buf(),
                to: trash,
            });
            Ok(())
        }
    }
}
