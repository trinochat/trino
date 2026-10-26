//! Blocking by identity (uso responsable UR-2, `Uso responsable/diseno.md`
//! §3): whom you blocked, by the keys they proved they hold, and what a
//! block stops.
//!
//! - **The identity key always blocks**: it signed the keys of its bundle
//!   (`verify_bundle_binding`). The DH and Nostr keys block only once they
//!   are proven (R-02): the Nostr key signed an event that reached us (a
//!   handshake we took, or a message we read), the DH key took part in an
//!   X3DH whose messages we read. A key that only came in a roster stays
//!   `unproven`: someone can put a stranger's key in their own bundle, and
//!   blocking them must never silence that stranger.
//! - **A proven key another contact holds is a clash**: nothing is blocked,
//!   and the UI says to compare the fingerprints (P1 R-14).
//! - Anyone can be blocked, not only a contact: a member of a group, and
//!   later whoever sends a request (UR-4) or is reported (UR-5).
//! - Blocking drops their pending group invitations; the chat stays, and
//!   they are told nothing. Unblocking runs the merge of the groups you
//!   share again (R-24); what they sent meanwhile does not come back.
//!
//! Where a block is checked: `groups::admit_event` (their events, but the
//! rosters of a group they administer and you are in, R-04),
//! `groups::merge_group_members` (they never come back as a contact from a
//! roster), `groups::ingest_incoming_roster` (no invitations), the sending
//! paths in `send` and `session`, the profile and the warning to a trusted
//! contact.

use crate::command_error::{CommandError, ErrorCode};
use crate::contacts::{not_found, GROUP_KEY_PREFIX};
use crate::envelope::{decode_envelope, Envelope};
use crate::events::EventSink;
use crate::group::{self, GroupRoster, MemberBundle};
use crate::groups::accept_incoming_roster;
use crate::groups::{
    log_skipped_members, member_fingerprint, merge_group_members, my_ik, shown_group_name,
};
use crate::identity::{Identity, PublicBundle};
use crate::session::dbg_log;
use crate::state::{FriendRecord, InnerState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use zeroize::Zeroize;

/// Where the block was made, for the list in Settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockOrigin {
    Contact,
    /// A request from someone who is not a contact (UR-4).
    Request,
    /// A member of a group who is not a contact.
    Group,
    /// From a report (UR-5).
    Report,
    /// From the notice of an invitation.
    Invitation,
}

/// Someone you blocked (design §3.1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedIdentity {
    /// Their identity key. `None` only for a block of before UR-2 whose
    /// contact was gone: then all there is, is the Nostr key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ik_sign: Option<String>,
    /// Their DH key, once an X3DH with them was complete (R-02).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ik_dh: Option<String>,
    /// Their Nostr key, once it signed an event that reached us (R-02).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nostr_pub: Option<String>,
    /// Keys of theirs nothing proved: kept, but they block nothing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unproven: Vec<String>,
    /// What you called them, only for your list.
    pub label: String,
    /// Their fingerprint when they were blocked; empty if their keys were
    /// not all known.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub fingerprint: String,
    pub blocked_at: i64,
    pub from: BlockOrigin,
}

impl BlockedIdentity {
    /// What names it in the list and in `unblock`: the identity key, or the
    /// Nostr key of a block of before UR-2 without one.
    pub fn key(&self) -> &str {
        self.ik_sign
            .as_deref()
            .or(self.nostr_pub.as_deref())
            .unwrap_or_default()
    }

    /// A Nostr key blocked before UR-2: proven, since it signed what came
    /// from it. With the contact that has it, completed with that contact's
    /// identity key (design §3.1, migration).
    pub fn before_ur2(nostr: String, friend: Option<&FriendRecord>, now: i64) -> Self {
        BlockedIdentity {
            ik_sign: friend.map(|f| f.bundle.ik_sign_pub.clone()),
            ik_dh: None,
            nostr_pub: Some(nostr),
            unproven: friend
                .map(|f| vec![f.bundle.ik_dh_pub.clone()])
                .unwrap_or_default(),
            label: friend.map(|f| f.handle.clone()).unwrap_or_default(),
            fingerprint: friend
                .map(|f| bundle_fingerprint(&f.bundle))
                .unwrap_or_default(),
            blocked_at: now,
            from: BlockOrigin::Contact,
        }
    }

    fn blocks(&self, ik_sign: &str, ik_dh: &str, nostr: &str) -> bool {
        self.ik_sign.as_deref() == Some(ik_sign)
            || self.ik_dh.as_deref() == Some(ik_dh)
            || self.nostr_pub.as_deref() == Some(nostr)
    }
}

/// Everyone you blocked. Kept in `account.bin`, sealed with the rest of the
/// account.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BlockList {
    entries: Vec<BlockedIdentity>,
}

impl BlockList {
    pub fn entries(&self) -> &[BlockedIdentity] {
        &self.entries
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether events signed by `nostr` are someone's you blocked.
    pub fn blocks_nostr(&self, nostr: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.nostr_pub.as_deref() == Some(nostr))
    }

