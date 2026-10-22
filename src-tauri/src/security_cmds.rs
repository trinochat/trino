//! The security commands of the first run and the settings: the passphrase
//! policy checked on its own (K1), TOTP turned on and off (K5) and a new
//! passphrase (K6).
//!
//! The settings' commands seal the vault again. While they do, they hold
//! `session_gate`, as `forge`, `unseal`, `lock_vault` and `wipe` do: a wipe
//! in between would otherwise find its vault written back. The slow key
//! derivation runs off the async workers, and the new vault is written in
//! two phases (the engine's vault_file.rs), so a crash leaves one or the
//! other. Each re-seal is noted in the store's index first (design §4.9),
//! so the next unlock does not take the new vault for another one.
//!
//! A version 3 vault (clave de emergencia CE-3) is sealed again part by
//! part: TOTP in its shared block, a new passphrase in its slot. The
//! session keeps its own copy of it, to seal its shared block when the name
//! or a security setting changes; the settings hold that copy for the
//! whole of their seal and put theirs in its place, so neither undoes the
//! other.

use crate::command_error::{CommandError, ErrorCode};
use crate::commands::storage_cmds::write_vault_noted_in;
use crate::commands::submitted_code;
use crate::passphrase::validate_passphrase;
use crate::state::{vault_path, AppState, InnerState};
use crate::store::session::StorageCell;
use crate::vault::{encode_vault, seal_vault, UnsealedVault};
use std::path::Path;
use tauri::State;
use trino_core::vault_v3::OpenVault;
use trino_engine::vault_file::{OpenedVault, SessionVault, VaultCell};
use zeroize::{Zeroize, Zeroizing};

/// How a settings command writes the vault it sealed again: noted in the
/// open session's store, with the signed prekey the vault holds (a re-seal
/// here never rotates it).
struct NotedWrite {
    storage: StorageCell,
    spk: u32,
    /// The session's version 3 vault, held while the settings seal theirs.
    vault: VaultCell,
}

impl NotedWrite {
    fn write(&self, vault: &Path, bytes: &[u8]) -> std::io::Result<()> {
        write_vault_noted_in(&self.storage, vault, bytes, self.spk)
    }
}

/// What a settings command sealed: a version 3 vault, which the session
/// keeps from then on in place of its own, or nothing to keep (a vault of
/// version 2, which the session does not keep, or nothing changed).
struct Resealed(Option<Box<OpenVault>>);

impl std::fmt::Debug for Resealed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() {
            "Resealed(v3)"
        } else {
            "Resealed"
        })
    }
}

impl Resealed {
    /// Put the vault sealed at `path` in the session, if there is one.
    fn keep_in(self, session: &mut Option<SessionVault>, path: &Path) {
        if let Some(vault) = self.0 {
            *session = Some(SessionVault {
                path: path.to_path_buf(),
                vault,
            });
        }
    }
}

/// The open session's `NotedWrite`; `no_vault` while it is locked.
fn noting(inner: &InnerState) -> Result<NotedWrite, CommandError> {
    require_session(inner)?;
    let spk = inner
        .identity
        .as_ref()
        .map_or(0, |identity| identity.signed_prekey.id);
    Ok(NotedWrite {
        storage: inner.storage.clone(),
        spk,
        vault: inner.vault.clone(),
    })
}

/// Check a new passphrase against the policy (passphrase.rs) before any
/// identity exists, so the first-run screens can tell what is wrong before
/// the slow key derivation of `forge`. The policy lives only in Rust: a copy
/// in TypeScript would drift from it. Takes no state and writes nothing;
/// `forge` checks again.
#[tauri::command]
pub fn check_passphrase(passphrase: String) -> Result<(), CommandError> {
    let passphrase = Zeroizing::new(passphrase);
    validate_passphrase(&passphrase).map_err(CommandError::from)
}

