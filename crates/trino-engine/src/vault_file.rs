//! `vault.bin` on disk (clave de emergencia CE-3, design §3.6 and §3.7):
//! opening every version the app reads, and the two-phase write every seal
//! goes through.
//!
//! - **Opening.** A version 3 vault (trino-core `vault_v3`) opens with
//!   `unseal_vault_v3`; one of version 1 or 2 with `unseal_vault`, and the
//!   unlock moves it to version 3 (`account::unlock_files`).
//! - **The two-phase write** (design §3.6). The new bytes go to
//!   `vault.bin.next` and onto the disk; then over `vault.bin` in place, the
//!   same file, and onto the disk; then `vault.bin.next` is destroyed. A
//!   rename would leave every older vault whole in the free space; written
//!   in place, the live file holds only the newest. If a cut tears
//!   `vault.bin`, the next opening finds that it does not open, opens
//!   `vault.bin.next` with the same passphrase, and finishes the write.
//!   Every seal of the vault goes through it: a new account, the rotation
//!   of the signed prekey, the settings, the migrations and the shared
//!   block, so the way the vault is written never tells one from another.

use crate::command_error::{CommandError, ErrorCode};
use crate::identity::Identity;
use crate::store::disk::{Disk, RealDisk};
use crate::vault::{decode_vault, unseal_vault, vault_requires_totp, UnsealedVault, VaultError};
use crate::vault_v3::{
    unseal_vault_v3, vault_v3_requires_totp, vault_version, OpenVault, Unlocked,
};
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Where the new bytes of a two-phase write wait: `vault.bin.next`.
pub fn next_path(vault: &Path) -> PathBuf {
    let mut name = vault.file_name().map(OsString::from).unwrap_or_default();
    name.push(".next");
    vault.with_file_name(name)
}

/// Phase 1 of the two-phase write: `bytes` to `vault.bin.next`, on the disk
/// when it returns. If it fails, `vault.bin` is as it was.
pub fn write_next(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    disk.write_durable(&next_path(vault), bytes)
}

/// Phases 2 and 3: `bytes` over `vault.bin` in place, on the disk when it
/// returns, then `vault.bin.next` destroyed. Once phase 1 is done the new
/// vault is committed: if this fails, or a cut tears `vault.bin`, the next
/// opening finishes it from `vault.bin.next`. A `vault.bin.next` that cannot
/// be destroyed now goes at the next opening.
pub fn finish(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    disk.overwrite_durable(vault, bytes)?;
    let _ = disk.destroy(&next_path(vault));
    Ok(())
}

/// The two-phase write on `disk` (design §3.6).
pub fn write_with(disk: &impl Disk, vault: &Path, bytes: &[u8]) -> io::Result<()> {
    write_next(disk, vault, bytes)?;
    finish(disk, vault, bytes)
}

/// The two-phase write on the real disk: how every vault is written.
pub fn write(vault: &Path, bytes: &[u8]) -> io::Result<()> {
    write_with(&RealDisk, vault, bytes)
}

/// Open the vault at `vault` with `open`, finishing a two-phase write a cut
/// stopped (design §3.6 and §6.4):
///
/// - `vault.bin` opens: what waits in `vault.bin.next` is not needed, and
///   goes;
/// - it does not (a wrong passphrase, or a torn file) and `vault.bin.next`
///   opens with the same passphrase and code: the write is finished from
///   it, and that is the vault;
/// - neither: nothing is written, and the error is that of
///   `vault.bin.next` if it is whole and `vault.bin` may be torn (a wrong
///   passphrase, or the code), else that of `vault.bin`.
///
/// A vault that asks for its code, or refuses the one given, opened its
/// slot: it is whole, and `vault.bin.next` is not tried.
pub fn open_with<T>(
    disk: &impl Disk,
    vault: &Path,
    open: impl Fn(&[u8]) -> Result<T, CommandError>,
) -> Result<T, CommandError> {
    let bytes = disk.read(vault).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => {
            CommandError::new(ErrorCode::NoVault, "there is no identity on this device")
        }
        _ => CommandError::io(&error),
    })?;
    let next = next_path(vault);
    let error = match open(&bytes) {
        Ok(opened) => {
            if next.exists() {
                let _ = disk.destroy(&next);
            }
            return Ok(opened);
        }
        Err(error) if asks_for_the_code(&error) => return Err(error),
        Err(error) => error,
    };
    let Ok(waiting) = disk.read(&next) else {
        return Err(error);
    };
    match open(&waiting) {
        Ok(opened) => {
            finish(disk, vault, &waiting).map_err(|e| CommandError::io(&e))?;
            Ok(opened)
        }
        // The vault that waits is whole, and `vault.bin` may be torn: its
        // answer is the one to give (the code, or a wrong passphrase).
        Err(next_error) if is_whole(&next_error) => Err(next_error),
        Err(_) => Err(error),
    }
}

