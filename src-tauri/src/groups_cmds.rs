//! Groups (W8): the members of a group matched to contacts by key (K9), and
//! what its admin can do: remove a member, rename the group or delete it,
//! while anyone can leave (K10).
//!
//! Nothing here changes the protocol: every change is a roster signed the
//! way 0.1.0 already checks and applies.
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::contacts_cmds::{not_found, sealed};
use super::{
    dbg_log, ensure_session_inner, fp, group_convo, group_info, persist_groups,
    refresh_member_bindings, save_history, self_member_bundle, send_cipher_inner, zeroize_file_ref,
    GroupInfo,
};
use crate::command_error::{CommandError, ErrorCode};
use crate::envelope::{encode_envelope, Envelope};
use crate::group::{self, GroupError, GroupRoster, MemberBundle};
use crate::identity::{decode_array_32, Identity};
use crate::state::{AppState, InnerState};
use serde::Serialize;
use tauri::State;

/// The admin removed me from a group, or deleted it (K10).
#[derive(Serialize, Clone)]
pub struct GroupRemovedEvent {
    pub gid: String,
}

/// A roster change, signed and ready to go out: the new roster and the
/// contacts it must reach.
#[derive(Debug)]
pub(crate) struct RosterChange {
    pub roster: GroupRoster,
    pub targets: Vec<String>,
}

/// One member of a group, as its roster names it (K9).
#[derive(Debug, PartialEq, Serialize)]
pub struct GroupMember {
    pub ik_sign_pub: String,
    /// The name the admin's roster gives it.
    pub roster_handle: String,
    /// The contact with its identity key, by the name it has here; `None`
    /// for me and for members who are not contacts.
    pub local_handle: Option<String>,
    /// From the keys in the roster.
    pub fingerprint: String,
    pub is_admin: bool,
    pub is_self: bool,
    /// The group whose roster brought that contact (`FriendRecord.via_group`).
    pub via_group: Option<String>,
}

/// The fingerprint of the keys a roster gives a member.
fn member_fingerprint(member: &MemberBundle) -> String {
    let key = |hex: &str| decode_array_32(hex).unwrap_or([0u8; 32]);
    fp(
        &key(&member.ik_sign_pub),
        &key(&member.ik_dh_pub),
        &key(&member.nostr_pub),
    )
}

/// The members of `gid`, in roster order, each matched to a contact by its
/// identity key, never by its name: names in a roster are whatever the admin
/// wrote, and one that clashes with a contact here was stored as `name-xxxx`.
pub(crate) fn members_of(
    inner: &InnerState,
    gid: &str,
    my_ik: &str,
) -> Result<Vec<GroupMember>, CommandError> {
    let roster: &GroupRoster = inner
        .groups
        .get(gid)
        .ok_or_else(|| not_found("unknown group"))?;
    Ok(roster
        .members
        .iter()
        .map(|member| {
            let is_self = member.ik_sign_pub == my_ik;
            let contact = inner
                .friends
                .values()
                .filter(|_| !is_self)
                .find(|f| f.bundle.ik_sign_pub == member.ik_sign_pub);
            GroupMember {
                ik_sign_pub: member.ik_sign_pub.clone(),
                roster_handle: member.handle.clone(),
                local_handle: contact.map(|f| f.handle.clone()),
                fingerprint: member_fingerprint(member),
                is_admin: member.ik_sign_pub == roster.admin_pub,
                is_self,
                via_group: contact.and_then(|f| f.via_group.clone()),
            }
        })
        .collect())
}

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

fn my_ik(identity: &Identity) -> String {
    hex::encode(identity.ik_sign.pub_bytes)
}

fn group_error(error: GroupError) -> CommandError {
    match error {
        GroupError::NotAdmin => CommandError::new(ErrorCode::NotAdmin, error.to_string()),
        other => CommandError::internal(other.to_string()),
    }
}