    /// Whether the identity `ik_sign` is blocked.
    pub fn blocks_identity(&self, ik_sign: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.ik_sign.as_deref() == Some(ik_sign))
    }

    /// Whether a bundle with these keys is someone's you blocked: the same
    /// identity key, or a DH or Nostr key they proved they hold.
    pub fn blocks_keys(&self, ik_sign: &str, ik_dh: &str, nostr: &str) -> bool {
        self.entries
            .iter()
            .any(|entry| entry.blocks(ik_sign, ik_dh, nostr))
    }

    pub fn blocks_bundle(&self, bundle: &PublicBundle) -> bool {
        self.blocks_keys(&bundle.ik_sign_pub, &bundle.ik_dh_pub, &bundle.nostr_pub)
    }

    pub fn blocks_member(&self, member: &MemberBundle) -> bool {
        self.blocks_keys(&member.ik_sign_pub, &member.ik_dh_pub, &member.nostr_pub)
    }

    /// The proven Nostr keys, sorted: what `account.bin` keeps in `blocked`
    /// too, so a Trino of before UR-2 still drops their events.
    pub fn nostr_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self
            .entries
            .iter()
            .filter_map(|entry| entry.nostr_pub.clone())
            .collect();
        keys.sort();
        keys.dedup();
        keys
    }

    /// Add `entry`, in place of one with the same key.
    pub fn insert(&mut self, entry: BlockedIdentity) {
        self.entries.retain(|kept| kept.key() != entry.key());
        self.entries.push(entry);
    }

    /// Take out the one named `key`.
    pub fn remove(&mut self, key: &str) -> Option<BlockedIdentity> {
        let at = self.entries.iter().position(|entry| entry.key() == key)?;
        Some(self.entries.remove(at))
    }

    /// Empty it, wiping the names (design §7.2 of cifrado local).
    pub fn clear(&mut self) {
        for mut entry in self.entries.drain(..) {
            entry.label.zeroize();
        }
    }

    /// The list `account.bin` gave: `saved` as it is, and each key of
    /// `legacy` (the Nostr keys of before UR-2) that none of them covers,
    /// completed with the contact that has it (design §3.1, migration).
    pub fn from_saved(
        saved: Vec<BlockedIdentity>,
        legacy: Vec<String>,
        friends: &HashMap<String, FriendRecord>,
        now: i64,
    ) -> BlockList {
        let mut list = BlockList::default();
        for entry in saved {
            if !entry.key().is_empty() {
                list.insert(entry);
            }
        }
        for nostr in legacy {
            if list.blocks_nostr(&nostr) {
                continue;
            }
            let friend = friends.values().find(|f| f.bundle.nostr_pub == nostr);
            if friend.is_some_and(|f| list.blocks_identity(&f.bundle.ik_sign_pub)) {
                continue;
            }
            list.entries
                .push(BlockedIdentity::before_ur2(nostr, friend, now));
        }
        list
    }

    /// Add what `other` has and this one does not.
    pub fn merge(&mut self, other: BlockList) {
        for entry in other.entries {
            if !self.entries.iter().any(|kept| kept.key() == entry.key()) {
                self.entries.push(entry);
            }
        }
    }
}

/// Whom to block.
#[derive(Clone, Debug, PartialEq)]
pub enum BlockTarget {
    /// A contact, by its name here.
    Contact(String),
    /// A member of the group `gid`, by its identity key: a contact or not.
    Member { gid: String, ik_sign: String },
}

/// A group you share with someone, for the confirmation (U5).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SharedGroup {
    pub gid: String,
    pub name: String,
    pub i_administer: bool,
    pub they_administer: bool,
}

/// What the confirmation says before blocking (design §12.1).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BlockPreview {
    pub label: String,
    /// Their identity key: what removing them from a group you administer
    /// takes (`remove_group_member`).
    pub ik_sign_pub: String,
    pub fingerprint: String,
    /// Their name among your contacts, if they are one.
    pub contact: Option<String>,
    pub shared_groups: Vec<SharedGroup>,
    /// A key they proved they hold is another contact's: blocking them
    /// would refuse with `key_clash`.
    pub clash: bool,
    /// Blocked already.
    pub blocked: bool,
}

/// One row of Settings › Privacidad › Bloqueados.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BlockedView {
    /// What `unblock` takes.
    pub key: String,
    pub label: String,
    pub fingerprint: String,
    pub blocked_at: i64,
    pub from: BlockOrigin,
    /// Their name among your contacts, if they still are one.
    pub contact: Option<String>,
}

/// `block_preview`: what blocking `target` would do.
pub fn preview(inner: &InnerState, target: &BlockTarget) -> Result<BlockPreview, CommandError> {
    let who = resolve(inner, target)?;
    Ok(BlockPreview {
        label: who.label.clone(),
        ik_sign_pub: who.ik_sign.clone(),
        fingerprint: who.fingerprint.clone(),
        contact: who.contact.clone(),
        shared_groups: shared_groups(inner, &who.ik_sign),
        clash: clashes(inner, &who),
        blocked: inner.blocked.blocks_identity(&who.ik_sign),
    })
}

/// Block `target` (design §3.4). Their pending group invitations go; the
/// chat stays and they are told nothing. A proven key of theirs that
/// another contact holds is `key_clash`, and nothing changes.
pub fn block(
    inner: &mut InnerState,
    target: &BlockTarget,
    origin: BlockOrigin,
    now: i64,
) -> Result<BlockedView, CommandError> {
    let who = resolve(inner, target)?;
    if inner
        .identity
        .as_ref()
        .is_some_and(|identity| my_ik(identity) == who.ik_sign)
    {
        return Err(CommandError::internal("you cannot block yourself"));
    }
    if clashes(inner, &who) {
        return Err(key_clash());
    }
    let mut unproven = Vec::new();
    let mut proven = |is: bool, key: &str| {
        if is {
            Some(key.to_string())
        } else {
            unproven.push(key.to_string());
            None
        }
    };
    let ik_dh = proven(who.dh_proven, &who.ik_dh);
    let nostr_pub = proven(who.nostr_proven, &who.nostr);
    // Blocked already, or before UR-2 by this Nostr key alone: it becomes
    // this one, and keeps when it was first.
    let earlier = [Some(who.ik_sign.as_str()), nostr_pub.as_deref()]
        .into_iter()
        .flatten()
        .filter_map(|key| inner.blocked.remove(key))
        .map(|entry| entry.blocked_at)
        .min();
    let entry = BlockedIdentity {
        ik_sign: Some(who.ik_sign.clone()),
        ik_dh,
        nostr_pub,
        unproven,
        label: who.label,
        fingerprint: who.fingerprint,
        blocked_at: earlier.unwrap_or(now),
        from: origin,
    };
    inner.blocked.insert(entry.clone());
    inner
        .group_invites
        .retain(|_, invite| invite.roster.admin_pub != who.ik_sign);
    // UR-4: their request goes too, once there are requests.
    Ok(view(inner, &entry))
}

