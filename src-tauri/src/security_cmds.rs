//! The security commands of the first run and the settings: the passphrase
//! policy checked on its own (K1), TOTP turned on and off (K5) and a new
//! passphrase (K6).
//!
//! The settings' commands seal the vault again. While they do, they hold
//! `session_gate`, as `forge`, `unseal`, `lock_vault` and `wipe` do: a wipe
//! in between would otherwise find its vault written back. The slow key
//! derivation runs off the async workers, and the new vault replaces the old
//! one atomically (fsutil.rs), so a crash leaves one or the other.

use crate::command_error::{CommandError, ErrorCode};
use crate::commands::{open_vault, submitted_code};
use crate::fsutil;
use crate::identity::Identity;
use crate::passphrase::validate_passphrase;
use crate::state::{vault_path, AppState, InnerState};
use crate::vault::{encode_vault, seal_vault};
use std::path::Path;
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

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
    let secret = confirmed_secret(&*state.inner.lock().await)?;
    let vault = vault_path();
    // The worker hands the secret back only once the vault holds it; on
    // any other way out it is dropped there, and wiped.
    let mut secret = run_blocking(move || {
        enable_totp(&vault, &passphrase, &secret, |bytes| {
            fsutil::atomic_write(&vault, bytes)
        })?;
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
    require_session(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        disable_totp(&vault, &passphrase, &code, |bytes| {
            fsutil::atomic_write(&vault, bytes)
        })
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
    require_session(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let code = totp_code.as_deref().map(String::as_str);
        reseal_with_new_passphrase(&vault, &current, &next, code, |bytes| {
            fsutil::atomic_write(&vault, bytes)
        })
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
) -> Result<(), CommandError> {
    // Without a code, only a vault that has TOTP asks for one.
    let (identity, _) = open_vault(vault, passphrase, None).map_err(|error| match error.code {
        ErrorCode::TotpRequired => CommandError::internal("TOTP is on already"),
        _ => error,
    })?;
    seal_and_write(&identity, Some(secret), passphrase, write)
}

/// Seal the vault at `vault` again without its TOTP secret, once
/// `passphrase` and a valid `code` opened it. A vault without TOTP is left as
/// it is.
fn disable_totp(
    vault: &Path,
    passphrase: &str,
    code: &str,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<(), CommandError> {
    let code = submitted_code(Some(code)).ok_or_else(|| {
        CommandError::new(ErrorCode::TotpRequired, "turning TOTP off needs a code")
    })?;
    let (identity, secret) = open_vault(vault, passphrase, Some(code))?;
    if secret.map(Zeroizing::new).is_none() {
        return Ok(());
    }
    seal_and_write(&identity, None, passphrase, write)
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
) -> Result<(), CommandError> {
    validate_passphrase(next)?;
    let (identity, secret) = open_vault(vault, current, submitted_code(code))?;
    let secret = secret.map(Zeroizing::new);
    seal_and_write(&identity, secret.as_deref().map(Vec::as_slice), next, write)
}

/// Seal `identity` with `passphrase` and, if given, `secret`, and save it
/// with `write`.
fn seal_and_write(
    identity: &Identity,
    secret: Option<&[u8]>,
    passphrase: &str,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<(), CommandError> {
    let sealed = seal_vault(identity, secret, passphrase)?;
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
    use crate::identity::{create_identity, Identity};
    use crate::state::InnerState;
    use crate::totp::{generate_totp_secret, totp_code, totp_now};
    use crate::vault::{encode_vault, seal_vault, vault_requires_totp};
    use std::path::{Path, PathBuf};

    const PASSPHRASE: &str = "correct horse battery staple";

    /// A vault in `scratch`, sealed with `PASSPHRASE` and, if given, `secret`.
    fn vault_with(scratch: &ScratchDir, secret: Option<&[u8]>) -> PathBuf {
        let vault = scratch.path().join("vault.bin");
        let sealed = seal_vault(&create_identity(), secret, PASSPHRASE).unwrap();
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
    ) -> Result<(Identity, Option<Vec<u8>>), CommandError> {
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
        let error = open_vault(&vault, PASSPHRASE, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        let (_, sealed) = open_with_code(&vault, PASSPHRASE, &secret).unwrap();
        assert_eq!(sealed.as_deref(), Some(secret.as_slice()));
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
        let (_, sealed) = open_vault(&vault, PASSPHRASE, None).unwrap();
        assert_eq!(sealed, None);
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
        assert!(code.contains("fsutil::atomic_write(&vault,bytes)"));
    }

    // ---- K6: a new passphrase ----

    const NEW_PASSPHRASE: &str = "otra frase larga para el baúl";

    #[test]
    fn a_new_passphrase_opens_the_vault_and_the_old_one_no_longer_does() {
        let scratch = ScratchDir::new("passphrase-new");
        let vault = vault_with(&scratch, None);

        reseal_with_new_passphrase(&vault, PASSPHRASE, NEW_PASSPHRASE, None, save_to(&vault))
            .unwrap();

        let old = open_vault(&vault, PASSPHRASE, None).unwrap_err();
        assert_eq!(old.code, ErrorCode::WrongPassphrase);
        let (_, secret) = open_vault(&vault, NEW_PASSPHRASE, None).unwrap();
        assert_eq!(secret, None, "TOTP stays off");
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
        let (_, sealed) = open_with_code(&vault, NEW_PASSPHRASE, &secret).unwrap();
        assert_eq!(
            sealed.as_deref(),
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
}
