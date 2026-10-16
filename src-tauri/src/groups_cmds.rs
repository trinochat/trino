//! The group commands (W8, K9, K10). What a group is and what its admin
//! can change are the engine's (`trino_engine::groups`); sending the roster
//! of a change is still here, with the commands, until the engine sends.
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::{
    dbg_log, ensure_session_inner, group_info, persist_account, save_history, send_cipher_inner,
    GroupInfo,
};
use crate::command_error::{CommandError, ErrorCode};
use crate::envelope::{encode_envelope, Envelope};
use crate::group::GroupRoster;
use crate::identity::Identity;
use crate::state::{AppState, InnerState};
use tauri::State;
use trino_engine::contacts::sealed;
pub(crate) use trino_engine::groups::{
    check_online, forget_group, members_of, open_identity, plan_addition, plan_deletion,
    plan_removal, plan_rename, GroupMember, RosterChange,
};

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

/// Send `roster` to each of `targets` over its pairwise session, going on
/// past a failure, which is only logged.
async fn send_roster(state: &AppState, roster: &GroupRoster, targets: &[String]) {
    let envelope = encode_envelope(&Envelope::Roster {
        roster: roster.clone(),
    });
    for handle in targets {
        let sent: Result<(), String> = async {
            ensure_session_inner(state, handle).await?;
            send_cipher_inner(state, handle, &envelope, None).await
        }
        .await;
        if sent.is_err() {
            dbg_log("  roster not sent to a member");
        }
    }
}

/// Plan a change to `gid` with the state locked, store it here and save the
/// groups with `persist`, then send it to its members with the state
/// unlocked (sending locks it per message).
async fn apply_and_send(
    state: &AppState,
    gid: &str,
    plan: impl FnOnce(&InnerState, &Identity) -> Result<RosterChange, CommandError>,
    persist: impl FnOnce(&InnerState) -> Result<(), String>,
) -> Result<GroupInfo, CommandError> {
    let (change, my_ik) = {
        let mut inner = state.inner.lock().await;
        let identity = open_identity(&inner)?;
        let change = plan(&inner, &identity)?;
        check_online(&inner, &change)?;
        inner.groups.insert(gid.to_string(), change.roster.clone());
        persist(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        (change, hex::encode(identity.ik_sign.pub_bytes))
    };
    send_roster(state, &change.roster, &change.targets).await;
    Ok(group_info(&change.roster, &my_ik))
}

/// `add_group_member`, saving the groups with `persist`. As K10's changes:
/// with no relay up it is `offline` and nothing changes here; otherwise the
/// roster is stored, then sent to every member, past any that fails. A
/// refused add means the contact was not added.
pub(crate) async fn add_member(
    state: &AppState,
    gid: &str,
    friend_handle: &str,
    persist: impl FnOnce(&InnerState) -> Result<(), String>,
) -> Result<GroupInfo, CommandError> {
    let plan = |inner: &InnerState, identity: &Identity| {
        plan_addition(inner, identity, gid, friend_handle)
    };
    apply_and_send(state, gid, plan, persist).await
}

/// Remove a member from a group I administer (K10).
#[tauri::command]
pub async fn remove_group_member(
    state: State<'_, AppState>,
    gid: String,
    ik_sign_pub: String,
) -> Result<GroupInfo, CommandError> {
    let plan =
        |inner: &InnerState, identity: &Identity| plan_removal(inner, identity, &gid, &ik_sign_pub);
    apply_and_send(&state, &gid, plan, persist_account).await
}

/// Rename a group I administer (K10).
#[tauri::command]
pub async fn rename_group(
    state: State<'_, AppState>,
    gid: String,
    name: String,
) -> Result<GroupInfo, CommandError> {
    let plan = |inner: &InnerState, identity: &Identity| plan_rename(inner, identity, &gid, &name);
    apply_and_send(&state, &gid, plan, persist_account).await
}

/// Leave a group (K10): forget it here, without telling anyone.
#[tauri::command]
pub async fn leave_group(state: State<'_, AppState>, gid: String) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open_identity(&inner)?;
    forget_group(&mut inner, &gid)?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    save_history(&inner);
    Ok(())
}

/// Delete a group I administer (K10): tell every member, then forget it here.
#[tauri::command]
pub async fn delete_group(state: State<'_, AppState>, gid: String) -> Result<(), CommandError> {
    let change = {
        let inner = state.inner.lock().await;
        let identity = open_identity(&inner)?;
        let change = plan_deletion(&inner, &identity, &gid)?;
        check_online(&inner, &change)?;
        change
    };
    send_roster(&state, &change.roster, &change.targets).await;
    let mut inner = state.inner.lock().await;
    // Gone already if a second delete raced this one: nothing left to do.
    if forget_group(&mut inner, &gid).is_ok() {
        persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        save_history(&inner);
    }
    Ok(())
}
