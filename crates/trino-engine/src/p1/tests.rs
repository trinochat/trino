//! P1-8: two sessions talk through their mailboxes, event by event, with no
//! relay in between.

use super::*;
use crate::device::tests::own_device_of;
use crate::identity::{create_identity, Identity};
use crate::session::tests::friend;
use trino_core::p1::event::mailbox_of;

pub(crate) const NOW: i64 = 1_793_000_000;

/// One side: its session state and its identity of today.
pub(crate) struct Person {
    pub inner: InnerState,
    pub v1: Identity,
}

pub(crate) fn person() -> Person {
    let v1 = create_identity();
    let inner = InnerState {
        identity: Some(v1.clone()),
        device: Some(own_device_of(&v1, NOW)),
        ..Default::default()
    };
    Person { inner, v1 }
}

impl Person {
    pub(crate) fn device(&self) -> &OwnDevice {
        self.inner.device.as_ref().unwrap()
    }

    /// Adds `other` as the contact `handle`, as its code of before P1 does;
    /// with `bundle`, its list and prekeys too.
    pub(crate) fn add(&mut self, handle: &str, other: &Person, bundle: Option<DeviceBundle>) {
        self.inner
            .friends
            .insert(handle.to_string(), friend(&other.v1, handle));
        if let Some(bundle) = bundle {
            take_bundle(&mut self.inner, handle, bundle, NOW as u64).unwrap();
        }
    }

    fn has_p1_session(&self, handle: &str) -> bool {
        self.inner
            .ratchets
            .get(handle)
            .is_some_and(RatchetState::is_p1)
    }
}

/// Ana and Bea, contacts of each other. Ana holds Bea's full bundle (a
/// normal handshake) or her compact one (PQ-11); Bea holds nothing of Ana's
/// account yet.
pub(crate) fn ana_and_bea(full: bool) -> (Person, Person) {
    let mut ana = person();
    let mut bea = person();
    let hers = if full {
        bea.device().full_bundle()
    } else {
        bea.device().compact_bundle()
    };
    ana.add("bea", &bea, Some(hers));
    bea.add("ana", &ana, None);
    (ana, bea)
}

/// An admitted event: its contact, envelope, time, whether it started a
/// session, and the replies.
type Admitted = (
    String,
    Option<Zeroizing<Vec<u8>>>,
    i64,
    bool,
    Vec<NostrEvent>,
);

/// What an event was, or a panic with the reason it was dropped.
fn contact(opened: Opened) -> Admitted {
    match opened {
        Opened::Contact {
            handle,
            envelope,
            ts,
            established,
            replies,
        } => (handle, envelope, ts, established, replies),
        Opened::Drop(why) => panic!("dropped: {why}"),
    }
}

fn dropped(opened: Opened) -> &'static str {
    match opened {
        Opened::Drop(why) => why,
        Opened::Contact { .. } => panic!("admitted"),
    }
}

/// Ana and Bea with a session, after the handshake and its replies.
pub(crate) fn talking(full: bool) -> (Person, Person) {
    let (mut ana, mut bea) = ana_and_bea(full);
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    let (_, _, _, _, replies) = contact(open(&mut bea.inner, &hello, NOW + 5));
    let mut back = Vec::new();
    for reply in &replies {
        let (_, _, _, _, more) = contact(open(&mut ana.inner, reply, NOW + 10));
        back.extend(more);
    }
    for event in &back {
        contact(open(&mut bea.inner, event, NOW + 15));
    }
    (ana, bea)
}