fn asks_for_the_code(error: &CommandError) -> bool {
    matches!(error.code, ErrorCode::TotpRequired | ErrorCode::InvalidTotp)
}

/// An error only a whole vault gives: it read, and the passphrase or the
/// code did not open it.
fn is_whole(error: &CommandError) -> bool {
    asks_for_the_code(error) || error.code == ErrorCode::WrongPassphrase
}

/// Whether opening the vault at `vault` will ask for a TOTP code, from its
/// header alone, of any version: `None` with no vault, or one this version
/// cannot read. A `vault.bin` a cut tore answers from `vault.bin.next`.
pub fn totp_hint(vault: &Path) -> Option<bool> {
    let hint = |path: &Path| std::fs::read(path).ok().and_then(|bytes| hint_of(&bytes));
    if !vault.exists() {
        return None;
    }
    hint(vault).or_else(|| hint(&next_path(vault)))
}

fn hint_of(bytes: &[u8]) -> Option<bool> {
    match vault_version(bytes) {
        Ok(3) => vault_v3_requires_totp(bytes).ok(),
        _ => vault_requires_totp(bytes).ok(),
    }
}

/// A vault opened with its passphrase: one of version 1 or 2, which the
/// unlock moves to version 3, or one of version 3, which seals itself again.
pub enum OpenedVault {
    Old(Box<UnsealedVault>),
    V3(Box<OpenVault>),
}

impl OpenedVault {
    pub fn identity(&self) -> &Identity {
        match self {
            OpenedVault::Old(old) => &old.identity,
            OpenedVault::V3(vault) => vault.identity(),
        }
    }

    pub fn totp_secret(&self) -> Option<&[u8]> {
        match self {
            OpenedVault::Old(old) => old.totp_secret.as_deref(),
            OpenedVault::V3(vault) => vault.totp_secret(),
        }
    }

    pub fn app(&self) -> Option<&[u8]> {
        match self {
            OpenedVault::Old(old) => old.app.as_deref().map(Vec::as_slice),
            OpenedVault::V3(vault) => vault.app(),
        }
    }

    /// What it holds, as a vault of version 2 gives it.
    pub fn into_unsealed(self) -> UnsealedVault {
        match self {
            OpenedVault::Old(old) => *old,
            OpenedVault::V3(vault) => UnsealedVault {
                identity: vault.identity().clone(),
                totp_secret: vault.totp_secret().map(<[u8]>::to_vec),
                app: vault.app().map(|app| Zeroizing::new(app.to_vec())),
            },
        }
    }
}

/// Open the vault in `bytes`, of any version, with `passphrase` and
/// `code`.
///
/// The emergency key (CE-4) is not handled yet: nothing in this version
/// can set one, and a vault that answers to one answers as a wrong
/// passphrase, with its very error.
pub fn open_bytes(
    bytes: &[u8],
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    if vault_version(bytes).ok() == Some(3) {
        return match unseal_vault_v3(bytes, passphrase, code)? {
            Unlocked::Real(vault) => Ok(OpenedVault::V3(vault)),
            Unlocked::Emergency(_) => Err(VaultError::DecryptionFailed.into()),
        };
    }
    let sealed = decode_vault(bytes)?;
    Ok(OpenedVault::Old(Box::new(unseal_vault(
        &sealed, passphrase, code,
    )?)))
}

