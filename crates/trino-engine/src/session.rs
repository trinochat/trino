//! The session's core (M4-0c): what a session with a contact is made of
//! and what every part of the engine shares about it.
//!
//! - The wire format of a message, the fingerprint of an identity, the
//!   checks on the pictures a contact sends, and the key a group's chat is
//!   kept under.
//! - The relay connections of an open session, and what they deliver
//!   (`handle_incoming_event`): admitted, decrypted, kept and told to the
//!   UI through an `EventSink`. The inspector's connections, apart.
//! - Sessions with contacts: started with a handshake (`ensure_session`,
//!   `connect`, `resync`), healed when they break (`trigger_resync`), and
//!   every message sealed for one (`seal_for`).
//! - What the session keeps: its history and its sessions, sealed in the
//!   store, and what locking drops from memory (`forget_session`).
//!
//! The host spawns the relays' task (`connect_relays`) on its runtime, and
//! gives the session its `EventSink` and the way to send the profile again
//! (`profile::Resend`).

use crate::call_signal::validate_call_signal;
use crate::connection::{ConnectionStatus, Debouncer, CONNECTION_CHANGED_EVENT, DEBOUNCE};
use crate::envelope::{decode_envelope, Envelope};
use crate::events::EventSink;
use crate::group::{self, FileRef, GroupRoster};
use crate::groups::{
    accept_incoming_roster, admit_event, judge_handshake, record_handshake, respond_to_handshake,
    Admission, HandshakeRejection,
};
use crate::identity::{decode_array_32, Identity};
use crate::nostr::{
    build_and_sign_event, inspector_connector, relay_deadline, CatchUp, ClientOptions, Connector,
    NostrClient, NostrEvent, NostrFilter, ReadyGate, StateHandler, TRINO_KIND,
};
use crate::profile;
use crate::ratchet::{
    init_initiator, ratchet_decrypt, ratchet_encrypt, EncryptedMessage, MessageHeader, RatchetError,
};
use crate::send::SendError;
use crate::state::{HandshakeMark, HistItem, InnerState};
use crate::store::envelope::Slot;
use crate::store::session::Found;
use crate::turn::TurnGate;
use crate::x3dh::initiate;
use crate::Engine;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

pub const MAX_INLINE_RASTER_BYTES: usize = 128 * 1024;
/// How far back the messaging subscription reaches for events sent while this
/// device was offline. Events older than this are lost (a known limitation).
pub const CATCH_UP_WINDOW_SECS: i64 = 86_400;
/// Clock skew between peers that we tolerate: how far in the future a
/// handshake may claim to be, and how much a re-subscription overlaps the time
/// the previous connection already covered.
pub const CLOCK_SKEW_SECS: i64 = 600;