/// Unblock the one named `key` (`BlockedIdentity::key`), and run the merge
/// of the groups you share again, so they are a contact of those groups
/// once more (R-24). What they sent meanwhile, and the invitations that
/// went, do not come back.
pub fn unblock(inner: &mut InnerState, key: &str, now: i64) -> Result<BlockedView, CommandError> {
    let entry = inner
        .blocked
        .remove(key)
        .ok_or_else(|| not_found("not blocked"))?;
    if let (Some(ik_sign), Some(identity)) = (entry.ik_sign.as_deref(), inner.identity.as_ref()) {
        let mine = my_ik(identity);
        let shared: Vec<GroupRoster> = inner
            .groups
            .values()
            .filter(|roster| group::is_member(roster, ik_sign))
            .cloned()
            .collect();
        for roster in &shared {
            let notes = merge_group_members(&mut inner.friends, &inner.blocked, roster, &mine, now);
            log_skipped_members(&notes);
        }
    }
    Ok(view(inner, &entry))
}

/// Unblock the contact `handle`: every entry that blocks it, a Nostr key
/// of before UR-2 included (`block_node` with `blocked: false`).
pub fn unblock_contact(
    inner: &mut InnerState,
    handle: &str,
    now: i64,
) -> Result<Vec<BlockedView>, CommandError> {
    let friend = inner
        .friends
        .get(handle)
        .cloned()
        .ok_or_else(|| not_found("unknown contact"))?;
    let b = &friend.bundle;
    let keys: Vec<String> = inner
        .blocked
        .entries()
        .iter()
        .filter(|entry| entry.blocks(&b.ik_sign_pub, &b.ik_dh_pub, &b.nostr_pub))
        .map(|entry| entry.key().to_string())
        .collect();
    keys.iter().map(|key| unblock(inner, key, now)).collect()
}

/// Everyone blocked, the latest first.
pub fn list(inner: &InnerState) -> Vec<BlockedView> {
    let mut shown: Vec<BlockedView> = inner
        .blocked
        .entries()
        .iter()
        .map(|entry| view(inner, entry))
        .collect();
    shown.sort_by(|a, b| b.blocked_at.cmp(&a.blocked_at).then(a.label.cmp(&b.label)));
    shown
}

/// Whether the contact `friend` is someone you blocked.
pub fn friend_blocked(inner: &InnerState, friend: &FriendRecord) -> bool {
    inner.blocked.blocks_bundle(&friend.bundle)
}

/// Whether `ik_sign` administers a group you are in: then its rosters still
/// count, blocked or not (R-04).
pub fn administers_a_group(inner: &InnerState, ik_sign: &str) -> bool {
    let Some(mine) = inner.identity.as_ref().map(my_ik) else {
        return false;
    };
    inner
        .groups
        .values()
        .any(|roster| roster.admin_pub == ik_sign && group::is_member(roster, &mine))
}

/// `key_clash`: the error of a block that would take another contact's key.
pub fn key_clash() -> CommandError {
    CommandError::new(
        ErrorCode::KeyClash,
        "a key this person proved they hold is another contact's",
    )
}

/// Whom a target names, and what proves their keys.
struct Who {
    ik_sign: String,
    ik_dh: String,
    nostr: String,
    dh_proven: bool,
    nostr_proven: bool,
    label: String,
    fingerprint: String,
    contact: Option<String>,
}

fn resolve(inner: &InnerState, target: &BlockTarget) -> Result<Who, CommandError> {
    match target {
        BlockTarget::Contact(handle) => {
            let friend = inner
                .friends
                .get(handle)
                .ok_or_else(|| not_found("unknown contact"))?;
            Ok(of_contact(inner, friend))
        }
        BlockTarget::Member { gid, ik_sign } => {
            let roster = inner
                .groups
                .get(gid)
                .ok_or_else(|| not_found("unknown group"))?;
            let member = roster
                .members
                .iter()
                .find(|member| &member.ik_sign_pub == ik_sign)
                .ok_or_else(|| not_found("not a member of this group"))?;
            // A contact is blocked as that contact, with what proves its keys.
            if let Some(friend) = inner
                .friends
                .values()
                .find(|friend| &friend.bundle.ik_sign_pub == ik_sign)
            {
                return Ok(of_contact(inner, friend));
            }
            // Someone known only from a roster: only the identity key that
            // signed their keys is proven (R-02).
            Ok(Who {
                ik_sign: member.ik_sign_pub.clone(),
                ik_dh: member.ik_dh_pub.clone(),
                nostr: member.nostr_pub.clone(),
                dh_proven: false,
                nostr_proven: false,
                label: crate::profile::shown_name(&member.handle, LABEL_MAX_CHARS, ""),
                fingerprint: member_fingerprint(member),
                contact: None,
            })
        }
    }
}

/// The longest name kept for someone blocked, as a group's member names
/// them.
const LABEL_MAX_CHARS: usize = 64;

fn of_contact(inner: &InnerState, friend: &FriendRecord) -> Who {
    let bundle = &friend.bundle;
    let read = read_from(inner, &friend.handle);
    Who {
        ik_sign: bundle.ik_sign_pub.clone(),
        ik_dh: bundle.ik_dh_pub.clone(),
        nostr: bundle.nostr_pub.clone(),
        // A message of theirs we read: the X3DH it came over took their
        // DH key, and their Nostr key signed it.
        dh_proven: read,
        // A handshake we took was signed with it too.
        nostr_proven: read || inner.handshake_marks.contains_key(&bundle.nostr_pub),
        label: friend.handle.clone(),
        fingerprint: bundle_fingerprint(bundle),
        contact: Some(friend.handle.clone()),
    }
}

/// Whether a chat holds a message of `handle`'s: their own chat, or a
/// group's.
fn read_from(inner: &InnerState, handle: &str) -> bool {
    inner.history.iter().any(|(convo, items)| {
        items.iter().any(|item| {
            item.side == "them"
                && (convo == handle
                    || (convo.starts_with(GROUP_KEY_PREFIX)
                        && item.from.as_deref() == Some(handle)))
        })
    })
}