/// The roster of `gid`, for a change only its admin may make, with every
/// member's own binding filled in from what we hold, as `add_group_member`
/// does: rosters stored before roster v2 lack them, and the core refuses to
/// sign a roster the members would reject.
fn admin_roster(
    inner: &InnerState,
    identity: &Identity,
    gid: &str,
) -> Result<GroupRoster, CommandError> {
    let current = inner
        .groups
        .get(gid)
        .ok_or_else(|| not_found("unknown group"))?;
    if current.admin_pub != my_ik(identity) {
        return Err(CommandError::new(
            ErrorCode::NotAdmin,
            "only the group admin can do that",
        ));
    }
    let mut roster = current.clone();
    let handle = inner.handle.clone().unwrap_or_else(|| "me".to_string());
    let me = self_member_bundle(identity, &handle);
    refresh_member_bindings(&mut roster.members, &inner.friends, &me);
    Ok(roster)
}

/// The contacts, by handle, that `members` other than me are, matched by
/// identity key. Members who are not contacts cannot be reached.
fn contacts_of(inner: &InnerState, members: &[MemberBundle], me: &str) -> Vec<String> {
    let mut handles: Vec<String> = Vec::new();
    for member in members.iter().filter(|m| m.ik_sign_pub != me) {
        let contact = inner
            .friends
            .values()
            .find(|f| f.bundle.ik_sign_pub == member.ik_sign_pub);
        if let Some(contact) = contact {
            if !handles.contains(&contact.handle) {
                handles.push(contact.handle.clone());
            }
        }
    }
    handles
}

/// Remove a member (K10, admin only): the roster of the next epoch without
/// them, for every member, the removed one included: it is how they learn.
pub(crate) fn plan_removal(
    inner: &InnerState,
    identity: &Identity,
    gid: &str,
    ik_sign_pub: &str,
) -> Result<RosterChange, CommandError> {
    let current = admin_roster(inner, identity, gid)?;
    if !group::is_member(&current, ik_sign_pub) {
        return Err(not_found("not a member of this group"));
    }
    let roster = group::remove_member(&current, identity, ik_sign_pub).map_err(group_error)?;
    let targets = contacts_of(inner, &current.members, &my_ik(identity));
    Ok(RosterChange { roster, targets })
}

/// Rename the group (K10, admin only): the roster of the next epoch with
/// the new name, for every member. The same name again sends the current
/// roster again, so a rename that reached nobody can be retried.
pub(crate) fn plan_rename(
    inner: &InnerState,
    identity: &Identity,
    gid: &str,
    name: &str,
) -> Result<RosterChange, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::internal("a group needs a name"));
    }
    let current = admin_roster(inner, identity, gid)?;
    let roster = if current.name == name {
        current
    } else {
        group::set_group_name(&current, identity, name).map_err(group_error)?
    };
    let targets = contacts_of(inner, &roster.members, &my_ik(identity));
    Ok(RosterChange { roster, targets })
}

/// Delete the group (K10, admin only): the roster of the next epoch with
/// only the admin, for every member. Their group ends; versions without
/// K10 keep it, with nobody else in it.
///
/// Signed here in one go, over the same bytes the core signs
/// (`roster_signing_bytes`) and checked with the core's `validate_roster`:
/// removing the members one at a time would sign, and check every member,
/// once per member.
pub(crate) fn plan_deletion(
    inner: &InnerState,
    identity: &Identity,
    gid: &str,
) -> Result<RosterChange, CommandError> {
    let current = admin_roster(inner, identity, gid)?;
    let members: Vec<MemberBundle> = current
        .members
        .iter()
        .filter(|m| m.ik_sign_pub == current.admin_pub)
        .cloned()
        .collect();
    let epoch = current.epoch + 1;
    let bytes = group::roster_signing_bytes(
        &current.group_id,
        &current.name,
        &current.photo,
        &current.admin_pub,
        &members,
        epoch,
    );
    let roster = GroupRoster {
        group_id: current.group_id.clone(),
        name: current.name.clone(),
        photo: current.photo.clone(),
        admin_pub: current.admin_pub.clone(),
        members,
        epoch,
        signature: hex::encode(crate::identity::ed25519_sign(&identity.ik_sign, &bytes)),
    };
    group::validate_roster(&roster).map_err(|e| CommandError::internal(e.to_string()))?;
    let targets = contacts_of(inner, &current.members, &my_ik(identity));
    Ok(RosterChange { roster, targets })
}

