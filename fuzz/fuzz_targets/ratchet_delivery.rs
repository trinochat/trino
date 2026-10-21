//! The Double Ratchet under any delivery a relay can arrange (trino-core
//! ratchet.rs, reached as the engine's receive path reaches it): messages
//! from both sides, delivered late, out of order, twice, or with a field
//! of the wire payload changed (`WirePayload` as JSON).
//!
//! Checked on every delivery:
//! - nothing panics;
//! - a message that decrypts gives the plaintext that was sent with it;
//! - no message decrypts twice (a replay is refused);
//! - with every message delivered once, in the order sent, all decrypt.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use std::sync::LazyLock;
use trino_engine::identity::{create_identity, public_bundle_for, Identity};
use trino_engine::ratchet::{
    init_initiator, init_responder, ratchet_decrypt, ratchet_encrypt, EncryptedMessage,
    MessageHeader, RatchetState,
};
use trino_engine::session::{WireHeader, WirePayload};
use trino_engine::x3dh::{initiate, respond};

struct Start {
    alice: RatchetState,
    bob: RatchetState,
    ad: Vec<u8>,
}

/// One X3DH, then the states both sides start from.
static START: LazyLock<Start> = LazyLock::new(|| {
    let alice: Identity = create_identity();
    let mut bob: Identity = create_identity();
    let bundle = public_bundle_for(&bob);
    let spk_pub = trino_engine::identity::decode_array_32(&bundle.spk_pub).unwrap();
    let init = initiate(&alice, &bundle).unwrap();
    let resp = respond(&mut bob, &init.message).unwrap();
    assert_eq!(init.associated_data, resp.associated_data);
    Start {
        alice: init_initiator(init.master_secret, spk_pub).unwrap(),
        bob: init_responder(resp.master_secret, resp.spk_keypair),
        ad: init.associated_data,
    }
});

#[derive(Arbitrary, Debug, Clone, Copy)]
enum Change {
    None,
    UpperHex,
    Pn(u32),
    N(u32),
    FlipCiphertext(u16),
    FlipNonce(u8),
    FlipDh(u8),
    TruncateCiphertext(u16),
}

#[derive(Arbitrary, Debug)]
enum Op {
    /// Alice (true) or Bob sends a message of this length.
    Send(bool, u8),
    /// Deliver the message with this index (mod the count) to its peer.
    Deliver(u16, Change),
}

#[derive(Arbitrary, Debug)]
struct Input {
    ops: Vec<Op>,
}

struct Sent {
    from_alice: bool,
    plain: Vec<u8>,
    wire: String,
    decrypted: bool,
}

fn to_wire(message: &EncryptedMessage) -> String {
    serde_json::to_string(&WirePayload {
        header: WireHeader {
            dh_pub: message.header.dh_pub.clone(),
            pn: message.header.pn,
            n: message.header.n,
        },
        nonce: message.nonce.clone(),
        ciphertext: message.ciphertext.clone(),
        handshake: None,
    })
    .unwrap()
}

fn from_wire(wire: &str) -> Option<EncryptedMessage> {
    let payload: WirePayload = serde_json::from_str(wire).ok()?;
    Some(EncryptedMessage {
        header: MessageHeader {
            dh_pub: payload.header.dh_pub,
            pn: payload.header.pn,
            n: payload.header.n,
        },
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
    })
}

fn flip_hex(text: &mut String, at: usize) {
    if text.is_empty() {
        return;
    }
    let at = at % text.len();
    let mut bytes = std::mem::take(text).into_bytes();
    bytes[at] = if bytes[at] == b'0' { b'1' } else { b'0' };
    *text = String::from_utf8(bytes).unwrap();
}

fn changed(message: &EncryptedMessage, change: Change) -> EncryptedMessage {
    let mut message = message.clone();
    match change {
        Change::None => {}
        Change::UpperHex => message.ciphertext = message.ciphertext.to_uppercase(),
        Change::Pn(pn) => message.header.pn = pn,
        Change::N(n) => message.header.n = n,
        Change::FlipCiphertext(at) => flip_hex(&mut message.ciphertext, at as usize),
        Change::FlipNonce(at) => flip_hex(&mut message.nonce, at as usize),
        Change::FlipDh(at) => flip_hex(&mut message.header.dh_pub, at as usize),
        Change::TruncateCiphertext(len) => {
            let len = (len as usize).min(message.ciphertext.len());
            message.ciphertext.truncate(len);
        }
    }
    message
}

fuzz_target!(|input: Input| {
    let start = &*START;
    let (mut alice, mut bob) = (start.alice.clone(), start.bob.clone());
    let mut sent: Vec<Sent> = Vec::new();
    let mut in_order = true;
    let mut delivered_upto = 0usize;

    for op in input.ops.iter().take(64) {
        match *op {
            Op::Send(from_alice, len) => {
                let plain: Vec<u8> = (0..len).map(|i| i ^ sent.len() as u8).collect();
                let state = if from_alice { &mut alice } else { &mut bob };
                if let Ok(message) = ratchet_encrypt(state, &plain, &start.ad) {
                    sent.push(Sent {
                        from_alice,
                        plain,
                        wire: to_wire(&message),
                        decrypted: false,
                    });
                }
            }
            Op::Deliver(index, change) => {
                if sent.is_empty() {
                    continue;
                }
                let index = index as usize % sent.len();
                if index != delivered_upto || !matches!(change, Change::None) {
                    in_order = false;
                }
                delivered_upto = delivered_upto.max(index + 1);
                let original = from_wire(&sent[index].wire).unwrap();
                let message = changed(&original, change);
                // Through the wire's JSON, as the receive path reads it.
                let Some(message) = from_wire(&to_wire(&message)) else {
                    continue;
                };
                let receiver = if sent[index].from_alice {
                    &mut bob
                } else {
                    &mut alice
                };
                match ratchet_decrypt(receiver, &message, &start.ad) {
                    Ok(plain) => {
                        assert_eq!(plain, sent[index].plain, "decrypted to another plaintext");
                        assert!(!sent[index].decrypted, "a message decrypted twice");
                        sent[index].decrypted = true;
                    }
                    Err(error) => {
                        assert!(
                            !(in_order && matches!(change, Change::None)),
                            "an in-order delivery failed: {error}"
                        );
                    }
                }
            }
        }
    }
});
