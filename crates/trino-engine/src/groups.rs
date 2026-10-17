//! Groups and handshakes (W8, K9, K10; M4-0c): what a roster a contact
//! sends does here, the invitations it leaves, a group's members matched to
//! contacts by key, and the changes only its admin can make; and the gates
//! a contact's event and handshake pass before anything of them is used.
//!
//! Nothing here changes the protocol: every change is a roster signed the
//! way 0.1.0 already checks and applies.

use crate::command_error::{CommandError, ErrorCode};
use crate::contacts::{check_local_handle, not_found, sealed};
use crate::envelope::{encode_envelope, Envelope};
use crate::events::EventSink;
use crate::group::{self, GroupError, GroupRoster, MemberBundle, RosterDecision};
use crate::identity::{decode_array_32, public_bundle_for, verify_bundle_binding, Identity};
use crate::nostr::{NostrEvent, TRINO_KIND};
use crate::ratchet::{init_responder, RatchetState};
use crate::session::{
    dbg_log, ensure_session_inner, fp, group_convo, sanitize_roster, save_history,
    send_cipher_inner, zeroize_file_ref, WireHandshake, CATCH_UP_WINDOW_SECS, CLOCK_SKEW_SECS,
};
use crate::state::{FriendRecord, GroupInvite, HandshakeMark, InnerState};
use crate::storage::persist_account;
use crate::x3dh::{respond, InitialMessage, X3dhError};
use crate::Engine;
use serde::Serialize;
use std::collections::HashMap;

/// Oldest handshake we accept. Equal to the catch-up window, because that is
/// how far back our subscription legitimately delivers: a peer who started a
/// session while we were offline must still get it accepted, or the messages
/// that follow it are lost. Anything older can only be a replay (relays are
/// free to ignore `since`). Replays inside the window are stopped by the
/// per-contact `HandshakeMark` instead.
pub const HANDSHAKE_MAX_AGE_SECS: i64 = CATCH_UP_WINDOW_SECS;
/// Bound on `HandshakeMark::ek_pubs`.
pub const MAX_SAME_SECOND_HANDSHAKES: usize = 8;

#[derive(Serialize, Clone)]
pub struct GroupUpdatedEvent {
    pub gid: String,
}

/// A pending group invitation, as shown to the user (`group-invite` event and
/// `list_group_invites`).
#[derive(Serialize, Clone)]
pub struct GroupInviteInfo {
    pub gid: String,
    pub name: String,
    pub from_handle: String,
    pub member_count: usize,
    pub received_at: i64,
}

#[derive(Serialize)]
pub struct GroupInfo {
    pub gid: String,
    pub name: String,
    pub epoch: u64,
    pub is_admin: bool,
    pub member_count: usize,
    pub members: Vec<String>,
    /// The admin removed me, or deleted the group (K10): the newest roster
    /// does not list me. The chat stays readable.
    pub ended: bool,
}

/// The notes of `merge_group_members` name members and prefixes of their
/// keys: the log only gets how many there were.
pub fn log_skipped_members(notes: &[String]) {
    if !notes.is_empty() {
        crate::diag::note_with("  group members skipped", &[("count", &notes.len())]);
    }
}

pub fn self_member_bundle(identity: &Identity, handle: &str) -> MemberBundle {
    MemberBundle::from_public_bundle(handle, &public_bundle_for(identity))
}

/// The longest group name shown, in Unicode scalar values.
pub const GROUP_NAME_MAX_CHARS: usize = 128;
/// The name of a group whose own name shows nothing.
pub const GROUP_NAME_FALLBACK: &str = "grupo";

/// A group's name as it is shown (TRN-APP-03): the admin chose it and signed
/// it, so the roster keeps it as it came; what reaches the inbox, the header
/// and the notifications has no control or format character to reorder it.
pub fn shown_group_name(name: &str) -> String {
    crate::profile::shown_name(name, GROUP_NAME_MAX_CHARS, GROUP_NAME_FALLBACK)
}

pub fn group_info(roster: &GroupRoster, my_ik: &str) -> GroupInfo {
    GroupInfo {
        gid: roster.group_id.clone(),
        name: shown_group_name(&roster.name),
        epoch: roster.epoch,
        is_admin: roster.admin_pub == my_ik,
        member_count: roster.members.len(),
        members: roster.members.iter().map(|m| m.handle.clone()).collect(),
        ended: !group::is_member(roster, my_ik),
    }
}

