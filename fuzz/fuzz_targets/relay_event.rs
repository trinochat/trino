//! What a relay delivers, up to the ratchet (trino-engine nostr.rs,
//! groups.rs, session.rs): the receive path's pure functions, in the order
//! `handle_relay_message` and `handle_incoming_event` call them.
//!
//! - Raw relay text: the NIP-01 array, the event in it, `verify_event`.
//! - An event signed by a contact, with any kind, tags, content and
//!   `created_at`: `admit_event`, the payload's JSON (`WirePayload`), the
//!   handshake's replay gate (`judge_handshake`) and the X3DH answer
//!   (`respond_to_handshake`) with whatever keys it names.
//!
//! Nothing may panic; an event that verifies must be one that was signed.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use serde_json::Value;
use std::sync::LazyLock;
use trino_engine::groups::{admit_event, judge_handshake, respond_to_handshake, Admission};
use trino_engine::identity::{create_identity, public_bundle_for, Identity};
use trino_engine::nostr::{build_and_sign_event, verify_event, NostrEvent, TRINO_KIND};
use trino_engine::session::{event_frame_bytes, WirePayload};
use trino_engine::state::{FriendRecord, HandshakeMark, InnerState};

/// A clock in October 2026: the device's, which no peer chooses.
const NOW: i64 = 1_792_000_000;

struct People {
    me: Identity,
    friend: Identity,
}

static PEOPLE: LazyLock<People> = LazyLock::new(|| People {
    me: create_identity(),
    friend: create_identity(),
});

#[derive(Arbitrary, Debug)]
struct Input {
    relay_text: String,
    trino_kind: bool,
    kind: u32,
    to_me: bool,
    tags: Vec<Vec<String>>,
    content: String,
    created_at: i64,
    mark: Option<(i64, Vec<String>)>,
}

fn state() -> InnerState {
    let mut inner = InnerState::default();
    let bundle = public_bundle_for(&PEOPLE.friend);
    inner.friends.insert(
        "friend".into(),
        FriendRecord {
            handle: "friend".into(),
            bundle,
            added_at: NOW - 86_400,
            avatar: None,
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
        },
    );
    inner
}

fuzz_target!(|input: Input| {
    // Raw text from a relay.
    if let Ok(message) = serde_json::from_str::<Vec<Value>>(&input.relay_text) {
        if message.first().and_then(Value::as_str) == Some("EVENT") && message.len() >= 3 {
            if let Ok(event) = serde_json::from_value::<NostrEvent>(message[2].clone()) {
                let _ = verify_event(&event);
                let _ = event.recipient();
                let _ = event_frame_bytes(&event);
            }
        }
    }

    // A contact's signed event.
    let my_pub = hex::encode(PEOPLE.me.nostr.pub_bytes);
    let mut tags = input.tags.clone();
    if input.to_me {
        tags.insert(0, vec!["p".into(), my_pub.clone()]);
    }
    let kind = if input.trino_kind {
        TRINO_KIND
    } else {
        input.kind
    };
    let friend = &PEOPLE.friend.nostr;
    let event = build_and_sign_event(
        &friend.priv_bytes,
        &friend.pub_bytes,
        kind,
        &input.content,
        tags,
        Some(input.created_at),
    )
    .unwrap();
    assert!(verify_event(&event), "a signed event must verify");
    // The same event as a relay sends it, read back.
    let text = serde_json::json!(["EVENT", "sub", event]).to_string();
    let back: Vec<Value> = serde_json::from_str(&text).unwrap();
    let back: NostrEvent = serde_json::from_value(back[2].clone()).unwrap();
    assert!(
        verify_event(&back),
        "a signed event must verify after the relay"
    );

    let mut inner = state();
    let Admission::Process(_) = admit_event(&mut inner, &event, &my_pub) else {
        return;
    };
    let Ok(payload) = serde_json::from_str::<WirePayload>(&event.content) else {
        return;
    };
    if let Some(handshake) = &payload.handshake {
        let mark = input.mark.as_ref().map(|(at, eks)| HandshakeMark {
            at: *at,
            ek_pubs: eks.clone(),
        });
        let _ = judge_handshake(mark.as_ref(), event.created_at, &handshake.ek_pub, NOW);
        let _ = respond_to_handshake(&PEOPLE.me, handshake);
    }
});
