//! Blocking (uso responsable UR-2, `Uso responsable/diseno.md` §3). Whom a
//! block names and what it stops are the engine's (`trino_engine::block`);
//! these commands save the account after each change.
//!
//! - `block_preview`: what the confirmation says (the groups you share, who
//!   administers them, a key clash) before anything changes;
//! - `block_identity`: a contact, a member of a group who is not one, or
//!   whoever sent a request (UR-4), whose request goes with it;
//! - `unblock_identity` and `list_blocked`: Ajustes › Privacidad ›
//!   Bloqueados.
//!
//! A child module of `commands`, so it reaches the helpers there
//! (persistence) without making them public.

use super::persist_account;
use crate::command_error::{CommandError, ErrorCode};
use crate::state::{AppState, InnerState};
use serde::Deserialize;
use tauri::State;
use trino_engine::block::{self, BlockOrigin, BlockPreview, BlockTarget, BlockedView};
use trino_engine::contacts::sealed;

/// Whom a command names, as the UI sends it (`BlockTarget` in
/// src/lib/api.ts).
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TargetWire {
    Contact {
        handle: String,
    },
    Member {
        gid: String,
        ik_sign_pub: String,
    },
    /// Whoever sent a request (UR-4), by its identity key.
    Request {
        ik_sign_pub: String,
    },
}

impl TargetWire {
    /// The engine's target, and where the block was made.
    fn target(self) -> (BlockTarget, BlockOrigin) {
        match self {
            TargetWire::Contact { handle } => (BlockTarget::Contact(handle), BlockOrigin::Contact),
            TargetWire::Member { gid, ik_sign_pub } => (
                BlockTarget::Member {
                    gid,
                    ik_sign: ik_sign_pub,
                },
                BlockOrigin::Group,
            ),
            TargetWire::Request { ik_sign_pub } => {
                (BlockTarget::Request(ik_sign_pub), BlockOrigin::Request)
            }
        }
    }
}

fn open(inner: &InnerState) -> Result<(), CommandError> {
    inner.identity.as_ref().map(drop).ok_or_else(sealed)
}

fn save(inner: &InnerState) -> Result<(), CommandError> {
    persist_account(inner).map_err(|e| CommandError::new(ErrorCode::Io, e))
}

/// What blocking `target` would do. Changes nothing.
#[tauri::command]
pub async fn block_preview(
    state: State<'_, AppState>,
    target: TargetWire,
) -> Result<BlockPreview, CommandError> {
    let inner = state.inner.lock().await;
    open(&inner)?;
    block::preview(&inner, &target.target().0)
}

/// Block `target`. `key_clash` when a key they proved they hold is another
/// contact's: then nothing changes.
#[tauri::command]
pub async fn block_identity(
    state: State<'_, AppState>,
    target: TargetWire,
) -> Result<BlockedView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let (target, origin) = target.target();
    let now = chrono::Utc::now().timestamp();
    let blocked = block::block(&mut inner, &target, origin, now)?;
    save(&inner)?;
    // Their request went with the block.
    trino_engine::requests::save(&inner);
    Ok(blocked)
}

/// Unblock the one `key` names (`BlockedView.key`).
#[tauri::command]
pub async fn unblock_identity(
    state: State<'_, AppState>,
    key: String,
) -> Result<BlockedView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let now = chrono::Utc::now().timestamp();
    let unblocked = block::unblock(&mut inner, &key, now)?;
    save(&inner)?;
    Ok(unblocked)
}

/// Everyone blocked, the latest first.
#[tauri::command]
pub async fn list_blocked(state: State<'_, AppState>) -> Result<Vec<BlockedView>, CommandError> {
    let inner = state.inner.lock().await;
    open(&inner)?;
    Ok(block::list(&inner))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ui_names_a_contact_or_a_member_and_says_nothing_more() {
        let contact: TargetWire =
            serde_json::from_value(serde_json::json!({ "kind": "contact", "handle": "ana" }))
                .unwrap();
        let member: TargetWire = serde_json::from_value(serde_json::json!({
            "kind": "member",
            "gid": "g1",
            "ik_sign_pub": "aa",
        }))
        .unwrap();

        assert_eq!(
            contact.target(),
            (BlockTarget::Contact("ana".into()), BlockOrigin::Contact)
        );
        assert_eq!(
            member.target(),
            (
                BlockTarget::Member {
                    gid: "g1".into(),
                    ik_sign: "aa".into()
                },
                BlockOrigin::Group
            )
        );
        // From Solicitudes (UR-4), by the request's identity key.
        let request: TargetWire = serde_json::from_value(serde_json::json!({
            "kind": "request",
            "ik_sign_pub": "bb",
        }))
        .unwrap();
        assert_eq!(
            request.target(),
            (BlockTarget::Request("bb".into()), BlockOrigin::Request)
        );
        let extra = serde_json::json!({ "kind": "contact", "handle": "ana", "from": "report" });
        assert!(serde_json::from_value::<TargetWire>(extra).is_err());
    }
}
