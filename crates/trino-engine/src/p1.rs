//! Sending and receiving under P1 (P1-8; design P1 §2, §3, §6.2 and
//! `diseno-vinculacion.md` §5, §21): what goes in and out of a contact's
//! mailboxes, at the level of the session's state, without any relay.
//!
//! - **The handshake** is trino-core's hybrid one, bound to the device
//!   lists ([`initiate`]). With the contact's full bundle it is a type 2
//!   (with its `pq_spk`); with a compact one only, it is PQ-11: a type 5,
//!   and nothing more is sent until the type 4 reply brings the KEM
//!   ciphertext. Message 0 carries this device's compact list and no text.
//! - **Every message** is a type 1 on the session's mailbox of the epoch
//!   ([`seal`]), in the frame of §21.4, at the step its content takes.
//! - **What arrives** ([`open`]) passes the admission of §6.2 with step 2a
//!   of `diseno-vinculacion.md` §5.4: the mailbox routes it (and gives the
//!   account, so the AD never comes from the message), the contact is not
//!   blocked, NIP-44 opens, the MAC and the type fit the mailbox, a
//!   handshake is fresh by its `ts`, and the event was not seen. Then the
//!   ratchet runs on a copy, and nothing is kept until it opens.
//! - **The responder** opens message 0 before it keeps anything (R-08),
//!   takes the initiator's list through the chain's rules, and admits the
//!   session only if the initiator's device is in it (RV-06). Its first
//!   reply brings its own list, and the initiator checks it the same way
//!   before anything else of that session counts.
//!
//! What this gives back to publish (the first replies, the full lists) goes
//! out at once; the delays of automatic answers are P1-11's.

use crate::block::{administers_a_group, friend_blocked};
use crate::device::{peer_account, peer_device_dh, take_bundle, OwnDevice};
use crate::groups::{judge_handshake, record_handshake};
use crate::identity::KeyPair;
use crate::mailboxes::table::{outgoing_intro, outgoing_session, Class, Table};
use crate::nostr::{seal_p1, NostrEvent};
use crate::ratchet::{
    init_initiator, init_responder, ratchet_decrypt, ratchet_encrypt, RatchetError, RatchetState,
};
use crate::send::SendError;
use crate::state::InnerState;
use serde::{Deserialize, Serialize};
use trino_core::device::{
    check_peer_device, peer_classical, peer_prekeys, DeviceBundle, DeviceError,
};
use trino_core::kem::{drbg, KemSecret};
use trino_core::p1::event::{mailbox_of, open_event, verify_event, Event};
pub use trino_core::p1::event::{KIND_CALL, KIND_MESSAGE};
use trino_core::p1::frame::{self, PartKind};
use trino_core::p1::mailbox::{epoch_of, session_seed};
use trino_core::p1::wire::{
    open_inner, seal_inner, HandshakeBody, HandshakePq11Body, InnerType, KemReplyBody, MessageBody,
    Step, WireError, KEM_CT_LEN,
};
use trino_core::pqxdh::{self, SUITE};
use zeroize::Zeroizing;

/// The step of a full device list in its own envelope (§21.4).
pub const FULL_LIST_STEP: Step = Step::K16;

/// A PQ-11 handshake this device started and whose type 4 has not come:
/// `SK₀`, the ephemeral KEM key's seed, the AD, the `ts` of the handshake
/// (its epoch is the session's `e0`) and the ratchet of message 0, whose
/// DH key the session restarts from (§21.6).
#[derive(Clone, Serialize, Deserialize)]
pub struct Pq11Pending {
    #[serde(with = "hex_secret")]
    sk0: Zeroizing<[u8; 32]>,
    #[serde(with = "hex_seed")]
    seed: Zeroizing<[u8; 64]>,
    ad: Vec<u8>,
    ts: i64,
    ratchet: RatchetState,
}

impl std::fmt::Debug for Pq11Pending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pq11Pending")
            .field("ts", &self.ts)
            .finish_non_exhaustive()
    }
}

impl PartialEq for Pq11Pending {
    fn eq(&self, other: &Self) -> bool {
        *self.sk0 == *other.sk0 && self.ts == other.ts
    }
}

