//! Contacts of a group, limited (uso responsable UR-3, `Uso responsable/
//! diseno.md` §4.4; P1's D18 brought forward, decision U6): being in a
//! group with you gives nobody a chat apart, calls, your profile or
//! invitations to other groups.
//!
//! A contact a group's roster made (`FriendRecord.via_group`) and that you
//! did not accept (`accepted_at` is `None`) is *limited*:
//!
//! - **What is of the group reaches you as always**: its messages and files
//!   with a `gid`, and its rosters, but only those of groups you are in
//!   (R-08, `groups::ingest_incoming_roster`): a roster of a new group is
//!   dropped, so it cannot invite you anywhere.
//! - **What it sends apart goes to Solicitudes**, without a sound
//!   (`requests::receive_and_tell` with `Via::Group`): its text, its file
//!   and its call, which never rings (R-12). Its keys count as proven: what
//!   came was signed with its Nostr key and read over the session.
//! - **It does not get your profile** (`profile::targets`, R-09), nor is
//!   its own read: its photo shows as initials. Neither is a warning to a
//!   trusted contact of its read.
//! - The UI names it "~name", the name the admin wrote (R-10), and does not
//!   fetch its files in a group by itself.
//!
//! "Agregar a contactos" (`accept`), accepting its request or adding its
//! code puts `accepted_at`. A contact of a group of before UR-3 reads as
//! accepted (`state::ACCEPTED_BEFORE_UR3`).

use crate::call_signal::validate_call_signal;
use crate::command_error::CommandError;
use crate::contacts::not_found;
use crate::envelope::{decode_envelope, Envelope};
use crate::events::EventSink;
use crate::group::{self, GroupRoster};
use crate::groups::shown_group_name;
use crate::requests::{self, Incoming, Item, Via};
use crate::session::{dbg_log, sanitize_file_ref, save_ratchets};
use crate::state::{FriendRecord, InnerState};
use serde_json::Value;

/// Whether `friend` is a contact a group made that you did not accept.
pub fn is_limited(friend: &FriendRecord) -> bool {
    friend.via_group.is_some() && friend.accepted_at.is_none()
}

/// Whether the contact `handle` is limited.
pub fn handle_is_limited(inner: &InnerState, handle: &str) -> bool {
    inner.friends.get(handle).is_some_and(is_limited)
}

/// Whether the identity `ik_sign` is a limited contact.
pub fn identity_is_limited(inner: &InnerState, ik_sign: &str) -> bool {
    inner
        .friends
        .values()
        .any(|friend| friend.bundle.ik_sign_pub == ik_sign && is_limited(friend))
}

/// The types of message of a limited contact that are never read: its
/// profile (R-09) and the warning to a trusted contact.
const NOT_READ: [&str; 3] = ["profile", "alert-reg", "alert-ack"];

/// The hook in `handle_incoming_event` after the block's and before the
/// profile's: whether the message of `friend` ends here because they are a
/// limited contact. What is of a group (a message or a file with a `gid`, a
/// roster) goes on; the rest goes to Solicitudes or is dropped.
pub fn on_message(
    events: &dyn EventSink,
    inner: &mut InnerState,
    friend: &FriendRecord,
    plain: &[u8],
    created_at: i64,
) -> bool {
    if !is_limited(friend) {
        return false;
    }
    if let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(plain) {
        if fields
            .get("ty")
            .and_then(Value::as_str)
            .is_some_and(|ty| NOT_READ.contains(&ty))
        {
            dbg_log("  DROP: a profile or a warning of a contact a group made");
            return true;
        }
    }
    let item = match decode_envelope(plain) {
        Envelope::Group { .. } | Envelope::Roster { .. } | Envelope::File { gid: Some(_), .. } => {
            return false
        }
        Envelope::Text { body, id } => {
            // A resend after an auto-heal repeats the id, as in a chat.
            if !id.is_empty() && !inner.remember_message_id(id) {
                dbg_log("  skip: duplicate message id");
                return true;
            }
            save_ratchets(inner);
            Item::Text {
                text: body,
                at: created_at,
            }
        }
        Envelope::File {
            file, gid: None, ..
        } => Item::File {
            file: sanitize_file_ref(file),
            at: created_at,
        },
        Envelope::Call { call } => match offer(&call) {
            Some(video) => Item::Call {
                video,
                at: created_at,
            },
            // The rest of a call that never rang: nothing to keep.
            None => {
                dbg_log("  DROP: a call signal of a contact a group made");
                return true;
            }
        },
    };
    let Some((via, name)) = where_from(inner, friend) else {
        dbg_log("  DROP: a contact a group made, in no group with you");
        return true;
    };
    let incoming = Incoming {
        bundle: friend.bundle.clone(),
        name,
        via,
        item,
        // It came signed with their Nostr key, over a session whose X3DH
        // took their DH key (R-02).
        nostr_proven: true,
        dh_proven: true,
    };
    let now = chrono::Utc::now().timestamp();
    requests::receive_and_tell(events, inner, incoming, now);
    true
}