/// What to do with a signature-verified event from a relay, decided before any
/// of its content is looked at.
#[derive(Debug)]
pub enum Admission {
    /// From a contact and not seen before: process it.
    Process(Box<FriendRecord>),
    /// From someone who is not a contact.
    Stranger,
    /// Ignore it; the reason is only for the log.
    Drop(&'static str),
}

/// Checks run in this order, and the event id is remembered only at the very
/// end:
/// 1. kind and recipient (`my_pub`): a relay can feed us a contact's events
///    addressed to someone else, such as group fan-out copies, which could
///    never decrypt and would tear our session down;
/// 2. blocked sender, then contact lookup: the dedup cache is bounded, so
///    letting strangers' events in would let anyone flush it and replay a
///    contact's old events past it.
pub fn admit_event(inner: &mut InnerState, event: &NostrEvent, my_pub: &str) -> Admission {
    if event.kind != TRINO_KIND {
        return Admission::Drop("not a trino event");
    }
    if event.recipient() != Some(my_pub) {
        return Admission::Drop("addressed to someone else");
    }
    if inner.blocked.contains(&event.pubkey) {
        return Admission::Drop("sender is blocked");
    }
    let Some(friend) = inner
        .friends
        .values()
        .find(|f| f.bundle.nostr_pub == event.pubkey)
        .cloned()
    else {
        return Admission::Stranger;
    };
    if !inner.remember_event(event.id.clone()) {
        return Admission::Drop("duplicate event (already seen from another relay)");
    }
    Admission::Process(Box::new(friend))
}

/// Why an incoming handshake was not allowed to (re)start a session.
#[derive(Debug, PartialEq)]
pub enum HandshakeRejection {
    Stale { age: i64 },
    FromTheFuture { ahead: i64 },
    NotNewer { last: i64 },
}

/// Whether a contact's handshake (already signature-checked and pinned) may
/// (re)start a session. `mark` is the newest handshake accepted from that
/// contact. Accepted means: no older than `HANDSHAKE_MAX_AGE_SECS`, no more
/// than `CLOCK_SKEW_SECS` in the future, and newer than `mark` (or from the
/// same second with an ephemeral key not seen yet).
pub fn judge_handshake(
    mark: Option<&HandshakeMark>,
    created_at: i64,
    ek_pub: &str,
    now: i64,
) -> Result<(), HandshakeRejection> {
    let age = now - created_at;
    if age > HANDSHAKE_MAX_AGE_SECS {
        return Err(HandshakeRejection::Stale { age });
    }
    if -age > CLOCK_SKEW_SECS {
        return Err(HandshakeRejection::FromTheFuture { ahead: -age });
    }
    if let Some(mark) = mark {
        let replayed_or_full = created_at == mark.at
            && (mark.ek_pubs.iter().any(|ek| ek == ek_pub)
                || mark.ek_pubs.len() >= MAX_SAME_SECOND_HANDSHAKES);
        if created_at < mark.at || replayed_or_full {
            return Err(HandshakeRejection::NotNewer { last: mark.at });
        }
    }
    Ok(())
}

/// Remember a handshake that `judge_handshake` accepted from `peer`.
pub fn record_handshake(
    marks: &mut HashMap<String, HandshakeMark>,
    peer: &str,
    created_at: i64,
    ek_pub: &str,
) {
    let mark = marks.entry(peer.to_string()).or_default();
    if created_at > mark.at || mark.ek_pubs.is_empty() {
        *mark = HandshakeMark {
            at: created_at,
            ek_pubs: vec![ek_pub.to_string()],
        };
    } else if created_at == mark.at
        && mark.ek_pubs.len() < MAX_SAME_SECOND_HANDSHAKES
        && !mark.ek_pubs.iter().any(|ek| ek == ek_pub)
    {
        mark.ek_pubs.push(ek_pub.to_string());
    }
}

/// Answer a contact's handshake: run X3DH as responder and start our ratchet.
/// Returns the identity after the exchange (it may have consumed a one-time
/// prekey), the ratchet and the associated data.
///
/// The ratchet starts from the signed prekey the handshake actually used,
/// which after a rotation is often a retired one: the peer's ratchet starts
/// from the public half of the prekey in the bundle it cached.
pub fn respond_to_handshake(
    identity: &Identity,
    hs: &WireHandshake,
) -> Result<(Identity, RatchetState, Vec<u8>), X3dhError> {
    let mut identity = identity.clone();
    let resp = respond(
        &mut identity,
        &InitialMessage {
            ik_dh_pub: hs.ik_dh_pub.clone(),
            ek_pub: hs.ek_pub.clone(),
            spk_id: hs.spk_id,
            opk_id: hs.opk_id,
        },
    )?;
    let ratchet = init_responder(resp.master_secret, resp.spk_keypair);
    Ok((identity, ratchet, resp.associated_data))
}

/// Where an incoming roster ended up. Produced by the pure
/// `ingest_incoming_roster`; the caller persists and notifies.
#[derive(Debug, PartialEq)]
pub enum RosterOutcome {
    /// Update applied to a group we are in; `notes` explain skipped members.
    Applied {
        gid: String,
        notes: Vec<String>,
    },
    /// Held as a pending invitation: nothing applied, no contacts created.
    Invited {
        gid: String,
    },
    /// The admin's newer roster for a group we are in does not list us: we
    /// were removed, or the group was deleted (K10). Kept, so the chat stays
    /// readable and the group reads as ended.
    Ended {
        gid: String,
    },
    Dropped(String),
}

/// How many invitations one contact may have waiting at once. Any contact can
/// send us validly signed rosters for groups of their own making.
pub const MAX_PENDING_INVITES_PER_CONTACT: usize = 5;

/// First `n` bytes of `s`, for handle suffixes and notes. Never panics on
/// short or non-ASCII (attacker-controlled) input.
pub fn short_prefix(s: &str, n: usize) -> &str {
    s.get(..n.min(s.len())).unwrap_or("?")
}

/// Pure part of handling a roster that `sender` sent us (see
/// `group::evaluate_incoming_roster` for the rules). An update to a group we
/// are in is applied; a roster for any other group is at most held as a
/// pending invite, which creates no group and no contacts.
pub fn ingest_incoming_roster(
    inner: &mut InnerState,
    roster: GroupRoster,
    sender_handle: &str,
    sender_ik: &str,
    my_ik: &str,
    now: i64,
) -> RosterOutcome {
    let gid = roster.group_id.clone();
    if let Some(current) = inner.groups.get(&gid) {
        return match group::evaluate_incoming_roster(Some(current), &roster, sender_ik, my_ik) {
            RosterDecision::Accept => {
                let roster = sanitize_roster(roster);
                let notes = merge_group_members(&mut inner.friends, &roster, my_ik, now);
                inner.groups.insert(gid.clone(), roster);
                RosterOutcome::Applied { gid, notes }
            }
            RosterDecision::PendingInvite => {
                RosterOutcome::Dropped("invite for a group we are already in".into())
            }
            // K10: the admin's next roster leaves us out: we were removed,
            // or the group was deleted. Kept, so later rosters must be newer
            // still and the chat stays readable; the group reads as ended.
            RosterDecision::Reject(group::RosterRejection::NotAMember)
                if group::accept_roster_update(current, &roster) =>
            {
                inner.groups.insert(gid.clone(), sanitize_roster(roster));
                RosterOutcome::Ended { gid }
            }
            RosterDecision::Reject(why) => RosterOutcome::Dropped(why.to_string()),
        };
    }
    let pending = inner.group_invites.get(&gid).map(|i| &i.roster);
    let is_new = pending.is_none();
    match group::evaluate_incoming_roster(pending, &roster, sender_ik, my_ik) {
        RosterDecision::Reject(why) => RosterOutcome::Dropped(why.to_string()),
        // PendingInvite: a new invitation. Accept: a newer roster for an
        // invitation already waiting, which replaces it.
        RosterDecision::PendingInvite | RosterDecision::Accept => {
            let waiting = inner
                .group_invites
                .values()
                .filter(|i| i.roster.admin_pub == roster.admin_pub)
                .count();
            if is_new && waiting >= MAX_PENDING_INVITES_PER_CONTACT {
                return RosterOutcome::Dropped("too many pending invites from this contact".into());
            }
            inner.group_invites.insert(
                gid.clone(),
                GroupInvite {
                    roster: sanitize_roster(roster),
                    from_handle: sender_handle.to_string(),
                    received_at: now,
                },
            );
            RosterOutcome::Invited { gid }
        }
    }
}

/// Join the group of a pending invite: apply its roster and add its members as
/// contacts. Pure. The invite is consumed whether or not joining succeeds.
pub fn take_group_invite(
    inner: &mut InnerState,
    gid: &str,
    my_ik: &str,
    now: i64,
) -> Result<(GroupRoster, Vec<String>), String> {
    let invite = inner
        .group_invites
        .remove(gid)
        .ok_or("unknown group invite")?;
    if inner.groups.contains_key(gid) {
        return Err("already a member of this group".into());
    }
    // Check again: group_invites.json on disk is not authenticated.
    let roster = invite.roster;
    match group::evaluate_incoming_roster(None, &roster, &roster.admin_pub, my_ik) {
        RosterDecision::PendingInvite => {}
        RosterDecision::Reject(why) => return Err(why.to_string()),
        RosterDecision::Accept => return Err("unexpected roster state".into()),
    }
    let notes = merge_group_members(&mut inner.friends, &roster, my_ik, now);
    inner.groups.insert(gid.to_string(), roster.clone());
    Ok((roster, notes))
}

/// Fill in the `id_sig` of members that lack a valid one (rosters stored before
/// roster v2 carry none) from bundles we hold ourselves: our own, or the stored
/// bundle of the same contact when its DH and Nostr keys match exactly. A
/// member we cannot vouch for is left as is, and the roster builder then
/// refuses the roster rather than sending one every member would reject.
pub fn refresh_member_bindings(
    members: &mut [MemberBundle],
    friends: &HashMap<String, FriendRecord>,
    me: &MemberBundle,
) {
    let mine = me.to_public_bundle();
    for m in members.iter_mut() {
        if verify_bundle_binding(&m.to_public_bundle()) {
            continue;
        }
        let held = std::iter::once(&mine)
            .chain(friends.values().map(|f| &f.bundle))
            .find(|b| {
                b.ik_sign_pub == m.ik_sign_pub
                    && b.ik_dh_pub == m.ik_dh_pub
                    && b.nostr_pub == m.nostr_pub
            });
        if let Some(bundle) = held {
            m.id_sig = bundle.id_sig.clone();
        }
    }
}

/// Handle a roster a contact sent us: apply it, hold it as an invite for the
/// user, or drop it. Persists and notifies the UI; the rules live in
/// `ingest_incoming_roster`.
pub fn accept_incoming_roster(
    events: &dyn EventSink,
    inner: &mut InnerState,
    identity: &Identity,
    sender: &FriendRecord,
    roster: GroupRoster,
) {
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let now = chrono::Utc::now().timestamp();
    match ingest_incoming_roster(
        inner,
        roster,
        &sender.handle,
        &sender.bundle.ik_sign_pub,
        &my_ik,
        now,
    ) {
        RosterOutcome::Applied { gid, notes } => {
            log_skipped_members(&notes);
            let _ = persist_account(inner);
            dbg_log("  OK: roster stored");
            events.emit("group-updated", &GroupUpdatedEvent { gid });
        }
        RosterOutcome::Invited { gid } => {
            let _ = persist_account(inner);
            dbg_log("  OK: group invite held");
            if let Some(invite) = inner.group_invites.get(&gid) {
                events.emit("group-invite", &invite_info(invite));
            }
        }
        RosterOutcome::Ended { gid } => {
            let _ = persist_account(inner);
            dbg_log("  OK: group ended for us");
            events.emit("group-removed", &GroupRemovedEvent { gid });
        }
        RosterOutcome::Dropped(_) => dbg_log("  DROP: roster rejected"),
    }
}

/// Add the members of a group we are in as contacts, so the pairwise fan-out
/// can reach them. Pure; returns one note per member skipped, for the log.
///
/// Never replaces or edits an existing contact. A member is skipped when its
/// own identity key did not sign its keys; when its identity key is already a
/// contact with different DH/Nostr keys (the pinned ones win); when its DH or
/// Nostr key already belongs to another contact (incoming events are matched
/// to contacts by Nostr key); or when no free handle is left for it. A name
/// that cannot name a contact here (`check_local_handle`) is
/// left out of its handle.
pub fn merge_group_members(
    friends: &mut HashMap<String, FriendRecord>,
    roster: &GroupRoster,
    my_ik: &str,
    now: i64,
) -> Vec<String> {
    let mut notes = Vec::new();
    for m in &roster.members {
        if m.ik_sign_pub == my_ik {
            continue;
        }
        let who = short_prefix(&m.ik_sign_pub, 8);
        let bundle = m.to_public_bundle();
        if !verify_bundle_binding(&bundle) {
            notes.push(format!("skip member {who}: keys not bound to its identity"));
            continue;
        }
        if let Some(known) = friends
            .values()
            .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
        {
            if known.bundle.ik_dh_pub != m.ik_dh_pub || known.bundle.nostr_pub != m.nostr_pub {
                notes.push(format!(
                    "skip member {who}: keys differ from contact {:?}",
                    known.handle
                ));
            }
            continue;
        }
        if friends
            .values()
            .any(|f| f.bundle.ik_dh_pub == m.ik_dh_pub || f.bundle.nostr_pub == m.nostr_pub)
        {
            notes.push(format!(
                "skip member {who}: its DH/Nostr key belongs to another contact"
            ));
            continue;
        }
        // The name the member gives itself, if it can name a contact here.
        // One the chats would read as the channel or a group, or with
        // control, format or bidi characters, or showing nothing, is left
        // out as an empty one is: the key tells the member apart.
        let name = match check_local_handle(&m.handle) {
            Ok(()) => m.handle.as_str(),
            Err(_) => "",
        };
        let handle = if name.is_empty() || friends.contains_key(name) {
            format!("{}-{}", name, short_prefix(&m.ik_sign_pub, 4))
        } else {
            name.to_string()
        };
        if friends.contains_key(&handle) {
            notes.push(format!("skip member {who}: handle {handle:?} is taken"));
            continue;
        }
        friends.insert(
            handle.clone(),
            FriendRecord {
                handle,
                bundle,
                added_at: now,
                avatar: None,
                previous_fingerprint: None,
                key_changed_at: None,
                // K9: the group panel tells these apart from contacts the
                // user added with a code.
                via_group: Some(roster.group_id.clone()),
            },
        );
    }
    notes
}

pub fn invite_info(invite: &GroupInvite) -> GroupInviteInfo {
    GroupInviteInfo {
        gid: invite.roster.group_id.clone(),
        name: shown_group_name(&invite.roster.name),
        from_handle: invite.from_handle.clone(),
        member_count: invite.roster.members.len(),
        received_at: invite.received_at,
    }
}

/// `accept_group_invite` on the open session. The invite is consumed either
/// way, and saved with the contacts and the group it brings in one write
/// (design §4.1), so a cut never leaves them half done.
pub fn accept_invite(inner: &mut InnerState, gid: &str, now: i64) -> Result<GroupInfo, String> {
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let joined = take_group_invite(inner, gid, &my_ik, now);
    persist_account(inner)?;
    let (roster, notes) = joined?;
    log_skipped_members(&notes);
    dbg_log("GROUP INVITE accepted");
    Ok(group_info(&roster, &my_ik))
}

/// `create_group` on the open session: a new group, with this identity as
/// its admin and only member.
pub fn create(inner: &mut InnerState, name: &str) -> Result<GroupInfo, String> {
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let handle = inner.handle.clone().unwrap_or_else(|| "me".to_string());
    let me = self_member_bundle(&identity, &handle);
    let roster = group::create_group(&identity, me, name.trim()).map_err(|e| e.to_string())?;
    inner.groups.insert(roster.group_id.clone(), roster.clone());
    persist_account(inner)?;
    Ok(group_info(&roster, &my_ik))
}

/// `list_groups`: the groups of the open session, by name.
pub fn list(inner: &InnerState) -> Vec<GroupInfo> {
    let my_ik = inner
        .identity
        .as_ref()
        .map(|i| hex::encode(i.ik_sign.pub_bytes))
        .unwrap_or_default();
    let mut out: Vec<GroupInfo> = inner
        .groups
        .values()
        .map(|r| group_info(r, &my_ik))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Invitations waiting for the user, oldest first (`list_group_invites`).
pub fn list_invites(inner: &InnerState) -> Vec<GroupInviteInfo> {
    let mut out: Vec<GroupInviteInfo> = inner.group_invites.values().map(invite_info).collect();
    out.sort_by_key(|i| i.received_at);
    out
}

/// Drop a pending invite (`decline_group_invite`). Nothing is sent to the
/// inviter.
pub fn decline_invite(inner: &mut InnerState, gid: &str) -> Result<(), String> {
    if inner.identity.is_none() {
        return Err("vault sealed".to_string());
    }
    inner
        .group_invites
        .remove(gid)
        .ok_or("unknown group invite")?;
    persist_account(inner)
}

/// The admin removed me from a group, or deleted it (K10).
#[derive(Serialize, Clone)]
pub struct GroupRemovedEvent {
    pub gid: String,
}

/// A roster change, signed and ready to go out: the new roster and the
/// contacts it must reach.
#[derive(Debug)]
pub struct RosterChange {
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
pub fn member_fingerprint(member: &MemberBundle) -> String {
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
pub fn members_of(
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

pub fn my_ik(identity: &Identity) -> String {
    hex::encode(identity.ik_sign.pub_bytes)
}

pub fn group_error(error: GroupError) -> CommandError {
    match error {
        GroupError::NotAdmin => CommandError::new(ErrorCode::NotAdmin, error.to_string()),
        other => CommandError::internal(other.to_string()),
    }
}

/// The roster of `gid`, for a change only its admin may make, with every
/// member's own binding filled in from what we hold, as `add_group_member`
/// does: rosters stored before roster v2 lack them, and the core refuses to
/// sign a roster the members would reject.
pub fn admin_roster(
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
pub fn contacts_of(inner: &InnerState, members: &[MemberBundle], me: &str) -> Vec<String> {
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
pub fn plan_removal(
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
pub fn plan_rename(
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
/// only the admin, for every member. Their group ends. 0.1.0 members drop
/// this roster, which does not list them (`NotAMember` in its core), and
/// keep the whole group, with every member still in it.
///
/// Signed here in one go, over the same bytes the core signs
/// (`roster_signing_bytes`) and checked with the core's `validate_roster`:
/// removing the members one at a time would sign, and check every member,
/// once per member.
pub fn plan_deletion(
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
pub fn forget_group(inner: &mut InnerState, gid: &str) -> Result<(), CommandError> {
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

/// The open identity, or `no_vault`.
pub fn open_identity(inner: &InnerState) -> Result<Identity, CommandError> {
    inner.identity.clone().ok_or_else(sealed)
}

/// A roster change goes nowhere without a relay that is up (K3): refuse it,
/// as `offline`, before anything changes here, so the user can try again
/// once connected.
pub fn check_online(inner: &InnerState, change: &RosterChange) -> Result<(), CommandError> {
    let any_up = inner.relays.iter().any(|relay| relay.is_connected());
    if !change.targets.is_empty() && !any_up {
        return Err(CommandError::new(
            ErrorCode::Offline,
            "no relay is connected: the change would reach nobody",
        ));
    }
    Ok(())
}

/// Add the contact `friend_handle` to `gid`: the roster of the next epoch
/// with them, which only the admin can sign, for every member, the new one
/// included. A contact in it already gets the current roster again, so an
/// add that reached nobody can be retried.
pub fn plan_addition(
    inner: &InnerState,
    identity: &Identity,
    gid: &str,
    friend_handle: &str,
) -> Result<RosterChange, CommandError> {
    let friend = inner
        .friends
        .get(friend_handle)
        .ok_or_else(|| not_found("unknown contact"))?;
    let current = inner
        .groups
        .get(gid)
        .ok_or_else(|| not_found("unknown group"))?;
    let roster = if group::is_member(current, &friend.bundle.ik_sign_pub) {
        current.clone()
    } else {
        // A roster stored before roster v2 lacks member id_sigs; fill in
        // what we can vouch for so the re-signed roster is valid.
        let mut current = current.clone();
        let handle = inner.handle.clone().unwrap_or_else(|| "me".to_string());
        let me = self_member_bundle(identity, &handle);
        refresh_member_bindings(&mut current.members, &inner.friends, &me);
        let member = MemberBundle::from_public_bundle(&friend.handle, &friend.bundle);
        group::add_member(&current, identity, member).map_err(group_error)?
    };
    let targets = contacts_of(inner, &roster.members, &my_ik(identity));
    Ok(RosterChange { roster, targets })
}

/// Send `roster` to each of `targets` over its pairwise session, going on
/// past a failure, which is only logged.
pub async fn send_roster(state: &Engine, roster: &GroupRoster, targets: &[String]) {
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
pub async fn apply_and_send(
    state: &Engine,
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
pub async fn add_member(
    state: &Engine,
    gid: &str,
    friend_handle: &str,
    persist: impl FnOnce(&InnerState) -> Result<(), String>,
) -> Result<GroupInfo, CommandError> {
    let plan = |inner: &InnerState, identity: &Identity| {
        plan_addition(inner, identity, gid, friend_handle)
    };
    apply_and_send(state, gid, plan, persist).await
}

/// `remove_group_member` (K10, admin only): the roster without them goes to
/// every member, the removed one included.
pub async fn remove_member(
    state: &Engine,
    gid: String,
    ik_sign_pub: String,
) -> Result<GroupInfo, CommandError> {
    let plan =
        |inner: &InnerState, identity: &Identity| plan_removal(inner, identity, &gid, &ik_sign_pub);
    apply_and_send(state, &gid, plan, persist_account).await
}

/// `rename_group` (K10, admin only).
pub async fn rename(state: &Engine, gid: String, name: String) -> Result<GroupInfo, CommandError> {
    let plan = |inner: &InnerState, identity: &Identity| plan_rename(inner, identity, &gid, &name);
    apply_and_send(state, &gid, plan, persist_account).await
}

/// `leave_group` (K10): forget the group here, without telling anyone.
pub async fn leave(state: &Engine, gid: String) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open_identity(&inner)?;
    forget_group(&mut inner, &gid)?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    save_history(&inner);
    Ok(())
}

/// `delete_group` (K10, admin only): tell every member, then forget it here.
pub async fn delete(state: &Engine, gid: String) -> Result<(), CommandError> {
    let change = {
        let inner = state.inner.lock().await;
        let identity = open_identity(&inner)?;
        let change = plan_deletion(&inner, &identity, &gid)?;
        check_online(&inner, &change)?;
        change
    };
    send_roster(state, &change.roster, &change.targets).await;
    let mut inner = state.inner.lock().await;
    // Gone already if a second delete raced this one: nothing left to do.
    if forget_group(&mut inner, &gid).is_ok() {
        persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        save_history(&inner);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

    /// TRN-APP-03: a group name with bidi or control characters shows
    /// without them, in the group and in its invitation. The roster is kept
    /// as the admin signed it, so it still verifies when it is sent on.
    #[test]
    fn trn_app_03_a_group_name_shows_without_bidi_or_control_characters() {
        let admin = create_identity();
        let name = "amigos\u{202E}lmth.exe\u{7}";
        let roster = group::create_group(&admin, member(&admin, "admin"), name).unwrap();
        let photo = crate::group::FileRef {
            url: "https://blossom.example/abc".into(),
            key: "00".repeat(32),
            sha256: "0".repeat(64),
            mime: "image/png".into(),
            name: "foto\u{202E}gnp.exe".into(),
            size: 1,
            thumb: None,
        };
        let roster = group::set_group_photo(&roster, &admin, Some(photo)).unwrap();
        let kept = sanitize_roster(roster.clone());
        assert!(
            group::verify_roster(&kept),
            "the roster stays as it was signed"
        );
        assert_eq!(group_info(&kept, &ik(&admin)).name, "amigoslmth.exe");
        let invite = GroupInvite {
            roster: kept,
            from_handle: "ana".into(),
            received_at: NOW,
        };
        assert_eq!(invite_info(&invite).name, "amigoslmth.exe");
        let blank =
            group::create_group(&admin, member(&admin, "admin"), "\u{202E}\u{2066}").unwrap();
        assert_eq!(group_info(&blank, &ik(&admin)).name, "grupo");
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
        // Sending only to the members of the new roster would skip bob:
        // this is how he learns it.
        assert_eq!(sorted(change.targets), ["ana", "bob"]);
        assert_eq!(inner.groups[&gid], before, "the command stores it");
    }

    #[test]
    fn adding_signs_the_next_epoch_for_every_member_the_new_one_included() {
        let (admin, me, ana, eve) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let (mut inner, gid) = admin_state(&admin, &[(&ana, "ana")]);
        inner.friends.insert("eve".into(), friend(&eve, "eve"));
        let before = inner.groups[&gid].clone();

        let change = plan_addition(&inner, &admin, &gid, "eve").unwrap();

        assert_eq!(change.roster.epoch, before.epoch + 1);
        assert!(group::is_member(&change.roster, &ik(&eve)));
        assert!(group::verify_roster(&change.roster));
        assert_eq!(sorted(change.targets), ["ana", "eve"]);
        assert_eq!(inner.groups[&gid], before, "the command stores it");

        // A member already: the same roster again, so it can be retried.
        inner.groups.insert(gid.clone(), change.roster.clone());
        let again = plan_addition(&inner, &admin, &gid, "eve").unwrap();
        assert_eq!(again.roster, change.roster);
        assert_eq!(sorted(again.targets), ["ana", "eve"]);

        let unknown_contact = plan_addition(&inner, &admin, &gid, "nadie").unwrap_err();
        let unknown_group = plan_addition(&inner, &admin, "nope", "eve").unwrap_err();
        assert_eq!(unknown_contact.code, ErrorCode::NotFound);
        assert_eq!(unknown_group.code, ErrorCode::NotFound);
        // Only the admin signs a roster with a new member.
        inner.friends.insert("me".into(), friend(&me, "me"));
        let not_admin = plan_addition(&inner, &ana, &gid, "me").unwrap_err();
        assert_eq!(not_admin.code, ErrorCode::NotAdmin);
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

    // ---- From commands.rs (M4-0c): rosters, invitations, and the gates of
    // a contact's events and handshakes ----

    use crate::group::roster_signing_bytes;
    use crate::identity::{ed25519_sign, generate_nostr_keypair, generate_x25519};
    use crate::nostr::build_and_sign_event;
    use crate::ratchet::{init_initiator, ratchet_decrypt, ratchet_encrypt};
    use crate::x3dh::initiate;

    fn state_with(friends: &[FriendRecord]) -> InnerState {
        let mut inner = InnerState::default();
        for f in friends {
            inner.friends.insert(f.handle.clone(), f.clone());
        }
        inner
    }

    /// A roster signed exactly as given, as a hostile admin's client can.
    fn signed_raw(admin: &Identity, members: Vec<MemberBundle>) -> GroupRoster {
        let group_id = hex::encode(crate::crypto::random_array::<32>());
        let admin_pub = ik(admin);
        let bytes = roster_signing_bytes(&group_id, "amigos", &None, &admin_pub, &members, 0);
        GroupRoster {
            group_id,
            name: "amigos".into(),
            photo: None,
            admin_pub,
            members,
            epoch: 0,
            signature: hex::encode(ed25519_sign(&admin.ik_sign, &bytes)),
        }
    }

    /// Alice's identity key with new DH and Nostr keys, validly bound: what a
    /// legitimate re-key would look like.
    fn rekeyed(id: &Identity) -> Identity {
        let mut other = id.clone();
        other.ik_dh = generate_x25519();
        other.nostr = generate_nostr_keypair();
        other
    }

    #[test]
    fn unknown_group_waits_as_an_invite_and_creates_no_contacts() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);

        let out = ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);

        assert_eq!(out, RosterOutcome::Invited { gid: gid.clone() });
        assert!(
            inner.groups.is_empty(),
            "nothing applied before the user accepts"
        );
        assert_eq!(
            inner.friends.len(),
            1,
            "no contacts before the user accepts"
        );
        let invite = inner.group_invites.get(&gid).expect("invite stored");
        assert_eq!(invite.from_handle, "admin");
        assert_eq!(invite.received_at, NOW);
    }

    #[test]
    fn accepting_an_invite_joins_and_adds_bound_members() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);

        let (joined, _notes) = take_group_invite(&mut inner, &gid, &ik(&me), NOW).unwrap();

        assert_eq!(joined.group_id, gid);
        assert!(inner.groups.contains_key(&gid));
        assert!(inner.group_invites.is_empty());
        let ana_contact = inner.friends.get("ana").expect("ana added on accept");
        assert_eq!(ana_contact.bundle.ik_sign_pub, ik(&ana));
        assert!(verify_bundle_binding(&ana_contact.bundle));
        assert!(
            take_group_invite(&mut inner, &gid, &ik(&me), NOW).is_err(),
            "an invite is taken once"
        );
    }

    #[test]
    fn a_newer_roster_refreshes_a_pending_invite() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let v2 = group::add_member(&v1, &admin, member(&ana, "ana")).unwrap();
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        let admin_ik = ik(&admin);

        let first =
            ingest_incoming_roster(&mut inner, v1.clone(), "admin", &admin_ik, &ik(&me), NOW);
        let second =
            ingest_incoming_roster(&mut inner, v2.clone(), "admin", &admin_ik, &ik(&me), NOW);
        let stale = ingest_incoming_roster(&mut inner, v1, "admin", &admin_ik, &ik(&me), NOW);

        assert_eq!(first, RosterOutcome::Invited { gid: gid.clone() });
        assert_eq!(second, RosterOutcome::Invited { gid: gid.clone() });
        assert!(matches!(stale, RosterOutcome::Dropped(_)));
        assert_eq!(inner.group_invites[&gid].roster.epoch, v2.epoch);
        assert!(inner.groups.is_empty());
        assert_eq!(inner.friends.len(), 1);
    }

    #[test]
    fn roster_relayed_by_a_non_admin_is_dropped() {
        let (admin, juan, me) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&juan, "juan"), (&me, "me")]);
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin"), friend(&juan, "juan")]);

        let out = ingest_incoming_roster(&mut inner, v1.clone(), "juan", &ik(&juan), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert!(inner.groups.is_empty() && inner.group_invites.is_empty());

        // Same for an update to a group we are already in.
        let v2 = group::add_member(&v1, &admin, member(&create_identity(), "ana")).unwrap();
        inner.groups.insert(gid.clone(), v1.clone());
        let out = ingest_incoming_roster(&mut inner, v2, "juan", &ik(&juan), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.groups[&gid].epoch, v1.epoch);
        assert_eq!(inner.friends.len(), 2);
    }

    #[test]
    fn update_from_the_admin_to_a_joined_group_is_applied() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let v2 = group::add_member(&v1, &admin, member(&ana, "ana")).unwrap();
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        inner.groups.insert(gid.clone(), v1);

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
        assert!(inner.friends.contains_key("ana"));
    }

    #[test]
    fn mallory_cannot_plant_a_fake_alice() {
        // C1 at the app layer: Mallory's own group lists "alice" with Alice's
        // real identity key and Mallory2's transport keys.
        let (mallory, me, alice, mallory2) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let m2 = public_bundle_for(&mallory2);
        let mut fake_alice = member(&alice, "alice");
        fake_alice.ik_dh_pub = m2.ik_dh_pub;
        fake_alice.nostr_pub = m2.nostr_pub;
        let roster = signed_raw(
            &mallory,
            vec![member(&mallory, "mallory"), member(&me, "me"), fake_alice],
        );
        let mut inner = state_with(&[friend(&mallory, "mallory")]);

        let out =
            ingest_incoming_roster(&mut inner, roster, "mallory", &ik(&mallory), &ik(&me), NOW);

        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.friends.len(), 1);
        assert!(inner.groups.is_empty() && inner.group_invites.is_empty());
    }

    #[test]
    fn merge_skips_members_whose_keys_are_not_bound() {
        // Defense in depth below roster validation: merge is given a roster
        // that never went through it.
        let (alice, mallory2) = (create_identity(), create_identity());
        let m2 = public_bundle_for(&mallory2);
        let mut fake_alice = member(&alice, "alice");
        fake_alice.ik_dh_pub = m2.ik_dh_pub;
        fake_alice.nostr_pub = m2.nostr_pub;
        let roster = signed_raw(&mallory2, vec![fake_alice]);
        let mut friends = HashMap::new();

        let notes = merge_group_members(&mut friends, &roster, "not-a-member", NOW);

        assert!(friends.is_empty());
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_replaces_a_contact_and_flags_changed_keys() {
        let alice = create_identity();
        let stored = friend(&alice, "alice");
        let mut friends = HashMap::from([("alice".to_string(), stored.clone())]);

        // Same identity, same keys: nothing to do, nothing to report.
        let same = signed_raw(&alice, vec![member(&alice, "alice")]);
        assert!(merge_group_members(&mut friends, &same, "me", NOW).is_empty());

        // Same identity key, different transport keys: keep what we have.
        let other_keys = signed_raw(&alice, vec![member(&rekeyed(&alice), "alice-new")]);
        let notes = merge_group_members(&mut friends, &other_keys, "me", NOW);

        assert_eq!(friends.len(), 1);
        assert_eq!(friends["alice"].bundle.ik_dh_pub, stored.bundle.ik_dh_pub);
        assert_eq!(friends["alice"].bundle.nostr_pub, stored.bundle.nostr_pub);
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_skips_members_reusing_a_contacts_transport_keys() {
        let alice = create_identity();
        let mut shadow = create_identity();
        shadow.ik_dh = alice.ik_dh.clone();
        shadow.nostr = alice.nostr.clone();
        let roster = signed_raw(&shadow, vec![member(&shadow, "alice2")]);
        let mut friends = HashMap::from([("alice".to_string(), friend(&alice, "alice"))]);

        let notes = merge_group_members(&mut friends, &roster, "me", NOW);

        assert_eq!(friends.len(), 1);
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_overwrites_on_a_handle_collision() {
        let (bob, carol, dave) = (create_identity(), create_identity(), create_identity());
        let taken = format!("bob-{}", &ik(&carol)[..4]);
        let mut friends = HashMap::from([
            ("bob".to_string(), friend(&bob, "bob")),
            (taken.clone(), friend(&dave, &taken)),
        ]);
        let roster = signed_raw(&carol, vec![member(&carol, "bob")]);

        let notes = merge_group_members(&mut friends, &roster, "me", NOW);

        assert_eq!(friends.len(), 2);
        assert_eq!(friends[&taken].bundle.ik_sign_pub, ik(&dave));
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_names_a_member_as_the_channel_or_a_group() {
        // The names members give themselves in a roster: here the chats
        // would read them as the announcements channel or as a group, and a
        // bidi control would reorder the list. The key tells them apart.
        let (admin, me, a, b, c, d) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let roster = roster_of(
            &admin,
            &[
                (&me, "me"),
                (&a, "channel"),
                (&b, "grp:4f1c"),
                (&c, "Ana\u{202E}"),
                (&d, "   "),
            ],
        );
        let mut friends = HashMap::new();

        let notes = merge_group_members(&mut friends, &roster, &ik(&me), NOW);

        assert!(notes.is_empty(), "{notes:?}");
        let handle_of = |id: &Identity| {
            friends
                .values()
                .find(|f| f.bundle.ik_sign_pub == ik(id))
                .map(|f| f.handle.clone())
        };
        for id in [&a, &b, &c, &d] {
            assert_eq!(handle_of(id), Some(format!("-{}", &ik(id)[..4])));
        }
        assert_eq!(handle_of(&admin).as_deref(), Some("admin"));
        assert!(friends
            .keys()
            .all(|handle| check_local_handle(handle).is_ok()));
    }

    #[test]
    fn pending_invites_per_contact_are_capped() {
        let (admin, me) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&admin, "admin")]);
        for _ in 0..MAX_PENDING_INVITES_PER_CONTACT {
            let roster = roster_of(&admin, &[(&me, "me")]);
            let out =
                ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);
            assert!(matches!(out, RosterOutcome::Invited { .. }), "{out:?}");
        }
        let one_more = roster_of(&admin, &[(&me, "me")]);
        let out = ingest_incoming_roster(&mut inner, one_more, "admin", &ik(&admin), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.group_invites.len(), MAX_PENDING_INVITES_PER_CONTACT);
    }

    #[test]
    fn refresh_member_bindings_restores_id_sig_from_what_we_hold() {
        // Rosters stored before roster v2 have no id_sig. When we rebuild one
        // (as admin), fill them in from our identity and matching contacts.
        let (admin, juan, ana) = (create_identity(), create_identity(), create_identity());
        let me = member(&admin, "me");
        let mut members = vec![me.clone(), member(&juan, "juan"), member(&ana, "ana")];
        for m in &mut members {
            m.id_sig.clear();
        }
        let friends = HashMap::from([
            ("juan".to_string(), friend(&juan, "juan")),
            // A contact whose keys no longer match the roster entry.
            ("ana".to_string(), friend(&rekeyed(&ana), "ana")),
        ]);

        refresh_member_bindings(&mut members, &friends, &me);

        assert_eq!(members[0].id_sig, me.id_sig);
        assert_eq!(members[1].id_sig, public_bundle_for(&juan).id_sig);
        assert!(
            members[2].id_sig.is_empty(),
            "never borrow a binding for other keys"
        );
    }

    // ---- Admission of relay events (M1, H2 event cache) ----

    fn nostr_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    fn event_to(sender: &Identity, to: &str, kind: u32, created_at: i64) -> NostrEvent {
        build_and_sign_event(
            &sender.nostr.priv_bytes,
            &sender.nostr.pub_bytes,
            kind,
            "{}",
            vec![vec!["p".to_string(), to.to_string()]],
            Some(created_at),
        )
        .unwrap()
    }

    #[test]
    fn a_contacts_event_is_admitted_once() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&me), TRINO_KIND, NOW);

        let first = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(
            matches!(&first, Admission::Process(f) if f.handle == "alice"),
            "{first:?}"
        );
        let again = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(again, Admission::Drop(_)), "{again:?}");
    }