/// What came of an event.
#[derive(Debug)]
pub enum Opened {
    /// Dropped, and why (fixed text, for the log).
    Drop(&'static str),
    /// A contact's event, admitted.
    Contact {
        handle: String,
        /// The envelope it carried (the JSON of today), if any.
        envelope: Option<Zeroizing<Vec<u8>>>,
        /// The sender's network time.
        ts: i64,
        /// A session with this contact started with it.
        established: bool,
        /// What this device answers, to publish now.
        replies: Vec<NostrEvent>,
        /// The contact's device list or prekeys changed: the account file
        /// keeps them.
        devices_changed: bool,
    },
    /// A message of a contact, sent at `ts`, that no session here opens:
    /// none is held, or the ratchet failed (the caller heals it).
    Undecryptable { handle: String, ts: i64 },
}

/// Starts a session with the contact `handle` at network time `ts`: the
/// handshake to publish, to its introduction mailbox.
pub fn initiate(inner: &mut InnerState, handle: &str, ts: i64) -> Result<NostrEvent, SendError> {
    let device = inner.device.as_ref().ok_or(SendError::Sealed)?;
    let friend = inner.friends.get(handle).ok_or(SendError::UnknownContact)?;
    let devices = friend.devices.as_ref().ok_or(SendError::NoPrekeys)?;
    let their_dh = peer_device_dh(friend).ok_or(SendError::NoPrekeys)?;
    let me = device.account();
    let my_dh = device.dev_dh().clone();
    let e = epoch_of(net_u64(ts)?);
    let intro = outgoing_intro(&my_dh, &their_dh, e).map_err(failed)?;
    let list = own_list_part(device, false)?;
    let mut rng = drbg();
    let (event, session) = match peer_prekeys(&devices.bundle, &devices.chain, &their_dh) {
        Ok(peer) => {
            let init = pqxdh::initiate_with_rng(&me, &my_dh, &peer, &mut rng).map_err(failed)?;
            let mut ratchet = init_initiator(*init.sk, peer.spk.public).map_err(failed)?;
            let m0 = ratchet_encrypt(&mut ratchet, &list, &init.ad).map_err(failed)?;
            let body = init
                .handshake(MessageBody::from_ratchet(&m0).map_err(failed)?)
                .encode();
            let frame = seal_inner(
                InnerType::Handshake,
                net_u64(ts)?,
                &body,
                Step::K4,
                &intro.k_mac,
            )
            .map_err(failed)?;
            ratchet
                .attach_session(SUITE, &init.s_ses, e, e)
                .map_err(failed)?;
            let event = seal_p1(KIND_MESSAGE, ts, &intro.tag, &frame).map_err(failed)?;
            (event, Started::Session(Box::new(ratchet), init.ad.clone()))
        }
        Err(DeviceError::NoPqPrekey) => {
            let peer =
                peer_classical(&devices.bundle, &devices.chain, &their_dh).map_err(failed)?;
            let init =
                pqxdh::initiate_pq11_with_rng(&me, &my_dh, &peer, &mut rng).map_err(failed)?;
            let mut ratchet = init_initiator(*init.sk0, peer.spk.public).map_err(failed)?;
            let m0 = ratchet_encrypt(&mut ratchet, &list, &init.ad).map_err(failed)?;
            let body = init
                .handshake(MessageBody::from_ratchet(&m0).map_err(failed)?)
                .encode();
            let frame = seal_inner(
                InnerType::HandshakePq11,
                net_u64(ts)?,
                &body,
                Step::K4,
                &intro.k_mac,
            )
            .map_err(failed)?;
            let event = seal_p1(KIND_MESSAGE, ts, &intro.tag, &frame).map_err(failed)?;
            let pending = Pq11Pending {
                sk0: init.sk0.clone(),
                seed: Zeroizing::new(*init.kem.seed()),
                ad: init.ad.clone(),
                ts,
                ratchet,
            };
            (event, Started::Pq11(Box::new(pending)))
        }
        Err(error) => return Err(failed(error)),
    };
    forget_session(inner, handle);
    match session {
        Started::Session(ratchet, ad) => {
            inner.ratchets.insert(handle.to_string(), *ratchet);
            inner.associated_data.insert(handle.to_string(), ad);
        }
        Started::Pq11(pending) => {
            inner.mailboxes.pq11.insert(handle.to_string(), *pending);
        }
    }
    inner.mailboxes.unverified.insert(handle.to_string());
    Ok(event)
}

/// What starting a handshake leaves.
enum Started {
    Session(Box<RatchetState>, Vec<u8>),
    Pq11(Box<Pq11Pending>),
}

/// Seals `envelope` (today's JSON) for `handle` at network time `ts`: a
/// type 1 on the session's mailbox. With `step`, at that step; if not, the
/// smallest it fits. The session moves on only if it is sealed.
pub fn seal(
    inner: &mut InnerState,
    handle: &str,
    envelope: &[u8],
    step: Option<Step>,
    kind: u32,
    ts: i64,
) -> Result<NostrEvent, SendError> {
    seal_parts(
        inner,
        handle,
        &[(PartKind::Envelope, envelope)],
        step,
        kind,
        ts,
    )
}

/// `seal` for any parts of the frame.
fn seal_parts(
    inner: &mut InnerState,
    handle: &str,
    parts: &[(PartKind, &[u8])],
    step: Option<Step>,
    kind: u32,
    ts: i64,
) -> Result<NostrEvent, SendError> {
    if inner.mailboxes.pq11.contains_key(handle) {
        return Err(SendError::Pending);
    }
    let device = inner.device.as_ref().ok_or(SendError::Sealed)?;
    let friend = inner.friends.get(handle).ok_or(SendError::UnknownContact)?;
    let their_dh = peer_device_dh(friend).ok_or(SendError::NoSession)?;
    let ad = inner
        .associated_data
        .get(handle)
        .ok_or(SendError::NoSession)?
        .clone();
    // A copy: the session moves on only once the event is sealed.
    let mut ratchet = inner
        .ratchets
        .get(handle)
        .filter(|ratchet| ratchet.is_p1())
        .ok_or(SendError::NoSession)?
        .clone();
    let e = epoch_of(net_u64(ts)?);
    let chain = ratchet.session.as_mut().ok_or(SendError::NoSession)?;
    if chain.secret(e).is_none() {
        chain.advance_to(e).map_err(|_| SendError::NoSession)?;
    }
    let mailbox = outgoing_session(device.dev_dh(), &their_dh, chain, e)
        .map_err(failed)?
        .ok_or(SendError::NoSession)?;
    let plain = Zeroizing::new(frame::encode(parts).map_err(failed)?);
    let message = ratchet_encrypt(&mut ratchet, &plain, &ad).map_err(failed)?;
    let body = MessageBody::from_ratchet(&message)
        .map_err(failed)?
        .encode();
    let step = match step {
        Some(step) => step,
        None => Step::smallest_for(body.len()).ok_or(SendError::TooLong)?,
    };
    let frame = seal_inner(
        InnerType::Message,
        net_u64(ts)?,
        &body,
        step,
        &mailbox.k_mac,
    )
    .map_err(|error| match error {
        WireError::TooLong => SendError::TooLong,
        other => failed(&other),
    })?;
    let event = seal_p1(kind, ts, &mailbox.tag, &frame).map_err(failed)?;
    inner.ratchets.insert(handle.to_string(), ratchet);
    Ok(event)
}

/// What an event that came at network time `now` is, through the
/// admission of §6.2; the state changes only if it is admitted.
pub fn open(inner: &mut InnerState, event: &NostrEvent, now: i64) -> Opened {
    if event.kind != KIND_MESSAGE && event.kind != KIND_CALL {
        return Opened::Drop("not a P1 kind");
    }
    let core: Event = event.clone().into();
    if !verify_event(&core) {
        return Opened::Drop("bad signature");
    }
    let Some(tag) = mailbox_of(&core) else {
        return Opened::Drop("no mailbox");
    };
    let Ok(now_u) = u64::try_from(now) else {
        return Opened::Drop("no time");
    };
    let today = epoch_of(now_u);
    advance_sessions(inner, today);
    // Steps 2 and 2a: the mailbox routes it, to a contact's device.
    let Some(table) = [today, today.saturating_sub(1), today + 1]
        .into_iter()
        .map(|e| Table::of(inner, e))
        .find(|table| table.route(&tag).is_some())
    else {
        return Opened::Drop("unknown mailbox");
    };
    let route = table.route(&tag).expect("found above");
    let handle = route.contact.clone();
    // Step 3.
    // Step 3; of someone blocked, only what a group they administer needs
    // (UR-2, R-04: `block::on_message` keeps their rosters only).
    match inner.friends.get(&handle) {
        Some(friend)
            if !friend_blocked(inner, friend)
                || administers_a_group(inner, &friend.bundle.ik_sign_pub) => {}
        _ => return Opened::Drop("blocked"),
    }
    // Steps 5 to 7.
    let Ok(frame) = open_event(&route.mailbox.sk, &core) else {
        return Opened::Drop("does not open");
    };
    let opened = match open_inner(&frame, &route.mailbox.k_mac) {
        Ok(opened) => opened,
        Err(WireError::Mac) => return Opened::Drop("bad mac"),
        Err(_) => return Opened::Drop("bad frame"),
    };
    let fits = matches!(
        (route.class, opened.kind),
        (
            Class::Intro,
            InnerType::Handshake | InnerType::HandshakePq11 | InnerType::KemReply
        ) | (Class::Session(_), InnerType::Message)
    );
    if !fits {
        return Opened::Drop("wrong type for the mailbox");
    }
    let Ok(ts) = i64::try_from(opened.ts) else {
        return Opened::Drop("bad time");
    };
    // Step 9 (8 is each type's own).
    if !inner.mailboxes.dedup.first_sight(route, &event.id) {
        return Opened::Drop("duplicate");
    }
    match opened.kind {
        InnerType::Message => on_message(inner, &handle, &opened.body, ts, now),
        InnerType::Handshake => on_handshake(inner, &handle, &opened.body, ts, now),
        InnerType::HandshakePq11 => on_pq11(inner, &handle, &opened.body, ts, now),
        InnerType::KemReply => on_kem_reply(inner, &handle, &opened.body, ts, now),
        InnerType::Request => Opened::Drop("wrong type for the mailbox"),
    }
}

/// A type 1 of `handle`'s session.
fn on_message(inner: &mut InnerState, handle: &str, body: &[u8], ts: i64, now: i64) -> Opened {
    let Ok(body) = MessageBody::decode(body) else {
        return Opened::Drop("bad message");
    };
    let undecryptable = || Opened::Undecryptable {
        handle: handle.to_string(),
        ts,
    };
    let Some(ad) = inner.associated_data.get(handle).cloned() else {
        return undecryptable();
    };
    let Some(mut ratchet) = inner.ratchets.get(handle).cloned() else {
        return undecryptable();
    };
    let plain = match ratchet_decrypt(&mut ratchet, &body.to_ratchet(), &ad) {
        Ok(plain) => Zeroizing::new(plain),
        Err(RatchetError::Replay { .. }) => return Opened::Drop("replayed"),
        Err(_) => return undecryptable(),
    };
    let Ok(parts) = frame::decode(&plain) else {
        return Opened::Drop("bad frame");
    };
    let unverified = inner.mailboxes.unverified.contains(handle);
    let took = take_lists(inner, handle, &parts, now);
    let mut replies = Vec::new();
    if unverified {
        // RV-06: the first reply brings the list its device is in.
        if !(took && device_checks(inner, handle)) {
            forget_session(inner, handle);
            return Opened::Drop("first reply without a list that checks");
        }
        inner.mailboxes.unverified.remove(handle);
    }
    inner.ratchets.insert(handle.to_string(), ratchet);
    if unverified {
        // It holds only our compact list: the full one, once (§21.4).
        replies.extend(full_list_for(inner, handle, now));
    }
    Opened::Contact {
        handle: handle.to_string(),
        envelope: envelope_of(parts),
        ts,
        established: false,
        replies,
        devices_changed: took,
    }
}

/// A type 2: the responder's side of a hybrid handshake.
fn on_handshake(inner: &mut InnerState, handle: &str, body: &[u8], ts: i64, now: i64) -> Opened {
    let Ok(hs) = HandshakeBody::decode(body) else {
        return Opened::Drop("bad handshake");
    };
    if let Some(why) = refuse_handshake(inner, handle, &hs.dev_dh, &hs.ek, ts, now) {
        return Opened::Drop(why);
    }
    let Some(device) = inner.device.as_ref() else {
        return Opened::Drop("no device");
    };
    let Some(their_account) = inner.friends.get(handle).and_then(peer_account) else {
        return Opened::Drop("no account");
    };
    let Some(keys) =
        device
            .identity
            .device
            .responder_keys(device.account(), hs.spk_id, hs.pq_spk_id)
    else {
        return Opened::Drop("unknown prekey");
    };
    let Ok(response) = pqxdh::respond(&keys, &their_account, &hs) else {
        return Opened::Drop("handshake does not open");
    };
    let spk = keys.spk.clone();
    // R-08: message 0 opens before anything is kept.
    let mut ratchet = init_responder(*response.sk, spk);
    let Ok(plain) = ratchet_decrypt(&mut ratchet, &hs.message.to_ratchet(), &response.ad) else {
        return Opened::Drop("message 0 does not open");
    };
    let plain = Zeroizing::new(plain);
    let Ok(parts) = frame::decode(&plain) else {
        return Opened::Drop("bad frame");
    };
    if let Some(why) = admit_initiator(inner, handle, &parts, &their_account, &hs.dev_dh, now) {
        return Opened::Drop(why);
    }
    let today = epoch_of(u64::try_from(now).unwrap_or_default());
    let e0 = epoch_of(u64::try_from(ts).unwrap_or_default());
    if ratchet
        .attach_session(SUITE, &response.s_ses, e0, today)
        .is_err()
    {
        return Opened::Drop("no session chain");
    }
    settle(inner, handle, ratchet, response.ad.clone(), &hs.ek, ts);
    let replies = full_list_for(inner, handle, now).into_iter().collect();
    Opened::Contact {
        handle: handle.to_string(),
        envelope: envelope_of(parts),
        ts,
        established: true,
        replies,
        devices_changed: true,
    }
}

/// A type 5: the responder's side of a PQ-11 handshake. It answers with the
/// type 4, and then its full list.
fn on_pq11(inner: &mut InnerState, handle: &str, body: &[u8], ts: i64, now: i64) -> Opened {
    let Ok(hs) = HandshakePq11Body::decode(body) else {
        return Opened::Drop("bad handshake");
    };
    if let Some(why) = refuse_handshake(inner, handle, &hs.dev_dh, &hs.ek, ts, now) {
        return Opened::Drop(why);
    }
    let Some(device) = inner.device.as_ref() else {
        return Opened::Drop("no device");
    };
    let Some(their_account) = inner.friends.get(handle).and_then(peer_account) else {
        return Opened::Drop("no account");
    };
    let Some(keys) = device
        .identity
        .device
        .classical_responder_keys(device.account(), hs.spk_id)
    else {
        return Opened::Drop("unknown prekey");
    };
    let Ok(response) = pqxdh::respond_pq11(&keys, &their_account, &hs) else {
        return Opened::Drop("handshake does not open");
    };
    let mut first = init_responder(*response.sk0, keys.spk.clone());
    let Ok(plain) = ratchet_decrypt(&mut first, &hs.message.to_ratchet(), &response.ad) else {
        return Opened::Drop("message 0 does not open");
    };
    let plain = Zeroizing::new(plain);
    let Ok(parts) = frame::decode(&plain) else {
        return Opened::Drop("bad frame");
    };
    let my_dh = device.dev_dh().clone();
    let list = match own_list_part(device, false) {
        Ok(list) => list,
        Err(_) => return Opened::Drop("no list"),
    };
    if let Some(why) = admit_initiator(inner, handle, &parts, &their_account, &hs.dev_dh, now) {
        return Opened::Drop(why);
    }
    // The KEM goes in before anything is encrypted (§21.6).
    let Ok((ct, root)) = response.reply_with_rng(&mut drbg()) else {
        return Opened::Drop("the KEM key does not take");
    };
    let Ok(mut ratchet) = init_initiator(*root.root, hs.message.dh) else {
        return Opened::Drop("no ratchet");
    };
    let today = epoch_of(u64::try_from(now).unwrap_or_default());
    let e0 = epoch_of(u64::try_from(ts).unwrap_or_default());
    if ratchet
        .attach_session(SUITE, &root.s_ses, e0, today)
        .is_err()
    {
        return Opened::Drop("no session chain");
    }
    let Some(reply) = kem_reply(
        &mut ratchet,
        ct,
        &list,
        &response.ad,
        &my_dh,
        &hs.dev_dh,
        now,
    ) else {
        return Opened::Drop("the reply does not seal");
    };
    settle(inner, handle, ratchet, response.ad.clone(), &hs.ek, ts);
    let mut replies = vec![reply];
    replies.extend(full_list_for(inner, handle, now));
    Opened::Contact {
        handle: handle.to_string(),
        envelope: envelope_of(parts),
        ts,
        established: true,
        replies,
        devices_changed: true,
    }
}

/// A type 4: the initiator's side of a PQ-11 handshake ends.
fn on_kem_reply(inner: &mut InnerState, handle: &str, body: &[u8], ts: i64, now: i64) -> Opened {
    let Some(pending) = inner.mailboxes.pq11.get(handle).cloned() else {
        return Opened::Drop("no PQ-11 handshake waits");
    };
    let Ok(reply) = KemReplyBody::decode(body) else {
        return Opened::Drop("bad reply");
    };
    let kem = KemSecret::from_seed(&pending.seed);
    let root = pqxdh::pq11_root(&pending.sk0, &kem.decapsulate(&reply.ct), &reply.ct);
    let s_ses = session_seed(&root, &pending.ad);
    let mut ratchet = init_responder(*root, pending.ratchet.dhs.clone());
    let Ok(plain) = ratchet_decrypt(&mut ratchet, &reply.message.to_ratchet(), &pending.ad) else {
        return Opened::Drop("the reply does not open");
    };
    let plain = Zeroizing::new(plain);
    let Ok(parts) = frame::decode(&plain) else {
        return Opened::Drop("bad frame");
    };
    if !(take_lists(inner, handle, &parts, now) && device_checks(inner, handle)) {
        forget_session(inner, handle);
        return Opened::Drop("first reply without a list that checks");
    }
    let today = epoch_of(u64::try_from(now).unwrap_or_default());
    let e0 = epoch_of(u64::try_from(pending.ts).unwrap_or_default());
    if ratchet.attach_session(SUITE, &s_ses, e0, today).is_err() {
        return Opened::Drop("no session chain");
    }
    inner.mailboxes.pq11.remove(handle);
    inner.mailboxes.unverified.remove(handle);
    inner.ratchets.insert(handle.to_string(), ratchet);
    inner
        .associated_data
        .insert(handle.to_string(), pending.ad.clone());
    let replies = full_list_for(inner, handle, now).into_iter().collect();
    Opened::Contact {
        handle: handle.to_string(),
        envelope: envelope_of(parts),
        ts,
        established: true,
        replies,
        devices_changed: true,
    }
}

/// Why a handshake of `handle`'s device `dev_dh` (with ephemeral `ek`, sent
/// at `ts`) does not start a session: too old or from the future, not newer
/// than the last one taken (step 8), or crossed with ours and ours wins (the
/// lower device key starts, §3.8).
fn refuse_handshake(
    inner: &InnerState,
    handle: &str,
    dev_dh: &[u8; 32],
    ek: &[u8; 32],
    ts: i64,
    now: i64,
) -> Option<&'static str> {
    let friend = inner.friends.get(handle)?;
    let mark = inner.handshake_marks.get(&friend.bundle.nostr_pub);
    if judge_handshake(mark, ts, &hex::encode(ek), now).is_err() {
        return Some("stale handshake");
    }
    let mine = inner.device.as_ref()?.dev_dh().pub_bytes;
    let ours_waits =
        inner.mailboxes.unverified.contains(handle) || inner.mailboxes.pq11.contains_key(handle);
    let have_session = inner.ratchets.contains_key(handle) || ours_waits;
    let theirs_wins = dev_dh < &mine;
    (have_session && !theirs_wins).then_some("crossed handshake: ours wins")
}

