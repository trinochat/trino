//! Solicitudes (uso responsable UR-4, `Uso responsable/diseno.md` §4.3).
//! What a request is, its quotas and what each answer does are the
//! engine's (`trino_engine::requests`); these commands save what changed.
//!
//! - `list_requests`: the list, the latest first, and how many did not fit.
//!   Never a file's address or key, nor a photo.
//! - `accept_request`: the contact it makes (or the one a group made), with
//!   what came in its chat; answers its name there.
//! - `accept_group_contact`: "Agregar a contactos" for a contact a group
//!   made (UR-3), with what its request held, if any.
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
use trino_engine::group_contacts;
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<Accepted, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let handle = requests::accept(&mut inner, &key, now())?;
    saved(&inner)?;
    let targets = profile_to(&inner, &handle);
    drop(inner);
    super::profile::send_in_background(&app, targets);
    Ok(Accepted { handle })
}

/// "Agregar a contactos" (UR-3): `handle`, a contact a group made, becomes
/// a contact of yours, with what its request held in its chat; your
/// profile goes to them now. Answers its name.
#[tauri::command]
pub async fn accept_group_contact(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    handle: String,
) -> Result<Accepted, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let had_request = inner.requests.len();
    let handle = group_contacts::accept(&mut inner, &handle, now())?;
    saved(&inner)?;
    if inner.requests.len() != had_request {
        // Its request went to its chat: Solicitudes counts one less.
        requests::tell(&*crate::events::sink(app.clone()), &inner);
    }
    let targets = profile_to(&inner, &handle);
    drop(inner);
    super::profile::send_in_background(&app, targets);
    Ok(Accepted { handle })
}

/// The account, the chats and the requests after an acceptance: the
/// account first, since the chat names the contact.
fn saved(inner: &InnerState) -> Result<(), CommandError> {
    persist_account(inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    trino_engine::session::save_history(inner);
    requests::save(inner);
    Ok(())
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

/// Whom to send the profile to once `handle` is accepted: them, if their
/// Trino reads profiles and they are not blocked. A contact a group made
/// never got it (UR-3, R-09).
pub(crate) fn profile_to(inner: &InnerState, handle: &str) -> Vec<String> {
    let reads_it = inner
        .profiles
        .contacts
        .get(handle)
        .is_some_and(|kept| kept.caps >= trino_engine::profile::PROFILE_V);
    let fit = inner.friends.get(handle).is_some_and(|friend| {
        !group_contacts::is_limited(friend) && !trino_engine::block::friend_blocked(inner, friend)
    });
    if reads_it && fit {
        vec![handle.to_string()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trino_engine::identity::{create_identity, public_bundle_for};
    use trino_engine::state::FriendRecord;

    #[test]
    fn ur3_once_accepted_they_get_the_profile_if_their_trino_reads_it() {
        let mut inner = InnerState::default();
        for handle in ["mara", "luis", "sin"] {
            inner.friends.insert(
                handle.into(),
                FriendRecord {
                    handle: handle.into(),
                    bundle: public_bundle_for(&create_identity()),
                    added_at: 0,
                    avatar: None,
                    previous_fingerprint: None,
                    key_changed_at: None,
                    via_group: Some("g1".into()),
                    accepted_at: None,
                    devices: None,
                },
            );
        }
        for handle in ["mara", "luis"] {
            inner
                .profiles
                .contacts
                .entry(handle.into())
                .or_default()
                .caps = trino_engine::profile::PROFILE_V;
        }
        inner.friends.get_mut("mara").unwrap().accepted_at = Some(1);
        inner.friends.get_mut("sin").unwrap().accepted_at = Some(1);
        assert_eq!(profile_to(&inner, "mara"), ["mara"]);
        assert!(profile_to(&inner, "luis").is_empty(), "not accepted");
        assert!(profile_to(&inner, "sin").is_empty(), "reads no profiles");
        assert!(profile_to(&inner, "nadie").is_empty());
    }

    #[test]
    fn accepting_answers_only_the_contacts_name() {
        let json = serde_json::to_value(Accepted {
            handle: "ana".into(),
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "handle": "ana" }));
    }
}
