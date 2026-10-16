//! Sending (K4; M4-0c): why a message was not sent.

use crate::command_error::{CommandError, ErrorCode};

/// Why a message was not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    Sealed,
    UnknownContact,
    UnknownGroup,
    Empty,
    /// The session has no relays at all.
    NoRelays,
    NoSession,
    /// No relay is up.
    Offline,
    NotAccepted,
    TooLong,
    /// The X3DH, the ratchet or the signature failed; for the log.
    Failed(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The commands that still answer with a string show these, as before.
        f.write_str(match self {
            SendError::Sealed => "vault sealed",
            SendError::UnknownContact => "unknown node",
            SendError::UnknownGroup => "unknown group",
            SendError::Empty => "empty message",
            SendError::NoRelays => "network is still connecting",
            SendError::NoSession => "no session — run connect first",
            SendError::Offline => "no relay is connected",
            SendError::NotAccepted => "no relay accepted the message",
            SendError::TooLong => "the message is too large for the relays",
            SendError::Failed(reason) => reason,
        })
    }
}

impl From<SendError> for CommandError {
    fn from(error: SendError) -> Self {
        let code = match &error {
            SendError::Sealed => ErrorCode::NoVault,
            SendError::NoSession => ErrorCode::NoSession,
            SendError::NoRelays | SendError::Offline => ErrorCode::Offline,
            SendError::NotAccepted => ErrorCode::NotAccepted,
            SendError::TooLong => ErrorCode::MessageTooLong,
            SendError::UnknownContact
            | SendError::UnknownGroup
            | SendError::Empty
            | SendError::Failed(_) => ErrorCode::Internal,
        };
        CommandError::new(code, error.to_string())
    }
}
