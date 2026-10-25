//! The error of the commands that create and open the identity: `forge`,
//! `unseal`, `totp_begin` and `totp_verify`, and of the redesign's commands
//! after them. The UI shows its own text for each `code`; the `message` is
//! English for the log. The older commands still fail with a plain string.

use crate::blossom::{BlossomError, ServerFailure};
use crate::passphrase::{EmergencyKeyError, PassphraseError};
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
    // -- W7 --
    /// No relay is up: nothing was sent (K4).
    Offline,
    /// Relays are up, but none took the event, or none said so in time (K4).
    NotAccepted,
    /// The event is larger than relays take: they would drop it unseen (K4).
    MessageTooLong,
    /// There is no session with the contact yet (K4).
    NoSession,
    /// Every file server failed to take an upload; `servers` says why (K2).
    UploadFailed,
    // -- W8 --
    /// A contact code that does not parse, or whose keys its identity key
    /// did not sign (K8).
    InvalidCode,
    /// Another contact, with other keys, has that name (K8).
    NameTaken,
    /// These keys are a contact already, under the name in `handle` (K8).
    AlreadyContact,
    /// No such contact, group, member or message.
    NotFound,
    /// Only the group's admin can do that (K10).
    NotAdmin,
    /// A name, an "about" or a photo over the limits of the shared profile
    /// (K12).
    ProfileInvalid,
    // -- B1 --
    /// A name a contact cannot have here: one the UI reads as the
    /// announcements channel (`channel`) or a group (`grp:…`), or one with
    /// a control, format or bidi character, or with nothing that shows.
    InvalidName,
    // -- Tor (TOR-4) --
    /// Tor is still connecting: nothing was sent, and nothing went direct.
    /// Never a reason to offer going without Tor (Tor design §2.4, R-11).
    TorNotReady,
    // -- Clave de emergencia (CE-5) --
    /// An emergency key that is the passphrase (design §8.3).
    SameAsPassphrase,
    /// An emergency key too like the passphrase: one could be typed for
    /// the other (design §8.3).
    LikePassphrase,
    /// A new passphrase, or an emergency key, that another slot of the
    /// vault takes already: choose another (design §11.4). Its message
    /// never says which slot.
    ChooseAnother,
    // -- Uso responsable (UR-2) --
    /// A key the person to block proved they hold is another contact's:
    /// nothing was blocked (design §3.1, P1 R-14).
    KeyClash,
    /// Someone you blocked: nothing goes to them (design §3.2).
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandError {
    pub code: ErrorCode,
    pub message: String,
    /// The minimum length, with `PassphraseTooShort` only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<usize>,
    /// Why each file server failed, with `UploadFailed` only (K2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub servers: Option<Vec<ServerFailure>>,
    /// The name the contact already has, with `AlreadyContact` only (K8).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
}

