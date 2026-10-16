//! TURN credentials for protected calls: the engine's
//! (`trino_engine::turn`, M4-0), under their old path here, and the command
//! the frontend calls for them.

use crate::command_error::CommandError;
use crate::state::AppState;
use std::sync::Arc;
use tauri::State;

pub use trino_engine::turn::*;

/// TURN servers for a protected (relay-only) call, asked for the call
/// `call_id` alone (renewals within it included). Only an unlocked session
/// asks, but never with the account's key. Calls go direct (STUN) only
/// after the user agrees, and never because Tor is not ready (R-11).
#[tauri::command]
pub async fn get_turn_servers(
    state: State<'_, AppState>,
    call_id: String,
) -> Result<TurnServers, CommandError> {
    if !valid_call_id(&call_id) {
        return Err(CommandError::internal("not a call id"));
    }
    let session = {
        let inner = state.inner.lock().await;
        if inner.identity.is_none() {
            return Err(TurnError::Locked.into());
        }
        // Under `inner`, like the identity: a later lock voids this session.
        state.turn.session()
    };
    let client = TurnClient::production(Arc::clone(&state.net));
    Ok(turn_servers(&state.turn, &client, session, &call_id).await?)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_command_never_signs_with_the_identity() {
        // Decision 18: the account's key never reaches the Worker. The
        // command reads only whether a session is open.
        // As checked out: on Windows, git may give the file CRLF line ends.
        let source = include_str!("turn.rs").replace("\r\n", "\n");
        let command = &source[source
            .find("pub async fn get_turn_servers")
            .expect("the command")..];
        let command = &command[..command.find("\n}\n").expect("its end")];
        assert!(!command.contains("priv_bytes"), "{command}");
        assert!(!command.contains("nostr."), "{command}");
    }
}