/// The initiator's list in message 0, through the chain's rules, with the
/// device that shook hands in it (RV-06); on any failure the contact's
/// devices stay as they were.
fn admit_initiator(
    inner: &mut InnerState,
    handle: &str,
    parts: &[(PartKind, Vec<u8>)],
    account: &[u8; 32],
    dev_dh: &[u8; 32],
    now: i64,
) -> Option<&'static str> {
    let before = inner.friends.get(handle)?.devices.clone();
    let checks = take_lists(inner, handle, parts, now)
        && inner
            .friends
            .get(handle)
            .and_then(|friend| friend.devices.as_ref())
            .is_some_and(|devices| check_peer_device(&devices.chain, account, dev_dh).is_ok());
    if checks {
        return None;
    }
    if let Some(friend) = inner.friends.get_mut(handle) {
        friend.devices = before;
    }
    Some("the handshake's device is not in its list")
}

/// Whether the device this device talks to of `handle` is active in the
/// list held of its account.
fn device_checks(inner: &InnerState, handle: &str) -> bool {
    let Some(friend) = inner.friends.get(handle) else {
        return false;
    };
    let (Some(account), Some(dev_dh), Some(devices)) = (
        peer_account(friend),
        peer_device_dh(friend),
        friend.devices.as_ref(),
    ) else {
        return false;
    };
    check_peer_device(&devices.chain, &account, &dev_dh).is_ok()
}