impl CommandError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CommandError {
            code,
            message: message.into(),
            min: None,
            servers: None,
            handle: None,
        }
    }

    /// Every file server failed: `servers` says why, for each one.
    pub fn upload_failed(servers: Vec<ServerFailure>) -> Self {
        CommandError {
            servers: Some(servers),
            ..CommandError::new(ErrorCode::UploadFailed, "every file server failed")
        }
    }

    /// The keys of a code are the contact named `handle` already (K8).
    pub fn already_contact(handle: &str) -> Self {
        CommandError {
            handle: Some(handle.to_string()),
            ..CommandError::new(
                ErrorCode::AlreadyContact,
                "these keys are a contact already",
            )
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
        // These name the emergency key: their message says nothing the
        // real path would not say (clave de emergencia, design §5.3).
        let neutral = match error {
            VaultError::PassphraseOpensEmergencySlot | VaultError::EmergencyKeyOpensAnotherSlot => {
                Some("choose another passphrase")
            }
            VaultError::IdVaultReused => Some("the vault could not be sealed"),
            _ => None,
        };
        let code = match error {
            // AES-GCM cannot tell a wrong key from a modified file; a wrong
            // passphrase is by far the likelier.
            VaultError::DecryptionFailed => ErrorCode::WrongPassphrase,
            VaultError::TotpRequired => ErrorCode::TotpRequired,
            VaultError::InvalidTotp => ErrorCode::InvalidTotp,
            // A vault of a newer Trino, or one a test build wrote (its
            // KDF byte, trino-core `test-kdf`).
            VaultError::UnsupportedVersion(_)
            | VaultError::UnsupportedFlags(_)
            | VaultError::UnsupportedKdf(_) => ErrorCode::UnsupportedVault,
            // A new passphrase that is the emergency key, or an emergency
            // key that another slot takes: "choose another" (design §11.4).
            VaultError::PassphraseOpensEmergencySlot | VaultError::EmergencyKeyOpensAnotherSlot => {
                ErrorCode::ChooseAnother
            }
            // A damaged file or a failure in the crypto: nothing the user
            // can fix by typing something else.
            VaultError::Corrupted
            | VaultError::BadMagic
            | VaultError::BadPayload
            | VaultError::InvalidAppData(_)
            | VaultError::Kdf(_)
            | VaultError::TooLarge { .. }
            | VaultError::IdVaultReused
            | VaultError::Crypto(_)
            | VaultError::Identity(_) => ErrorCode::Internal,
        };
        match neutral {
            Some(message) => CommandError::new(code, message),
            None => CommandError::new(code, error.to_string()),
        }
    }
}

impl From<BlossomError> for CommandError {
    fn from(error: BlossomError) -> Self {
        match error {
            BlossomError::AllFailed { servers } => CommandError::upload_failed(servers),
            BlossomError::TorNotReady => {
                CommandError::new(ErrorCode::TorNotReady, error.to_string())
            }
            // A bad key or blob, or a failure in the crypto: nothing a file
            // server did.
            other => CommandError::internal(other.to_string()),
        }
    }
}

