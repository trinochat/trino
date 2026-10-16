//! The group commands (W8, K9, K10). What a group is, what its admin can
//! change and sending the roster of a change are the engine's
//! (`trino_engine::groups`, M4-0c).
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use crate::command_error::CommandError;
use crate::state::AppState;
use tauri::State;
use trino_engine::contacts::sealed;
use trino_engine::groups::{self, GroupInfo};
pub(crate) use trino_engine::groups::{members_of, GroupMember};

/// The members of a group (K9).
#[tauri::command]
pub async fn group_members(
    state: State<'_, AppState>,
    gid: String,
) -> Result<Vec<GroupMember>, CommandError> {
    let inner = state.inner.lock().await;
    let my_ik = inner
        .identity
        .as_ref()
        .map(|identity| hex::encode(identity.ik_sign.pub_bytes))
        .ok_or_else(sealed)?;
    members_of(&inner, &gid, &my_ik)
}

/// Remove a member from a group I administer (K10).
#[tauri::command]
pub async fn remove_group_member(
    state: State<'_, AppState>,
    gid: String,
    ik_sign_pub: String,
) -> Result<GroupInfo, CommandError> {
    groups::remove_member(&state, gid, ik_sign_pub).await
}

/// Rename a group I administer (K10).
#[tauri::command]
pub async fn rename_group(
    state: State<'_, AppState>,
    gid: String,
    name: String,
) -> Result<GroupInfo, CommandError> {
    groups::rename(&state, gid, name).await
}

/// Leave a group (K10): forget it here, without telling anyone.
#[tauri::command]
pub async fn leave_group(state: State<'_, AppState>, gid: String) -> Result<(), CommandError> {
    groups::leave(&state, gid).await
}

/// Delete a group I administer (K10): tell every member, then forget it here.
#[tauri::command]
pub async fn delete_group(state: State<'_, AppState>, gid: String) -> Result<(), CommandError> {
    groups::delete(&state, gid).await
}