/// Takes the device lists among `parts`; true if one was there and taken.
fn take_lists(
    inner: &mut InnerState,
    handle: &str,
    parts: &[(PartKind, Vec<u8>)],
    now: i64,
) -> bool {
    let now = u64::try_from(now).unwrap_or_default();
    let mut took = false;
    for (kind, bytes) in parts {
        let bundle = match kind {
            PartKind::DeviceListCompact => DeviceBundle::decode_compact(bytes),
            PartKind::DeviceListFull => DeviceBundle::decode_full(bytes),
            _ => continue,
        };
        match bundle.map(|bundle| take_bundle(inner, handle, bundle, now)) {
            Ok(Ok(_)) => took = true,
            _ => crate::diag::note("a device list was not taken"),
        }
    }
    took
}

/// Keeps a session that just started, in place of any other with `handle`,
/// and the handshake's mark.
fn settle(
    inner: &mut InnerState,
    handle: &str,
    ratchet: RatchetState,
    ad: Vec<u8>,
    ek: &[u8; 32],
    ts: i64,
) {
    forget_session(inner, handle);
    if let Some(nostr) = inner
        .friends
        .get(handle)
        .map(|f| f.bundle.nostr_pub.clone())
    {
        record_handshake(&mut inner.handshake_marks, &nostr, ts, &hex::encode(ek));
    }
    inner.ratchets.insert(handle.to_string(), ratchet);
    inner.associated_data.insert(handle.to_string(), ad);
}