#[test]
fn a_normal_handshake_gives_both_sides_one_session_and_their_lists() {
    let (mut ana, mut bea) = ana_and_bea(true);
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    assert_eq!(hello.kind, KIND_MESSAGE);
    // To Bea's introduction mailbox of the day, and to nothing else.
    let intro = outgoing_intro(
        ana.device().dev_dh(),
        &bea.device().dev_dh().pub_bytes,
        epoch_of(NOW as u64),
    )
    .unwrap();
    assert_eq!(mailbox_of(&hello.clone().into()), Some(intro.tag));
    // Ana can write at once, on the new session.
    assert!(ana.has_p1_session("bea"));

    let (handle, envelope, ts, established, replies) =
        contact(open(&mut bea.inner, &hello, NOW + 5));
    assert_eq!(handle, "ana");
    assert!(envelope.is_none(), "message 0 carries no text");
    assert_eq!(ts, NOW);
    assert!(established);
    assert!(bea.has_p1_session("ana"));
    // Bea took Ana's list from message 0, pinned to the ik_sign she had.
    let devices = bea.inner.friends["ana"].devices.as_ref().unwrap();
    assert_eq!(devices.chain.current(), &ana.device().list);
    // Her first reply brings her list.
    assert_eq!(replies.len(), 1);

    let (handle, envelope, _, _, back) = contact(open(&mut ana.inner, &replies[0], NOW + 10));
    assert_eq!(handle, "bea");
    assert!(envelope.is_none());
    assert!(!ana.inner.mailboxes.unverified.contains("bea"));
    // Ana owes Bea her full list (Bea only has the compact one).
    assert_eq!(back.len(), 1);
    contact(open(&mut bea.inner, &back[0], NOW + 15));
    let held = &bea.inner.friends["ana"].devices.as_ref().unwrap().bundle;
    assert!(held.pq_spks.is_some());
}