/// Whether a key `who` proved they hold is another contact's (P1 R-14).
fn clashes(inner: &InnerState, who: &Who) -> bool {
    let proven: Vec<&str> = [
        (who.dh_proven, who.ik_dh.as_str()),
        (who.nostr_proven, who.nostr.as_str()),
    ]
    .into_iter()
    .filter_map(|(is, key)| is.then_some(key))
    .collect();
    inner
        .friends
        .values()
        .filter(|friend| friend.bundle.ik_sign_pub != who.ik_sign)
        .filter(|friend| !inner.blocked.blocks_identity(&friend.bundle.ik_sign_pub))
        .any(|friend| {
            let b = &friend.bundle;
            proven
                .iter()
                .any(|key| [&b.ik_sign_pub, &b.ik_dh_pub, &b.nostr_pub].contains(&&key.to_string()))
        })
}

/// The groups you and `ik_sign` are both in, by name.
fn shared_groups(inner: &InnerState, ik_sign: &str) -> Vec<SharedGroup> {
    let mine = inner.identity.as_ref().map(my_ik).unwrap_or_default();
    let mut shared: Vec<SharedGroup> = inner
        .groups
        .values()
        .filter(|roster| group::is_member(roster, ik_sign) && group::is_member(roster, &mine))
        .map(|roster| SharedGroup {
            gid: roster.group_id.clone(),
            name: shown_group_name(&roster.name),
            i_administer: roster.admin_pub == mine,
            they_administer: roster.admin_pub == ik_sign,
        })
        .collect();
    shared.sort_by(|a, b| a.name.cmp(&b.name).then(a.gid.cmp(&b.gid)));
    shared
}

/// How `entry` shows in the list, with the contact it still is.
fn view(inner: &InnerState, entry: &BlockedIdentity) -> BlockedView {
    let contact = inner
        .friends
        .values()
        .find(|friend| match entry.ik_sign.as_deref() {
            Some(ik_sign) => friend.bundle.ik_sign_pub == ik_sign,
            None => entry.nostr_pub.as_deref() == Some(friend.bundle.nostr_pub.as_str()),
        })
        .map(|friend| friend.handle.clone());
    BlockedView {
        key: entry.key().to_string(),
        label: entry.label.clone(),
        fingerprint: entry.fingerprint.clone(),
        blocked_at: entry.blocked_at,
        from: entry.from,
        contact,
    }
}

/// The hook in `handle_incoming_event` before the profile's: whether the
/// message of `friend` ends here because they are blocked. Such a message
/// got past `admit_event` only because they administer a group you are in
/// (R-04): a roster of theirs goes on as any other, and the roster rules
/// keep only those of groups you are in. Their texts, files, calls,
/// profile and warnings are not read, and nothing is answered.
pub fn on_message(
    events: &dyn EventSink,
    inner: &mut InnerState,
    identity: &Identity,
    friend: &FriendRecord,
    plain: &[u8],
) -> bool {
    if !friend_blocked(inner, friend) {
        return false;
    }
    match decode_envelope(plain) {
        Envelope::Roster { roster } => {
            accept_incoming_roster(events, inner, identity, friend, roster);
        }
        _ => dbg_log("  DROP: from someone blocked"),
    }
    true
}

