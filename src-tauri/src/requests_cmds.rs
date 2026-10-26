//! Solicitudes (uso responsable UR-4, `Uso responsable/diseno.md` §4.3).
//! What a request is, its quotas and what each answer does are the
//! engine's (`trino_engine::requests`); these commands save what changed.
//!
//! - `list_requests`: the list, the latest first, and how many did not fit.
//!   Never a file's address or key, nor a photo.
//! - `accept_request`: the contact it makes (or the one a group made), with
//!   what came in its chat; answers its name there.
//! - `delete_request`: what that identity sends in the next 30 days is
//!   dropped in silence.
//! - `list_deleted_requests` and `undo_deleted_request`: Ajustes ›
//!   Privacidad › Solicitudes eliminadas.
//!
//! Blocking from a request is `block_identity` with `{ kind: "request" }`.
//! A failed save is only logged, as the profiles' is: an account the
//! migration has not moved yet keeps its requests for this session only.
//! A child module of `commands`, so it reaches the helpers there
//! (persistence) without making them public.

use super::persist_account;
use crate::command_error::{CommandError, ErrorCode};
use crate::state::{AppState, InnerState};
use serde::Serialize;
use tauri::State;
use trino_engine::contacts::sealed;
use trino_engine::requests::{self, DeletedView, RequestsView};

fn open(inner: &InnerState) -> Result<(), CommandError> {
    inner.identity.as_ref().map(drop).ok_or_else(sealed)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// What `accept_request` answers: the contact's name, to open its chat.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Accepted {
    pub handle: String,
}

/// Solicitudes. What expired goes first, and is saved.
#[tauri::command]
pub async fn list_requests(state: State<'_, AppState>) -> Result<RequestsView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let now = now();
    if inner.requests.prune(now) {
        requests::save(&inner);
    }
    Ok(requests::list(&inner, now))
}

/// Accept the request of `key`. The contact, its chat and the requests are
/// saved: the account first, since the chat names the contact.
#[tauri::command]
pub async fn accept_request(
    state: State<'_, AppState>,
    key: String,
) -> Result<Accepted, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let handle = requests::accept(&mut inner, &key, now())?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    trino_engine::session::save_history(&inner);
    requests::save(&inner);
    Ok(Accepted { handle })
}

/// Delete the request of `key`.
#[tauri::command]
pub async fn delete_request(state: State<'_, AppState>, key: String) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    requests::delete(&mut inner, &key, now())?;
    requests::save(&inner);
    Ok(())
}

/// Solicitudes eliminadas, the latest first.
#[tauri::command]
pub async fn list_deleted_requests(
    state: State<'_, AppState>,
) -> Result<Vec<DeletedView>, CommandError> {
    let inner = state.inner.lock().await;
    open(&inner)?;
    Ok(requests::list_deleted(&inner, now()))
}

/// Let the deleted `key` send requests again.
#[tauri::command]
pub async fn undo_deleted_request(
    state: State<'_, AppState>,
    key: String,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    requests::undo_delete(&mut inner, &key)?;
    requests::save(&inner);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepting_answers_only_the_contacts_name() {
        let json = serde_json::to_value(Accepted {
            handle: "ana".into(),
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "handle": "ana" }));
    }
}
