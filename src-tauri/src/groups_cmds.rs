//! Groups (W8): the members of a group matched to contacts by key (K9).
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::contacts_cmds::{not_found, sealed};
use super::fp;
use crate::command_error::CommandError;
use crate::group::{GroupRoster, MemberBundle};
use crate::identity::decode_array_32;
use crate::state::{AppState, InnerState};
use serde::Serialize;
use tauri::State;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::commands::merge_group_members;
    use crate::group;
    use crate::identity::{create_identity, public_bundle_for, Identity};
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
}