/// The fingerprint of a bundle's keys, as the contacts and members show it.
pub fn bundle_fingerprint(bundle: &PublicBundle) -> String {
    member_fingerprint(&MemberBundle::from_public_bundle("", bundle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group;
    use crate::groups::{
        admit_event, ingest_incoming_roster, merge_group_members, take_group_invite, Admission,
        RosterOutcome,
    };
    use crate::identity::{create_identity, Identity};
    use crate::nostr::{build_and_sign_event, TRINO_KIND};
    use crate::session::fp;
    use crate::session::tests::{friend, ik, member, roster_of, NOW};
    use crate::state::{GroupInvite, HandshakeMark, HistItem};

    fn nostr_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    fn dh_hex(id: &Identity) -> String {
        hex::encode(id.ik_dh.pub_bytes)
    }

    fn fingerprint_of(id: &Identity) -> String {
        fp(
            &id.ik_sign.pub_bytes,
            &id.ik_dh.pub_bytes,
            &id.nostr.pub_bytes,
        )
    }

    /// Me, with `contacts` as contacts.
    fn me_with(me: &Identity, contacts: &[(&Identity, &str)]) -> InnerState {
        let mut inner = InnerState {
            identity: Some(me.clone()),
            handle: Some("me".into()),
            ..InnerState::default()
        };
        for (id, handle) in contacts {
            inner.friends.insert(handle.to_string(), friend(id, handle));
        }
        inner
    }

    /// `handle` wrote to me: their keys are proven.
    fn wrote(inner: &mut InnerState, handle: &str) {
        inner
            .history
            .entry(handle.to_string())
            .or_default()
            .push(HistItem {
                side: "them".into(),
                from: None,
                text: Some("hola".into()),
                file: None,
                call: None,
                ts: NOW,
            });
    }

    fn contact(handle: &str) -> BlockTarget {
        BlockTarget::Contact(handle.to_string())
    }

    fn event_from(sender: &Identity, me: &Identity) -> crate::nostr::NostrEvent {
        build_and_sign_event(
            &sender.nostr.priv_bytes,
            &sender.nostr.pub_bytes,
            TRINO_KIND,
            "{}",
            vec![vec!["p".to_string(), nostr_hex(me)]],
            Some(NOW),
        )
        .unwrap()
    }

    /// An identity with `other`'s DH or Nostr key in its own bundle, its
    /// own identity key signing it: a valid binding (R-02).
    fn with_keys_of(other: &Identity, dh: bool, nostr: bool) -> Identity {
        let mut shadow = create_identity();
        if dh {
            shadow.ik_dh = other.ik_dh.clone();
        }
        if nostr {
            shadow.nostr = other.nostr.clone();
        }
        shadow
    }

    // ---- Design test 1: merge_group_members skips them ----

    #[test]
    fn ur2_1_a_roster_never_brings_back_someone_blocked_by_any_proven_key() {
        let (me, admin, eve) = (create_identity(), create_identity(), create_identity());
        let mut inner = me_with(&me, &[(&admin, "admin"), (&eve, "eve")]);
        wrote(&mut inner, "eve");
        block(&mut inner, &contact("eve"), BlockOrigin::Contact, NOW).unwrap();
        inner.friends.remove("eve");
        // Eve herself, and two identities of hers carrying her proven DH
        // key and her proven Nostr key, each in a group of its own.
        let eve_dh = with_keys_of(&eve, true, false);
        let eve_nostr = with_keys_of(&eve, false, true);
        for (who, name) in [(&eve, "eve"), (&eve_dh, "eva"), (&eve_nostr, "evita")] {
            let roster = roster_of(&admin, &[(&me, "me"), (who, name)]);

            let notes =
                merge_group_members(&mut inner.friends, &inner.blocked, &roster, &ik(&me), NOW);

            assert_eq!(
                notes,
                [format!("skip member {}: blocked", &ik(who)[..8])],
                "{name}"
            );
        }
        assert_eq!(inner.friends.keys().collect::<Vec<_>>(), ["admin"]);
        // Someone else in such a roster is merged as always.
        let roster = roster_of(&admin, &[(&me, "me"), (&create_identity(), "juan")]);
        merge_group_members(&mut inner.friends, &inner.blocked, &roster, &ik(&me), NOW);
        assert!(inner.friends.contains_key("juan"));
    }

    // ---- Design test 2: their invitations ----

    #[test]
    fn ur2_2_blocking_drops_their_invitations_and_a_new_roster_of_theirs_makes_none() {
        let (me, admin, ana) = (create_identity(), create_identity(), create_identity());
        let mut inner = me_with(&me, &[(&admin, "admin"), (&ana, "ana")]);
        let theirs = roster_of(&admin, &[(&me, "me")]);
        let anas = roster_of(&ana, &[(&me, "me")]);
        for (roster, from) in [(theirs, &admin), (anas.clone(), &ana)] {
            let sender = if std::ptr::eq(from, &admin) {
                "admin"
            } else {
                "ana"
            };
            ingest_incoming_roster(&mut inner, roster, sender, &ik(from), &ik(&me), NOW);
        }
        assert_eq!(inner.group_invites.len(), 2);

        block(&mut inner, &contact("admin"), BlockOrigin::Contact, NOW).unwrap();

        assert_eq!(
            inner.group_invites.keys().collect::<Vec<_>>(),
            [&anas.group_id],
            "only ana's stays"
        );
        let another = roster_of(&admin, &[(&me, "me")]);
        let out = ingest_incoming_roster(&mut inner, another, "admin", &ik(&admin), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.group_invites.len(), 1);
        // One kept on disk from before is refused too.
        let old = roster_of(&admin, &[(&me, "me")]);
        let gid = old.group_id.clone();
        inner.group_invites.insert(
            gid.clone(),
            GroupInvite {
                roster: old,
                from_handle: "admin".into(),
                received_at: NOW,
            },
        );
        assert!(take_group_invite(&mut inner, &gid, &ik(&me), NOW).is_err());
        assert!(!inner.groups.contains_key(&gid));
    }

    // ---- Design test 4: removed, and back in a roster ----

    #[test]
    fn ur2_4_a_blocked_contact_removed_does_not_come_back_with_a_roster() {
        let (me, admin, eve) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let v2 = group::add_member(&v1, &admin, member(&eve, "eve")).unwrap();
        let mut inner = me_with(&me, &[(&admin, "admin"), (&eve, "eve")]);
        inner.groups.insert(v1.group_id.clone(), v1);
        block(&mut inner, &contact("eve"), BlockOrigin::Contact, NOW).unwrap();
        inner.friends.remove("eve");

        let out = ingest_incoming_roster(&mut inner, v2, "admin", &ik(&admin), &ik(&me), NOW);

        assert!(matches!(out, RosterOutcome::Applied { .. }), "{out:?}");
        assert!(
            !inner
                .friends
                .values()
                .any(|f| f.bundle.ik_sign_pub == ik(&eve)),
            "{:?}",
            inner.friends.keys()
        );
        assert!(inner.blocked.blocks_identity(&ik(&eve)));
    }

    // ---- Design test 7: a blocked admin ----

    #[test]
    fn ur2_7_a_blocked_admins_rosters_count_only_for_groups_you_are_in() {
        let (me, admin, ana) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let gid = v1.group_id.clone();
        let mut inner = me_with(&me, &[(&admin, "admin"), (&ana, "ana")]);
        inner.groups.insert(gid.clone(), v1.clone());
        block(&mut inner, &contact("admin"), BlockOrigin::Contact, NOW).unwrap();
        block(&mut inner, &contact("ana"), BlockOrigin::Contact, NOW).unwrap();

        // Their events get in only because of that group (R-04).
        let mine = nostr_hex(&me);
        let from_admin = admit_event(&mut inner, &event_from(&admin, &me), &mine);
        let from_ana = admit_event(&mut inner, &event_from(&ana, &me), &mine);
        assert!(
            matches!(from_admin, Admission::Process(_)),
            "{from_admin:?}"
        );
        assert!(matches!(from_ana, Admission::Drop(_)), "{from_ana:?}");
        assert!(administers_a_group(&inner, &ik(&admin)));
        assert!(!administers_a_group(&inner, &ik(&ana)));

        // Their signed roster of that group applies: you see who comes and goes.
        let v2 = group::add_member(&v1, &admin, member(&create_identity(), "juan")).unwrap();
        let out =
            ingest_incoming_roster(&mut inner, v2.clone(), "admin", &ik(&admin), &ik(&me), NOW);
        assert_eq!(
            out,
            RosterOutcome::Applied {
                gid: gid.clone(),
                notes: vec![]
            }
        );
        assert_eq!(inner.groups[&gid].epoch, v2.epoch);
        // One of a new group is no invitation.
        let new = roster_of(&admin, &[(&me, "me")]);
        let out = ingest_incoming_roster(&mut inner, new, "admin", &ik(&admin), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert!(inner.group_invites.is_empty());
    }

    // ---- Design test 8: the blocks of before UR-2 ----

    #[test]
    fn ur2_8_blocks_of_before_load_as_identities() {
        let (ana, gone) = (create_identity(), create_identity());
        let friends = HashMap::from([("ana".to_string(), friend(&ana, "ana"))]);
        let legacy = vec![nostr_hex(&ana), nostr_hex(&gone)];

        let list = BlockList::from_saved(Vec::new(), legacy, &friends, NOW);

        assert_eq!(list.len(), 2);
        let anas = list.entries().iter().find(|e| e.label == "ana").unwrap();
        assert_eq!(anas.ik_sign.as_deref(), Some(ik(&ana).as_str()));
        assert_eq!(anas.nostr_pub.as_deref(), Some(nostr_hex(&ana).as_str()));
        assert_eq!(anas.fingerprint, fingerprint_of(&ana));
        assert_eq!(anas.from, BlockOrigin::Contact);
        assert_eq!(anas.blocked_at, NOW);
        // Without its contact, the Nostr key alone, which signed what came.
        let gones = list.entries().iter().find(|e| e.ik_sign.is_none()).unwrap();
        assert_eq!(gones.nostr_pub.as_deref(), Some(nostr_hex(&gone).as_str()));
        assert_eq!(gones.key(), nostr_hex(&gone));
        assert!(list.blocks_identity(&ik(&ana)));
        assert!(list.blocks_nostr(&nostr_hex(&gone)));
        // Saved again, the same: nothing migrates twice.
        let again = BlockList::from_saved(
            list.entries().to_vec(),
            list.nostr_keys(),
            &friends,
            NOW + 9,
        );
        assert_eq!(again, list);
    }

    // ---- Design test 10: proof of possession (R-02) ----

    #[test]
    fn ur2_10_blocking_never_takes_a_key_not_proven_and_its_holder_still_writes() {
        let (me, admin, carol) = (create_identity(), create_identity(), create_identity());
        // Mallory's bundle carries carol's Nostr key, validly bound.
        let mallory = with_keys_of(&carol, false, true);
        let roster = roster_of(&admin, &[(&me, "me"), (&mallory, "mallory")]);
        let gid = roster.group_id.clone();
        let mut inner = me_with(&me, &[(&admin, "admin"), (&carol, "carol")]);
        inner.groups.insert(gid.clone(), roster);
        let target = BlockTarget::Member {
            gid,
            ik_sign: ik(&mallory),
        };

        assert!(!preview(&inner, &target).unwrap().clash);
        block(&mut inner, &target, BlockOrigin::Group, NOW).unwrap();

        let entry = &inner.blocked.entries()[0];
        assert_eq!(entry.ik_sign.as_deref(), Some(ik(&mallory).as_str()));
        assert_eq!(entry.nostr_pub, None, "not proven");
        assert!(entry.unproven.contains(&nostr_hex(&carol)));
        assert!(!inner.blocked.blocks_nostr(&nostr_hex(&carol)));
        let out = admit_event(&mut inner, &event_from(&carol, &me), &nostr_hex(&me));
        assert!(
            matches!(&out, Admission::Process(f) if f.handle == "carol"),
            "{out:?}"
        );
    }

    #[test]
    fn ur2_a_proven_key_another_contact_holds_is_a_clash_and_nothing_is_blocked() {
        let (me, carol) = (create_identity(), create_identity());
        // Before UR-2 a contact could share carol's Nostr key.
        let twin = with_keys_of(&carol, false, true);
        let mut inner = me_with(&me, &[(&carol, "carol"), (&twin, "twin")]);
        inner
            .handshake_marks
            .insert(nostr_hex(&carol), HandshakeMark::default());

        assert!(preview(&inner, &contact("twin")).unwrap().clash);
        let error = block(&mut inner, &contact("twin"), BlockOrigin::Contact, NOW).unwrap_err();

        assert_eq!(error.code, ErrorCode::KeyClash);
        assert!(inner.blocked.is_empty());
    }

    #[test]
    fn ur2_what_proves_a_contacts_keys() {
        let (me, ana, bob, cami) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let mut inner = me_with(&me, &[(&ana, "ana"), (&bob, "bob"), (&cami, "cami")]);
        // Ana wrote: both proven. Bob's handshake came: his Nostr key signed
        // it. Cami never sent anything.
        wrote(&mut inner, "ana");
        inner
            .handshake_marks
            .insert(nostr_hex(&bob), HandshakeMark::default());
        for handle in ["ana", "bob", "cami"] {
            block(&mut inner, &contact(handle), BlockOrigin::Contact, NOW).unwrap();
        }
        let of = |id: &Identity| {
            inner
                .blocked
                .entries()
                .iter()
                .find(|e| e.ik_sign.as_deref() == Some(ik(id).as_str()))
                .unwrap()
                .clone()
        };
        assert_eq!(of(&ana).ik_dh, Some(dh_hex(&ana)));
        assert_eq!(of(&ana).nostr_pub, Some(nostr_hex(&ana)));
        assert_eq!(of(&bob).ik_dh, None);
        assert_eq!(of(&bob).nostr_pub, Some(nostr_hex(&bob)));
        assert_eq!((of(&cami).ik_dh, of(&cami).nostr_pub), (None, None));
        assert_eq!(of(&cami).unproven.len(), 2);
        // Blocked anyway, by the identity key.
        let out = admit_event(&mut inner, &event_from(&cami, &me), &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
    }

    // ---- Design test 11: someone who is not a contact ----

    #[test]
    fn ur2_11_a_member_who_is_no_contact_can_be_blocked_and_is_listed() {
        let (me, admin, juan) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&juan, "juan")]);
        let gid = roster.group_id.clone();
        let mut inner = me_with(&me, &[(&admin, "admin")]);
        inner.groups.insert(gid.clone(), roster.clone());
        let target = BlockTarget::Member {
            gid: gid.clone(),
            ik_sign: ik(&juan),
        };

        let shown = preview(&inner, &target).unwrap();
        assert_eq!(shown.label, "juan");
        assert_eq!(shown.ik_sign_pub, ik(&juan), "to remove him from a group");
        assert_eq!(shown.contact, None);
        assert_eq!(shown.fingerprint, fingerprint_of(&juan));
        assert_eq!(shown.shared_groups.len(), 1);
        assert!(!shown.shared_groups[0].i_administer && !shown.shared_groups[0].they_administer);
        let view = block(&mut inner, &target, BlockOrigin::Group, NOW).unwrap();

        assert_eq!(view.key, ik(&juan));
        assert_eq!(view.from, BlockOrigin::Group);
        assert_eq!(list(&inner), [view]);
        // The admin's next roster does not make him a contact.
        let v2 = group::set_group_name(&roster, &admin, "otro").unwrap();
        ingest_incoming_roster(&mut inner, v2, "admin", &ik(&admin), &ik(&me), NOW);
        assert_eq!(inner.friends.len(), 1);
        // Unknown ones are not found.
        let nobody = BlockTarget::Member {
            gid,
            ik_sign: ik(&create_identity()),
        };
        assert_eq!(
            block(&mut inner, &nobody, BlockOrigin::Group, NOW)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
        assert_eq!(
            block(&mut inner, &contact("nadie"), BlockOrigin::Contact, NOW)
                .unwrap_err()
                .code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn ur2_a_member_who_is_a_contact_is_blocked_as_that_contact() {
        let (me, admin, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana-del-grupo")]);
        let gid = roster.group_id.clone();
        let mut inner = me_with(&me, &[(&admin, "admin"), (&ana, "ana")]);
        inner.groups.insert(gid.clone(), roster);

        let target = BlockTarget::Member {
            gid,
            ik_sign: ik(&ana),
        };
        let shown = preview(&inner, &target).unwrap();
        assert_eq!(shown.contact.as_deref(), Some("ana"));
        assert_eq!(shown.label, "ana");
        let view = block(&mut inner, &target, BlockOrigin::Group, NOW).unwrap();
        assert_eq!(view.contact.as_deref(), Some("ana"));
        assert!(friend_blocked(&inner, &inner.friends["ana"]));
    }

    #[test]
    fn ur2_the_confirmation_names_the_groups_you_share_and_who_administers_them() {
        let (me, ana) = (create_identity(), create_identity());
        let mine = roster_of(&me, &[(&ana, "ana")]);
        let hers = roster_of(&ana, &[(&me, "me")]);
        let other = roster_of(&me, &[]);
        let mut inner = me_with(&me, &[(&ana, "ana")]);
        for roster in [&mine, &hers, &other] {
            inner.groups.insert(roster.group_id.clone(), roster.clone());
        }

        let mut shared = preview(&inner, &contact("ana")).unwrap().shared_groups;
        shared.sort_by_key(|g| g.i_administer);

        assert_eq!(shared.len(), 2, "not the group without her");
        assert_eq!(shared[0].gid, hers.group_id);
        assert!(shared[0].they_administer && !shared[0].i_administer);
        assert_eq!(shared[1].gid, mine.group_id);
        assert!(shared[1].i_administer && !shared[1].they_administer);
        assert_eq!(shared[1].name, "amigos");
    }

    // ---- Design test 12: unblocking ----

    #[test]
    fn ur2_12_unblocking_runs_the_merge_of_the_groups_you_share_again() {
        let (me, admin, eve) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&eve, "eve")]);
        let gid = roster.group_id.clone();
        let mut inner = me_with(&me, &[(&admin, "admin"), (&eve, "eve")]);
        inner.groups.insert(gid, roster);
        block(&mut inner, &contact("eve"), BlockOrigin::Contact, NOW).unwrap();
        inner.friends.remove("eve");

        let view = unblock(&mut inner, &ik(&eve), NOW).unwrap();

        assert_eq!(view.label, "eve");
        assert!(inner.blocked.is_empty());
        let eve_again = inner
            .friends
            .values()
            .find(|f| f.bundle.ik_sign_pub == ik(&eve));
        assert!(
            eve_again.is_some_and(|f| f.via_group.is_some()),
            "a contact of the group again"
        );
        assert_eq!(
            unblock(&mut inner, &ik(&eve), NOW).unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn ur2_the_list_puts_the_latest_first_and_names_who_is_still_a_contact() {
        let (me, ana, bob) = (create_identity(), create_identity(), create_identity());
        let mut inner = me_with(&me, &[(&ana, "ana"), (&bob, "bob")]);
        block(&mut inner, &contact("ana"), BlockOrigin::Contact, NOW).unwrap();
        block(&mut inner, &contact("bob"), BlockOrigin::Contact, NOW + 5).unwrap();
        inner.friends.remove("ana");

        let shown = list(&inner);

        assert_eq!(shown.len(), 2);
        assert_eq!(shown[0].label, "bob");
        assert_eq!(shown[0].contact.as_deref(), Some("bob"));
        assert_eq!(shown[0].fingerprint, fingerprint_of(&bob));
        assert_eq!(shown[1].label, "ana");
        assert_eq!(shown[1].contact, None);
        // Blocking again keeps when it was first.
        block(&mut inner, &contact("bob"), BlockOrigin::Contact, NOW + 60).unwrap();
        assert_eq!(list(&inner)[0].blocked_at, NOW + 5);
    }

    #[test]
    fn ur2_unblocking_a_contact_by_name_takes_every_entry_that_blocks_it() {
        let (me, ana, bob) = (create_identity(), create_identity(), create_identity());
        let mut inner = me_with(&me, &[(&ana, "ana"), (&bob, "bob")]);
        wrote(&mut inner, "ana");
        block(&mut inner, &contact("ana"), BlockOrigin::Contact, NOW).unwrap();
        // A Nostr key of hers blocked before UR-2, kept apart.
        inner
            .blocked
            .insert(BlockedIdentity::before_ur2(nostr_hex(&ana), None, NOW));
        block(&mut inner, &contact("bob"), BlockOrigin::Contact, NOW).unwrap();

        let gone = unblock_contact(&mut inner, "ana", NOW).unwrap();

        assert_eq!(gone.len(), 2);
        assert!(!friend_blocked(&inner, &inner.friends["ana"]));
        assert!(friend_blocked(&inner, &inner.friends["bob"]));
        assert_eq!(
            unblock_contact(&mut inner, "nadie", NOW).unwrap_err().code,
            ErrorCode::NotFound
        );
        assert!(unblock_contact(&mut inner, "ana", NOW).unwrap().is_empty());
    }

    #[test]
    fn ur2_the_group_says_who_is_blocked_in_it() {
        let (me, admin, juan, ana) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let with_juan = roster_of(&admin, &[(&me, "me"), (&juan, "juan")]);
        let without = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let mut inner = me_with(&me, &[(&admin, "admin"), (&ana, "ana")]);
        for roster in [&with_juan, &without] {
            inner.groups.insert(roster.group_id.clone(), roster.clone());
        }
        let target = BlockTarget::Member {
            gid: with_juan.group_id.clone(),
            ik_sign: ik(&juan),
        };
        block(&mut inner, &target, BlockOrigin::Group, NOW).unwrap();

        let members = crate::groups::members_of(&inner, &with_juan.group_id, &ik(&me)).unwrap();
        let blocked: Vec<&str> = members
            .iter()
            .filter(|m| m.blocked)
            .map(|m| m.roster_handle.as_str())
            .collect();
        assert_eq!(blocked, ["juan"]);
        let groups = crate::groups::list(&inner);
        let flagged: Vec<&str> = groups
            .iter()
            .filter(|g| g.has_blocked)
            .map(|g| g.gid.as_str())
            .collect();
        assert_eq!(flagged, [with_juan.group_id.as_str()]);
    }

    #[test]
    fn ur2_the_list_keeps_what_proves_each_key_in_account_bin() {
        let entry = BlockedIdentity {
            ik_sign: Some("aa".repeat(32)),
            ik_dh: None,
            nostr_pub: Some("bb".repeat(32)),
            unproven: vec!["cc".repeat(32)],
            label: "ana".into(),
            fingerprint: "1A2B".into(),
            blocked_at: NOW,
            from: BlockOrigin::Group,
        };
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "ikSign": "aa".repeat(32),
                "nostrPub": "bb".repeat(32),
                "unproven": ["cc".repeat(32)],
                "label": "ana",
                "fingerprint": "1A2B",
                "blockedAt": NOW,
                "from": "group",
            })
        );
        let back: BlockedIdentity = serde_json::from_value(json).unwrap();
        assert_eq!(back, entry);
    }
}

#[cfg(test)]
mod session_tests {
    //! Design test 7 end to end: what reaches a session from someone it
    //! blocked, through a local test relay.

    use super::*;
    use crate::events::RecordingSink;
    use crate::groups::send_roster;
    use crate::identity::create_identity;
    use crate::nostr::test_relay::{wait_until, Answer, TestRelay};
    use crate::send::{send_group_text, send_text};
    use crate::session::handle_incoming_event;
    use crate::session::tests::{add_session_read_by, friend, roster_of, sending_state, NOW};
    use std::sync::Arc;

    #[tokio::test]
    async fn ur2_7_of_a_blocked_admin_only_the_rosters_of_your_groups_get_through() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (ana_id, bob_id) = (create_identity(), create_identity());
        let ana = sending_state(&ana_id, vec![relay.client().await]).await;
        let bob = sending_state(&bob_id, vec![relay.client().await]).await;
        // Ana administers a group Bob is in, and Bob blocked her.
        let roster = roster_of(&ana_id, &[(&bob_id, "bob")]);
        let gid = roster.group_id.clone();
        {
            let mut a = ana.inner.lock().await;
            let mut b = bob.inner.lock().await;
            let (ratchet, ad) = add_session_read_by(&mut a, &ana_id, &bob_id, "bob");
            b.friends.insert("ana".into(), friend(&ana_id, "ana"));
            b.ratchets.insert("ana".into(), ratchet);
            b.associated_data.insert("ana".into(), ad);
            a.groups.insert(gid.clone(), roster.clone());
            b.groups.insert(gid.clone(), roster.clone());
            let target = BlockTarget::Contact("ana".into());
            block(&mut b, &target, BlockOrigin::Contact, NOW).unwrap();
        }
        let wait = std::time::Duration::from_millis(300);
        send_text(&ana, "bob", "hola".into(), wait).await.unwrap();
        send_group_text(&ana, &gid, "hola grupo".into(), None, wait)
            .await
            .unwrap();
        let renamed = crate::group::set_group_name(&roster, &ana_id, "Familia").unwrap();
        send_roster(&ana, &renamed, &["bob".to_string()]).await;
        let another = roster_of(&ana_id, &[(&bob_id, "bob")]);
        send_roster(&ana, &another, &["bob".to_string()]).await;
        wait_until("the four events", || relay.events().len() == 4).await;

        let sink = RecordingSink::new();
        let resend: crate::profile::Resend = Arc::new(|_| {});
        for event in relay.events() {
            handle_incoming_event(&*sink, &resend, Arc::clone(&bob.inner), event).await;
        }

        let b = bob.inner.lock().await;
        assert!(b.history.is_empty(), "{:?}", b.history.keys());
        assert_eq!(b.groups[&gid].name, "Familia", "her roster applied");
        assert!(b.group_invites.is_empty(), "no invitation of hers");
        assert!(b.profiles.contacts.is_empty(), "nothing of her profile");
        assert_eq!(sink.names(), ["group-updated"]);
    }
}
