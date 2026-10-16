//! Contacts (W8): what the engine needs of them so far (M4-0c), the names
//! a contact can have here and the errors the commands about contacts share.

use crate::command_error::{CommandError, ErrorCode};
use serde::Serialize;
use std::collections::HashMap;

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

/// How long `contact-key-mismatch` stays quiet for a contact once it fired.
pub const KEY_MISMATCH_QUIET_SECS: i64 = 600;

/// A handshake from a contact came with other keys than the pinned ones.
#[derive(Serialize, Clone)]
pub struct ContactKeyMismatchEvent {
    pub handle: String,
}

/// Whether a handshake with other keys from `handle` raises
/// `contact-key-mismatch` now: at most once every `KEY_MISMATCH_QUIET_SECS`
/// per contact. A clock that went back counts as time passed.
pub fn should_report_key_mismatch(last: &mut HashMap<String, i64>, handle: &str, now: i64) -> bool {
    if let Some(&at) = last.get(handle) {
        if (at..at + KEY_MISMATCH_QUIET_SECS).contains(&now) {
            return false;
        }
    }
    last.insert(handle.to_string(), now);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_760_000_000;

    #[test]
    fn a_key_mismatch_is_reported_at_most_once_every_ten_minutes_per_contact() {
        let mut last = HashMap::new();
        assert!(should_report_key_mismatch(&mut last, "ana", NOW));
        assert!(!should_report_key_mismatch(&mut last, "ana", NOW + 1));
        assert!(!should_report_key_mismatch(
            &mut last,
            "ana",
            NOW + KEY_MISMATCH_QUIET_SECS - 1
        ));
        assert!(
            should_report_key_mismatch(&mut last, "bob", NOW + 1),
            "per contact"
        );
        assert!(should_report_key_mismatch(
            &mut last,
            "ana",
            NOW + KEY_MISMATCH_QUIET_SECS
        ));
    }
}