/// Drops whatever session `handle` had or was starting.
fn forget_session(inner: &mut InnerState, handle: &str) {
    inner.ratchets.remove(handle);
    if let Some(mut ad) = inner.associated_data.remove(handle) {
        zeroize::Zeroize::zeroize(&mut ad);
    }
    inner.mailboxes.pq11.remove(handle);
    inner.mailboxes.unverified.remove(handle);
}

/// The type 4 to the initiator's introduction mailbox: the ciphertext and
/// the first message of the session, with this device's compact list.
fn kem_reply(
    ratchet: &mut RatchetState,
    ct: Box<[u8; KEM_CT_LEN]>,
    list: &[u8],
    ad: &[u8],
    my_dh: &KeyPair,
    their_dh: &[u8; 32],
    now: i64,
) -> Option<NostrEvent> {
    let now_u = u64::try_from(now).ok()?;
    let intro = outgoing_intro(my_dh, their_dh, epoch_of(now_u)).ok()?;
    let message = ratchet_encrypt(ratchet, list, ad).ok()?;
    let body = KemReplyBody {
        ct,
        message: MessageBody::from_ratchet(&message).ok()?,
    }
    .encode();
    let frame = seal_inner(InnerType::KemReply, now_u, &body, Step::K4, &intro.k_mac).ok()?;
    seal_p1(KIND_MESSAGE, now, &intro.tag, &frame).ok()
}