    #[test]
    fn a_contacts_event_addressed_to_someone_else_is_dropped() {
        // A group fan-out copy meant for another member, fed to us by a relay:
        // trying to decrypt it would fail and tear our session down.
        let (me, alice, carol) = (create_identity(), create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&carol), TRINO_KIND, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    #[test]
    fn a_contacts_event_of_another_kind_is_dropped() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&me), 1, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    #[test]
    fn strangers_events_never_enter_the_seen_cache() {
        // Otherwise anyone can flush the bounded cache and replay our contacts'
        // old events.
        let (me, stranger) = (create_identity(), create_identity());
        let mut inner = state_with(&[]);
        for n in 0..3 {
            let event = event_to(&stranger, &nostr_hex(&me), TRINO_KIND, NOW + n);
            let out = admit_event(&mut inner, &event, &nostr_hex(&me));
            assert!(matches!(out, Admission::Stranger), "{out:?}");
        }
        assert!(inner.seen_events.is_empty());
        assert!(inner.seen_event_order.is_empty());
    }

    #[test]
    fn blocked_contacts_events_never_enter_the_seen_cache() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        inner.blocked.insert(nostr_hex(&alice));
        let event = event_to(&alice, &nostr_hex(&me), TRINO_KIND, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    // ---- Handshake replay gate (H2) ----

    #[test]
    fn a_stale_handshake_is_rejected() {
        let created_at = NOW - HANDSHAKE_MAX_AGE_SECS - 1;
        assert_eq!(
            judge_handshake(None, created_at, "ek", NOW),
            Err(HandshakeRejection::Stale {
                age: HANDSHAKE_MAX_AGE_SECS + 1
            })
        );
    }

    #[test]
    fn a_handshake_from_the_future_is_rejected() {
        let created_at = NOW + CLOCK_SKEW_SECS + 1;
        assert_eq!(
            judge_handshake(None, created_at, "ek", NOW),
            Err(HandshakeRejection::FromTheFuture {
                ahead: CLOCK_SKEW_SECS + 1
            })
        );
    }

    #[test]
    fn a_handshake_older_than_the_last_accepted_one_is_rejected() {
        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-new");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 200, "ek-old", NOW),
            Err(HandshakeRejection::NotNewer { last: NOW - 100 })
        );
    }