/// Turn TOTP on (K5): seal the vault again with the secret confirmed through
/// `totp_begin` and `totp_verify`, so unlocking asks for its code from then
/// on. Needs the open session and its passphrase; `status.totp_enabled`
/// follows, as it reads the vault.
#[tauri::command]
pub async fn totp_enable(
    state: State<'_, AppState>,
    passphrase: String,
) -> Result<(), CommandError> {
    let passphrase = Zeroizing::new(passphrase);
    let _gate = state.session_gate.lock().await;
    let (secret, noted) = {
        let inner = state.inner.lock().await;
        (confirmed_secret(&inner)?, noting(&inner)?)
    };
    let vault = vault_path();
    // The worker hands the secret back only once the vault holds it; on
    // any other way out it is dropped there, and wiped.
    let mut secret = run_blocking(move || {
        let mut session = noted.vault.lock();
        enable_totp(&vault, &passphrase, &secret, |bytes| {
            noted.write(&vault, bytes)
        })?
        .keep_in(&mut session, &vault);
        Ok(secret)
    })
    .await?;
    let mut inner = state.inner.lock().await;
    inner.totp_enrollment.clear();
    replace_secret(&mut inner, Some(std::mem::take(&mut *secret)));
    Ok(())
}

/// Turn TOTP off (K5): with the passphrase and a valid code, as T4 asks,
/// seal the vault again without its secret.
#[tauri::command]
pub async fn totp_disable(
    state: State<'_, AppState>,
    passphrase: String,
    code: String,
) -> Result<(), CommandError> {
    let passphrase = Zeroizing::new(passphrase);
    let code = Zeroizing::new(code);
    let _gate = state.session_gate.lock().await;
    let noted = noting(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let mut session = noted.vault.lock();
        disable_totp(&vault, &passphrase, &code, |bytes| {
            noted.write(&vault, bytes)
        })?
        .keep_in(&mut session, &vault);
        Ok(())
    })
    .await?;
    replace_secret(&mut *state.inner.lock().await, None);
    Ok(())
}

/// A new passphrase (K6). `next` must pass the policy, checked first; then
/// `current` opens the vault, with a valid `totp_code` when TOTP is on, and
/// the vault is sealed again with `next` and the same TOTP secret.
#[tauri::command]
pub async fn change_passphrase(
    state: State<'_, AppState>,
    current: String,
    next: String,
    totp_code: Option<String>,
) -> Result<(), CommandError> {
    let current = Zeroizing::new(current);
    let next = Zeroizing::new(next);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    let noted = noting(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let mut session = noted.vault.lock();
        let code = totp_code.as_deref().map(String::as_str);
        reseal_with_new_passphrase(&vault, &current, &next, code, |bytes| {
            noted.write(&vault, bytes)
        })?
        .keep_in(&mut session, &vault);
        Ok(())
    })
    .await
}

/// The open session's TOTP secret from `totp_begin`, once `totp_verify`
/// confirmed it: nobody may turn on a secret their app does not have.
fn confirmed_secret(inner: &InnerState) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    require_session(inner)?;
    Ok(Zeroizing::new(
        inner.totp_enrollment.verified_secret()?.to_vec(),
    ))
}

fn require_session(inner: &InnerState) -> Result<(), CommandError> {
    match inner.identity {
        Some(_) => Ok(()),
        None => Err(CommandError::new(ErrorCode::NoVault, "the vault is locked")),
    }
}

/// The session's copy of the TOTP secret, the old one wiped first.
fn replace_secret(inner: &mut InnerState, secret: Option<Vec<u8>>) {
    if let Some(old) = inner.totp_secret.as_mut() {
        old.zeroize();
    }
    inner.totp_secret = secret;
}

/// Run `work`, a key derivation, off the async workers, as `unseal` does.
async fn run_blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, CommandError> + Send + 'static,
) -> Result<T, CommandError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| CommandError::internal("vault worker failed"))?
}