/// Open the vault at `vault` on the real disk (`open_with`).
pub fn open(
    vault: &Path,
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    open_with(&RealDisk, vault, |bytes| {
        open_bytes(bytes, passphrase, code)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::disk::cut::{CutDisk, Step};
    use std::io::{Read, Seek};

    const NEW: &[u8] = b"the vault as sealed now";
    const OLD: &[u8] = b"the vault as it was sealed before, longer";

    /// Opens `b"<passphrase>|..."` only with that passphrase: a stand-in
    /// for a vault, so these tests derive no key.
    fn opener(passphrase: &'static str) -> impl Fn(&[u8]) -> Result<Vec<u8>, CommandError> {
        move |bytes| {
            if bytes.starts_with(passphrase.as_bytes()) {
                Ok(bytes.to_vec())
            } else {
                Err(VaultError::DecryptionFailed.into())
            }
        }
    }

    /// Design §12.2, test 19: through `vault.bin.next`, then over the same
    /// file, then the copy destroyed.
    #[test]
    fn a_vault_write_goes_through_next_and_overwrites_in_place() {
        let scratch = ScratchDir::new("vault-two-phase");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, OLD).unwrap();
        let mut held = std::fs::File::open(&vault).unwrap();
        let disk = CutDisk::whole();

        write_with(&disk, &vault, NEW).unwrap();

        assert_eq!(
            *disk.steps.borrow(),
            [
                Step::WriteDurable(next_path(&vault)),
                Step::Overwrite(vault.clone()),
                Step::Destroy(next_path(&vault)),
            ]
        );
        assert_eq!(std::fs::read(&vault).unwrap(), NEW);
        assert!(!next_path(&vault).exists());
        // The same file: a handle opened before reads the new bytes, which
        // a rename over it would have left in another file.
        let mut through_handle = Vec::new();
        held.rewind().unwrap();
        held.read_to_end(&mut through_handle).unwrap();
        assert_eq!(through_handle, NEW);
    }

    #[test]
    fn the_real_disk_writes_a_new_vault_too() {
        let scratch = ScratchDir::new("vault-two-phase-new");
        let vault = scratch.path().join("vault.bin");
        write(&vault, NEW).unwrap();
        assert_eq!(std::fs::read(&vault).unwrap(), NEW);
        write(&vault, OLD).unwrap();
        write(&vault, NEW).unwrap();
        assert_eq!(std::fs::read(&vault).unwrap(), NEW, "the older tail stayed");
        assert!(!next_path(&vault).exists());
    }

    /// A cut before the copy is on the disk leaves `vault.bin` as it was.
    #[test]
    fn a_cut_in_the_first_phase_leaves_the_vault_as_it_was() {
        let scratch = ScratchDir::new("vault-two-phase-cut");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, OLD).unwrap();
        for at in 0..2 {
            let disk = CutDisk::cut_at(at);
            assert!(write_with(&disk, &vault, NEW).is_err());
            assert_eq!(std::fs::read(&vault).unwrap(), OLD, "cut at {at}");
        }
    }

    /// Design §12.2, test 20.
    #[test]
    fn a_torn_vault_with_a_valid_next_is_finished_at_open() {
        let scratch = ScratchDir::new("vault-torn");
        let vault = scratch.path().join("vault.bin");
        let whole = b"pass|the new vault".to_vec();
        std::fs::write(next_path(&vault), &whole).unwrap();
        let mut torn = whole.clone();
        torn[..4].copy_from_slice(b"\0\0\0\0");
        std::fs::write(&vault, &torn).unwrap();

        // Another passphrase opens neither: nothing is written.
        let error = open_with(&RealDisk, &vault, opener("nope")).unwrap_err();
        assert_eq!(error.code, ErrorCode::WrongPassphrase);
        assert_eq!(std::fs::read(&vault).unwrap(), torn);
        assert!(next_path(&vault).exists());

        let opened = open_with(&RealDisk, &vault, opener("pass")).unwrap();
        assert_eq!(opened, whole);
        assert_eq!(std::fs::read(&vault).unwrap(), whole);
        assert!(!next_path(&vault).exists());
    }

    /// A copy left by a cut after `vault.bin` was written goes once it opens.
    #[test]
    fn a_next_left_over_goes_once_the_vault_opens() {
        let scratch = ScratchDir::new("vault-next-left");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"pass|the vault").unwrap();
        std::fs::write(next_path(&vault), b"pass|the vault").unwrap();

        assert!(open_with(&RealDisk, &vault, opener("nope")).is_err());
        assert!(next_path(&vault).exists(), "a failed unlock wrote");
        open_with(&RealDisk, &vault, opener("pass")).unwrap();
        assert!(!next_path(&vault).exists());
        assert_eq!(std::fs::read(&vault).unwrap(), b"pass|the vault");
    }

    /// A torn vault whose copy asks for its code: the code is asked for,
    /// never "wrong passphrase", and nothing is written until it is given.
    #[test]
    fn a_torn_vault_whose_copy_asks_for_the_code_asks_for_it() {
        let scratch = ScratchDir::new("vault-torn-totp");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(&vault, b"torn").unwrap();
        std::fs::write(next_path(&vault), b"pass|with totp").unwrap();
        let asks = |bytes: &[u8]| -> Result<(), CommandError> {
            if bytes.starts_with(b"pass") {
                Err(VaultError::TotpRequired.into())
            } else {
                Err(VaultError::DecryptionFailed.into())
            }
        };
        let error = open_with(&RealDisk, &vault, asks).unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        assert_eq!(std::fs::read(&vault).unwrap(), b"torn");
    }

    #[test]
    fn opening_tells_a_missing_vault() {
        let scratch = ScratchDir::new("vault-missing");
        let vault = scratch.path().join("vault.bin");
        std::fs::write(next_path(&vault), b"pass|a copy alone").unwrap();
        let error = open_with(&RealDisk, &vault, opener("pass")).unwrap_err();
        assert_eq!(error.code, ErrorCode::NoVault);
        assert_eq!(totp_hint(&vault), None);
    }
}
