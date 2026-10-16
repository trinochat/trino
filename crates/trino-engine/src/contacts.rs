//! Contacts (W8): what the engine needs of them so far (M4-0c), the names
//! a contact can have here and the errors the commands about contacts share.

use crate::command_error::{CommandError, ErrorCode};

pub fn sealed() -> CommandError {
    CommandError::new(ErrorCode::NoVault, "vault sealed")
}

pub fn not_found(message: &str) -> CommandError {
    CommandError::new(ErrorCode::NotFound, message)
}

/// The keys the chats give a meaning of their own (src/lib/convo.ts): the
/// announcements channel, and the chat of a group, `grp:<gid>`, as the
/// history keys it (`group_convo`) and the UI keeps a group's settings.
pub const CHANNEL_KEY: &str = "channel";
pub const GROUP_KEY_PREFIX: &str = "grp:";

/// Whether `handle`, trimmed, can name a contact here: not a key the chats
/// read as the channel or a group, and a name a profile could carry (no
/// control, format or bidi character, something that shows). Otherwise
/// `invalid_name`.
pub fn check_local_handle(handle: &str) -> Result<(), CommandError> {
    if handle == CHANNEL_KEY || handle.starts_with(GROUP_KEY_PREFIX) {
        return Err(CommandError::new(
            ErrorCode::InvalidName,
            "the chats read that name as the channel or a group",
        ));
    }
    if !crate::profile::readable_name(handle) {
        return Err(CommandError::new(
            ErrorCode::InvalidName,
            "the name holds a control, format or bidi character, or nothing that shows",
        ));
    }
    Ok(())
}