/// Seal the vault at `vault` again with `secret`, once `passphrase` opened
/// it, and save it with `write`. A vault with TOTP on is left as it is: a
/// second secret would replace the one in the user's app.
fn enable_totp(
    vault: &Path,
    passphrase: &str,
    secret: &[u8],
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    // Without a code, only a vault that has TOTP asks for one.
    let opened = open_any(vault, passphrase, None).map_err(|error| match error.code {
        ErrorCode::TotpRequired => CommandError::internal("TOTP is on already"),
        _ => error,
    })?;
    match opened {
        OpenedVault::V3(mut fresh) => {
            fresh.set_totp_secret(Some(secret))?;
            write_v3(fresh, write)
        }
        OpenedVault::Old(old) => {
            seal_and_write(&old, Some(secret), passphrase, write)?;
            Ok(Resealed(None))
        }
    }
}

/// Seal the vault at `vault` again without its TOTP secret, once
/// `passphrase` and a valid `code` opened it. A vault without TOTP is left as
/// it is.
fn disable_totp(
    vault: &Path,
    passphrase: &str,
    code: &str,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    let code = submitted_code(Some(code)).ok_or_else(|| {
        CommandError::new(ErrorCode::TotpRequired, "turning TOTP off needs a code")
    })?;
    match open_any(vault, passphrase, Some(code))? {
        OpenedVault::V3(fresh) if fresh.totp_secret().is_none() => Ok(Resealed(None)),
        OpenedVault::V3(mut fresh) => {
            fresh.set_totp_secret(None)?;
            write_v3(fresh, write)
        }
        OpenedVault::Old(mut old) => {
            if old.totp_secret.take().map(Zeroizing::new).is_none() {
                return Ok(Resealed(None));
            }
            seal_and_write(&old, None, passphrase, write)?;
            Ok(Resealed(None))
        }
    }
}

/// Seal the vault at `vault` with `next` instead of `current`, keeping its
/// TOTP secret or the lack of one, and save it with `write`. The policy on
/// `next` is checked before anything is opened; a vault with TOTP needs its
/// `code`.
fn reseal_with_new_passphrase(
    vault: &Path,
    current: &str,
    next: &str,
    code: Option<&str>,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    validate_passphrase(next)?;
    match open_any(vault, current, submitted_code(code))? {
        OpenedVault::V3(mut fresh) => {
            // The same salt and parameters; the other slots as they are. A
            // new passphrase that is the emergency key is refused.
            fresh.change_passphrase(next)?;
            write_v3(fresh, write)
        }
        OpenedVault::Old(mut old) => {
            let secret = old.totp_secret.take().map(Zeroizing::new);
            seal_and_write(&old, secret.as_deref().map(Vec::as_slice), next, write)?;
            Ok(Resealed(None))
        }
    }
}

/// Open the vault at `vault`, of any version, finishing a write a cut
/// stopped (the engine's vault_file.rs).
fn open_any(
    vault: &Path,
    passphrase: &str,
    code: Option<&str>,
) -> Result<OpenedVault, CommandError> {
    trino_engine::vault_file::open(vault, passphrase, code)
}

/// Save the version 3 vault the settings sealed again, for the session to
/// keep.
fn write_v3(
    fresh: Box<OpenVault>,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    write(fresh.bytes()).map_err(|e| CommandError::io(&e))?;
    Ok(Resealed(Some(fresh)))
}