/// This device's full list, once, to `handle`, in its own 16 KiB envelope.
fn full_list_for(inner: &mut InnerState, handle: &str, now: i64) -> Option<NostrEvent> {
    let list = own_list_part(inner.device.as_ref()?, true).ok()?;
    let parts = frame::decode(&list).ok()?;
    let parts: Vec<(PartKind, &[u8])> = parts.iter().map(|(k, b)| (*k, b.as_slice())).collect();
    seal_parts(
        inner,
        handle,
        &parts,
        Some(FULL_LIST_STEP),
        KIND_MESSAGE,
        now,
    )
    .ok()
}

/// A frame with only this device's list, compact or full.
fn own_list_part(device: &OwnDevice, full: bool) -> Result<Vec<u8>, SendError> {
    let (kind, bytes) = if full {
        (
            PartKind::DeviceListFull,
            device
                .full_bundle()
                .encode_full()
                .ok_or(SendError::NoPrekeys)?,
        )
    } else {
        (
            PartKind::DeviceListCompact,
            device.compact_bundle().encode_compact(),
        )
    };
    frame::encode(&[(kind, &bytes)]).map_err(failed)
}

/// The envelope among the frame's parts.
fn envelope_of(parts: Vec<(PartKind, Vec<u8>)>) -> Option<Zeroizing<Vec<u8>>> {
    parts
        .into_iter()
        .find(|(kind, _)| *kind == PartKind::Envelope)
        .map(|(_, bytes)| Zeroizing::new(bytes))
}