    #[test]
    fn the_accepted_handshake_cannot_be_replayed() {
        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-1");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 100, "ek-1", NOW),
            Err(HandshakeRejection::NotNewer { last: NOW - 100 })
        );
    }

    #[test]
    fn a_fresh_newer_handshake_is_accepted() {
        assert_eq!(judge_handshake(None, NOW - 30, "ek-0", NOW), Ok(()));

        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-1");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 50, "ek-2", NOW),
            Ok(())
        );
        // A second genuine handshake within the same second is not a replay.
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 100, "ek-2", NOW),
            Ok(())
        );
        // Marks are per contact.
        assert_eq!(
            judge_handshake(marks.get("bob"), NOW - 200, "ek-1", NOW),
            Ok(())
        );
    }

    #[test]
    fn handshakes_in_one_second_are_bounded() {
        let mut marks = HashMap::new();
        for n in 0..MAX_SAME_SECOND_HANDSHAKES {
            let ek = format!("ek-{n}");
            assert_eq!(judge_handshake(marks.get("alice"), NOW, &ek, NOW), Ok(()));
            record_handshake(&mut marks, "alice", NOW, &ek);
        }
        assert!(judge_handshake(marks.get("alice"), NOW, "ek-extra", NOW).is_err());
        assert_eq!(marks["alice"].ek_pubs.len(), MAX_SAME_SECOND_HANDSHAKES);
    }

    // ---- Responder ratchet after a prekey rotation (H1) ----

    #[test]
    fn a_handshake_from_a_bundle_cached_before_rotation_decrypts() {
        let alice = create_identity();
        let mut bob = create_identity();
        let cached = public_bundle_for(&bob);
        let rotate_at = bob.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;
        assert!(crate::identity::rotate_signed_prekey_if_due(
            &mut bob, rotate_at
        ));

        // Alice opens a session from the bundle she cached, as connect_node does.
        let init = initiate(&alice, &cached).unwrap();
        let spk_pub = decode_array_32(&cached.spk_pub).unwrap();
        let mut alice_ratchet = init_initiator(init.master_secret, spk_pub).unwrap();
        let first = ratchet_encrypt(
            &mut alice_ratchet,
            b"__trino_handshake__",
            &init.associated_data,
        )
        .unwrap();
        let hs = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };

        let (_bob, mut bob_ratchet, ad) = respond_to_handshake(&bob, &hs).unwrap();
        let plain = ratchet_decrypt(&mut bob_ratchet, &first, &ad)
            .expect("the first message of the new session must decrypt");
        assert_eq!(plain, b"__trino_handshake__");
    }
}
