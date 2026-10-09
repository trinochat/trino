//! The error of the commands that create and open the identity: `forge`,
//! `unseal`, `totp_begin` and `totp_verify`. The UI shows its own text for
//! each `code`; the `message` is English for the log. Every other command
//! still fails with a plain string.

use crate::passphrase::PassphraseError;
use crate::vault::VaultError;
use serde::Serialize;

/// Sent as snake_case, the names `COMMAND_ERROR_CODES` in src/lib/api.ts lists.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    PassphraseTooShort,
    PassphraseTooCommon,
    /// `forge` was asked for TOTP without a confirmed code from `totp_verify`,
    /// or `totp_verify` was called with no `totp_begin` before it.
    TotpNotVerified,
    /// There is an identity on this device already.
    VaultExists,
    NoVault,
    WrongPassphrase,
    TotpRequired,
    InvalidTotp,
    /// The vault comes from a newer Trino: a version or flags this one does
    /// not know.
    UnsupportedVault,
    Io,
    Internal,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    /// The minimum length, with `PassphraseTooShort` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            min: None,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        CommandError::new(ErrorCode::Internal, message)
    }

    pub fn io(error: &std::io::Error) -> Self {
        CommandError::new(ErrorCode::Io, error.to_string())
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl From<VaultError> for CommandError {
    fn from(error: VaultError) -> Self {
        let code = match error {
            // AES-GCM cannot tell a wrong key from a modified file; a wrong
            // passphrase is by far the likelier.
            VaultError::DecryptionFailed => ErrorCode::WrongPassphrase,
            VaultError::TotpRequired => ErrorCode::TotpRequired,
            VaultError::InvalidTotp => ErrorCode::InvalidTotp,
            VaultError::UnsupportedVersion(_) | VaultError::UnsupportedFlags(_) => {
                ErrorCode::UnsupportedVault
            }
            // A damaged file or a failure in the crypto: nothing the user
            // can fix by typing something else.
            VaultError::Corrupted
            | VaultError::BadMagic
            | VaultError::BadPayload
            | VaultError::Crypto(_)
            | VaultError::Identity(_) => ErrorCode::Internal,
        };
        CommandError::new(code, error.to_string())
    }
}

impl From<PassphraseError> for CommandError {
    fn from(error: PassphraseError) -> Self {
        match error {
            PassphraseError::TooShort { min } => CommandError {
                min: Some(min),
                ..CommandError::new(ErrorCode::PassphraseTooShort, error.to_string())
            },
            PassphraseError::TooCommon => {
                CommandError::new(ErrorCode::PassphraseTooCommon, error.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::CryptoError;
    use crate::identity::IdentityError;
    use serde_json::json;

    fn code_of(error: impl Into<CommandError>) -> ErrorCode {
        error.into().code
    }

    #[test]
    fn vault_errors_map_to_the_codes_the_ui_knows() {
        assert_eq!(
            code_of(VaultError::DecryptionFailed),
            ErrorCode::WrongPassphrase
        );
        assert_eq!(code_of(VaultError::TotpRequired), ErrorCode::TotpRequired);
        assert_eq!(code_of(VaultError::InvalidTotp), ErrorCode::InvalidTotp);
        assert_eq!(
            code_of(VaultError::UnsupportedVersion(2)),
            ErrorCode::UnsupportedVault
        );
        assert_eq!(
            code_of(VaultError::UnsupportedFlags(0x02)),
            ErrorCode::UnsupportedVault
        );
    }

    #[test]
    fn a_damaged_vault_or_a_crypto_failure_is_internal() {
        // Nothing the user can fix by typing something else.
        for error in [
            VaultError::Corrupted,
            VaultError::BadMagic,
            VaultError::BadPayload,
            VaultError::Crypto(CryptoError::Aead),
            VaultError::Identity(IdentityError::InvalidLength),
        ] {
            assert_eq!(code_of(error), ErrorCode::Internal);
        }
    }

    #[test]
    fn passphrase_errors_map_to_their_codes_and_say_the_minimum() {
        let short = CommandError::from(PassphraseError::TooShort { min: 10 });
        assert_eq!(
            (short.code, short.min),
            (ErrorCode::PassphraseTooShort, Some(10))
        );
        let common = CommandError::from(PassphraseError::TooCommon);
        assert_eq!(
            (common.code, common.min),
            (ErrorCode::PassphraseTooCommon, None)
        );
    }

    #[test]
    fn the_ui_receives_a_code_and_a_message_for_the_log() {
        assert_eq!(
            serde_json::to_value(CommandError::from(PassphraseError::TooShort { min: 10 }))
                .unwrap(),
            json!({
                "code": "passphrase_too_short",
                "message": "the passphrase needs at least 10 characters",
                "min": 10,
            })
        );
        assert_eq!(
            serde_json::to_value(CommandError::from(VaultError::UnsupportedFlags(0x02))).unwrap(),
            json!({
                "code": "unsupported_vault",
                "message": "unsupported vault flags: 0x02",
            })
        );
    }

    #[test]
    fn every_code_has_the_name_the_ui_maps() {
        // `COMMAND_ERROR_CODES` in src/lib/api.ts lists these same names.
        let names: Vec<serde_json::Value> = [
            ErrorCode::PassphraseTooShort,
            ErrorCode::PassphraseTooCommon,
            ErrorCode::TotpNotVerified,
            ErrorCode::VaultExists,
            ErrorCode::NoVault,
            ErrorCode::WrongPassphrase,
            ErrorCode::TotpRequired,
            ErrorCode::InvalidTotp,
            ErrorCode::UnsupportedVault,
            ErrorCode::Io,
            ErrorCode::Internal,
        ]
        .iter()
        .map(|code| serde_json::to_value(code).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "passphrase_too_short",
                "passphrase_too_common",
                "totp_not_verified",
                "vault_exists",
                "no_vault",
                "wrong_passphrase",
                "totp_required",
                "invalid_totp",
                "unsupported_vault",
                "io",
                "internal",
            ]
        );
    }
}