/// Whether `call` is a valid offer of a call (not a renegotiation), and
/// whether with video.
fn offer(call: &str) -> Option<bool> {
    validate_call_signal(call).ok()?;
    let signal: Value = serde_json::from_str(call).ok()?;
    let is_offer = signal.get("t").and_then(Value::as_str) == Some("offer")
        && signal.get("renegotiate").and_then(Value::as_bool) != Some(true);
    is_offer.then(|| signal.get("video").and_then(Value::as_bool) == Some(true))
}

/// The group a limited contact writes from, and the name its roster gives
/// them (R-10): the group that made them, if you are both still in it,
/// else the first you share by name.
fn where_from(inner: &InnerState, friend: &FriendRecord) -> Option<(Via, String)> {
    let mine = inner.identity.as_ref().map(crate::groups::my_ik)?;
    let theirs = &friend.bundle.ik_sign_pub;
    let shared =
        |roster: &&GroupRoster| group::is_member(roster, theirs) && group::is_member(roster, &mine);
    let made = friend
        .via_group
        .as_ref()
        .and_then(|gid| inner.groups.get(gid))
        .filter(shared);
    let roster = made.or_else(|| {
        inner
            .groups
            .values()
            .filter(shared)
            .min_by(|a, b| a.name.cmp(&b.name).then(a.group_id.cmp(&b.group_id)))
    })?;
    let name = roster
        .members
        .iter()
        .find(|member| &member.ik_sign_pub == theirs)
        .map(|member| member.handle.clone())
        .unwrap_or_else(|| friend.handle.clone());
    let via = Via::Group {
        gid: roster.group_id.clone(),
        group: shown_group_name(&roster.name),
    };
    Some((via, name))
}

/// "Agregar a contactos": the contact `handle`, a group made, becomes a
/// contact of yours; what its request held moves to its chat. Its name
/// here.
pub fn accept(inner: &mut InnerState, handle: &str, now: i64) -> Result<String, CommandError> {
    let key = inner
        .friends
        .get(handle)
        .map(|friend| friend.bundle.ik_sign_pub.clone())
        .ok_or_else(|| not_found("unknown contact"))?;
    if inner.requests.get(&key).is_some() {
        return requests::accept(inner, &key, now);
    }
    if let Some(friend) = inner.friends.get_mut(handle) {
        friend.accepted_at.get_or_insert(now);
    }
    Ok(handle.to_string())
}