impl From<EmergencyKeyError> for CommandError {
    fn from(error: EmergencyKeyError) -> Self {
        let code = match error {
            EmergencyKeyError::SameAsPassphrase => ErrorCode::SameAsPassphrase,
            EmergencyKeyError::LikePassphrase => ErrorCode::LikePassphrase,
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

    /// The version 3 vault's errors (clave de emergencia CE-3, design
    /// §5.3): none tells the real path from the emergency one, in its code
    /// or in its message, which the log may keep.
    #[test]
    fn the_errors_of_a_version_3_vault_never_name_the_emergency_key() {
        use crate::kdf::KdfError;
        assert_eq!(
            code_of(VaultError::UnsupportedKdf(0xf1)),
            ErrorCode::UnsupportedVault
        );
        for error in [
            VaultError::Kdf(KdfError::ParamsOutOfBounds),
            VaultError::Kdf(KdfError::Failed),
            VaultError::TooLarge {
                what: "body",
                len: 30_000,
                max: 24_236,
            },
            VaultError::IdVaultReused,
        ] {
            assert_eq!(code_of(error), ErrorCode::Internal);
        }
        // A new passphrase that is the emergency key, or an emergency key
        // that is the passphrase: "choose another", with a code of its own
        // (CE-5), not "too common", which would not be true.
        for error in [
            VaultError::PassphraseOpensEmergencySlot,
            VaultError::EmergencyKeyOpensAnotherSlot,
        ] {
            assert_eq!(code_of(error), ErrorCode::ChooseAnother);
        }
        for error in [
            VaultError::UnsupportedKdf(0xf1),
            VaultError::Kdf(KdfError::ParamsOutOfBounds),
            VaultError::TooLarge {
                what: "body",
                len: 30_000,
                max: 24_236,
            },
            VaultError::PassphraseOpensEmergencySlot,
            VaultError::EmergencyKeyOpensAnotherSlot,
            VaultError::IdVaultReused,
        ] {
            let message = CommandError::from(error).message.to_lowercase();
            for word in ["emergency", "empty", "slot", "redirect"] {
                assert!(!message.contains(word), "{message}");
            }
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
    fn an_emergency_key_like_the_passphrase_has_its_own_code() {
        assert_eq!(
            code_of(EmergencyKeyError::SameAsPassphrase),
            ErrorCode::SameAsPassphrase
        );
        assert_eq!(
            code_of(EmergencyKeyError::LikePassphrase),
            ErrorCode::LikePassphrase
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
            ErrorCode::Offline,
            ErrorCode::NotAccepted,
            ErrorCode::MessageTooLong,
            ErrorCode::NoSession,
            ErrorCode::UploadFailed,
            ErrorCode::SameAsPassphrase,
            ErrorCode::LikePassphrase,
            ErrorCode::ChooseAnother,
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
                "offline",
                "not_accepted",
                "message_too_long",
                "no_session",
                "upload_failed",
                "same_as_passphrase",
                "like_passphrase",
                "choose_another",
            ]
        );
    }

    #[test]
    fn an_upload_failure_reaches_the_ui_with_each_server() {
        use crate::blossom::{BlossomError, ServerFailure};
        let failed = CommandError::from(BlossomError::AllFailed {
            servers: vec![
                ServerFailure {
                    server: "https://blossom.primal.net".to_string(),
                    reason: "http 413: blob too big".to_string(),
                },
                ServerFailure {
                    server: "https://blossom.band".to_string(),
                    reason: "timeout".to_string(),
                },
            ],
        });
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            json!({
                "code": "upload_failed",
                "message": "every file server failed",
                "servers": [
                    { "server": "https://blossom.primal.net", "reason": "http 413: blob too big" },
                    { "server": "https://blossom.band", "reason": "timeout" },
                ],
            })
        );
        // Anything else from Blossom is internal, and has no `servers`.
        let other = CommandError::from(BlossomError::BadInput);
        assert_eq!(other.code, ErrorCode::Internal);
        assert!(serde_json::to_value(&other)
            .unwrap()
            .get("servers")
            .is_none());
    }

    #[test]
    fn the_codes_of_the_contacts_groups_and_history_have_the_names_the_ui_maps() {
        // W8: also listed in `COMMAND_ERROR_CODES` (src/lib/api.ts).
        let names: Vec<serde_json::Value> = [
            ErrorCode::InvalidCode,
            ErrorCode::NameTaken,
            ErrorCode::AlreadyContact,
            ErrorCode::NotFound,
            ErrorCode::NotAdmin,
            ErrorCode::ProfileInvalid,
            ErrorCode::InvalidName,
        ]
        .iter()
        .map(|code| serde_json::to_value(code).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "invalid_code",
                "name_taken",
                "already_contact",
                "not_found",
                "not_admin",
                "profile_invalid",
                "invalid_name"
            ]
        );
    }

    #[test]
    fn tor_not_ready_has_the_name_the_ui_maps_and_comes_from_blossom() {
        // Tor design §2.4 and §9.3: the UI tells "Tor is still connecting"
        // apart from "the server did not answer". Also listed, last, in
        // `COMMAND_ERROR_CODES` (src/lib/api.ts).
        assert_eq!(
            serde_json::to_value(ErrorCode::TorNotReady).unwrap(),
            "tor_not_ready"
        );
        let error = CommandError::from(BlossomError::TorNotReady);
        assert_eq!(error.code, ErrorCode::TorNotReady);
        assert!(error.servers.is_none());
    }

    #[test]
    fn already_contact_says_which_contact_has_the_keys() {
        assert_eq!(
            serde_json::to_value(CommandError::already_contact("ana")).unwrap(),
            json!({
                "code": "already_contact",
                "message": "these keys are a contact already",
                "handle": "ana",
            })
        );
        // No other error carries a name.
        let other = serde_json::to_value(CommandError::internal("x")).unwrap();
        assert!(other.get("handle").is_none());
    }
}