/// Forget a group here: its roster and its chat. Nothing is sent, and
/// nothing marks it as left, so the admin's next roster comes back as an
/// invitation that can be declined.
pub(crate) fn forget_group(inner: &mut InnerState, gid: &str) -> Result<(), CommandError> {
    use zeroize::Zeroize;
    inner
        .groups
        .remove(gid)
        .ok_or_else(|| not_found("unknown group"))?;
    if let Some(mut items) = inner.history.remove(&group_convo(gid)) {
        for item in &mut items {
            if let Some(text) = item.text.as_mut() {
                text.zeroize();
            }
            if let Some(file) = item.file.as_mut() {
                zeroize_file_ref(file);
            }
        }
    }
    Ok(())
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

/// The open identity, or `no_vault`.
fn open_identity(inner: &InnerState) -> Result<Identity, CommandError> {
    inner.identity.clone().ok_or_else(sealed)
}

/// A roster change goes nowhere without a relay that is up (K3): refuse it,
/// as `offline`, before anything changes here, so the user can try again
/// once connected.
fn check_online(inner: &InnerState, change: &RosterChange) -> Result<(), CommandError> {
    let any_up = inner.relays.iter().any(|relay| relay.is_connected());
    if !change.targets.is_empty() && !any_up {
        return Err(CommandError::new(
            ErrorCode::Offline,
            "no relay is connected: the change would reach nobody",
        ));
    }
    Ok(())
}

/// Plan a change to `gid` with the state locked, store it here, then send it
/// to its members with the state unlocked (sending locks it per message).
async fn apply_and_send(
    state: &State<'_, AppState>,
    gid: &str,
    plan: impl FnOnce(&InnerState, &Identity) -> Result<RosterChange, CommandError>,
) -> Result<GroupInfo, CommandError> {
    let (change, my_ik) = {
        let mut inner = state.inner.lock().await;
        let identity = open_identity(&inner)?;
        let change = plan(&inner, &identity)?;
        check_online(&inner, &change)?;
        inner.groups.insert(gid.to_string(), change.roster.clone());
        persist_groups(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        (change, hex::encode(identity.ik_sign.pub_bytes))
    };
    send_roster(state, &change.roster, &change.targets).await;
    Ok(group_info(&change.roster, &my_ik))
}

/// Remove a member from a group I administer (K10).
#[tauri::command]
pub async fn remove_group_member(
    state: State<'_, AppState>,
    gid: String,
    ik_sign_pub: String,
) -> Result<GroupInfo, CommandError> {
    apply_and_send(&state, &gid, |inner, identity| {
        plan_removal(inner, identity, &gid, &ik_sign_pub)
    })
    .await
}

/// Rename a group I administer (K10).
#[tauri::command]
pub async fn rename_group(
    state: State<'_, AppState>,
    gid: String,
    name: String,
) -> Result<GroupInfo, CommandError> {
    apply_and_send(&state, &gid, |inner, identity| {
        plan_rename(inner, identity, &gid, &name)
    })
    .await
}

/// Leave a group (K10): forget it here, without telling anyone.
#[tauri::command]
pub async fn leave_group(state: State<'_, AppState>, gid: String) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open_identity(&inner)?;
    forget_group(&mut inner, &gid)?;
    persist_groups(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
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
        persist_groups(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        save_history(&inner);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{ingest_incoming_roster, merge_group_members, RosterOutcome};
    use crate::identity::{create_identity, public_bundle_for};
    use crate::state::FriendRecord;
    use std::collections::HashMap;

    const NOW: i64 = 1_760_000_000;

    fn ik(id: &Identity) -> String {
        hex::encode(id.ik_sign.pub_bytes)
    }

    fn member(id: &Identity, handle: &str) -> MemberBundle {
        MemberBundle::from_public_bundle(handle, &public_bundle_for(id))
    }

    fn friend(id: &Identity, handle: &str) -> FriendRecord {
        FriendRecord {
            handle: handle.to_string(),
            bundle: public_bundle_for(id),
            added_at: 0,
            avatar: None,
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
        }
    }

    /// A group made by `admin`, with `others` added in order.
    fn roster_of(admin: &Identity, others: &[(&Identity, &str)]) -> GroupRoster {
        let mut roster = group::create_group(admin, member(admin, "admin"), "amigos").unwrap();
        for (id, handle) in others {
            roster = group::add_member(&roster, admin, member(id, handle)).unwrap();
        }
        roster
    }

    #[test]
    fn members_joined_from_a_roster_remember_their_group() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let mut friends = HashMap::from([("admin".to_string(), friend(&admin, "admin"))]);

        merge_group_members(&mut friends, &roster, &ik(&me), NOW);

        assert_eq!(
            friends["ana"].via_group.as_deref(),
            Some(roster.group_id.as_str())
        );
        assert_eq!(
            friends["admin"].via_group, None,
            "a contact added with its code"
        );
    }

    #[test]
    fn members_are_matched_to_contacts_by_key_even_when_names_clash() {
        let (admin, me, bob, carol) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        // Carol calls herself "bob" in the roster, and "bob" is taken here.
        let roster = roster_of(&admin, &[(&me, "me"), (&carol, "bob")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.friends.insert("bob".into(), friend(&bob, "bob"));
        merge_group_members(&mut inner.friends, &roster, &ik(&me), NOW);
        inner.groups.insert(gid.clone(), roster);

        let members = members_of(&inner, &gid, &ik(&me)).unwrap();

        let carol_row = members
            .iter()
            .find(|m| m.ik_sign_pub == ik(&carol))
            .unwrap();
        let carol_here = format!("bob-{}", &ik(&carol)[..4]);
        assert_eq!(carol_row.roster_handle, "bob");
        assert_eq!(carol_row.local_handle.as_deref(), Some(carol_here.as_str()));
        assert_eq!(carol_row.via_group.as_deref(), Some(gid.as_str()));
        assert_eq!(
            carol_row.fingerprint,
            fp(
                &carol.ik_sign.pub_bytes,
                &carol.ik_dh.pub_bytes,
                &carol.nostr.pub_bytes
            )
        );
        assert!(!carol_row.is_admin && !carol_row.is_self);
        assert!(
            members
                .iter()
                .all(|m| m.local_handle.as_deref() != Some("bob")),
            "the real bob is not in this group"
        );
    }

    #[test]
    fn members_say_who_administers_and_which_one_is_me() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.groups.insert(gid.clone(), roster);

        let members = members_of(&inner, &gid, &ik(&me)).unwrap();

        assert_eq!(members.len(), 3);
        let admin_row = members.iter().find(|m| m.is_admin).unwrap();
        assert_eq!(admin_row.ik_sign_pub, ik(&admin));
        assert_eq!(admin_row.local_handle.as_deref(), Some("admin"));
        assert_eq!(admin_row.via_group, None);
        let my_row = members.iter().find(|m| m.is_self).unwrap();
        assert_eq!(my_row.ik_sign_pub, ik(&me));
        assert_eq!(my_row.local_handle, None);
        assert_eq!(
            members.iter().filter(|m| m.is_admin || m.is_self).count(),
            2
        );
        let ana_row = members.iter().find(|m| m.ik_sign_pub == ik(&ana)).unwrap();
        assert_eq!(ana_row.local_handle, None, "not a contact here");
    }

    #[test]
    fn the_members_of_an_unknown_group_are_not_found() {
        let inner = InnerState::default();
        let error = members_of(&inner, "nope", "me").unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
    }

    // ---- K10: what the admin can do, and what the others see ----

    /// The admin's own state: a group with `others` as members, all of them
    /// contacts.
    fn admin_state(admin: &Identity, others: &[(&Identity, &str)]) -> (InnerState, String) {
        let roster = roster_of(admin, others);
        let gid = roster.group_id.clone();
        let mut inner = InnerState {
            identity: Some(admin.clone()),
            ..InnerState::default()
        };
        for (id, handle) in others {
            inner.friends.insert(handle.to_string(), friend(id, handle));
        }
        inner.groups.insert(gid.clone(), roster);
        (inner, gid)
    }

    fn sorted(mut handles: Vec<String>) -> Vec<String> {
        handles.sort();
        handles
    }

    #[test]
    fn only_the_admin_can_remove_rename_or_delete() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        inner.groups.insert(gid.clone(), roster.clone());

        let errors = [
            plan_removal(&inner, &me, &gid, &ik(&ana)).unwrap_err(),
            plan_rename(&inner, &me, &gid, "otro").unwrap_err(),
            plan_deletion(&inner, &me, &gid).unwrap_err(),
        ];

        for error in errors {
            assert_eq!(error.code, ErrorCode::NotAdmin);
        }
        assert_eq!(inner.groups[&gid], roster);
    }

    #[test]
    fn removing_a_member_signs_the_next_epoch_and_also_reaches_the_removed_member() {
        let (admin, ana, bob) = (create_identity(), create_identity(), create_identity());
        let (inner, gid) = admin_state(&admin, &[(&ana, "ana"), (&bob, "bob")]);
        let before = inner.groups[&gid].clone();

        let change = plan_removal(&inner, &admin, &gid, &ik(&bob)).unwrap();

        assert_eq!(change.roster.epoch, before.epoch + 1);
        assert!(!group::is_member(&change.roster, &ik(&bob)));
        assert!(group::is_member(&change.roster, &ik(&ana)));
        assert!(group::verify_roster(&change.roster));
        // `distribute_roster` would skip bob: this is how he learns it.
        assert_eq!(sorted(change.targets), ["ana", "bob"]);
        assert_eq!(inner.groups[&gid], before, "the command stores it");
    }

    #[test]
    fn the_admin_strangers_and_unknown_groups_cannot_be_removed_from() {
        let (admin, ana) = (create_identity(), create_identity());
        let (inner, gid) = admin_state(&admin, &[(&ana, "ana")]);

        let admin_out = plan_removal(&inner, &admin, &gid, &ik(&admin)).unwrap_err();
        let stranger = plan_removal(&inner, &admin, &gid, &ik(&create_identity())).unwrap_err();
        let no_group = plan_removal(&inner, &admin, "nope", &ik(&ana)).unwrap_err();

        assert_eq!(admin_out.code, ErrorCode::Internal);
        assert_eq!(stranger.code, ErrorCode::NotFound);
        assert_eq!(no_group.code, ErrorCode::NotFound);
    }

    #[test]
    fn renaming_signs_the_next_epoch_for_every_member() {
        let (admin, ana) = (create_identity(), create_identity());
        let (mut inner, gid) = admin_state(&admin, &[(&ana, "ana")]);
        let epoch = inner.groups[&gid].epoch;

        let change = plan_rename(&inner, &admin, &gid, "  Familia ").unwrap();

        assert_eq!(change.roster.name, "Familia");
        assert_eq!(change.roster.epoch, epoch + 1);
        assert!(group::verify_roster(&change.roster));
        assert_eq!(change.targets, ["ana"]);
        let blank = plan_rename(&inner, &admin, &gid, "   ").unwrap_err();
        assert_eq!(blank.code, ErrorCode::Internal);

        // The same name again sends the same roster again: a retry.
        inner.groups.insert(gid.clone(), change.roster.clone());
        let again = plan_rename(&inner, &admin, &gid, "Familia").unwrap();
        assert_eq!(again.roster, change.roster);
        assert_eq!(again.targets, ["ana"]);
    }

    #[test]
    fn deleting_sends_every_member_a_roster_with_only_the_admin() {
        let (admin, ana, bob) = (create_identity(), create_identity(), create_identity());
        let (inner, gid) = admin_state(&admin, &[(&ana, "ana"), (&bob, "bob")]);
        let before = inner.groups[&gid].clone();

        let change = plan_deletion(&inner, &admin, &gid).unwrap();

        assert_eq!(change.roster.members.len(), 1);
        assert!(group::is_member(&change.roster, &ik(&admin)));
        assert_eq!(change.roster.epoch, before.epoch + 1);
        assert!(group::verify_roster(&change.roster));
        assert_eq!(sorted(change.targets), ["ana", "bob"]);
        assert_eq!(
            inner.groups[&gid], before,
            "forgotten only once it went out"
        );
    }

    #[test]
    fn a_member_the_admin_removes_keeps_the_chat_and_the_group_ends() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.groups.insert(gid.clone(), roster.clone());
        let without_me = group::remove_member(&roster, &admin, &ik(&me)).unwrap();

        let out = ingest_incoming_roster(
            &mut inner,
            without_me.clone(),
            "admin",
            &ik(&admin),
            &ik(&me),
            NOW,
        );

        assert_eq!(out, RosterOutcome::Ended { gid: gid.clone() });
        assert_eq!(inner.groups[&gid], without_me);
        let info = group_info(&inner.groups[&gid], &ik(&me));
        assert!(info.ended);
        assert_eq!(serde_json::to_value(&info).unwrap()["ended"], true);
        assert!(!group_info(&roster, &ik(&me)).ended);
    }

    #[test]
    fn a_roster_without_me_changes_nothing_unless_it_is_the_admins_next_one() {
        let (admin, me, ana, mallory) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let v0 = group::create_group(&admin, member(&admin, "admin"), "amigos").unwrap();
        let v1 = group::add_member(&v0, &admin, member(&me, "me")).unwrap();
        let v2 = group::add_member(&v1, &admin, member(&ana, "ana")).unwrap();
        let gid = v2.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        inner
            .friends
            .insert("mallory".into(), friend(&mallory, "mallory"));
        inner.groups.insert(gid.clone(), v2.clone());
        let without_me = group::remove_member(&v2, &admin, &ik(&me)).unwrap();
        let mut takeover = group::create_group(&mallory, member(&mallory, "m"), "amigos").unwrap();
        takeover.group_id = gid.clone();
        let takeover = group::set_group_name(&takeover, &mallory, "amigos").unwrap();

        for (roster, sender, sender_ik) in [
            // Relayed by a member, not sent by the admin.
            (without_me, "ana", ik(&ana)),
            // An older roster of the admin's, from before I joined.
            (v0, "admin", ik(&admin)),
            // Another admin reusing the group id.
            (takeover, "mallory", ik(&mallory)),
        ] {
            let out = ingest_incoming_roster(&mut inner, roster, sender, &sender_ik, &ik(&me), NOW);
            assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        }
        assert_eq!(inner.groups[&gid], v2);
    }

    #[test]
    fn leaving_forgets_the_group_and_its_chat_and_a_later_roster_is_an_invitation() {
        let (admin, me) = (create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        inner.groups.insert(gid.clone(), roster.clone());
        inner.history.insert(format!("grp:{gid}"), vec![]);
        inner.history.insert("admin".into(), vec![]);

        forget_group(&mut inner, &gid).unwrap();

        assert!(!inner.groups.contains_key(&gid));
        assert!(!inner.history.contains_key(&format!("grp:{gid}")));
        assert!(inner.history.contains_key("admin"), "other chats stay");
        assert_eq!(
            forget_group(&mut inner, &gid).unwrap_err().code,
            ErrorCode::NotFound
        );

        // No tombstone: the admin's next roster comes back as an invitation.
        let next = group::set_group_name(&roster, &admin, "amigos 2").unwrap();
        let out = ingest_incoming_roster(&mut inner, next, "admin", &ik(&admin), &ik(&me), NOW);
        assert_eq!(out, RosterOutcome::Invited { gid: gid.clone() });
        assert!(!inner.groups.contains_key(&gid));
    }

    #[tokio::test]
    async fn a_roster_change_waits_for_a_relay_that_is_up() {
        // Since K3 the session holds a client for every relay, up or not, so
        // having relays says nothing: only one that is up can carry it.
        use crate::nostr::test_relay::{unreachable_client, Answer, TestRelay};
        let (me, ana) = (create_identity(), create_identity());
        let change = RosterChange {
            roster: roster_of(&me, &[(&ana, "ana")]),
            targets: vec!["ana".to_string()],
        };
        let mut inner = InnerState::default();

        for relays in [vec![], vec![unreachable_client(Default::default())]] {
            inner.relays = relays;
            let error = check_online(&inner, &change).unwrap_err();
            assert_eq!(error.code, ErrorCode::Offline);
        }

        let relay = TestRelay::start(Answer::Accept).await;
        inner.relays.push(relay.client().await);
        assert!(check_online(&inner, &change).is_ok());
        // A change nobody else has to hear about needs no relay.
        inner.relays.clear();
        let alone = RosterChange {
            targets: Vec::new(),
            ..change
        };
        assert!(check_online(&inner, &alone).is_ok());
    }

    /// What 0.1.0 checks the admin's signature over: a frozen copy of
    /// `roster_signing_bytes` from trino-core 1bac851, the core of 0.1.0. If
    /// the pinned core ever signs other bytes, rosters from this version stop
    /// applying on 0.1.0, and these tests say so.
    mod compat_v010 {
        use crate::group::{FileRef, GroupRoster, MemberBundle};

        pub fn roster_signing_bytes(
            group_id: &str,
            name: &str,
            photo: &Option<FileRef>,
            admin_pub: &str,
            members: &[MemberBundle],
            epoch: u64,
        ) -> Vec<u8> {
            let photo_val = match photo {
                Some(p) => serde_json::json!([p.url, p.key, p.sha256, p.mime, p.name, p.size]),
                None => serde_json::Value::Null,
            };
            let mut member_vals: Vec<serde_json::Value> = members
                .iter()
                .map(|m| {
                    serde_json::json!([
                        m.ik_sign_pub,
                        m.ik_dh_pub,
                        m.nostr_pub,
                        m.spk_id,
                        m.spk_pub,
                        m.spk_sig,
                        m.id_sig,
                        m.handle
                    ])
                })
                .collect();
            member_vals.sort_by_cached_key(|v| v.to_string());
            let body =
                serde_json::json!([group_id, name, photo_val, admin_pub, member_vals, epoch]);
            let mut out = b"trino/roster/v2\0".to_vec();
            out.extend_from_slice(body.to_string().as_bytes());
            out
        }

        /// Whether 0.1.0 takes `roster` as signed by its admin.
        pub fn signed_by_its_admin(roster: &GroupRoster) -> bool {
            let bytes = roster_signing_bytes(
                &roster.group_id,
                &roster.name,
                &roster.photo,
                &roster.admin_pub,
                &roster.members,
                roster.epoch,
            );
            let (Ok(admin), Ok(signature)) = (
                crate::identity::decode_array_32(&roster.admin_pub),
                crate::identity::decode_array_64(&roster.signature),
            ) else {
                return false;
            };
            crate::identity::ed25519_verify(&admin, &bytes, &signature)
        }
    }

    #[test]
    fn the_signed_bytes_of_a_roster_are_the_ones_0_1_0_checks() {
        let fixed = MemberBundle {
            handle: "ana".into(),
            ik_sign_pub: "aa".into(),
            ik_dh_pub: "bb".into(),
            nostr_pub: "cc".into(),
            spk_id: 7,
            spk_pub: "dd".into(),
            spk_sig: "ee".into(),
            id_sig: "ff".into(),
        };
        let mut golden = b"trino/roster/v2\0".to_vec();
        golden.extend_from_slice(
            br#"["g1","amigos",null,"aa",[["aa","bb","cc",7,"dd","ee","ff","ana"]],3]"#,
        );

        let members = std::slice::from_ref(&fixed);
        assert_eq!(
            group::roster_signing_bytes("g1", "amigos", &None, "aa", members, 3),
            golden
        );
        assert_eq!(
            compat_v010::roster_signing_bytes("g1", "amigos", &None, "aa", members, 3),
            golden
        );
    }

    #[test]
    fn rosters_from_removing_renaming_and_deleting_apply_on_0_1_0() {
        let (admin, ana, bob) = (create_identity(), create_identity(), create_identity());
        let (inner, gid) = admin_state(&admin, &[(&ana, "ana"), (&bob, "bob")]);

        for change in [
            plan_removal(&inner, &admin, &gid, &ik(&bob)).unwrap(),
            plan_rename(&inner, &admin, &gid, "otro").unwrap(),
            plan_deletion(&inner, &admin, &gid).unwrap(),
        ] {
            assert!(
                compat_v010::signed_by_its_admin(&change.roster),
                "epoch {} with {} members",
                change.roster.epoch,
                change.roster.members.len()
            );
        }
    }
}