/// Seal the identity and the app data of a vault of version 2, `opened`,
/// with `passphrase` and, if given, `secret`, and save it with `write`. The app data always goes back
/// in: trino-core seals only what it is given, and it holds the key to
/// everything in store/.
fn seal_and_write(
    opened: &UnsealedVault,
    secret: Option<&[u8]>,
    passphrase: &str,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<(), CommandError> {
    let app = opened.app.as_deref().map(Vec::as_slice);
    let sealed = seal_vault(&opened.identity, secret, app, passphrase)?;
    write(&encode_vault(&sealed)).map_err(|e| CommandError::io(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::passphrase::MIN_PASSPHRASE_CHARS;

    #[test]
    fn a_short_passphrase_is_refused_with_the_minimum() {
        let error = check_passphrase("corta".to_string()).unwrap_err();
        assert_eq!(
            (error.code, error.min),
            (ErrorCode::PassphraseTooShort, Some(MIN_PASSPHRASE_CHARS))
        );
    }

    #[test]
    fn a_common_passphrase_is_refused() {
        for common in ["Contraseña123", "1234567890", "qwertyuiop", "aaaaaaaaaaaa"] {
            let error = check_passphrase(common.to_string()).unwrap_err();
            assert_eq!(error.code, ErrorCode::PassphraseTooCommon, "{common}");
            assert_eq!(error.min, None);
        }
    }

    #[test]
    fn a_passphrase_that_passes_the_policy_is_accepted() {
        assert_eq!(
            check_passphrase("correct horse battery staple".to_string()),
            Ok(())
        );
    }

    #[test]
    fn the_policy_is_checked_before_any_identity_exists() {
        // The first-run screens ask before `forge`: no vault, no session and
        // no data directory are needed. The command takes no state, so it
        // cannot read or write one, and it still refuses what the policy
        // refuses.
        let check: fn(String) -> Result<(), crate::command_error::CommandError> = check_passphrase;
        let refused = |passphrase: &str| check(passphrase.to_string()).unwrap_err().code;
        assert_eq!(refused("corta"), ErrorCode::PassphraseTooShort);
        assert_eq!(refused("1234567890"), ErrorCode::PassphraseTooCommon);
        assert!(check("una frase larga y rara".to_string()).is_ok());
    }

    #[test]
    fn turning_totp_on_keeps_no_plain_copy_of_the_secret() {
        // A plain Vec of it would stay in freed memory whenever sealing
        // fails: a wrong passphrase, TOTP on already, a disk error.
        let code = include_str!("security_cmds.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let body = code
            .split("pub async fn totp_enable(")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .unwrap();
        assert!(!body.contains("to_vec()"), "a plain copy:{body}");
    }

    // ---- K5: TOTP on and off from the settings ----
    //
    // Each seal or unseal is a full PBKDF2 run, seconds in a debug build:
    // these tests use as few as they can.

    use crate::commands::open_vault;
    use crate::fsutil::{self, scratch::ScratchDir};
    use crate::identity::create_identity;
    use crate::state::InnerState;
    use crate::totp::{generate_totp_secret, totp_code, totp_now};
    use crate::vault::{encode_vault, seal_vault, vault_requires_totp, UnsealedVault};
    use std::path::{Path, PathBuf};

    const PASSPHRASE: &str = "correct horse battery staple";

    /// A vault in `scratch`, sealed with `PASSPHRASE` and, if given, `secret`.
    fn vault_with(scratch: &ScratchDir, secret: Option<&[u8]>) -> PathBuf {
        vault_with_app(scratch, secret, None)
    }

    /// Like `vault_with`, carrying `app` as its app data.
    fn vault_with_app(scratch: &ScratchDir, secret: Option<&[u8]>, app: Option<&[u8]>) -> PathBuf {
        let vault = scratch.path().join("vault.bin");
        let sealed = seal_vault(&create_identity(), secret, app, PASSPHRASE).unwrap();
        fsutil::atomic_write(&vault, &encode_vault(&sealed)).unwrap();
        vault
    }

    fn save_to(vault: &Path) -> impl FnOnce(&[u8]) -> std::io::Result<()> + '_ {
        move |bytes| fsutil::atomic_write(vault, bytes)
    }

    fn bytes_of(vault: &Path) -> Vec<u8> {
        std::fs::read(vault).unwrap()
    }

    /// Run `with_code` with a code computed just before. Codes are only
    /// checked after the slow key derivation; should that take one past its
    /// window, a fresh code gets one more try.
    fn with_fresh_code<T>(
        secret: &[u8],
        mut with_code: impl FnMut(&str) -> Result<T, CommandError>,
    ) -> Result<T, CommandError> {
        match with_code(&totp_now(secret)) {
            Err(error) if error.code == ErrorCode::InvalidTotp => with_code(&totp_now(secret)),
            done => done,
        }
    }

    fn open_with_code(
        vault: &Path,
        passphrase: &str,
        secret: &[u8],
    ) -> Result<UnsealedVault, CommandError> {
        with_fresh_code(secret, |code| open_vault(vault, passphrase, Some(code)))
    }

    /// A six-digit code that is valid for `secret` at none of the steps the
    /// check accepts right now.
    fn wrong_code(secret: &[u8]) -> String {
        let now = chrono::Utc::now().timestamp();
        let valid: Vec<String> = [-60, -30, 0, 30, 60]
            .iter()
            .map(|offset| totp_code(secret, (now + offset) as u64, 6, 30))
            .collect();
        ["000000", "111111", "222222", "333333", "444444", "555555"]
            .into_iter()
            .find(|code| !valid.iter().any(|v| v == code))
            .unwrap()
            .to_string()
    }

    #[test]
    fn turning_totp_on_makes_unlocking_ask_for_its_code() {
        let scratch = ScratchDir::new("totp-on");
        let vault = vault_with(&scratch, None);
        let secret = generate_totp_secret();

        enable_totp(&vault, PASSPHRASE, &secret, save_to(&vault)).unwrap();

        assert!(
            vault_requires_totp(&bytes_of(&vault)).unwrap(),
            "the header"
        );
        let error = open_vault(&vault, PASSPHRASE, None).map(drop).unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        let opened = open_with_code(&vault, PASSPHRASE, &secret).unwrap();
        assert_eq!(opened.totp_secret.as_deref(), Some(secret.as_slice()));
    }

    #[test]
    fn turning_totp_on_needs_the_passphrase() {
        let scratch = ScratchDir::new("totp-on-wrong");
        let vault = vault_with(&scratch, None);
        let before = bytes_of(&vault);

        let error = enable_totp(
            &vault,
            "not the passphrase",
            &generate_totp_secret(),
            save_to(&vault),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::WrongPassphrase);
        assert_eq!(bytes_of(&vault), before, "the vault changed");
    }

    #[test]
    fn totp_that_is_on_is_not_turned_on_again() {
        // A second secret would replace the one in the user's app.
        let scratch = ScratchDir::new("totp-on-twice");
        let first = generate_totp_secret();
        let vault = vault_with(&scratch, Some(&first));
        let before = bytes_of(&vault);

        let error =
            enable_totp(&vault, PASSPHRASE, &generate_totp_secret(), save_to(&vault)).unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(bytes_of(&vault), before);
    }

    #[test]
    fn turning_totp_on_needs_a_secret_confirmed_with_a_code() {
        let sealed = InnerState::default();
        assert_eq!(
            confirmed_secret(&sealed).unwrap_err().code,
            ErrorCode::NoVault
        );
        let mut inner = InnerState {
            identity: Some(create_identity()),
            ..InnerState::default()
        };
        assert_eq!(
            confirmed_secret(&inner).unwrap_err().code,
            ErrorCode::TotpNotVerified,
            "nothing begun"
        );
        inner.totp_enrollment.begin("ana");
        assert_eq!(
            confirmed_secret(&inner).unwrap_err().code,
            ErrorCode::TotpNotVerified,
            "begun, never confirmed"
        );
    }

    #[test]
    fn turning_totp_off_needs_a_valid_code_and_then_unlocking_does_not() {
        let scratch = ScratchDir::new("totp-off");
        let secret = generate_totp_secret();
        let vault = vault_with(&scratch, Some(&secret));

        let wrong =
            disable_totp(&vault, PASSPHRASE, &wrong_code(&secret), save_to(&vault)).unwrap_err();
        assert_eq!(wrong.code, ErrorCode::InvalidTotp);
        // A blank code is no code, refused before the key derivation.
        let blank = disable_totp(&vault, PASSPHRASE, "  ", |_| {
            panic!("nothing may be written without a code")
        })
        .unwrap_err();
        assert_eq!(blank.code, ErrorCode::TotpRequired);

        with_fresh_code(&secret, |code| {
            disable_totp(&vault, PASSPHRASE, code, save_to(&vault))
        })
        .unwrap();

        assert!(
            !vault_requires_totp(&bytes_of(&vault)).unwrap(),
            "the header"
        );
        let opened = open_vault(&vault, PASSPHRASE, None).unwrap();
        assert_eq!(opened.totp_secret, None);
    }

    #[test]
    fn a_reseal_that_cannot_be_saved_leaves_the_vault_as_it_was() {
        let scratch = ScratchDir::new("totp-on-unsaved");
        let vault = vault_with(&scratch, None);
        let before = bytes_of(&vault);

        let error = enable_totp(&vault, PASSPHRASE, &generate_totp_secret(), |_| {
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(bytes_of(&vault), before);
    }

    #[test]
    fn the_vault_is_only_ever_replaced_atomically() {
        // A plain `fs::write` truncates first: a crash halfway would lose
        // the identity (fsutil.rs).
        let code = include_str!("security_cmds.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let code: String = code.split_whitespace().collect();
        assert!(!code.contains("fs::write("), "a plain write");
        assert!(code.contains("write_vault_noted_in(&self.storage,vault,bytes,self.spk)"));
        // That one notes the re-seal in the store and writes the vault in
        // two phases, over the same file (the engine's storage.rs since
        // M4-0c; vault_file.rs since clave de emergencia CE-3).
        let storage: String = include_str!("../../crates/trino-engine/src/storage.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .split_whitespace()
            .collect();
        let noted = storage
            .split("pubfnwrite_vault_noted(")
            .nth(1)
            .and_then(|rest| rest.split("pubfn").next())
            .unwrap();
        assert!(!noted.contains("fs::write("), "a plain write");
        assert!(noted.contains("crate::vault_file::write(vault,bytes)"));
    }

    // ---- K6: a new passphrase ----

    const NEW_PASSPHRASE: &str = "otra frase larga para el baúl";

    #[test]
    fn a_new_passphrase_opens_the_vault_and_the_old_one_no_longer_does() {
        let scratch = ScratchDir::new("passphrase-new");
        let vault = vault_with(&scratch, None);

        reseal_with_new_passphrase(&vault, PASSPHRASE, NEW_PASSPHRASE, None, save_to(&vault))
            .unwrap();

        let old = open_vault(&vault, PASSPHRASE, None).map(drop).unwrap_err();
        assert_eq!(old.code, ErrorCode::WrongPassphrase);
        let opened = open_vault(&vault, NEW_PASSPHRASE, None).unwrap();
        assert_eq!(opened.totp_secret, None, "TOTP stays off");
    }

    #[test]
    fn a_new_passphrase_keeps_totp_and_asks_for_its_code() {
        let scratch = ScratchDir::new("passphrase-totp");
        let secret = generate_totp_secret();
        let vault = vault_with(&scratch, Some(&secret));

        let missing =
            reseal_with_new_passphrase(&vault, PASSPHRASE, NEW_PASSPHRASE, None, save_to(&vault))
                .unwrap_err();
        assert_eq!(missing.code, ErrorCode::TotpRequired);
        let wrong = reseal_with_new_passphrase(
            &vault,
            PASSPHRASE,
            NEW_PASSPHRASE,
            Some(&wrong_code(&secret)),
            save_to(&vault),
        )
        .unwrap_err();
        assert_eq!(wrong.code, ErrorCode::InvalidTotp);

        with_fresh_code(&secret, |code| {
            reseal_with_new_passphrase(
                &vault,
                PASSPHRASE,
                NEW_PASSPHRASE,
                Some(code),
                save_to(&vault),
            )
        })
        .unwrap();

        assert!(
            vault_requires_totp(&bytes_of(&vault)).unwrap(),
            "the header"
        );
        let opened = open_with_code(&vault, NEW_PASSPHRASE, &secret).unwrap();
        assert_eq!(
            opened.totp_secret.as_deref(),
            Some(secret.as_slice()),
            "the same secret"
        );
    }

    #[test]
    fn the_new_passphrase_must_pass_the_policy_before_anything_is_opened() {
        // No vault at all: the policy answers before the key derivation.
        let scratch = ScratchDir::new("passphrase-policy");
        let nowhere = scratch.path().join("vault.bin");
        let never = |_: &[u8]| -> std::io::Result<()> { panic!("written") };

        let short =
            reseal_with_new_passphrase(&nowhere, PASSPHRASE, "corta", None, never).unwrap_err();
        assert_eq!(
            (short.code, short.min),
            (ErrorCode::PassphraseTooShort, Some(MIN_PASSPHRASE_CHARS))
        );
        let common = reseal_with_new_passphrase(&nowhere, PASSPHRASE, "Contraseña123", None, never)
            .unwrap_err();
        assert_eq!(common.code, ErrorCode::PassphraseTooCommon);
    }

    #[test]
    fn a_wrong_current_passphrase_changes_nothing() {
        let scratch = ScratchDir::new("passphrase-wrong");
        let vault = vault_with(&scratch, None);
        let before = bytes_of(&vault);

        let error = reseal_with_new_passphrase(
            &vault,
            "not the passphrase",
            NEW_PASSPHRASE,
            None,
            save_to(&vault),
        )
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::WrongPassphrase);
        assert_eq!(bytes_of(&vault), before);
    }

    #[test]
    fn a_new_passphrase_that_cannot_be_saved_keeps_the_old_one() {
        let scratch = ScratchDir::new("passphrase-unsaved");
        let vault = vault_with(&scratch, None);
        let before = bytes_of(&vault);

        let error = reseal_with_new_passphrase(&vault, PASSPHRASE, NEW_PASSPHRASE, None, |_| {
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(
            bytes_of(&vault),
            before,
            "the old passphrase still opens it"
        );
    }

    /// CE-3's open end (clave de emergencia CE-4): the new vault reached
    /// `vault.bin.next`, but `vault.bin` stayed held by another program.
    /// The settings say the change was not saved, and that is what the next
    /// unlock finds: the old passphrase opens, the new one does not, and no
    /// copy waits to finish the change behind the user's back.
    #[test]
    fn a_new_passphrase_whose_second_phase_fails_is_not_kept_halfway() {
        use trino_engine::store::disk::faulty::FaultyDisk;
        let scratch = ScratchDir::new("passphrase-phase-2");
        let vault = vault_with(&scratch, None);
        let before = bytes_of(&vault);
        let held = std::rc::Rc::new(FaultyDisk::default());
        held.fail_writes.borrow_mut().insert("vault.bin".into());

        let error = reseal_with_new_passphrase(&vault, PASSPHRASE, NEW_PASSPHRASE, None, |bytes| {
            trino_engine::vault_file::write_with(&held, &vault, bytes)
        })
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(bytes_of(&vault), before);
        assert!(!trino_engine::vault_file::next_path(&vault).exists());
        let new = open_vault(&vault, NEW_PASSPHRASE, None)
            .map(drop)
            .unwrap_err();
        assert_eq!(new.code, ErrorCode::WrongPassphrase);
        assert!(open_vault(&vault, PASSPHRASE, None).is_ok());
    }

    // ---- The version 3 vault (clave de emergencia CE-3) ----

    /// The settings seal a version 3 vault again part by part (design
    /// §3.5): TOTP in the shared block, the passphrase in its slot, and
    /// the rest, the app data and the shared block's own, as it was.
    #[test]
    fn the_settings_keep_a_version_3_vault_and_what_they_do_not_change() {
        use trino_core::vault_v3::{create_vault_v3, vault_version, NewAccount, V3_VAULT_LEN};
        use trino_engine::vault_file::OpenedVault;
        let scratch = ScratchDir::new("settings-v3");
        let vault = scratch.path().join("vault.bin");
        let identity = create_identity();
        let app: &[u8] = b"the key to the local data";
        let shared: &[u8] = br#"{"v":1,"name":"ana","createdAt":1}"#;
        let created = create_vault_v3(
            &NewAccount {
                identity: &identity,
                app: Some(app),
                shared_app: shared,
                id_vault: [7; 16],
            },
            None,
            PASSPHRASE,
        )
        .unwrap();
        fsutil::atomic_write(&vault, created.bytes()).unwrap();
        let secret = generate_totp_secret();
        let v3 = |vault: &Path, passphrase: &str, code: Option<&str>| {
            match trino_engine::vault_file::open(vault, passphrase, code) {
                Ok(OpenedVault::V3(opened)) => Ok(opened),
                Ok(OpenedVault::Old(_)) => panic!("sealed again as version 2"),
                Err(error) => Err(error),
            }
        };

        enable_totp(&vault, PASSPHRASE, &secret, save_to(&vault)).unwrap();
        assert_eq!(vault_version(&bytes_of(&vault)).unwrap(), 3);
        assert_eq!(
            v3(&vault, PASSPHRASE, None).map(drop).unwrap_err().code,
            ErrorCode::TotpRequired
        );
        with_fresh_code(&secret, |code| {
            reseal_with_new_passphrase(
                &vault,
                PASSPHRASE,
                NEW_PASSPHRASE,
                Some(code),
                save_to(&vault),
            )
        })
        .unwrap();
        let old = v3(&vault, PASSPHRASE, Some("000000"))
            .map(drop)
            .unwrap_err();
        assert_eq!(old.code, ErrorCode::WrongPassphrase);
        let opened =
            with_fresh_code(&secret, |code| v3(&vault, NEW_PASSPHRASE, Some(code))).unwrap();
        assert_eq!(opened.totp_secret(), Some(secret.as_slice()));
        assert_eq!(opened.app(), Some(app));
        assert_eq!(opened.shared_app(), shared);
        assert_eq!(
            opened.identity().ik_sign.pub_bytes,
            identity.ik_sign.pub_bytes
        );

        with_fresh_code(&secret, |code| {
            disable_totp(&vault, NEW_PASSPHRASE, code, save_to(&vault))
        })
        .unwrap();
        let opened = v3(&vault, NEW_PASSPHRASE, None).unwrap();
        assert_eq!(opened.totp_secret(), None);
        assert_eq!(opened.shared_app(), shared);
        assert_eq!(bytes_of(&vault).len(), V3_VAULT_LEN);
    }

    // ---- The app data (cifrado local): every re-seal carries it ----

    #[test]
    fn every_reseal_of_the_settings_keeps_the_app_data() {
        // trino-core seals only what it is given: a re-seal that left the
        // app data out would lose the key to everything in store/.
        let scratch = ScratchDir::new("reseal-app");
        let app: &[u8] = b"the key to the local data";
        let vault = vault_with_app(&scratch, None, Some(app));
        let secret = generate_totp_secret();

        enable_totp(&vault, PASSPHRASE, &secret, save_to(&vault)).unwrap();
        with_fresh_code(&secret, |code| {
            reseal_with_new_passphrase(
                &vault,
                PASSPHRASE,
                NEW_PASSPHRASE,
                Some(code),
                save_to(&vault),
            )
        })
        .unwrap();
        with_fresh_code(&secret, |code| {
            disable_totp(&vault, NEW_PASSPHRASE, code, save_to(&vault))
        })
        .unwrap();

        let opened = open_vault(&vault, NEW_PASSPHRASE, None).unwrap();
        assert_eq!(opened.totp_secret, None, "TOTP went off last");
        assert_eq!(opened.app.as_deref().map(Vec::as_slice), Some(app));
    }
}