/// The limited contacts among the members of `roster`, by their name here,
/// sorted.
pub fn limited_members(inner: &InnerState, roster: &GroupRoster) -> Vec<String> {
    let mut handles: Vec<String> = inner
        .friends
        .values()
        .filter(|friend| is_limited(friend))
        .filter(|friend| group::is_member(roster, &friend.bundle.ik_sign_pub))
        .map(|friend| friend.handle.clone())
        .collect();
    handles.sort();
    handles
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{encode_envelope, Envelope};
    use crate::group::{self, FileRef};
    use crate::identity::{create_identity, Identity};
    use crate::requests::{Item, Via};
    use crate::session::tests::{
        friend, heard, ik, named, receiving_in_session, roster_of, sealed_event, NOW,
    };
    use crate::session::unix_now;
    use crate::state::{HistItem, ACCEPTED_BEFORE_UR3};

    /// Me, in session with Mara, a contact the group "Familia" made: in a
    /// group with her and Ana, its admin. Mara's side of the session, to
    /// write to me with.
    fn mara_from_familia(
        me: &Identity,
        mara: &Identity,
    ) -> (InnerState, crate::session::tests::Peer, Vec<u8>, String) {
        let ana = create_identity();
        let (mut inner, side, ad) = receiving_in_session(me, mara, "mara");
        let roster = roster_of(&ana, &[(me, "me"), (mara, "mara")]);
        let roster = group::set_group_name(&roster, &ana, "Familia").unwrap();
        let gid = roster.group_id.clone();
        inner.groups.insert(gid.clone(), roster);
        let record = inner.friends.get_mut("mara").unwrap();
        record.via_group = Some(gid.clone());
        record.accepted_at = None;
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        (inner, side, ad, gid)
    }

    fn photo() -> FileRef {
        FileRef {
            url: "https://blossom.example/abc".into(),
            key: "ab".repeat(32),
            sha256: "0".repeat(64),
            mime: "image/jpeg".into(),
            name: "torta.jpg".into(),
            size: 1_200_000,
            thumb: None,
        }
    }

    const OFFER: &str =
        r#"{"t":"offer","callId":"abcdefghijklmnop1234","sdp":"v=0\r\n","video":true}"#;

    #[test]
    fn a_contact_a_group_made_is_limited_until_accepted() {
        let mut record = friend(&create_identity(), "mara");
        assert!(!is_limited(&record), "added with a code");
        record.via_group = Some("g1".into());
        assert!(!is_limited(&record), "a group's, accepted");
        record.accepted_at = None;
        assert!(is_limited(&record));
    }

    /// Design test 20 (U6): a contact of a group of before UR-3 reads as
    /// accepted; one made now keeps `null` and stays limited.
    #[test]
    fn ur3_20_the_contacts_of_a_group_of_before_stay_accepted() {
        let mut record = friend(&create_identity(), "mara");
        record.via_group = Some("g1".into());
        let mut old = serde_json::to_value(&record).unwrap();
        old.as_object_mut().unwrap().remove("acceptedAt");
        let read: FriendRecord = serde_json::from_value(old).unwrap();
        assert_eq!(read.accepted_at, Some(ACCEPTED_BEFORE_UR3));
        assert!(!is_limited(&read));

        record.accepted_at = None;
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(
            json["acceptedAt"],
            serde_json::Value::Null,
            "written as null"
        );
        let back: FriendRecord = serde_json::from_value(json).unwrap();
        assert!(is_limited(&back));
    }

    /// A roster's member becomes a limited contact.
    #[test]
    fn a_member_a_roster_brings_is_not_accepted() {
        let (me, ana, mara) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&ana, &[(&me, "me"), (&mara, "mara")]);
        let mut friends = std::collections::HashMap::new();
        friends.insert("ana".to_string(), friend(&ana, "ana"));
        let blocked = crate::block::BlockList::default();
        crate::groups::merge_group_members(&mut friends, &blocked, &roster, &ik(&me), NOW);
        assert_eq!(friends["mara"].accepted_at, None);
        assert!(is_limited(&friends["mara"]));
        assert!(
            !is_limited(&friends["ana"]),
            "a contact before stays as it was"
        );
    }

    /// Design test 13: her text apart goes to Solicitudes, not to a chat,
    /// and the UI hears only the count.
    #[tokio::test]
    async fn ur3_13_a_text_apart_goes_to_solicitudes_without_a_sound() {
        let (me, mara) = (create_identity(), create_identity());
        let (inner, mut side, ad, gid) = mara_from_familia(&me, &mara);
        let plain = encode_envelope(&Envelope::Text {
            body: "hola, te vi en el grupo".into(),
            id: "m1".into(),
        });
        let at = unix_now();
        let event = sealed_event(&mara, &me, &mut side, &ad, &plain, at);

        let (events, asked, inner) = heard(inner, event).await;

        assert_eq!(events, [named("requests-changed", r#"{"count":1}"#)]);
        assert!(asked.is_empty(), "{asked:?}");
        assert!(inner.history.is_empty(), "{:?}", inner.history.keys());
        let request = inner
            .requests
            .get(&crate::session::tests::ik(&mara))
            .unwrap();
        assert_eq!(
            request.via,
            Via::Group {
                gid,
                group: "Familia".into()
            }
        );
        assert_eq!(request.name, "mara", "the name in the roster");
        assert!(request.nostr_proven && request.dh_proven);
        assert!(
            matches!(&request.items[..], [Item::Text { text, .. }] if text == "hola, te vi en el grupo")
        );
    }

    /// Her file apart waits in the request, not downloaded; what she sends
    /// to the group reaches the group as always.
    #[tokio::test]
    async fn a_file_apart_waits_and_the_group_reaches_the_group() {
        let (me, mara) = (create_identity(), create_identity());
        let (inner, mut side, ad, gid) = mara_from_familia(&me, &mara);
        let apart = encode_envelope(&Envelope::File {
            file: photo(),
            gid: None,
            body: None,
        });
        let to_group = encode_envelope(&Envelope::Group {
            gid: gid.clone(),
            ep: 1,
            body: "así quedó la torta".into(),
        });
        let at = unix_now();
        let first = sealed_event(&mara, &me, &mut side, &ad, &apart, at);
        let second = sealed_event(&mara, &me, &mut side, &ad, &to_group, at);

        let (events, _, inner) = heard(inner, first).await;
        assert_eq!(events, [named("requests-changed", r#"{"count":1}"#)]);
        let (events, _, inner) = heard(inner, second).await;

        assert_eq!(
            events
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["group-message"]
        );
        let convo = crate::session::group_convo(&gid);
        assert_eq!(inner.history.keys().collect::<Vec<_>>(), [&convo]);
        let request = inner.requests.get(&ik(&mara)).unwrap();
        assert!(matches!(&request.items[..], [Item::File { file, .. }] if file.size == 1_200_000));
    }

    /// Design test 16 (R-12): no offer of hers rings; the request says she
    /// tried to call. Nothing else of a call reaches the UI.
    #[tokio::test]
    async fn ur3_16_her_call_never_rings() {
        let (me, mara) = (create_identity(), create_identity());
        let (inner, mut side, ad, _) = mara_from_familia(&me, &mara);
        let at = unix_now();
        let offer = encode_envelope(&Envelope::Call { call: OFFER.into() });
        let bye = encode_envelope(&Envelope::Call {
            call: r#"{"t":"bye","callId":"abcdefghijklmnop1234"}"#.into(),
        });
        let first = sealed_event(&mara, &me, &mut side, &ad, &offer, at);
        let second = sealed_event(&mara, &me, &mut side, &ad, &bye, at);

        let (events, _, inner) = heard(inner, first).await;
        let (more, _, inner) = heard(inner, second).await;

        assert_eq!(events, [named("requests-changed", r#"{"count":1}"#)]);
        assert!(more.is_empty(), "{more:?}");
        let request = inner.requests.get(&ik(&mara)).unwrap();
        assert!(matches!(
            &request.items[..],
            [Item::Call { video: true, .. }]
        ));
    }

    /// Design test 15 (R-09): her profile is not read and ours is not sent
    /// to her, not even when her group message says she lacks it; nor is a
    /// warning to a trusted contact of hers.
    #[tokio::test]
    async fn ur3_15_no_profile_either_way_and_no_warning() {
        let (me, mara) = (create_identity(), create_identity());
        let (mut inner, mut side, ad, gid) = mara_from_familia(&me, &mara);
        inner.profiles.rev = 10;
        let at = unix_now();
        let profile = br#"{"ty":"profile","v":1,"rev":5,"name":"Mara","about":"hola"}"#;
        let grp = format!(
            r#"{{"ty":"grp","gid":"{gid}","ep":1,"body":"hola","prof":{{"v":1,"have":3}}}}"#
        );
        let warning = br#"{"ty":"alert-reg","v":1}"#;
        let events: Vec<_> = [&profile[..], grp.as_bytes(), &warning[..]]
            .iter()
            .map(|plain| sealed_event(&mara, &me, &mut side, &ad, plain, at))
            .collect();

        let mut heard_all = Vec::new();
        let mut asked_all = Vec::new();
        let mut inner = inner;
        for event in events {
            let (events, asked, after) = heard(inner, event).await;
            heard_all.extend(events);
            asked_all.extend(asked);
            inner = after;
        }

        assert!(asked_all.is_empty(), "{asked_all:?}");
        // That her Trino reads profiles is noted, so she gets yours once
        // you accept her; what she shares is not.
        assert_eq!(
            heard_all
                .iter()
                .map(|(name, _)| name.as_str())
                .collect::<Vec<_>>(),
            ["profile-updated", "group-message"]
        );
        assert!(
            inner
                .profiles
                .contacts
                .get("mara")
                .is_none_or(|kept| kept.name.is_none()),
            "her profile was read"
        );
        assert!(inner.requests.is_empty(), "nothing of that is a request");
    }

    /// Design test 15 (R-09): our profile goes to accepted contacts only.
    #[test]
    fn ur3_15_the_profile_goes_to_accepted_contacts_only() {
        let (me, mara) = (create_identity(), create_identity());
        let (mut inner, _, _, _) = mara_from_familia(&me, &mara);
        for handle in ["mara", "ana"] {
            inner
                .profiles
                .contacts
                .entry(handle.into())
                .or_default()
                .caps = crate::profile::PROFILE_V;
        }
        assert_eq!(crate::profile::targets(&mut inner), ["ana"]);
    }

    /// Design test 14 (R-08): her roster of a group you are not in is
    /// dropped and invites you nowhere; Ana's, accepted, still does.
    #[test]
    fn ur3_14_her_roster_of_a_new_group_is_dropped() {
        let (me, mara) = (create_identity(), create_identity());
        let (mut inner, _, _, _) = mara_from_familia(&me, &mara);
        let hers = roster_of(&mara, &[(&me, "me")]);
        let outcome = crate::groups::ingest_incoming_roster(
            &mut inner,
            hers,
            "mara",
            &ik(&mara),
            &ik(&me),
            NOW,
        );
        assert!(
            matches!(outcome, crate::groups::RosterOutcome::Dropped(_)),
            "{outcome:?}"
        );
        assert!(inner.group_invites.is_empty());
    }

    /// A limited admin's roster of a group you are in still applies.
    #[test]
    fn ur3_14_her_roster_of_a_group_you_are_in_applies() {
        let (me, mara) = (create_identity(), create_identity());
        let mut inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };
        let roster = roster_of(&mara, &[(&me, "me")]);
        let gid = roster.group_id.clone();
        inner.groups.insert(gid.clone(), roster.clone());
        let mut record = friend(&mara, "mara");
        record.via_group = Some(gid.clone());
        record.accepted_at = None;
        inner.friends.insert("mara".into(), record);
        let renamed = group::set_group_name(&roster, &mara, "Familia").unwrap();
        let outcome = crate::groups::ingest_incoming_roster(
            &mut inner,
            renamed,
            "mara",
            &ik(&mara),
            &ik(&me),
            NOW,
        );
        assert!(
            matches!(outcome, crate::groups::RosterOutcome::Applied { .. }),
            "{outcome:?}"
        );
        assert_eq!(inner.groups[&gid].name, "Familia");
    }

    /// "Agregar a contactos": accepted, with what her request held in her
    /// chat; without a request, accepted all the same.
    #[tokio::test]
    async fn adding_her_to_contacts_accepts_her_and_moves_her_request() {
        let (me, mara) = (create_identity(), create_identity());
        let (inner, mut side, ad, _) = mara_from_familia(&me, &mara);
        let plain = encode_envelope(&Envelope::Text {
            body: "hola".into(),
            id: "m1".into(),
        });
        let event = sealed_event(&mara, &me, &mut side, &ad, &plain, unix_now());
        let (_, _, mut inner) = heard(inner, event).await;

        assert_eq!(accept(&mut inner, "mara", NOW).unwrap(), "mara");

        assert_eq!(inner.friends["mara"].accepted_at, Some(NOW));
        assert!(inner.requests.is_empty());
        let chat: Vec<&HistItem> = inner.history["mara"].iter().collect();
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].text.as_deref(), Some("hola"));

        let other = create_identity();
        let mut record = friend(&other, "luis");
        record.via_group = Some("g1".into());
        record.accepted_at = None;
        inner.friends.insert("luis".into(), record);
        assert_eq!(accept(&mut inner, "luis", NOW + 1).unwrap(), "luis");
        assert_eq!(inner.friends["luis"].accepted_at, Some(NOW + 1));
        assert!(accept(&mut inner, "nadie", NOW).is_err());
    }

    /// Once accepted, her text goes to her chat as any contact's.
    #[tokio::test]
    async fn once_accepted_her_text_goes_to_her_chat() {
        let (me, mara) = (create_identity(), create_identity());
        let (mut inner, mut side, ad, _) = mara_from_familia(&me, &mara);
        accept(&mut inner, "mara", NOW).unwrap();
        let plain = encode_envelope(&Envelope::Text {
            body: "hola".into(),
            id: "m2".into(),
        });
        let event = sealed_event(&mara, &me, &mut side, &ad, &plain, unix_now());
        let (events, _, inner) = heard(inner, event).await;
        assert_eq!(events[0].0, "message-received");
        assert_eq!(inner.history["mara"].len(), 1);
    }

    #[test]
    fn the_limited_members_of_a_group_by_their_name_here() {
        let (me, mara) = (create_identity(), create_identity());
        let (inner, _, _, gid) = mara_from_familia(&me, &mara);
        assert_eq!(limited_members(&inner, &inner.groups[&gid]), ["mara"]);
        // The group's list and its members say so to the UI.
        let listed = crate::groups::list(&inner);
        assert_eq!(listed[0].limited, ["mara"]);
        let members = crate::groups::members_of(&inner, &gid, &ik(&me)).unwrap();
        let limited: Vec<&str> = members
            .iter()
            .filter(|member| member.limited)
            .map(|member| member.roster_handle.as_str())
            .collect();
        assert_eq!(limited, ["mara"]);
    }
}
