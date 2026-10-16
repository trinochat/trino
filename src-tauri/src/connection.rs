//! The state of the relay connections (K3) is the engine's
//! (`trino_engine::connection`, M4-0c); its command is here.

use crate::command_error::CommandError;
use crate::state::AppState;
use tauri::State;
pub use trino_engine::connection::*;

/// How many relays are up right now (K3). A locked session has none.
#[tauri::command]
pub async fn connection_status(
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, CommandError> {
    Ok(ConnectionStatus::of(&state.inner.lock().await.relays))
}