#[derive(Serialize, Deserialize, Clone)]
pub struct WirePayload {
    pub header: WireHeader,
    pub nonce: String,
    pub ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handshake: Option<WireHandshake>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WireHeader {
    #[serde(rename = "dhPub")]
    pub dh_pub: String,
    pub pn: u32,
    pub n: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WireHandshake {
    #[serde(rename = "ikDhPub")]
    pub ik_dh_pub: String,
    #[serde(rename = "ekPub")]
    pub ek_pub: String,
    #[serde(rename = "spkId")]
    pub spk_id: u32,
    #[serde(rename = "opkId")]
    pub opk_id: Option<u32>,
}

/// Human-verifiable fingerprint bound to ALL three public keys (ik_sign, ik_dh,
/// nostr), so comparing it out-of-band actually detects a swapped DH/Nostr key.
pub fn fp(ik_sign: &[u8; 32], ik_dh: &[u8; 32], nostr: &[u8; 32]) -> String {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(ik_sign);
    input.extend_from_slice(ik_dh);
    input.extend_from_slice(nostr);
    let h = crate::crypto::sha256(&input);
    let hex = hex::encode(&h[..8]);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(".")
}

/// A line for the diagnostic log, so silent failures in the receive path
/// leave a trace after a live test. Fixed text only, and only debug builds
/// keep the log: see diag.rs (T3).
pub fn dbg_log(text: &'static str) {
    crate::diag::note(text);
}

pub fn checked_inline_raster(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some((meta, payload)) = value.split_once(',') else {
        return Err("inline image must be a base64 data URL".to_string());
    };
    if !matches!(
        meta,
        "data:image/jpeg;base64"
            | "data:image/png;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
    ) {
        return Err("only inline jpeg/png/gif/webp images are allowed".to_string());
    }
    if payload.is_empty()
        || payload.len() > MAX_INLINE_RASTER_BYTES.div_ceil(3) * 4 + 4
        || payload.trim() != payload
    {
        return Err("inline image is empty or too large".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "inline image has invalid base64".to_string())?;
    if decoded.len() > MAX_INLINE_RASTER_BYTES {
        return Err("inline image is too large".to_string());
    }
    Ok(Some(value))
}

pub fn sanitized_inline_raster(value: Option<String>) -> Option<String> {
    checked_inline_raster(value).ok().flatten()
}

/// The longest file name kept, in Unicode scalar values: what most file
/// systems take.
pub const FILE_NAME_MAX_CHARS: usize = 255;
/// The name of a file whose own name shows nothing.
pub const FILE_NAME_FALLBACK: &str = "archivo";
/// The longest extension kept whole when a long file name is cut.
const EXTENSION_MAX_CHARS: usize = 16;

/// A file name a peer sent, as it can be shown and saved (TRN-APP-03): no
/// control or format character, so a right-to-left override cannot make
/// "factura\u{202E}fdp.exe" read as a PDF, and at most `FILE_NAME_MAX_CHARS`
/// long. A long name is cut before its extension, so the extension shown is
/// the real one.
pub fn shown_file_name(name: &str) -> String {
    let clean = profile::shown_name(name, usize::MAX, FILE_NAME_FALLBACK);
    if clean.chars().count() <= FILE_NAME_MAX_CHARS {
        return clean;
    }
    let extension = clean
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .filter(|extension| (1..=EXTENSION_MAX_CHARS).contains(&extension.chars().count()));
    match extension {
        Some(extension) => {
            let stem = FILE_NAME_MAX_CHARS - 1 - extension.chars().count();
            let head: String = clean.chars().take(stem).collect();
            format!("{head}.{extension}")
        }
        None => clean.chars().take(FILE_NAME_MAX_CHARS).collect(),
    }
}

pub fn sanitize_file_ref(mut file: FileRef) -> FileRef {
    file.thumb = sanitized_inline_raster(file.thumb);
    file.name = shown_file_name(&file.name);
    file
}

/// A roster as it can be kept: only its photo's thumbnail is cleaned. Its
/// name and its photo's name are signed by the admin and stay as signed, so
/// the roster still verifies when it is sent on; they are cleaned where they
/// are shown (`groups::group_info`, TRN-APP-03).
pub fn sanitize_roster(mut roster: GroupRoster) -> GroupRoster {
    if let Some(photo) = roster.photo.as_mut() {
        photo.thumb = sanitized_inline_raster(photo.thumb.take());
    }
    roster
}

pub fn zeroize_file_ref(file: &mut FileRef) {
    file.key.zeroize();
    if let Some(thumb) = file.thumb.as_mut() {
        thumb.zeroize();
    }
}

pub fn group_convo(gid: &str) -> String {
    format!("grp:{}", gid)
}

/// How fresh an undecryptable event must be to be allowed to tear down a
/// session (see the auto-heal path). Wide enough to absorb clock skew between
/// peers, far tighter than the 24h catch-up window an attacker would replay
/// from. NOTE: if outgoing timestamps ever get jittered (NIP-17), this must be
/// >= that jitter or legitimate desyncs will stop healing.
pub const AUTO_HEAL_MAX_AGE_SECS: i64 = 600;

/// The largest `["EVENT", …]` frame a relay takes. Relays drop larger ones
/// without a word (strfry's `maxEventSize` is 64 KiB); a big inline preview
/// of a file used to go out that way, and never arrive.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;

#[derive(Serialize, Clone)]
pub struct IncomingMessageEvent {
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct HandshakeNeededEvent {
    pub from_pubkey: String,
}

#[derive(Serialize, Clone)]
pub struct IncomingGroupMessageEvent {
    pub gid: String,
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct FileMessageEvent {
    pub from_handle: String,
    pub gid: Option<String>,
    pub file: FileRef,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct CallSignalEvent {
    pub from_handle: String,
    pub payload: String,
}

/// What `lock_vault` and `wipe` drop from memory: the relay connections,
/// the secrets and any request for TURN credentials in flight.
pub fn forget_session(inner: &mut InnerState, turn: &TurnGate) {
    for relay in inner.relays.drain(..) {
        relay.close();
    }
    clear_sensitive_state(inner);
    turn.clear();
}

pub fn clear_sensitive_state(inner: &mut InnerState) {
    // Both callers already drop `relays`; the inspector's sockets are closed
    // here so locking or wiping can never leave a connection behind.
    for client in inner.inspector_relays.drain(..) {
        client.close();
    }
    if let Some(secret) = inner.totp_secret.as_mut() {
        secret.zeroize();
    }
    inner.totp_secret = None;
    inner.totp_enrollment.clear();
    // The storage holds the data key: taken out, it is dropped and wiped,
    // and nothing is written until the next unlock.
    drop(inner.storage.take());

    for ratchet in inner.ratchets.values_mut() {
        ratchet.zeroize_secrets();
    }
    inner.ratchets.clear();
    for ad in inner.associated_data.values_mut() {
        ad.zeroize();
    }
    inner.associated_data.clear();

    for items in inner.history.values_mut() {
        for item in items {
            if let Some(text) = item.text.as_mut() {
                text.zeroize();
            }
            if let Some(file) = item.file.as_mut() {
                zeroize_file_ref(file);
            }
        }
    }
    inner.history.clear();

    for items in inner.outbox.values_mut() {
        for (id, envelope, _) in items {
            id.zeroize();
            envelope.zeroize();
        }
    }
    inner.outbox.clear();

    if let Some(avatar) = inner.avatar.as_mut() {
        avatar.zeroize();
    }
    for friend in inner.friends.values_mut() {
        if let Some(avatar) = friend.avatar.as_mut() {
            avatar.zeroize();
        }
    }
    for roster in inner.groups.values_mut() {
        if let Some(photo) = roster.photo.as_mut() {
            zeroize_file_ref(photo);
        }
    }
    for invite in inner.group_invites.values_mut() {
        if let Some(photo) = invite.roster.photo.as_mut() {
            zeroize_file_ref(photo);
        }
    }

    crate::storage::zeroize_names(inner);
    inner.identity = None;
    inner.handle = None;
    inner.avatar = None;
    inner.relay_urls.clear();
    inner.created_at = 0;
    inner.friends.clear();
    inner.groups.clear();
    inner.group_invites.clear();
    inner.blocked.clear();
    inner.current_peer = None;
    inner.resync_at.clear();
    inner.handshake_marks.clear();
    inner.clear_seen_ids();
    // -- W8 --
    inner.key_mismatch_at.clear();
    inner.profiles.forget();
}

/// The relay connections of a session `open_session` just opened: what
/// the host spawns once the session is open (`relay_starter` in the app).
///
/// Every relay gets its client at once (K3). One that is down keeps being
/// tried while the session is open, instead of being given up until the next
/// unlock, and counts as down in `connection_status` meanwhile. Whenever a
/// socket comes up or goes down, the UI gets a debounced
/// `connection-changed`. Each relay is opened by `connector`, through the
/// app's `Net`. The events go to `events`, and what is received may send
/// the profile again through `resend_profile` (`handle_incoming_event`).
#[allow(clippy::too_many_arguments)]
pub async fn connect_relays(
    events: Arc<dyn EventSink>,
    resend_profile: profile::Resend,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
    connector: Connector,
    ready: ReadyGate,
    net: Arc<trino_net::Net>,
    relays: Vec<String>,
    expected_nostr_pub: String,
    expected_handle: String,
) {
    let changes = Arc::new(connection_changes(Arc::clone(&events), state_inner.clone()));
    let mut clients = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for relay_url in relays {
        if !seen.insert(relay_url.clone()) {
            continue;
        }
        let on_event = incoming_events(
            Arc::clone(&events),
            Arc::clone(&resend_profile),
            state_inner.clone(),
        );
        let on_state: StateHandler = {
            let changes = Arc::clone(&changes);
            Arc::new(move |_up| changes.poke())
        };
        let options = relay_options(&relay_url, &connector, &ready, &net, Some(on_state));
        let client = NostrClient::start(&relay_url, on_event, options);
        // Catch up on messages sent while this device was offline: the
        // whole window on the first connection, and on every reconnect
        // only what this relay may not have delivered yet (so the window
        // does not grow with uptime). Duplicate event ids and ratchet
        // state are checked before anything reaches the UI. Sent once the
        // socket is up.
        let _ = client
            .subscribe_catching_up(
                &NostrFilter {
                    kinds: Some(vec![TRINO_KIND]),
                    p_tag: Some(vec![expected_nostr_pub.clone()]),
                    ..Default::default()
                },
                CatchUp {
                    max_window_secs: CATCH_UP_WINDOW_SECS,
                    overlap_secs: CLOCK_SKEW_SECS,
                },
            )
            .await;
        clients.push(client);
    }

    let mut inner = state_inner.lock().await;
    let same_identity = inner
        .identity
        .as_ref()
        .is_some_and(|identity| hex::encode(identity.nostr.pub_bytes) == expected_nostr_pub)
        && inner.handle.as_deref() == Some(expected_handle.as_str());
    if same_identity {
        inner.relays.extend(clients);
        drop(inner);
        // The UI learns how many relays there are before any is up.
        changes.poke();
    } else {
        drop(inner);
        for client in clients {
            client.close();
        }
    }
}

/// How a session's client of `relay_url` connects through `net`: with its
/// deadline, once `net` is ready (Tor design §2.4), and opened again the
/// other way whenever `net` goes without Tor or back to it, so the sockets
/// already open move too (§2.8, design test 15).
pub fn relay_options(
    relay_url: &str,
    connector: &Connector,
    ready: &ReadyGate,
    net: &trino_net::Net,
    on_state: Option<StateHandler>,
) -> ClientOptions {
    ClientOptions {
        connect_deadline: relay_deadline(relay_url),
        ready: Some(Arc::clone(ready)),
        route: Some(net.route()),
        ..ClientOptions::new(Arc::clone(connector), on_state)
    }
}

/// What a relay of the session delivers goes to `handle_incoming_event`.
pub fn incoming_events(
    events: Arc<dyn EventSink>,
    resend_profile: profile::Resend,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
) -> Arc<dyn Fn(NostrEvent) + Send + Sync> {
    Arc::new(move |event: NostrEvent| {
        let events = Arc::clone(&events);
        let resend_profile = Arc::clone(&resend_profile);
        let inner = state_inner.clone();
        tokio::spawn(async move {
            handle_incoming_event(&*events, &resend_profile, inner, event).await;
        });
    })
}

/// Emits `connection-changed` with the status of the session's relays at
/// most once per `DEBOUNCE` (K3).
pub fn connection_changes(
    events: Arc<dyn EventSink>,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
) -> Debouncer {
    Debouncer::spawn(DEBOUNCE, move || {
        let events = Arc::clone(&events);
        let inner = state_inner.clone();
        async move {
            let status = ConnectionStatus::of(&inner.lock().await.relays);
            events.emit(CONNECTION_CHANGED_EVENT, &status);
        }
    })
}

/// What the transport relay can see about one event. Deliberately metadata
/// only: the id, who published it, who it is addressed to, its size and its
/// timestamp — exactly what a relay operator already observes. The encrypted
/// content is never included.
#[derive(Clone, Serialize)]
pub struct RelayObservation {
    pub relay: String,
    pub id: String,
    pub from: String,
    pub to: String,
    pub size: usize,
    pub created_at: i64,
}

/// `relay_inspect_start`: read-only connections to the relays this device
/// is actually using, each telling `events` the metadata it can see.
///
/// These are separate sockets from the messaging ones on purpose. The inspector
/// subscribes to all trino traffic — that is the whole point, showing that the
/// relay sees blobs it cannot read — whereas the messaging subscription is
/// filtered to events addressed to us. Feeding strangers' events into the
/// decryption pipeline would be wasteful at best and a footgun at worst.
pub async fn inspect_relays(
    state: &Engine,
    events: Arc<dyn EventSink>,
) -> Result<Vec<String>, String> {
    let urls: Vec<String> = {
        let mut inner = state.inner.lock().await;
        // Drop anything left over from a previous inspection first.
        for client in inner.inspector_relays.drain(..) {
            client.close();
        }
        inner.relays.iter().map(|c| c.url().to_string()).collect()
    };
    if urls.is_empty() {
        return Err("no relay connections to inspect".to_string());
    }

    // The inspector's own session and tokens: its connections never share a
    // Tor circuit with the messaging ones (Tor design §2.7, R2).
    let connector = inspector_connector(Arc::clone(&state.net), state.net.session());
    let mut connected = Vec::new();
    for url in urls {
        let on_event = inspector_events(Arc::clone(&events), url.clone());

        let options = ClientOptions {
            route: Some(state.net.route()),
            ..ClientOptions::new(Arc::clone(&connector), None)
        };
        match NostrClient::connect_with(&url, on_event, options).await {
            Ok(client) => {
                let _ = client
                    .subscribe(&NostrFilter {
                        kinds: Some(vec![TRINO_KIND]),
                        limit: Some(40),
                        ..Default::default()
                    })
                    .await;
                state.inner.lock().await.inspector_relays.push(client);
                connected.push(url);
            }
            Err(_) => dbg_log("  inspector relay connection failed"),
        }
    }

    if connected.is_empty() {
        return Err("could not reach any relay".to_string());
    }
    Ok(connected)
}

/// What the inspector's connection to `relay` sees goes to the UI as
/// `relay-event`, its metadata only (`RelayObservation`).
pub fn inspector_events(
    events: Arc<dyn EventSink>,
    relay: String,
) -> Arc<dyn Fn(NostrEvent) + Send + Sync> {
    Arc::new(move |event: NostrEvent| {
        let to = event.recipient().unwrap_or_default().to_string();
        events.emit(
            "relay-event",
            &RelayObservation {
                relay: relay.clone(),
                id: event.id.clone(),
                from: event.pubkey.clone(),
                to,
                size: event.content.len(),
                created_at: event.created_at,
            },
        );
    })
}

/// `relay_inspect_stop`: the inspector's connections closed.
pub async fn stop_inspecting(state: &Engine) {
    let mut inner = state.inner.lock().await;
    for client in inner.inspector_relays.drain(..) {
        client.close();
    }
}

/// `connect_node`: a session with the contact `handle`, its handshake sent,
/// unless there is one already; either way `handle` becomes the current peer.
pub async fn connect(state: &Engine, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    if inner.ratchets.contains_key(&handle) {
        inner.current_peer = Some(handle);
        return Ok(());
    }

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    send_cipher_inner(state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// `resync_session`: a fresh handshake with `handle`, whatever session
/// there was.
pub async fn resync(state: &Engine, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    inner.ratchets.remove(&handle);
    inner.associated_data.remove(&handle);

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    dbg_log("RESYNC: forcing a fresh handshake");
    send_cipher_inner(state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Establish a pairwise session with `handle` (initiate + send handshake) if none.
pub async fn ensure_session(state: &Engine, handle: &str) -> Result<(), SendError> {
    let failed = |e: &dyn std::fmt::Display| SendError::Failed(e.to_string());
    let handshake = {
        let mut inner = state.inner.lock().await;
        if inner.ratchets.contains_key(handle) {
            return Ok(());
        }
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?.clone();
        let friend = inner
            .friends
            .get(handle)
            .ok_or(SendError::UnknownContact)?
            .clone();
        let init = initiate(&identity, &friend.bundle).map_err(|e| failed(&e))?;
        let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| failed(&e))?;
        let ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| failed(&e))?;
        inner.ratchets.insert(handle.to_string(), ratchet);
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data.clone());
        save_ratchets(&inner);
        WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        }
    };
    publish_sealed(state, handle, b"__trino_handshake__", Some(handshake)).await
}

/// `ensure_session`, for the callers that answer with a string.
pub async fn ensure_session_inner(state: &Engine, handle: &str) -> Result<(), String> {
    ensure_session(state, handle)
        .await
        .map_err(|e| e.to_string())
}

pub fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Encrypt `plaintext` for `handle` into a signed event dated `created_at`
/// (now when `None`), and return it with the relays to send it to.
///
/// Every outgoing message of a contact passes here. A text, group or file
/// message also says that this Trino reads profiles, and which revision of
/// the contact's profile it holds (K12, `profile::with_caps`); the rest goes
/// as it is. The session moves on only when the event fits a relay
/// (`MAX_EVENT_BYTES`), so a message refused for its size costs no ratchet
/// step. With `need_relay_up`, nothing is encrypted while no relay is up.
pub async fn seal_for(
    state: &Engine,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
    created_at: Option<i64>,
    need_relay_up: bool,
) -> Result<(NostrEvent, Vec<Arc<NostrClient>>), SendError> {
    let failed = |e: &dyn std::fmt::Display| SendError::Failed(e.to_string());
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
    let signing_key = Zeroizing::new(identity.nostr.priv_bytes);
    let signing_pub = identity.nostr.pub_bytes;
    let recipient = inner
        .friends
        .get(handle)
        .ok_or(SendError::UnknownContact)?
        .bundle
        .nostr_pub
        .clone();
    let relays = inner.relays.clone();
    if relays.is_empty() {
        return Err(SendError::NoRelays);
    }
    let ad = inner
        .associated_data
        .get(handle)
        .ok_or(SendError::NoSession)?
        .clone();
    // A copy: the session itself only moves on once the event fits.
    let mut ratchet = inner
        .ratchets
        .get(handle)
        .ok_or(SendError::NoSession)?
        .clone();
    if need_relay_up && !relays.iter().any(|relay| relay.is_connected()) {
        return Err(SendError::Offline);
    }

    let plaintext = profile::with_caps(&inner.profiles, handle, plaintext);
    let ct: EncryptedMessage =
        ratchet_encrypt(&mut ratchet, &plaintext, &ad).map_err(|e| failed(&e))?;
    let is_handshake = handshake.is_some();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: ct.header.dh_pub,
            pn: ct.header.pn,
            n: ct.header.n,
        },
        nonce: ct.nonce,
        ciphertext: ct.ciphertext,
        handshake,
    };
    let payload_json = serde_json::to_string(&payload).map_err(|e| failed(&e))?;
    let event = build_and_sign_event(
        &signing_key,
        &signing_pub,
        TRINO_KIND,
        &payload_json,
        vec![vec!["p".to_string(), recipient]],
        created_at,
    )
    .map_err(|e| failed(&e))?;
    if event_frame_bytes(&event) > MAX_EVENT_BYTES {
        // The advanced copy of the session is dropped, and wiped with it.
        return Err(SendError::TooLong);
    }

    inner.ratchets.insert(handle.to_string(), ratchet);
    save_ratchets(&inner); // sending chain advanced — persist it
    drop(inner);
    crate::diag::note_with(
        "send",
        &[("handshake", &is_handshake), ("relays", &relays.len())],
    );
    Ok((event, relays))
}

/// The size of `event` as a relay receives it.
pub fn event_frame_bytes(event: &NostrEvent) -> usize {
    serde_json::json!(["EVENT", event]).to_string().len()
}

/// Encrypt and publish without waiting for any relay: handshakes, call
/// signals, rosters and resends, as before K4. A relay that is down gets it
/// once it is back.
pub async fn publish_sealed(
    state: &Engine,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
) -> Result<(), SendError> {
    let (event, relays) = seal_for(state, handle, plaintext, handshake, None, false).await?;
    for relay in &relays {
        let _ = relay.publish(&event).await;
    }
    Ok(())
}

/// `publish_sealed`, for the callers that answer with a string.
pub async fn send_cipher_inner(
    state: &Engine,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
) -> Result<(), String> {
    publish_sealed(state, handle, plaintext, handshake)
        .await
        .map_err(|e| e.to_string())
}

/// What a relay of the session delivered: admitted, decrypted and kept, and
/// told to the UI through `events`. A contact holding an older profile gets
/// ours again through `resend_profile`.
pub async fn handle_incoming_event(
    events: &dyn EventSink,
    resend_profile: &profile::Resend,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
    event: NostrEvent,
) {
    dbg_log("RECV event");
    let mut inner = state_inner.lock().await;
    let identity = match &inner.identity {
        Some(i) => i.clone(),
        None => {
            dbg_log("  DROP: vault sealed (no identity in memory)");
            return;
        }
    };
    let my_pub = hex::encode(identity.nostr.pub_bytes);
    let friend = match admit_event(&mut inner, &event, &my_pub) {
        Admission::Process(friend) => *friend,
        Admission::Stranger => {
            dbg_log("  DROP: sender not a known friend -> emitting handshake-needed");
            events.emit(
                "handshake-needed",
                &HandshakeNeededEvent {
                    from_pubkey: event.pubkey.clone(),
                },
            );
            return;
        }
        Admission::Drop(reason) => {
            dbg_log(reason);
            return;
        }
    };
    // Persist the event id (only a contact's, see admit_event) before
    // processing, so a restart cannot process the same event twice. This is
    // dedup, not replay protection: the cache is bounded, which is why
    // handshakes also pass `judge_handshake`.
    save_ratchets(&inner);
    dbg_log("  sender is a contact");

    let payload: WirePayload = match serde_json::from_str(&event.content) {
        Ok(p) => p,
        Err(_) => {
            dbg_log("  DROP: payload JSON parse failed");
            return;
        }
    };

    if let Some(hs) = &payload.handshake {
        // PINNING (TOFU): the identity DH key in an incoming handshake must match
        // the one we pinned when we added this contact. The ik_dh_pub is stable
        // (only ek/spk rotate), so a legit re-handshake or auto-heal always
        // matches — a mismatch means someone is trying to silently replace the
        // session with a different identity. Reject it.
        if hs.ik_dh_pub != friend.bundle.ik_dh_pub {
            dbg_log(
                "  DROP: handshake ik_dh_pub does not match the pinned bundle (impersonation?)",
            );
            // K8: the UI says so, at most once every 10 minutes per contact.
            // The handshake is still dropped.
            let now = chrono::Utc::now().timestamp();
            if crate::contacts::should_report_key_mismatch(
                &mut inner.key_mismatch_at,
                &friend.handle,
                now,
            ) {
                events.emit(
                    "contact-key-mismatch",
                    &crate::contacts::ContactKeyMismatchEvent {
                        handle: friend.handle.clone(),
                    },
                );
            }
            return;
        }
        // REPLAY GATE: relay traffic is public and the dedup cache is bounded,
        // so an old handshake of this contact can be fed to us again. Only a
        // fresh one that is newer than every handshake already accepted from
        // them may (re)start a session. The event and its ciphertext are
        // dropped with it: they belong to a session we are not going to have.
        let now = chrono::Utc::now().timestamp();
        let mark = inner.handshake_marks.get(&friend.bundle.nostr_pub);
        if let Err(rejection) = judge_handshake(mark, event.created_at, &hs.ek_pub, now) {
            match rejection {
                HandshakeRejection::Stale { age } => {
                    crate::diag::note_with("  DROP: stale handshake", &[("age_s", &age)])
                }
                HandshakeRejection::FromTheFuture { ahead } => crate::diag::note_with(
                    "  DROP: handshake from the future",
                    &[("ahead_s", &ahead)],
                ),
                HandshakeRejection::NotNewer { .. } => {
                    dbg_log("  DROP: handshake not newer than the last one accepted")
                }
            }
            return;
        }
        record_handshake(
            &mut inner.handshake_marks,
            &friend.bundle.nostr_pub,
            event.created_at,
            &hs.ek_pub,
        );
        save_ratchets(&inner); // the mark must survive a restart
        let have_session = inner.ratchets.contains_key(&friend.handle);
        // Glare resolution: if BOTH peers initiated a handshake at the same time we
        // end up with two incompatible sessions. Deterministic tie-break: the
        // session initiated by the LOWER nostr pubkey wins. So if the peer's pubkey
        // sorts below ours, we YIELD — accept their handshake and replace our own.
        let peer_wins = friend.bundle.nostr_pub.as_str() < my_pub.as_str();
        crate::diag::note_with(
            "  handshake present",
            &[
                ("spk_id", &hs.spk_id),
                ("has_session", &have_session),
                ("peer_wins", &peer_wins),
            ],
        );
        if !have_session || peer_wins {
            let (identity_after, ratchet, associated_data) =
                match respond_to_handshake(&identity, hs) {
                    Ok(answer) => answer,
                    Err(_) => {
                        dbg_log("  DROP: X3DH respond() failed");
                        return;
                    }
                };
            inner.identity = Some(identity_after);
            inner.ratchets.insert(friend.handle.clone(), ratchet);
            inner
                .associated_data
                .insert(friend.handle.clone(), associated_data);
            save_ratchets(&inner);
            dbg_log("  responder ratchet established");
            // Fresh session: replay any buffered outgoing so messages the peer
            // lost during the desync get re-delivered (deduped by id).
            events.emit("session-established", &friend.handle);
        }
    }

    let ad = match inner.associated_data.get(&friend.handle).cloned() {
        Some(a) => a,
        None => {
            dbg_log("  DROP: no associated_data (no session) — auto-healing");
            trigger_resync(&mut inner, events, &friend.handle);
            return;
        }
    };
    let has_ratchet = inner.ratchets.contains_key(&friend.handle);
    if !has_ratchet {
        dbg_log("  DROP: no ratchet for friend — auto-healing");
        trigger_resync(&mut inner, events, &friend.handle);
        return;
    }
    let ratchet = inner.ratchets.get_mut(&friend.handle).unwrap();
    let msg = EncryptedMessage {
        header: MessageHeader {
            dh_pub: payload.header.dh_pub,
            pn: payload.header.pn,
            n: payload.header.n,
        },
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
    };
    let plain = match ratchet_decrypt(ratchet, &msg, &ad) {
        Ok(p) => p,
        Err(RatchetError::Replay { .. }) => {
            crate::diag::note_with(
                "  skip: replayed ciphertext",
                &[("n", &msg.header.n), ("pn", &msg.header.pn)],
            );
            return;
        }
        Err(_) => {
            crate::diag::note_with(
                "  DROP: ratchet_decrypt failed",
                &[("n", &msg.header.n), ("pn", &msg.header.pn)],
            );
            // AUTO-HEAL: a decrypt failure means our ratchet diverged from the
            // peer's (a lost message, a crash mid-save, call-signal flooding…).
            // Drop the broken session and ask the UI to re-handshake. The
            // deterministic pubkey tie-break then reconverges both sides on one
            // session. Rate-limited so a burst of undecryptable events (or a
            // hostile sender) can't trigger a re-handshake storm.
            //
            // FRESHNESS GATE (anti-DoS): only a RECENT undecryptable message may
            // tear down a session. Relay traffic is public, so anyone could
            // record an old ciphertext of ours, flood `seen_events` until its id
            // is evicted, and replay it — it is too old to be caught by the
            // replay detector, fails AEAD, and would wipe the session. Repeat
            // forever = permanent loss of service. Genuine desyncs surface on
            // live messages; stale ones from the 24h catch-up window are just
            // dropped.
            let now = chrono::Utc::now().timestamp();
            let age = now - event.created_at;
            if !(-AUTO_HEAL_MAX_AGE_SECS..=AUTO_HEAL_MAX_AGE_SECS).contains(&age) {
                crate::diag::note_with(
                    "  stale undecryptable event dropped without auto-heal",
                    &[("age_s", &age)],
                );
                return;
            }
            let last = *inner.resync_at.get(&friend.handle).unwrap_or(&0);
            if now - last > 20 {
                inner.resync_at.insert(friend.handle.clone(), now);
                inner.ratchets.remove(&friend.handle);
                inner.associated_data.remove(&friend.handle);
                save_ratchets(&inner);
                dbg_log("  AUTO-HEAL: cleared a desynced session, requesting resync");
                events.emit("resync-needed", &friend.handle);
            }
            return;
        }
    };
    save_ratchets(&inner); // receiving chain advanced — persist it
    if plain == b"__trino_handshake__" {
        dbg_log("  OK: handshake message decrypted (no UI emit)");
        return;
    }
    // -- W8 (K12) -- A profile message ends here, never as text; text, group
    // and file messages say whether their sender reads profiles.
    if profile::on_message(
        events,
        resend_profile,
        &mut inner,
        &friend.handle,
        &plain,
        event.created_at,
    ) {
        return;
    }

    match decode_envelope(&plain) {
        Envelope::Text { body, id } => {
            // Drop duplicates (a resend after auto-heal replays the same id).
            if !id.is_empty() && !inner.remember_message_id(id.clone()) {
                dbg_log("  skip: duplicate message id");
                return;
            }
            save_ratchets(&inner);
            dbg_log("  OK: text received");
            record_history(
                &mut inner,
                friend.handle.clone(),
                HistItem {
                    side: "them".into(),
                    from: None,
                    text: Some(body.clone()),
                    file: None,
                    call: None,
                    ts: event.created_at,
                },
            );
            events.emit(
                "message-received",
                &IncomingMessageEvent {
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Group { gid, ep: _, body } => {
            let allowed = inner
                .groups
                .get(&gid)
                .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                .unwrap_or(false);
            if !allowed {
                dbg_log("  DROP: group message from a non-member");
                return;
            }
            dbg_log("  OK: group message received");
            record_history(
                &mut inner,
                group_convo(&gid),
                HistItem {
                    side: "them".into(),
                    from: Some(friend.handle.clone()),
                    text: Some(body.clone()),
                    file: None,
                    call: None,
                    ts: event.created_at,
                },
            );
            events.emit(
                "group-message",
                &IncomingGroupMessageEvent {
                    gid,
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Roster { roster } => {
            accept_incoming_roster(events, &mut inner, &identity, &friend, roster);
        }
        Envelope::File { file, gid, body: _ } => {
            let file = sanitize_file_ref(file);
            if let Some(g) = &gid {
                let allowed = inner
                    .groups
                    .get(g)
                    .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                    .unwrap_or(false);
                if !allowed {
                    dbg_log("  DROP: group file from non-member");
                    return;
                }
            }
            dbg_log("  OK: file received");
            let convo = match &gid {
                Some(g) => group_convo(g),
                None => friend.handle.clone(),
            };
            let from = gid.as_ref().map(|_| friend.handle.clone());
            record_history(
                &mut inner,
                convo,
                HistItem {
                    side: "them".into(),
                    from,
                    text: None,
                    file: Some(file.clone()),
                    call: None,
                    ts: event.created_at,
                },
            );
            events.emit(
                "file-message",
                &FileMessageEvent {
                    from_handle: friend.handle.clone(),
                    gid,
                    file,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Call { call } => {
            // Call signals (SDP offer/answer, ICE) are only meaningful in real
            // time. The catch-up subscription delivers old ones again after a
            // restart or reconnect, so a stale offer would occupy the call
            // state and make live calls read
            // as "busy". Drop stale/future-dated and malformed signals.
            let age = chrono::Utc::now().timestamp() - event.created_at;
            if !(-60..=60).contains(&age) {
                crate::diag::note_with("  stale call signal ignored", &[("age_s", &age)]);
            } else if validate_call_signal(&call).is_err() {
                dbg_log("  invalid call signal ignored");
            } else {
                dbg_log("  call signal received");
                events.emit(
                    "call-signal",
                    &CallSignalEvent {
                        from_handle: friend.handle.clone(),
                        payload: call,
                    },
                );
            }
        }
    }
}

pub const HISTORY_CAP: usize = 500; // keep last N per conversation (bounds the file)

/// The key earlier versions seal history.bin and ratchets.bin with, which an
/// account not moved to the store yet still uses. A derivation that fails is
/// an error, never a key anyone could seal with (TRN-ENG-09).
pub fn derive_history_key(identity: &Identity) -> std::io::Result<Zeroizing<[u8; 32]>> {
    legacy_key(crate::crypto::hkdf_expand(
        &identity.ik_sign.priv_bytes,
        &[0u8; 32],
        b"trino-history-key-v1",
        32,
    ))
}

/// A legacy key from what HKDF gave: 32 bytes, not all zero. A failed
/// derivation, another length or all zeros are an error, so no path turns
/// them into a key (TRN-ENG-09).
pub(crate) fn legacy_key<E: std::fmt::Display>(
    okm: Result<Vec<u8>, E>,
) -> std::io::Result<Zeroizing<[u8; 32]>> {
    let okm = Zeroizing::new(okm.map_err(|error| std::io::Error::other(error.to_string()))?);
    let mut key = Zeroizing::new([0u8; 32]);
    if okm.len() != key.len() {
        return Err(std::io::Error::other("a legacy key is 32 bytes"));
    }
    key.copy_from_slice(&okm);
    if key.iter().all(|byte| *byte == 0) {
        return Err(std::io::Error::other("an all-zero legacy key"));
    }
    Ok(key)
}

pub fn save_history(inner: &InnerState) {
    // Not fatal, as before: a failed write keeps the previous history whole,
    // and the next save writes everything again.
    if write_history(inner).is_err() {
        dbg_log("the history could not be saved");
    }
}

/// Save the history where the session keeps it, sealed. With no session
/// nothing is written.
pub fn write_history(inner: &InnerState) -> std::io::Result<()> {
    let json = Zeroizing::new(serde_json::to_vec(&inner.history).map_err(std::io::Error::other)?);
    inner.storage.write_history(&json)
}

/// The history unlocking found. One that opens but does not read is held:
/// never written over this session (H2).
pub fn load_history(inner: &mut InnerState, found: Found) {
    let Found::Ready(json) = found else {
        return;
    };
    match serde_json::from_slice::<HashMap<String, Vec<HistItem>>>(&json) {
        Ok(mut history) => {
            for items in history.values_mut() {
                for item in items {
                    if let Some(file) = item.file.take() {
                        item.file = Some(sanitize_file_ref(file));
                    }
                }
            }
            inner.history = history;
        }
        Err(_) => {
            dbg_log("the history does not read: kept as it is");
            inner.storage.hold(&Slot::History);
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
pub struct RatchetsFile {
    pub ratchets: HashMap<String, crate::ratchet::RatchetState>,
    #[serde(default)]
    pub associated_data: HashMap<String, Vec<u8>>,
    #[serde(default)]
    pub seen_events: Vec<String>,
    #[serde(default)]
    pub seen_msg_ids: Vec<String>,
    /// Defaulted so files written before the handshake replay gate still
    /// load; such contacts start without a mark (see HANDSHAKE_MAX_AGE_SECS).
    #[serde(default)]
    pub handshake_marks: HashMap<String, HandshakeMark>,
}

impl RatchetsFile {
    pub fn from_state(inner: &InnerState) -> Self {
        RatchetsFile {
            ratchets: inner.ratchets.clone(),
            associated_data: inner.associated_data.clone(),
            seen_events: inner.seen_event_order.iter().cloned().collect(),
            seen_msg_ids: inner.seen_msg_id_order.iter().cloned().collect(),
            handshake_marks: inner.handshake_marks.clone(),
        }
    }

    pub fn restore_into(self, inner: &mut InnerState) {
        inner.ratchets = self.ratchets;
        inner.associated_data = self.associated_data;
        inner.handshake_marks = self.handshake_marks;
        inner.clear_seen_ids();
        for id in self.seen_events {
            inner.remember_event(id);
        }
        for id in self.seen_msg_ids {
            inner.remember_message_id(id);
        }
    }
}

/// Persist the Double Ratchet sessions (+ associated data) ENCRYPTED to disk so
/// they survive app restarts. Without this, every restart forces a fresh X3DH
/// handshake and desyncs the peer (messages silently fail to decrypt).
pub fn save_ratchets(inner: &InnerState) {
    let file = RatchetsFile::from_state(inner);
    let Ok(json) = serde_json::to_vec(&file).map(Zeroizing::new) else {
        return;
    };
    // Not fatal, as before: a failed write keeps the previous sessions
    // whole, and the next save writes every session again.
    if inner.storage.write_sessions(&json).is_err() {
        dbg_log("the sessions could not be saved");
    }
}

/// The sessions unlocking found. Ones that open but do not read are held,
/// and every contact gets a new session as it writes.
pub fn load_ratchets(inner: &mut InnerState, found: Found) {
    let Found::Ready(json) = found else {
        return;
    };
    match serde_json::from_slice::<RatchetsFile>(&json) {
        Ok(file) => file.restore_into(inner),
        Err(_) => {
            dbg_log("the sessions do not read: kept as they are");
            inner.storage.hold(&Slot::Sessions);
        }
    }
}

/// Auto-heal a broken/absent session: drop it and ask the UI to re-handshake
/// (rate-limited per peer). Covers both decrypt failures (AEAD) and the
/// "peer thinks we have a session but we don't" case. The tie-break reconverges
/// and buffered messages get replayed, so nothing is lost.
pub fn trigger_resync(inner: &mut InnerState, events: &dyn EventSink, handle: &str) {
    let now = chrono::Utc::now().timestamp();
    let last = *inner.resync_at.get(handle).unwrap_or(&0);
    if now - last <= 20 {
        return;
    }
    inner.resync_at.insert(handle.to_string(), now);
    inner.ratchets.remove(handle);
    inner.associated_data.remove(handle);
    save_ratchets(inner);
    dbg_log("  AUTO-HEAL: requesting resync");
    events.emit("resync-needed", handle);
}

/// Unique-enough message id for dedup (ts + a process counter, hashed).
pub fn new_msg_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = chrono::Utc::now().timestamp_millis();
    let h = crate::crypto::sha256(format!("{ts}:{n}").as_bytes());
    hex::encode(&h[..8])
}

pub fn record_history(inner: &mut InnerState, convo: String, item: HistItem) {
    let v = inner.history.entry(convo).or_default();
    v.push(item);
    if v.len() > HISTORY_CAP {
        let excess = v.len() - HISTORY_CAP;
        v.drain(0..excess);
    }
    save_history(inner);
}

#[cfg(test)]
pub(crate) mod tests {
    //! The session's own tests, and helpers the other modules' tests share
    //! (M4-0c: from the app's commands.rs).

    use super::*;
    use crate::envelope::encode_envelope;
    use crate::group::{GroupRoster, MemberBundle};
    use crate::identity::{create_identity, public_bundle_for};
    use crate::nostr::test_relay::{Answer, TestRelay};
    use crate::ratchet::RatchetState;
    use crate::state::FriendRecord;

    pub(crate) const NOW: i64 = 1_760_000_000;

    pub(crate) fn ik(id: &Identity) -> String {
        hex::encode(id.ik_sign.pub_bytes)
    }

    pub(crate) fn member(id: &Identity, handle: &str) -> MemberBundle {
        MemberBundle::from_public_bundle(handle, &public_bundle_for(id))
    }

    pub(crate) fn friend(id: &Identity, handle: &str) -> FriendRecord {
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

    /// A roster built by the admin's honest client.
    pub(crate) fn roster_of(admin: &Identity, others: &[(&Identity, &str)]) -> GroupRoster {
        let mut roster = group::create_group(admin, member(admin, "admin"), "amigos").unwrap();
        for (id, handle) in others {
            roster = group::add_member(&roster, admin, member(id, handle)).unwrap();
        }
        roster
    }

    /// `add_session`, plus the contact's own side of that session, so a test
    /// reads what was sent as the contact's Trino would.
    pub(crate) fn add_session_read_by(
        inner: &mut InnerState,
        me: &Identity,
        contact: &Identity,
        handle: &str,
    ) -> (RatchetState, Vec<u8>) {
        inner
            .friends
            .insert(handle.to_string(), friend(contact, handle));
        let bundle = public_bundle_for(contact);
        let init = initiate(me, &bundle).unwrap();
        let spk = decode_array_32(&bundle.spk_pub).unwrap();
        inner.ratchets.insert(
            handle.to_string(),
            init_initiator(init.master_secret, spk).unwrap(),
        );
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data);
        let handshake = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };
        let (_, ratchet, associated_data) = respond_to_handshake(contact, &handshake).unwrap();
        (ratchet, associated_data)
    }

    /// What `event` carries, decrypted by its recipient's side of the session.
    pub(crate) fn opened_by(event: &NostrEvent, ratchet: &mut RatchetState, ad: &[u8]) -> Vec<u8> {
        let payload: WirePayload = serde_json::from_str(&event.content).unwrap();
        let message = EncryptedMessage {
            header: MessageHeader {
                dh_pub: payload.header.dh_pub,
                pn: payload.header.pn,
                n: payload.header.n,
            },
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
        };
        ratchet_decrypt(ratchet, &message, ad).unwrap()
    }

    /// The unlocked session of `me`, sending through `relays`. It has no
    /// storage, so nothing is ever written to the real data directory.
    pub(crate) async fn sending_state(me: &Identity, relays: Vec<Arc<NostrClient>>) -> Engine {
        let state = Engine::default();
        {
            let mut inner = state.inner.lock().await;
            inner.identity = Some(me.clone());
            inner.handle = Some("me".to_string());
            inner.relays = relays;
        }
        state
    }

    fn state_with(friends: &[FriendRecord]) -> InnerState {
        let mut inner = InnerState::default();
        for f in friends {
            inner.friends.insert(f.handle.clone(), f.clone());
        }
        inner
    }

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
    fn handshake_marks_survive_a_restart() {
        let mut inner = state_with(&[]);
        record_handshake(&mut inner.handshake_marks, "alice", NOW, "ek-1");
        assert!(!inner.handshake_marks.is_empty());

        let saved = serde_json::to_vec(&RatchetsFile::from_state(&inner)).unwrap();
        let mut restarted = InnerState::default();
        serde_json::from_slice::<RatchetsFile>(&saved)
            .unwrap()
            .restore_into(&mut restarted);

        assert_eq!(restarted.handshake_marks, inner.handshake_marks);
    }

    #[test]
    fn a_ratchets_file_from_before_handshake_marks_still_loads() {
        let legacy =
            br#"{"ratchets":{},"associated_data":{},"seen_events":["e1"],"seen_msg_ids":[]}"#;
        let mut inner = InnerState::default();
        serde_json::from_slice::<RatchetsFile>(legacy)
            .unwrap()
            .restore_into(&mut inner);
        assert!(inner.handshake_marks.is_empty());
        assert!(inner.seen_events.contains("e1"));
    }
    #[tokio::test]
    async fn locking_or_wiping_voids_the_turn_requests_of_the_session() {
        use crate::turn::{TurnError, TurnServers};
        let servers = || async {
            Ok(TurnServers {
                ice_servers: Vec::new(),
                expires_at: NOW + 14_400,
            })
        };
        let turn = TurnGate::default();
        let session = turn.session();
        turn.request(session, servers).await.unwrap();

        forget_session(&mut InnerState::default(), &turn);

        // No request of the session before it may get credentials now.
        assert_eq!(turn.request(session, servers).await, Err(TurnError::Locked));
        assert_ne!(turn.session(), session);
    }

    #[tokio::test]
    async fn locking_stops_the_relays_still_trying_to_connect() {
        // K3: a relay that was down at unlock is tried again and again while
        // the session is open, and never after.
        use crate::nostr::test_relay::{unreachable_client, wait_until};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut inner = InnerState::default();
        inner.relays.push(unreachable_client(Arc::clone(&attempts)));
        wait_until("a second attempt", || attempts.load(Ordering::SeqCst) >= 2).await;

        forget_session(&mut inner, &TurnGate::default());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let after_lock = attempts.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        assert!(inner.relays.is_empty());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            after_lock,
            "it kept trying after the lock"
        );
    }

    #[tokio::test]
    async fn calls_rosters_handshakes_and_profiles_go_out_as_they_are() {
        use crate::nostr::test_relay::wait_until;
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob, carol) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        let (mut bob_side, ad, roster) = {
            let mut inner = state.inner.lock().await;
            let (bob_side, ad) = add_session_read_by(&mut inner, &me, &bob, "bob");
            // bob reads profiles, and revision 3 is this identity's.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: 7,
                    caps: profile::PROFILE_V,
                    ..Default::default()
                },
            );
            inner.profiles.rev = 3;
            // carol is a contact with no session yet.
            inner
                .friends
                .insert("carol".to_string(), friend(&carol, "carol"));
            (bob_side, ad, roster_of(&me, &[(&bob, "bob")]))
        };
        let call = encode_envelope(&Envelope::Call {
            call: r#"{"type":"bye"}"#.to_string(),
        });
        let roster = encode_envelope(&Envelope::Roster { roster });

        // A call signal and a roster, as send_call_signal and
        // groups_cmds::send_roster send them, this identity's profile,
        send_cipher_inner(&state, "bob", &call, None).await.unwrap();
        send_cipher_inner(&state, "bob", &roster, None)
            .await
            .unwrap();
        profile::send_profile(&state, vec!["bob".to_string()]).await;
        // and the handshake that opens a session with carol.
        ensure_session(&state, "carol").await.unwrap();
        wait_until("the four events", || relay.events().len() == 4).await;

        let events = relay.events();
        assert_eq!(opened_by(&events[0], &mut bob_side, &ad), call);
        assert_eq!(opened_by(&events[1], &mut bob_side, &ad), roster);
        // A profile message with anything more would be dropped as invalid.
        let profile_message = opened_by(&events[2], &mut bob_side, &ad);
        let mut bobs_profiles = profile::Profiles::default();
        let received = profile::receive(
            &mut bobs_profiles,
            "me",
            &profile_message,
            events[2].created_at,
        );
        assert!(received.consumed && received.save, "bob's Trino refused it");
        assert_eq!(bobs_profiles.contacts["me"].rev, 3);
        assert_eq!(bobs_profiles.contacts["me"].name.as_deref(), Some("me"));
        // carol reads the handshake as it was.
        let payload: WirePayload = serde_json::from_str(&events[3].content).unwrap();
        let (_, mut carol_side, carol_ad) =
            respond_to_handshake(&carol, payload.handshake.as_ref().unwrap()).unwrap();
        assert_eq!(
            opened_by(&events[3], &mut carol_side, &carol_ad),
            b"__trino_handshake__"
        );
    }

    // ---- M4-0b: what the session hears goes to the UI through the sink ----
    //
    // Each event under the name and with the JSON the UI got from Tauri's
    // `emit` before the sink: the payloads are written out here, field by
    // field and in order, as the frontend reads them (src/lib/api.ts).

    use crate::events::RecordingSink;

    /// A resend that only keeps whom it was asked to send the profile to.
    fn recording_resend() -> (profile::Resend, Arc<std::sync::Mutex<Vec<Vec<String>>>>) {
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let resend: profile::Resend = {
            let asked = Arc::clone(&asked);
            Arc::new(move |targets| asked.lock().unwrap().push(targets))
        };
        (resend, asked)
    }

    /// The unlocked session of `me`, with `contact` as `handle` and no
    /// session with them yet. No storage, so nothing is written to the real
    /// data directory.
    fn receiving(me: &Identity, contact: &Identity, handle: &str) -> InnerState {
        let mut inner = state_with(&[friend(contact, handle)]);
        inner.identity = Some(me.clone());
        inner.handle = Some("me".to_string());
        inner
    }

    /// `receiving`, holding the responder's side of a session `contact`
    /// started; with the contact's side, to write to `me` with.
    fn receiving_in_session(
        me: &Identity,
        contact: &Identity,
        handle: &str,
    ) -> (InnerState, RatchetState, Vec<u8>) {
        let mut theirs = InnerState::default();
        let (mine, ad) = add_session_read_by(&mut theirs, contact, me, "me");
        let their_side = theirs.ratchets.remove("me").unwrap();
        let mut inner = receiving(me, contact, handle);
        inner.ratchets.insert(handle.to_string(), mine);
        inner.associated_data.insert(handle.to_string(), ad.clone());
        (inner, their_side, ad)
    }

    /// `plain` as `sender`'s Trino sends it to `to`: encrypted with
    /// `ratchet` and `ad`, with `handshake`, signed and dated `created_at`.
    fn sealed_event(
        sender: &Identity,
        to: &Identity,
        ratchet: &mut RatchetState,
        ad: &[u8],
        plain: &[u8],
        handshake: Option<WireHandshake>,
        created_at: i64,
    ) -> NostrEvent {
        let ct = ratchet_encrypt(ratchet, plain, ad).unwrap();
        let payload = WirePayload {
            header: WireHeader {
                dh_pub: ct.header.dh_pub,
                pn: ct.header.pn,
                n: ct.header.n,
            },
            nonce: ct.nonce,
            ciphertext: ct.ciphertext,
            handshake,
        };
        build_and_sign_event(
            &sender.nostr.priv_bytes,
            &sender.nostr.pub_bytes,
            TRINO_KIND,
            &serde_json::to_string(&payload).unwrap(),
            vec![vec!["p".to_string(), nostr_hex(to)]],
            Some(created_at),
        )
        .unwrap()
    }

    /// `handle_incoming_event` on `event`, for `inner`: what the UI heard,
    /// and whom the profile was sent to again.
    async fn heard(
        inner: InnerState,
        event: NostrEvent,
    ) -> (Vec<(String, String)>, Vec<Vec<String>>, InnerState) {
        let sink = RecordingSink::new();
        let (resend, asked) = recording_resend();
        let inner = Arc::new(tokio::sync::Mutex::new(inner));
        handle_incoming_event(&*sink, &resend, Arc::clone(&inner), event).await;
        let asked = asked.lock().unwrap().clone();
        let inner = Arc::try_unwrap(inner).ok().unwrap().into_inner();
        (sink.events(), asked, inner)
    }

    fn named(name: &str, json: &str) -> (String, String) {
        (name.to_string(), json.to_string())
    }

    #[tokio::test]
    async fn a_text_from_a_contact_goes_to_the_ui_as_message_received() {
        let (me, bob) = (create_identity(), create_identity());
        let (inner, mut bob_side, ad) = receiving_in_session(&me, &bob, "bob");
        let plain = encode_envelope(&Envelope::Text {
            body: "hola \"tú\"".to_string(),
            id: "m1".to_string(),
        });
        let at = unix_now();
        let sent = sealed_event(&bob, &me, &mut bob_side, &ad, &plain, None, at);

        let (events, asked, inner) = heard(inner, sent).await;

        assert_eq!(
            events,
            [named(
                "message-received",
                &format!(r#"{{"from_handle":"bob","text":"hola \"tú\"","timestamp":{at}}}"#)
            )]
        );
        assert!(asked.is_empty(), "{asked:?}");
        assert_eq!(inner.history["bob"].len(), 1);
    }

    #[tokio::test]
    async fn a_contact_behind_on_this_profile_gets_it_through_the_resend() {
        let (me, bob) = (create_identity(), create_identity());
        let (mut inner, mut bob_side, ad) = receiving_in_session(&me, &bob, "bob");
        inner.profiles.rev = 10;
        let plain = br#"{"ty":"text","body":"hola","id":"m1","prof":{"v":1,"have":3}}"#;
        let at = unix_now();
        let sent = sealed_event(&bob, &me, &mut bob_side, &ad, plain, None, at);

        let (events, asked, _) = heard(inner, sent).await;

        assert_eq!(
            events,
            [
                named("profile-updated", r#"{"handle":"bob"}"#),
                named(
                    "message-received",
                    &format!(r#"{{"from_handle":"bob","text":"hola","timestamp":{at}}}"#)
                ),
            ]
        );
        assert_eq!(asked, [vec!["bob".to_string()]]);
    }

    #[tokio::test]
    async fn a_strangers_event_goes_to_the_ui_as_handshake_needed() {
        let (me, eve) = (create_identity(), create_identity());
        let inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };

        let (events, _, _) = heard(inner, event_to(&eve, &nostr_hex(&me), TRINO_KIND, NOW)).await;

        assert_eq!(
            events,
            [named(
                "handshake-needed",
                &format!(r#"{{"from_pubkey":"{}"}}"#, nostr_hex(&eve))
            )]
        );
    }

    /// The handshake `contact` sends to start a session with `me`, and the
    /// contact's side of that session.
    fn handshake_to(me: &Identity, contact: &Identity) -> (WireHandshake, RatchetState, Vec<u8>) {
        let bundle = public_bundle_for(me);
        let init = initiate(contact, &bundle).unwrap();
        let spk = decode_array_32(&bundle.spk_pub).unwrap();
        let ratchet = init_initiator(init.master_secret, spk).unwrap();
        let handshake = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };
        (handshake, ratchet, init.associated_data)
    }

    #[tokio::test]
    async fn a_contacts_handshake_goes_to_the_ui_as_session_established() {
        let (me, bob) = (create_identity(), create_identity());
        let (handshake, mut bob_side, ad) = handshake_to(&me, &bob);
        let plain = b"__trino_handshake__";
        let sent = sealed_event(
            &bob,
            &me,
            &mut bob_side,
            &ad,
            plain,
            Some(handshake),
            unix_now(),
        );

        let (events, _, inner) = heard(receiving(&me, &bob, "bob"), sent).await;

        assert_eq!(events, [named("session-established", r#""bob""#)]);
        assert!(inner.ratchets.contains_key("bob"));
    }

    #[tokio::test]
    async fn a_handshake_with_another_key_goes_to_the_ui_as_contact_key_mismatch() {
        let (me, bob) = (create_identity(), create_identity());
        let (mut handshake, mut bob_side, ad) = handshake_to(&me, &bob);
        handshake.ik_dh_pub = public_bundle_for(&create_identity()).ik_dh_pub;
        let sent = sealed_event(
            &bob,
            &me,
            &mut bob_side,
            &ad,
            b"__trino_handshake__",
            Some(handshake),
            unix_now(),
        );

        let (events, _, _) = heard(receiving(&me, &bob, "bob"), sent).await;

        assert_eq!(
            events,
            [named("contact-key-mismatch", r#"{"handle":"bob"}"#)]
        );
    }

    #[tokio::test]
    async fn a_message_without_a_session_goes_to_the_ui_as_resync_needed() {
        let (me, bob) = (create_identity(), create_identity());
        let (_, mut bob_side, ad) = receiving_in_session(&me, &bob, "bob");
        let plain = encode_envelope(&Envelope::Text {
            body: "hola".to_string(),
            id: "m1".to_string(),
        });
        let sent = sealed_event(&bob, &me, &mut bob_side, &ad, &plain, None, unix_now());

        // No session with bob here (`trigger_resync`).
        let (events, _, _) = heard(receiving(&me, &bob, "bob"), sent).await;

        assert_eq!(events, [named("resync-needed", r#""bob""#)]);
    }

    #[tokio::test]
    async fn a_message_that_does_not_decrypt_goes_to_the_ui_as_resync_needed() {
        let (me, bob) = (create_identity(), create_identity());
        let (inner, mut bob_side, _) = receiving_in_session(&me, &bob, "bob");
        let plain = encode_envelope(&Envelope::Text {
            body: "hola".to_string(),
            id: "m1".to_string(),
        });
        // Sealed with associated data of another session: the AEAD fails.
        let sent = sealed_event(&bob, &me, &mut bob_side, b"other", &plain, None, unix_now());

        let (events, _, inner) = heard(inner, sent).await;

        assert_eq!(events, [named("resync-needed", r#""bob""#)]);
        assert!(!inner.ratchets.contains_key("bob"), "the session stayed");
    }

    #[tokio::test]
    async fn a_contacts_group_roster_goes_to_the_ui_as_group_invite() {
        let (me, bob, ana) = (create_identity(), create_identity(), create_identity());
        let (inner, mut bob_side, ad) = receiving_in_session(&me, &bob, "bob");
        let roster = roster_of(&bob, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let plain = encode_envelope(&Envelope::Roster { roster });
        let sent = sealed_event(&bob, &me, &mut bob_side, &ad, &plain, None, unix_now());

        let (events, _, inner) = heard(inner, sent).await;

        let received_at = inner.group_invites[&gid].received_at;
        assert_eq!(
            events,
            [named(
                "group-invite",
                &format!(
                    r#"{{"gid":"{gid}","name":"amigos","from_handle":"bob","member_count":3,"received_at":{received_at}}}"#
                )
            )]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_relays_state_goes_to_the_ui_as_connection_changed() {
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut inner = InnerState::default();
        let relay = crate::nostr::test_relay::unreachable_client(attempts);
        let url = relay.url().to_string();
        inner.relays.push(relay);
        let inner = Arc::new(tokio::sync::Mutex::new(inner));
        let sink = RecordingSink::new();

        let changes = connection_changes(sink.clone(), Arc::clone(&inner));
        changes.poke();
        changes.poke();
        tokio::time::sleep(DEBOUNCE * 2).await;

        assert_eq!(
            sink.events(),
            [named(
                "connection-changed",
                &format!(r#"{{"up":0,"total":1,"relays":[{{"url":"{url}","connected":false}}]}}"#)
            )]
        );
        for client in inner.lock().await.relays.drain(..) {
            client.close();
        }
    }

    #[test]
    fn what_the_inspector_sees_goes_to_the_ui_as_relay_event() {
        let (alice, bob) = (create_identity(), create_identity());
        let seen = event_to(&alice, &nostr_hex(&bob), TRINO_KIND, NOW);
        let sink = RecordingSink::new();

        let on_event = inspector_events(sink.clone(), "wss://relay.example".to_string());
        on_event(seen.clone());

        assert_eq!(
            sink.events(),
            [named(
                "relay-event",
                &format!(
                    r#"{{"relay":"wss://relay.example","id":"{}","from":"{}","to":"{}","size":2,"created_at":{NOW}}}"#,
                    seen.id,
                    nostr_hex(&alice),
                    nostr_hex(&bob)
                )
            )]
        );
    }

    // ---- M4-0c: the boundary with the host ----

    /// The host spawns the relays' task on its own runtime (the desktop
    /// app on Tauri's, a phone's on its own): it must be a future that can
    /// go to any thread and outlives the call that made it. Made here and
    /// dropped unpolled, so nothing connects.
    #[test]
    fn the_relays_task_can_go_to_any_hosts_runtime() {
        fn spawnable<F: std::future::Future<Output = ()> + Send + 'static>(task: F) -> F {
            task
        }
        let net = Arc::new(trino_net::Net::default());
        let events: Arc<dyn EventSink> = RecordingSink::new();
        let resend: profile::Resend = Arc::new(|_| {});
        let connector = crate::nostr::relay_connector(
            Arc::clone(&net),
            net.session(),
            trino_net::IsoKind::RELAY,
        );
        let task = spawnable(connect_relays(
            events,
            resend,
            Arc::default(),
            connector,
            crate::nostr::ready_gate(Arc::clone(&net)),
            net,
            vec!["wss://relay.example".to_string()],
            "ab".repeat(32),
            "ana".to_string(),
        ));
        drop(task);
    }

    /// TRN-ENG-09: the legacy history key had an all-zero fallback; were it
    /// ever reached, anyone could seal a history.bin that passes M0.
    #[test]
    fn the_legacy_history_key_never_falls_back_to_zeros() {
        let source = include_str!("session.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(
            !code.contains("vec![0u8; 32]"),
            "a zero-key fallback exists"
        );
        assert!(
            !code.contains("unwrap_or_else(|_| vec!"),
            "a derivation failure is swallowed"
        );
    }

    fn file_named(name: &str) -> FileRef {
        FileRef {
            url: String::new(),
            key: String::new(),
            sha256: "0".repeat(64),
            mime: "application/octet-stream".into(),
            name: name.into(),
            size: 1,
            thumb: None,
        }
    }

    /// TRN-APP-03: a right-to-left override made "factura\u{202E}fdp.exe"
    /// read as a PDF. A peer's file name loses control and format characters,
    /// as a contact's name is held to them, so the extension shown is the
    /// real one.
    #[test]
    fn trn_app_03_incoming_file_names_lose_bidi_controls() {
        let file = sanitize_file_ref(file_named("factura\u{202E}fdp.exe"));
        assert!(!file.name.contains('\u{202E}'));
        assert_eq!(file.name, "facturafdp.exe");
        let mixed = sanitize_file_ref(file_named("a\u{2066}b\u{0}c\nd\u{2069}.txt"));
        assert_eq!(mixed.name, "abcd.txt");
        // The two joiners stay: emoji such as 👩‍💻 need them.
        let emoji = sanitize_file_ref(file_named("👩\u{200D}💻.png"));
        assert_eq!(emoji.name, "👩\u{200D}💻.png");
        // A name that shows nothing is still a name to save under.
        assert_eq!(
            sanitize_file_ref(file_named("\u{202E}\u{200B}")).name,
            "archivo"
        );
        assert_eq!(sanitize_file_ref(file_named("")).name, "archivo");
    }

    #[test]
    fn trn_app_03_a_long_file_name_is_capped_and_keeps_its_extension() {
        let name = sanitize_file_ref(file_named(&format!("{}.exe", "a".repeat(1000)))).name;
        assert_eq!(name.chars().count(), 255);
        assert!(name.ends_with("a.exe"), "{name}");
        let plain = sanitize_file_ref(file_named(&"b".repeat(1000))).name;
        assert_eq!(plain, "b".repeat(255));
    }

    #[test]
    fn a_failed_derivation_is_an_error_not_a_zero_key() {
        assert!(legacy_key::<&str>(Err("HKDF failed")).is_err());
        assert!(legacy_key::<&str>(Ok(vec![0u8; 32])).is_err(), "all zeros");
        assert!(legacy_key::<&str>(Ok(vec![1u8; 16])).is_err(), "short");
        assert!(legacy_key::<&str>(Ok(vec![1u8; 64])).is_err(), "long");
        assert_eq!(*legacy_key::<&str>(Ok(vec![1u8; 32])).unwrap(), [1u8; 32]);
    }

    #[test]
    fn the_legacy_history_key_is_the_identitys_and_never_zero() {
        let me = create_identity();
        let key = derive_history_key(&me).unwrap();
        assert_ne!(*key, [0u8; 32]);
        assert_eq!(*key, *derive_history_key(&me).unwrap(), "stable");
        assert_ne!(*key, *derive_history_key(&create_identity()).unwrap());
    }
}