/// Walks every session's mailbox chain to `today`.
fn advance_sessions(inner: &mut InnerState, today: u32) {
    for ratchet in inner.ratchets.values_mut() {
        if let Some(chain) = ratchet.session.as_mut() {
            if chain.secret(today).is_none() {
                let _ = chain.advance_to(today);
            }
        }
    }
}

fn net_u64(ts: i64) -> Result<u64, SendError> {
    u64::try_from(ts).map_err(|_| SendError::ClockSkewed)
}

fn failed<E: std::fmt::Display>(error: E) -> SendError {
    SendError::Failed(error.to_string())
}

/// `Zeroizing<[u8; 32]>` in hex.
mod hex_secret {
    use serde::{Deserialize, Deserializer, Serializer};
    use zeroize::Zeroizing;

    pub fn serialize<S: Serializer>(v: &Zeroizing<[u8; 32]>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v.as_slice()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Zeroizing<[u8; 32]>, D::Error> {
        let text = Zeroizing::new(String::deserialize(d)?);
        let bytes = Zeroizing::new(hex::decode(&*text).map_err(serde::de::Error::custom)?);
        let array: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| serde::de::Error::custom("32 bytes"))?;
        Ok(Zeroizing::new(array))
    }
}

/// `Zeroizing<[u8; 64]>` in hex.
mod hex_seed {
    use serde::{Deserialize, Deserializer, Serializer};
    use zeroize::Zeroizing;

    pub fn serialize<S: Serializer>(v: &Zeroizing<[u8; 64]>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v.as_slice()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Zeroizing<[u8; 64]>, D::Error> {
        let text = Zeroizing::new(String::deserialize(d)?);
        let bytes = Zeroizing::new(hex::decode(&*text).map_err(serde::de::Error::custom)?);
        let array: [u8; 64] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| serde::de::Error::custom("64 bytes"))?;
        Ok(Zeroizing::new(array))
    }
}

#[cfg(test)]
pub(crate) mod tests;
