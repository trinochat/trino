//! The security commands of the first run and the settings: the passphrase
//! policy checked on its own (K1).

use crate::command_error::CommandError;
use crate::passphrase::validate_passphrase;
use zeroize::Zeroizing;

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
        // cannot read or write one.
        let check: fn(String) -> Result<(), crate::command_error::CommandError> = check_passphrase;
        assert!(check("una frase larga y rara".to_string()).is_ok());
    }
}