#[test]
fn a_message_goes_both_ways_with_its_time() {
    for full in [true, false] {
        let (mut ana, mut bea) = talking(full);
        let event = seal(
            &mut ana.inner,
            "bea",
            br#"{"ty":"text","body":"hola"}"#,
            None,
            KIND_MESSAGE,
            NOW + 60,
        )
        .unwrap();
        let (handle, envelope, ts, established, replies) =
            contact(open(&mut bea.inner, &event, NOW + 70));
        assert_eq!(handle, "ana");
        assert_eq!(
            envelope.as_deref().map(Vec::as_slice),
            Some(&br#"{"ty":"text","body":"hola"}"#[..])
        );
        assert_eq!(ts, NOW + 60);
        assert!(!established);
        assert!(replies.is_empty());

        let event = seal(
            &mut bea.inner,
            "ana",
            br#"{"ty":"text","body":"que tal"}"#,
            None,
            KIND_MESSAGE,
            NOW + 80,
        )
        .unwrap();
        let (handle, envelope, ..) = contact(open(&mut ana.inner, &event, NOW + 90));
        assert_eq!(handle, "bea");
        assert_eq!(
            envelope.as_deref().map(Vec::as_slice),
            Some(&br#"{"ty":"text","body":"que tal"}"#[..])
        );
    }
}

#[test]
fn pq11_sends_no_text_until_the_kem_reply_comes() {
    let (mut ana, mut bea) = ana_and_bea(false);
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    // No session yet: only the KEM reply opens one.
    assert!(!ana.has_p1_session("bea"));
    assert_eq!(
        seal(&mut ana.inner, "bea", b"{}", None, KIND_MESSAGE, NOW + 1).unwrap_err(),
        SendError::Pending
    );

    let (_, envelope, _, established, replies) = contact(open(&mut bea.inner, &hello, NOW + 5));
    assert!(envelope.is_none());
    assert!(established);
    assert!(bea.has_p1_session("ana"));
    // The type 4 (to Ana's introduction mailbox) and Bea's full list.
    assert_eq!(replies.len(), 2);
    let intro = outgoing_intro(
        bea.device().dev_dh(),
        &ana.device().dev_dh().pub_bytes,
        epoch_of((NOW + 5) as u64),
    )
    .unwrap();
    assert_eq!(mailbox_of(&replies[0].clone().into()), Some(intro.tag));

    let (_, _, _, established, back) = contact(open(&mut ana.inner, &replies[0], NOW + 10));
    assert!(established);
    assert!(ana.has_p1_session("bea"));
    assert!(ana.inner.mailboxes.pq11.is_empty());
    // Bea's full list, then: Ana now holds her post-quantum prekey.
    contact(open(&mut ana.inner, &replies[1], NOW + 11));
    assert!(ana.inner.friends["bea"]
        .devices
        .as_ref()
        .unwrap()
        .bundle
        .pq_spks
        .is_some());
    for event in &back {
        contact(open(&mut bea.inner, event, NOW + 12));
    }
    let event = seal(
        &mut ana.inner,
        "bea",
        b"{\"ty\":\"x\"}",
        None,
        KIND_MESSAGE,
        NOW + 20,
    )
    .unwrap();
    contact(open(&mut bea.inner, &event, NOW + 21));
}

#[test]
fn a_pq11_handshake_waiting_for_its_reply_is_kept() {
    let (mut ana, _bea) = ana_and_bea(false);
    initiate(&mut ana.inner, "bea", NOW).unwrap();
    let kept = serde_json::to_string(&ana.inner.mailboxes).unwrap();
    let back: crate::mailboxes::MailboxState = serde_json::from_str(&kept).unwrap();
    assert_eq!(back, ana.inner.mailboxes);
    assert!(back.pq11.contains_key("bea"));
}

#[test]
fn the_responder_keeps_nothing_unless_message_0_opens_and_its_list_names_the_device() {
    // Ana's list is replaced by another account's: Bea pinned Ana's ik_sign.
    let (mut ana, mut bea) = ana_and_bea(true);
    let stranger = person();
    ana.inner.device.as_mut().unwrap().list = stranger.device().list.clone();
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    dropped(open(&mut bea.inner, &hello, NOW + 5));
    assert!(bea.inner.ratchets.is_empty());
    assert!(bea.inner.associated_data.is_empty());
    assert!(bea.inner.friends["ana"].devices.is_none());

    // A list of Ana's account that does not name the device that shook hands.
    let (mut ana, mut bea) = ana_and_bea(true);
    let mut other = ana.v1.clone();
    other.ik_dh = create_identity().ik_dh;
    ana.inner.device.as_mut().unwrap().list = own_device_of(&other, NOW).list;
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    dropped(open(&mut bea.inner, &hello, NOW + 5));
    assert!(bea.inner.ratchets.is_empty());
}

#[test]
fn the_initiator_drops_a_session_whose_first_reply_does_not_check() {
    let (mut ana, mut bea) = ana_and_bea(true);
    let hello = initiate(&mut ana.inner, "bea", NOW).unwrap();
    // Bea answers with a list of her account that does not name her
    // device (another one of the same account, with the same gen and seq).
    let sibling = trino_core::identity_v2::IdentityV2 {
        device: trino_core::identity_v2::DeviceIdentity::generate_with_rng(NOW, &mut drbg()),
        account: bea.device().identity.account.clone(),
    };
    let (other_list, _) = crate::device::list_for(&sibling, None, NOW).unwrap();
    bea.inner.device.as_mut().unwrap().list = other_list;
    let (.., replies) = contact(open(&mut bea.inner, &hello, NOW + 5));
    dropped(open(&mut ana.inner, &replies[0], NOW + 10));
    assert!(!ana.has_p1_session("bea"));
}

#[test]
fn admission_drops_what_is_not_for_this_session() {
    let (mut ana, mut bea) = talking(true);
    // A mailbox nobody here listens to.
    let elsewhere = seal_p1(KIND_MESSAGE, NOW, &[7; 32], &[0u8; 1024]).unwrap();
    assert_eq!(
        dropped(open(&mut bea.inner, &elsewhere, NOW)),
        "unknown mailbox"
    );

    // Another key for the MAC: dropped, and Bea's session does not move.
    let good = seal(&mut ana.inner, "bea", b"{}", None, KIND_MESSAGE, NOW + 30).unwrap();
    let before = serde_json::to_string(&bea.inner.ratchets["ana"]).unwrap();
    let tag = mailbox_of(&good.clone().into()).unwrap();
    let wrong = seal_inner(
        InnerType::Message,
        (NOW + 30) as u64,
        &[1; 100],
        Step::K1,
        &[9; 32],
    )
    .unwrap();
    let forged = seal_p1(KIND_MESSAGE, NOW + 30, &tag, &wrong).unwrap();
    assert_eq!(dropped(open(&mut bea.inner, &forged, NOW + 31)), "bad mac");
    assert_eq!(
        serde_json::to_string(&bea.inner.ratchets["ana"]).unwrap(),
        before
    );

    // The real one, once; then it is a duplicate.
    contact(open(&mut bea.inner, &good, NOW + 32));
    assert_eq!(dropped(open(&mut bea.inner, &good, NOW + 33)), "duplicate");

    // Someone blocked: nothing of theirs is opened.
    let next = seal(&mut ana.inner, "bea", b"{}", None, KIND_MESSAGE, NOW + 40).unwrap();
    let f = bea.inner.friends["ana"].clone();
    bea.inner
        .blocked
        .insert(crate::block::BlockedIdentity::before_ur2(
            f.bundle.nostr_pub.clone(),
            Some(&f),
            NOW,
        ));
    assert!(matches!(
        open(&mut bea.inner, &next, NOW + 41),
        Opened::Drop(_)
    ));
}

#[test]
fn an_old_handshake_and_a_message_on_the_wrong_mailbox_are_dropped() {
    let (mut ana, mut bea) = ana_and_bea(true);
    let old = initiate(&mut ana.inner, "bea", NOW - 25 * 3600).unwrap();
    // Its mailbox is of an epoch Bea no longer listens to, or it is stale.
    assert!(matches!(open(&mut bea.inner, &old, NOW), Opened::Drop(_)));
    assert!(bea.inner.ratchets.is_empty());

    // A handshake-only mailbox does not take a message.
    let (mut ana, mut bea) = talking(true);
    let dh = bea.device().dev_dh().pub_bytes;
    let intro = outgoing_intro(ana.device().dev_dh(), &dh, epoch_of(NOW as u64)).unwrap();
    let ratchet = ana.inner.ratchets.get_mut("bea").unwrap();
    let ad = ana.inner.associated_data["bea"].clone();
    let m = ratchet_encrypt(ratchet, b"x", &ad).unwrap();
    let body = MessageBody::from_ratchet(&m).unwrap().encode();
    let frame = seal_inner(
        InnerType::Message,
        NOW as u64,
        &body,
        Step::K1,
        &intro.k_mac,
    )
    .unwrap();
    let event = seal_p1(KIND_MESSAGE, NOW, &intro.tag, &frame).unwrap();
    assert_eq!(
        dropped(open(&mut bea.inner, &event, NOW)),
        "wrong type for the mailbox"
    );
}

#[test]
fn nothing_in_an_event_names_either_side() {
    let (mut ana, bea) = talking(true);
    let mut authors = std::collections::HashSet::new();
    for n in 0..3 {
        let event = seal(
            &mut ana.inner,
            "bea",
            b"{\"ty\":\"text\",\"body\":\"hola\"}",
            None,
            KIND_MESSAGE,
            NOW + n,
        )
        .unwrap();
        let json = serde_json::to_string(&event).unwrap();
        for who in [&ana, &bea] {
            for key in [
                who.v1.nostr.pub_bytes,
                who.v1.ik_dh.pub_bytes,
                who.v1.ik_sign.pub_bytes,
                who.device().identity.device.dev_sign.pub_bytes,
            ] {
                assert!(
                    !json.contains(&hex::encode(key)),
                    "a key of theirs is in the event"
                );
            }
        }
        // The handles, as any value of the JSON (base64 may hold any letters).
        assert!(!json.contains("\"bea\"") && !json.contains("\"ana\""));
        assert_eq!(event.tags.iter().filter(|t| t[0] == "p").count(), 1);
        assert!(event.tags.iter().any(|t| t[0] == "expiration"));
        assert!(authors.insert(event.pubkey.clone()));
    }
}

#[test]
fn two_lengths_in_one_step_give_the_same_content_length() {
    let (mut ana, _) = talking(true);
    let short = seal(
        &mut ana.inner,
        "bea",
        b"{\"body\":\"a\"}",
        None,
        KIND_MESSAGE,
        NOW,
    )
    .unwrap();
    let long = seal(&mut ana.inner, "bea", &[b'a'; 600], None, KIND_MESSAGE, NOW).unwrap();
    assert_eq!(short.content.len(), long.content.len());
    let call = seal(
        &mut ana.inner,
        "bea",
        b"{}",
        Some(Step::K16),
        KIND_CALL,
        NOW,
    )
    .unwrap();
    assert_eq!(call.kind, KIND_CALL);
    assert!(call.content.len() > long.content.len());
    // What does not fit its step is refused, and the session does not move.
    let before = serde_json::to_string(&ana.inner.ratchets["bea"]).unwrap();
    assert_eq!(
        seal(
            &mut ana.inner,
            "bea",
            &[b'a'; 5000],
            Some(Step::K4),
            KIND_MESSAGE,
            NOW
        )
        .unwrap_err(),
        SendError::TooLong
    );
    assert_eq!(
        serde_json::to_string(&ana.inner.ratchets["bea"]).unwrap(),
        before
    );
}

#[test]
fn crossed_handshakes_end_in_one_session() {
    for full in [true, false] {
        let (mut ana, mut bea) = ana_and_bea(full);
        // Bea holds Ana's bundle too, so she can start one.
        let anas = ana.device().full_bundle();
        take_bundle(&mut bea.inner, "ana", anas, NOW as u64).unwrap();
        let from_ana = initiate(&mut ana.inner, "bea", NOW).unwrap();
        let from_bea = initiate(&mut bea.inner, "ana", NOW).unwrap();
        let mut to_ana = Vec::new();
        let mut to_bea = Vec::new();
        if let Opened::Contact { replies, .. } = open(&mut bea.inner, &from_ana, NOW + 1) {
            to_ana.extend(replies);
        }
        if let Opened::Contact { replies, .. } = open(&mut ana.inner, &from_bea, NOW + 1) {
            to_bea.extend(replies);
        }
        // Whatever is still owed goes back and forth until it settles.
        for round in 0..3 {
            let mut next_ana = Vec::new();
            let mut next_bea = Vec::new();
            for event in to_ana.drain(..) {
                if let Opened::Contact { replies, .. } =
                    open(&mut ana.inner, &event, NOW + 2 + round)
                {
                    next_bea.extend(replies);
                }
            }
            for event in to_bea.drain(..) {
                if let Opened::Contact { replies, .. } =
                    open(&mut bea.inner, &event, NOW + 2 + round)
                {
                    next_ana.extend(replies);
                }
            }
            to_ana = next_ana;
            to_bea = next_bea;
        }
        let event = seal(
            &mut ana.inner,
            "bea",
            b"{\"ty\":\"x\"}",
            None,
            KIND_MESSAGE,
            NOW + 30,
        )
        .unwrap();
        contact(open(&mut bea.inner, &event, NOW + 31));
        let event = seal(
            &mut bea.inner,
            "ana",
            b"{\"ty\":\"y\"}",
            None,
            KIND_MESSAGE,
            NOW + 32,
        )
        .unwrap();
        contact(open(&mut ana.inner, &event, NOW + 33));
    }
}

#[test]
fn without_a_list_of_the_contact_there_is_no_handshake() {
    let mut ana = person();
    let bea = person();
    ana.add("bea", &bea, None);
    assert_eq!(
        initiate(&mut ana.inner, "bea", NOW).unwrap_err(),
        SendError::NoPrekeys
    );
    assert_eq!(
        initiate(&mut ana.inner, "nadie", NOW).unwrap_err(),
        SendError::UnknownContact
    );
}
