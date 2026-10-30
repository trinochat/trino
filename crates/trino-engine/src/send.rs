//! Sending (K4; M4-0c): a text or a file to a contact or a group, counted
//! as sent once a relay says OK, and why one was not sent.
//!
//! - A text or a file to a contact waits for the first relay that takes it
//!   (`send_text`, `announce_file`); to a group, every member is tried
//!   whatever happens to the others (`fan_out`), and the receipt says whom
//!   it reached.
//! - A lock meanwhile keeps nothing of it (`same_session`).
//! - A message too large for the relays goes to nobody, and a file whose
//!   announcement cannot fit is refused before its upload.
//! - What is shown as sent at once (a forward) needs a relay that is up.

use crate::blossom;
use crate::call_signal::validate_call_signal;
use crate::command_error::{CommandError, ErrorCode};
use crate::envelope::{encode_envelope, Envelope};
use crate::group::{FileRef, GroupRoster};
use crate::identity::Identity;
use crate::nostr::{NostrClient, NostrEvent, TRINO_KIND};
use crate::profile;
use crate::session::{
    checked_inline_raster, ensure_session, ensure_session_inner, event_frame_bytes, group_convo,
    new_msg_id, publish_sealed, record_history, sanitize_file_ref, seal_for, send_cipher_inner,
    unix_now, zeroize_file_ref, WireHeader, WirePayload, MAX_EVENT_BYTES,
};
use crate::state::{HistItem, InnerState};
use crate::Engine;
use base64::Engine as _;
use serde::Serialize;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

/// Why a message was not sent.
#[derive(Debug, PartialEq, Eq)]
pub enum SendError {
    Sealed,
    UnknownContact,
    UnknownGroup,
    Empty,
    /// The session has no relays at all.
    NoRelays,
    NoSession,
    /// No relay is up.
    Offline,
    NotAccepted,
    TooLong,
    /// To someone you blocked (UR-2).
    Blocked,
    /// The session waits for the contact's first reply (a PQ-11 handshake,
    /// P1-8): nothing else goes until it comes.
    Pending,
    /// No list of the contact's account yet, so no P1 handshake can start
    /// (P1-8).
    NoPrekeys,
    /// The network time is unknown and the clock is off by more than an
    /// hour (design P1 §3.5).
    ClockSkewed,
    /// The X3DH, the ratchet or the signature failed; for the log.
    Failed(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The commands that still answer with a string show these, as before.
        f.write_str(match self {
            SendError::Sealed => "vault sealed",
            SendError::UnknownContact => "unknown node",
            SendError::UnknownGroup => "unknown group",
            SendError::Empty => "empty message",
            SendError::NoRelays => "network is still connecting",
            SendError::NoSession => "no session — run connect first",
            SendError::Offline => "no relay is connected",
            SendError::NotAccepted => "no relay accepted the message",
            SendError::TooLong => "the message is too large for the relays",
            SendError::Blocked => "blocked",
            SendError::Pending => "waiting for the contact's reply",
            SendError::NoPrekeys => "no device list of this contact yet",
            SendError::ClockSkewed => "the clock is too far off to send",
            SendError::Failed(reason) => reason,
        })
    }
}

impl From<SendError> for CommandError {
    fn from(error: SendError) -> Self {
        let code = match &error {
            SendError::Sealed => ErrorCode::NoVault,
            SendError::NoSession | SendError::Pending | SendError::NoPrekeys => {
                ErrorCode::NoSession
            }
            SendError::ClockSkewed => ErrorCode::Offline,
            SendError::NoRelays | SendError::Offline => ErrorCode::Offline,
            SendError::NotAccepted => ErrorCode::NotAccepted,
            SendError::TooLong => ErrorCode::MessageTooLong,
            SendError::Blocked => ErrorCode::Blocked,
            SendError::UnknownContact
            | SendError::UnknownGroup
            | SendError::Empty
            | SendError::Failed(_) => ErrorCode::Internal,
        };
        CommandError::new(code, error.to_string())
    }
}

pub const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
/// How long a message waits for a relay to confirm it (K4).
pub const ACK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// A message one relay at least took (K4): its time, which is also the time
/// it is stored with, and the relays that took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SendReceipt {
    pub ts: i64,
    pub accepted_by: Vec<String>,
}

/// A group message (K4): every member is tried, whatever happens to the
/// others. `accepted` and `failed` are their handles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GroupSendReceipt {
    pub ts: i64,
    pub accepted: Vec<String>,
    pub failed: Vec<String>,
}

/// What `send_file` answers: the file with its receipt, in one object
/// (`SentFile` in src/lib/api.ts). When the UI hands it back to
/// `forward_file`, `FileRef` ignores the receipt's fields.
#[derive(Serialize)]
pub struct SentFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: SendReceipt,
}

/// What `send_group_file` answers, as `SentFile` does.
#[derive(Serialize)]
pub struct SentGroupFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: GroupSendReceipt,
}

/// `send_message`, waiting up to `wait` for a relay's OK. A lock meanwhile
/// keeps nothing of it (`same_session`).
pub async fn send_text(
    state: &Engine,
    handle: &str,
    text: String,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    // Wiped whichever way this returns, unless they are kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let id = new_msg_id();
    let mut env = Zeroizing::new(encode_envelope(&Envelope::Text {
        body: text.to_string(),
        id: id.clone(),
    }));
    let session = {
        let inner = state.inner.lock().await;
        refuse_blocked(&inner, handle)?;
        session_key(&inner).ok_or(SendError::Sealed)?
    };
    let sent = send_acked(state, handle, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    remember_outgoing(&mut inner, handle, id, std::mem::take(&mut *env));
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: Some(std::mem::take(&mut *text)),
            file: None,
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(receipt)
}

/// `send_group_message`, waiting up to `wait` for each member's relay OK.
/// A lock meanwhile keeps nothing of it (`same_session`).
pub async fn send_group_text(
    state: &Engine,
    gid: &str,
    text: String,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    // Wiped whichever way this returns, unless it is kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::Group {
            gid: gid.to_string(),
            ep: roster.epoch,
            body: text.to_string(),
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    crate::diag::note_with("group send", &[("members", &targets.len())]);
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: Some(std::mem::take(&mut *text)),
                file: None,
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(receipt)
}

/// Encrypt file bytes, upload the ciphertext to Blossom, return the E2E reference.
/// When every file server fails, the error says why for each (`upload_failed`).
pub async fn prepare_file(
    state: &Engine,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<FileRef, CommandError> {
    let (identity, blob, file) =
        encrypt_attachment(state, name, mime, data_b64, thumb, gid).await?;
    let url = blossom::upload(&state.net, &identity, &blob, &file.sha256).await?;
    Ok(FileRef { url, ..file })
}

/// What `prepare_file` uploads: the identity that signs the upload, the
/// encrypted blob, and its reference, without the URL the upload gives it.
/// `gid` is the group it goes to, if any.
pub async fn encrypt_attachment(
    state: &Engine,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<(Identity, Vec<u8>, FileRef), CommandError> {
    let too_large = || CommandError::internal("attachment is too large (25 MB max)");
    if data_b64.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 4 {
        return Err(too_large());
    }
    let thumb = checked_inline_raster(thumb).map_err(CommandError::internal)?;
    if !announcement_fits(name, mime, data_b64, thumb.as_deref(), gid) {
        return Err(SendError::TooLong.into());
    }
    let identity = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?.clone();
        // With no relay to announce the file, the upload would be wasted (K4).
        if !inner.relays.iter().any(|relay| relay.is_connected()) {
            return Err(SendError::Offline.into());
        }
        identity
    };
    // Wiped when dropped, whichever way this returns.
    let data = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|_| CommandError::internal("bad base64"))?,
    );
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large());
    }
    let size = data.len() as u64;
    let enc = blossom::encrypt_file(&data)?;
    drop(data);
    let file = FileRef {
        url: String::new(),
        key: enc.key_hex,
        sha256: enc.sha256_hex,
        mime: mime.to_string(),
        name: name.to_string(),
        size,
        thumb,
    };
    Ok((identity, enc.blob, file))
}

/// Whether the announcement of a file can fit a relay whatever URL its
/// upload gives it (`blossom::MAX_URL_BYTES`), to a contact or to the group
/// `gid`. Checked before the upload, so a file that cannot be announced,
/// such as one with too large a preview, is never uploaded. The preview is
/// a checked data URL, which JSON writes as it is: a stand-in of its length
/// sizes it without copying it.
pub fn announcement_fits(
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<&str>,
    gid: Option<&str>,
) -> bool {
    let announcement = Envelope::File {
        file: FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            key: "0".repeat(64),
            sha256: "0".repeat(64),
            mime: mime.to_string(),
            name: name.to_string(),
            // The most bytes `data_b64` can hold.
            size: (data_b64.len() / 4 * 3 + 3) as u64,
            thumb: thumb.map(|thumb| "t".repeat(thumb.len())),
        },
        gid: gid.map(str::to_string),
        body: None,
    };
    largest_frame_bytes(&encode_envelope(&announcement), unix_now()) <= MAX_EVENT_BYTES
}

/// `send_file` once the file is uploaded: announce it to `handle`, waiting
/// up to `wait` for a relay's OK. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
pub async fn announce_file(
    state: &Engine,
    handle: &str,
    mut file: FileRef,
    wait: std::time::Duration,
) -> Result<SentFile, SendError> {
    let env = Zeroizing::new(encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: None,
        body: None,
    }));
    let session = {
        let inner = state.inner.lock().await;
        if let Err(blocked) = refuse_blocked(&inner, handle) {
            zeroize_file_ref(&mut file);
            return Err(blocked);
        }
        session_key(&inner).ok_or(SendError::Sealed)?
    };
    let sent = match ensure_session(state, handle).await {
        Ok(()) => send_acked(state, handle, &env, unix_now(), wait).await,
        Err(error) => Err(error),
    };
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file.clone()),
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(SentFile { file, receipt })
}

/// `send_group_file` once the file is uploaded: announce it to the group as
/// `send_group_text` sends a text. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
pub async fn announce_group_file(
    state: &Engine,
    gid: &str,
    mut file: FileRef,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<SentGroupFile, SendError> {
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: Some(gid.to_string()),
            body: None,
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file.clone()),
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(SentGroupFile { file, receipt })
}

/// `forward_file`, to the contact or the group `target`. It waits for no
/// relay's OK and is stored as forwarded at once, so it needs a relay that
/// is up: otherwise it would only wait in the queues of relays that are
/// down, and be lost if the session locked first.
pub async fn forward_to(
    state: &Engine,
    target: &str,
    is_group: bool,
    file: FileRef,
) -> Result<(), SendError> {
    let file = sanitize_file_ref(file);
    let (handles, convo) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        if !inner.relays.iter().any(|relay| relay.is_connected()) {
            return Err(SendError::Offline);
        }
        if is_group {
            let my_ik = hex::encode(identity.ik_sign.pub_bytes);
            let roster = inner.groups.get(target).ok_or(SendError::UnknownGroup)?;
            let handles = member_handles(&inner, roster, &my_ik, None);
            (handles, group_convo(target))
        } else {
            refuse_blocked(&inner, target)?;
            (vec![target.to_string()], target.to_string())
        }
    };
    let env = encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: is_group.then(|| target.to_string()),
        body: None,
    });
    for handle in &handles {
        ensure_session(state, handle).await?;
        publish_sealed(state, handle, &env, None).await?;
    }
    let mut inner = state.inner.lock().await;
    record_history(
        &mut inner,
        convo,
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file),
            call: None,
            ts: unix_now(),
        },
    );
    Ok(())
}

/// The largest frame `plaintext` can make once `seal_for` seals it for any
/// contact, dated `ts`: with the longest profile announcement
/// `profile::with_caps` can add, and the widest counters a session can have.
/// A message for several contacts, and a file before its upload, are sized
/// with it, so one too large for the relays goes to nobody.
pub fn largest_frame_bytes(plaintext: &[u8], ts: i64) -> usize {
    let mut profiles = profile::Profiles::default();
    profiles.contacts.insert(
        String::new(),
        profile::ContactProfile {
            rev: u64::MAX,
            ..Default::default()
        },
    );
    let bare = br#"{"ty":"text"}"#;
    let announcement = profile::with_caps(&profiles, "", bare).len() - bare.len();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: "0".repeat(64),
            pn: u32::MAX,
            n: u32::MAX,
        },
        // AES-GCM, as `ratchet_encrypt` uses it: a 12-byte nonce, and the
        // plaintext with its 16-byte tag, both in hex.
        nonce: "0".repeat(24),
        ciphertext: "0".repeat((plaintext.len() + announcement + 16) * 2),
        handshake: None,
    };
    let event = NostrEvent {
        id: "0".repeat(64),
        pubkey: "0".repeat(64),
        created_at: ts,
        kind: TRINO_KIND,
        tags: vec![vec!["p".to_string(), "0".repeat(64)]],
        content: serde_json::to_string(&payload).unwrap_or_default(),
        sig: "0".repeat(128),
    };
    event_frame_bytes(&event)
}

/// Send `plaintext` to `handle` dated `ts`, and wait up to `wait` for the
/// first relay that takes it (K4).
pub async fn send_acked(
    state: &Engine,
    handle: &str,
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    let (event, relays) = seal_for(state, handle, plaintext, None, Some(ts), true).await?;
    let accepted_by = first_acceptance(&relays, &event, wait).await?;
    Ok(SendReceipt {
        ts: event.created_at,
        accepted_by,
    })
}

/// Publish `event` to the relays that are up and answer as soon as one of
/// them takes it. A relay that is down is not asked: a message the UI shows
/// as failed must not go out later by itself.
pub async fn first_acceptance(
    relays: &[Arc<NostrClient>],
    event: &NostrEvent,
    wait: std::time::Duration,
) -> Result<Vec<String>, SendError> {
    use futures_util::StreamExt;
    let mut answers: futures_util::stream::FuturesUnordered<_> = relays
        .iter()
        .filter(|relay| relay.is_connected())
        .map(|relay| async move { (relay.url(), relay.publish_acked(event, wait).await) })
        .collect();
    if answers.is_empty() {
        return Err(SendError::Offline);
    }
    while let Some((url, ack)) = answers.next().await {
        if ack == crate::nostr::Ack::Accepted {
            return Ok(vec![url.to_string()]);
        }
    }
    Err(SendError::NotAccepted)
}

/// The session a send starts in: its identity's Nostr key. `None` while
/// the vault is locked.
pub fn session_key(inner: &InnerState) -> Option<[u8; 32]> {
    inner
        .identity
        .as_ref()
        .map(|identity| identity.nostr.pub_bytes)
}

/// `state` locked again once a send has waited for its relays (K4), if the
/// session it started in (`session_key`) is open; `NoSession` if not.
///
/// A lock during that wait ends the session: `lock_vault` saves the history
/// without the message, wipes it, and leaves no storage to write with.
/// So a message a relay accepted while its session was locked is not kept
/// in the sender's history, nor in the outbox to replay, although its
/// contact may receive it: the send answers `no_session` and wipes its
/// text. An unlock of the same identity before the wait ends opens the
/// session again, and the message is kept there. The name is not compared,
/// so renaming this identity meanwhile loses nothing.
pub async fn same_session(
    state: &Engine,
    session: [u8; 32],
) -> Result<tokio::sync::MutexGuard<'_, InnerState>, SendError> {
    let inner = state.inner.lock().await;
    if session_key(&inner) == Some(session) {
        Ok(inner)
    } else {
        Err(SendError::NoSession)
    }
}

/// Whether any relay of the session is up.
pub async fn any_relay_up(state: &Engine) -> bool {
    let inner = state.inner.lock().await;
    inner.relays.iter().any(|relay| relay.is_connected())
}

/// The handles of `roster`'s members other than us that are contacts, in
/// roster order; with `only`, just the ones it names. Never someone you
/// blocked (UR-2, decision U5): your messages and files of the group do not
/// reach them. Your rosters do (`groups::contacts_of`), so the group does
/// not break for them (R-25).
pub fn member_handles(
    inner: &InnerState,
    roster: &GroupRoster,
    my_ik: &str,
    only: Option<&[String]>,
) -> Vec<String> {
    roster
        .members
        .iter()
        .filter(|m| m.ik_sign_pub != my_ik)
        .filter_map(|m| {
            inner
                .friends
                .values()
                .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                .filter(|f| !crate::block::friend_blocked(inner, f))
                .map(|f| f.handle.clone())
        })
        .filter(|handle| only.is_none_or(|only| only.contains(handle)))
        .collect()
}

/// Send `plaintext` to each of `targets`, all dated `ts`, each waiting for
/// its own relay OK. Every member is tried whatever happens to the others:
/// the send used to stop at the first one that failed. A message too large
/// for the relays is refused before any member gets it; when nobody takes
/// it, `group_receipt` says why.
pub async fn fan_out(
    state: &Engine,
    targets: &[String],
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    if largest_frame_bytes(plaintext, ts) > MAX_EVENT_BYTES {
        return Err(SendError::TooLong);
    }
    if targets.is_empty() {
        return group_receipt(ts, Vec::new());
    }
    if !any_relay_up(state).await {
        return Err(SendError::Offline);
    }
    let sends = targets.iter().map(|handle| async move {
        let sent = match ensure_session(state, handle).await {
            Ok(()) => send_acked(state, handle, plaintext, ts, wait)
                .await
                .map(drop),
            Err(error) => Err(error),
        };
        (handle.clone(), sent)
    });
    group_receipt(ts, futures_util::future::join_all(sends).await)
}

/// What a group send dated `ts` answers once every member was tried: the
/// receipt, when one member at least took it (or there was nobody to send
/// to). When nobody did, why: the reason every member failed for, when it
/// is the same one (too large, offline, no session…), and `NotAccepted`
/// when they failed in different ways.
pub fn group_receipt(
    ts: i64,
    results: Vec<(String, Result<(), SendError>)>,
) -> Result<GroupSendReceipt, SendError> {
    let mut receipt = GroupSendReceipt {
        ts,
        accepted: Vec::new(),
        failed: Vec::new(),
    };
    let mut causes = Vec::new();
    for (handle, sent) in results {
        match sent {
            Ok(()) => receipt.accepted.push(handle),
            Err(error) => {
                receipt.failed.push(handle);
                causes.push(error);
            }
        }
    }
    let mut causes = causes.into_iter();
    let Some(first) = causes.next() else {
        return Ok(receipt);
    };
    if !receipt.accepted.is_empty() {
        return Ok(receipt);
    }
    if causes.all(|other| other == first) {
        Err(first)
    } else {
        Err(SendError::NotAccepted)
    }
}

/// `Blocked` when the contact `handle` is someone you blocked (UR-2, design
/// §3.2): no text, file, forward, call or handshake goes to them. Rosters
/// do, and they open a session with `ensure_session`, which does not ask.
pub fn refuse_blocked(inner: &InnerState, handle: &str) -> Result<(), SendError> {
    match inner.friends.get(handle) {
        Some(friend) if crate::block::friend_blocked(inner, friend) => Err(SendError::Blocked),
        _ => Ok(()),
    }
}

/// `refuse_blocked`, before a file to `handle` is uploaded.
pub async fn check_not_blocked(state: &Engine, handle: &str) -> Result<(), SendError> {
    refuse_blocked(&*state.inner.lock().await, handle)
}

/// Buffer a just-sent text envelope so it can be replayed after an auto-heal.
/// Capped to the last 20 messages / 10 minutes per peer.
pub fn remember_outgoing(inner: &mut InnerState, handle: &str, id: String, env: Vec<u8>) {
    let now = chrono::Utc::now().timestamp();
    let buf = inner.outbox.entry(handle.to_string()).or_default();
    buf.push((id, env, now));
    buf.retain(|(_, _, ts)| now - *ts < 600);
    if buf.len() > 20 {
        let excess = buf.len() - 20;
        buf.drain(0..excess);
    }
}

/// `resend_outbox`: how many buffered messages it sent again.
pub async fn resend_buffered(state: &Engine, handle: &str) -> usize {
    let items: Vec<Vec<u8>> = {
        let inner = state.inner.lock().await;
        if refuse_blocked(&inner, handle).is_err() {
            return 0;
        }
        inner
            .outbox
            .get(handle)
            .map(|v| v.iter().map(|(_, e, _)| e.clone()).collect())
            .unwrap_or_default()
    };
    if items.is_empty() {
        return 0;
    }
    crate::diag::note_with("RESEND buffered messages", &[("count", &items.len())]);
    for env in &items {
        let _ = send_cipher_inner(state, handle, env, None).await;
    }
    items.len()
}

/// `fetch_file`: download, verify and decrypt a file, as a `data:` URL for
/// the frontend. The download goes through the engine's `Net` (Tor design
/// §3 B2). With `max_file_bytes` it takes no more than a file of that size,
/// sealed: a sticker fetched by itself (TRN-APP-02).
pub async fn fetch_file(
    state: &Engine,
    url: &str,
    key: &str,
    sha256: &str,
    mime: &str,
    max_file_bytes: Option<usize>,
) -> Result<String, String> {
    let max = blossom::blob_cap(max_file_bytes);
    let blob = blossom::download_at_most(&state.net, url, sha256, max)
        .await
        .map_err(|e| e.to_string())?;
    let mut plain = blossom::decrypt_file(&blob, key).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&plain);
    plain.zeroize();
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// `send_call_signal`: a WebRTC signaling payload (offer/answer/ICE/bye) to
/// `handle`, E2E-encrypted, over a session started first if there is none.
pub async fn call_signal(state: &Engine, handle: &str, payload: String) -> Result<(), String> {
    validate_call_signal(&payload).map_err(str::to_string)?;
    check_not_blocked(state, handle)
        .await
        .map_err(|e| e.to_string())?;
    ensure_session_inner(state, handle).await?;
    let env = encode_envelope(&Envelope::Call { call: payload });
    send_cipher_inner(state, handle, &env, None).await
}

#[cfg(test)]
mod tests {
    //! M4-0c: from the app's commands.rs.

    use super::*;
    use crate::command_error::ErrorCode;
    use crate::envelope::decode_envelope;
    use crate::group;
    use crate::identity::create_identity;
    use crate::identity::{decode_array_32, public_bundle_for};
    use crate::nostr::test_relay::{unreachable_client, Answer, TestRelay};
    use crate::ratchet::init_initiator;
    use crate::session::forget_session;
    use crate::session::tests::{
        add_session_read_by, friend, ik, opened_by, roster_of, sending_state, NOW,
    };
    use crate::turn::TurnGate;
    use crate::x3dh::initiate;

    /// How long these tests wait for an OK that will not come.
    const SHORT_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

    /// `contact` as `handle`, with a session open, as `connect_node` leaves it.
    fn add_session(inner: &mut InnerState, me: &Identity, contact: &Identity, handle: &str) {
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
    }

    /// How many messages the session with `handle` has sent.
    async fn sent_so_far(state: &Engine, handle: &str) -> u32 {
        state.inner.lock().await.ratchets[handle].sending_msg_number
    }

    fn pub_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    #[tokio::test]
    async fn a_message_counts_as_sent_once_a_relay_says_ok() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let receipt = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted_by, std::slice::from_ref(&relay.url));
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].created_at, receipt.ts);
        assert_eq!(events[0].recipient(), Some(pub_hex(&bob).as_str()));
        let inner = state.inner.lock().await;
        let stored = inner.history["bob"].last().unwrap();
        assert_eq!(stored.ts, receipt.ts, "stored with the time of the receipt");
        assert_eq!(stored.text.as_deref(), Some("hola"));
        assert_eq!(stored.side, "me");
    }

    #[tokio::test]
    async fn a_message_no_relay_takes_is_not_accepted_and_not_stored() {
        let refusing = TestRelay::start(Answer::Reject).await;
        let silent = TestRelay::start(Answer::Silent).await;
        let (me, bob) = (create_identity(), create_identity());
        let relays = vec![refusing.client().await, silent.client().await];
        let state = sending_state(&me, relays).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert_eq!((refusing.events().len(), silent.events().len()), (1, 1));
        assert!(!state.inner.lock().await.history.contains_key("bob"));
    }

    #[tokio::test]
    async fn without_a_relay_up_nothing_is_encrypted_or_sent() {
        let (me, bob) = (create_identity(), create_identity());
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

            let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
                .await
                .unwrap_err();

            assert_eq!(CommandError::from(error).code, ErrorCode::Offline);
            assert_eq!(sent_so_far(&state, "bob").await, 0, "the session moved on");
        }
    }

    #[tokio::test]
    async fn a_message_too_big_for_the_relays_is_refused_without_a_ratchet_step() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        // About 80 KB once encrypted and hex-encoded: relays drop it unseen.
        let error = send_text(&state, "bob", "x".repeat(40_000), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(sent_so_far(&state, "bob").await, 0);
        assert!(relay.events().is_empty());
        // About 40 KB fits, on the same session.
        send_text(&state, "bob", "x".repeat(20_000), SHORT_WAIT)
            .await
            .unwrap();
        assert_eq!(sent_so_far(&state, "bob").await, 1);
    }

    #[tokio::test]
    async fn a_message_to_a_contact_without_a_session_says_so() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        state
            .inner
            .lock()
            .await
            .friends
            .insert("bob".to_string(), friend(&bob, "bob"));

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NoSession);
        assert!(relay.events().is_empty());
    }

    /// Me, admin of a group with bob, carol and dave, all with sessions.
    pub(crate) async fn group_of_three(
        state: &Engine,
        me: &Identity,
        others: &[Identity; 3],
    ) -> String {
        let mut inner = state.inner.lock().await;
        let handles = ["bob", "carol", "dave"];
        for (who, handle) in others.iter().zip(handles) {
            add_session(&mut inner, me, who, handle);
        }
        let members: Vec<(&Identity, &str)> = others.iter().zip(handles).collect();
        let roster = roster_of(me, &members);
        let gid = roster.group_id.clone();
        inner.groups.insert(gid.clone(), roster);
        gid
    }

    #[tokio::test]
    async fn a_group_message_reaches_every_member_it_can_whatever_happens_to_one() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::RejectTo(pub_hex(&others[1]))).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let receipt = send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["bob", "dave"]);
        assert_eq!(receipt.failed, ["carol"]);
        let events = relay.events();
        assert_eq!(events.len(), 3, "every member was tried");
        assert!(events.iter().all(|e| e.created_at == receipt.ts));
        let inner = state.inner.lock().await;
        let stored = inner.history[&group_convo(&gid)].last().unwrap();
        assert_eq!(stored.ts, receipt.ts);
        assert_eq!(stored.text.as_deref(), Some("hola grupo"));
    }

    #[tokio::test]
    async fn a_resend_goes_only_to_the_members_named_and_is_not_stored_again() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        let only = ["carol".to_string()];

        let receipt = send_group_text(&state, &gid, "hola".to_string(), Some(&only), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["carol"]);
        assert!(receipt.failed.is_empty());
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].recipient(), Some(pub_hex(&others[1]).as_str()));
        assert!(
            !state
                .inner
                .lock()
                .await
                .history
                .contains_key(&group_convo(&gid)),
            "the first send stored it already"
        );
    }

    #[tokio::test]
    async fn a_group_message_no_member_takes_is_not_accepted() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Reject).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let error = send_group_text(&state, &gid, "hola".to_string(), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    fn sample_file() -> FileRef {
        FileRef {
            url: "https://blossom.band/abc".to_string(),
            key: "00".repeat(32),
            sha256: "ab".repeat(32),
            mime: "image/png".to_string(),
            name: "foto.png".to_string(),
            size: 3,
            thumb: None,
        }
    }

    #[test]
    fn the_ui_receives_the_receipts_in_the_contract_shape() {
        // `SendReceipt`, `GroupSendReceipt` and `SentFile` in src/lib/api.ts.
        let receipt = SendReceipt {
            ts: NOW,
            accepted_by: vec!["wss://relay.damus.io".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted_by": ["wss://relay.damus.io"] })
        );
        let group = GroupSendReceipt {
            ts: NOW,
            accepted: vec!["bob".to_string()],
            failed: vec!["carol".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&group).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted": ["bob"], "failed": ["carol"] })
        );
        let sent = SentFile {
            file: sample_file(),
            receipt,
        };
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            serde_json::json!({
                "url": "https://blossom.band/abc",
                "key": "00".repeat(32),
                "sha256": "ab".repeat(32),
                "mime": "image/png",
                "name": "foto.png",
                "size": 3,
                "ts": NOW,
                "accepted_by": ["wss://relay.damus.io"],
            })
        );
        let sent_to_group = SentGroupFile {
            file: sample_file(),
            receipt: group,
        };
        let value = serde_json::to_value(&sent_to_group).unwrap();
        assert_eq!(value["accepted"], serde_json::json!(["bob"]));
        assert_eq!(value["failed"], serde_json::json!(["carol"]));
        assert_eq!(value["name"], "foto.png");
    }

    #[test]
    fn a_sent_file_given_back_to_forward_file_is_just_the_file() {
        // The UI forwards the `SentFile` it got from `send_file`.
        let sent = serde_json::to_value(SentFile {
            file: sample_file(),
            receipt: SendReceipt {
                ts: NOW,
                accepted_by: vec!["wss://nos.lol".to_string()],
            },
        })
        .unwrap();

        let file: FileRef = serde_json::from_value(sent).expect("extra fields are ignored");

        assert_eq!(file, sample_file());
        let forwarded = encode_envelope(&Envelope::File {
            file,
            gid: None,
            body: None,
        });
        let forwarded: serde_json::Value = serde_json::from_slice(&forwarded).unwrap();
        assert!(forwarded["file"].get("ts").is_none());
        assert!(forwarded["file"].get("accepted_by").is_none());
    }

    #[test]
    fn send_errors_reach_the_ui_with_their_codes_and_the_old_texts() {
        for (error, code) in [
            (SendError::Sealed, ErrorCode::NoVault),
            (SendError::NoSession, ErrorCode::NoSession),
            (SendError::NoRelays, ErrorCode::Offline),
            (SendError::Offline, ErrorCode::Offline),
            (SendError::NotAccepted, ErrorCode::NotAccepted),
            (SendError::TooLong, ErrorCode::MessageTooLong),
            (SendError::UnknownContact, ErrorCode::Internal),
            (SendError::UnknownGroup, ErrorCode::Internal),
            (SendError::Empty, ErrorCode::Internal),
        ] {
            assert_eq!(CommandError::from(error).code, code);
        }
        // The commands that still answer with a string keep their texts.
        assert_eq!(SendError::Sealed.to_string(), "vault sealed");
        assert_eq!(SendError::UnknownContact.to_string(), "unknown node");
        assert_eq!(
            SendError::NoRelays.to_string(),
            "network is still connecting"
        );
        assert_eq!(
            SendError::NoSession.to_string(),
            "no session — run connect first"
        );
    }

    /// A preview `chars` characters long, as the UI sends a sticker's data
    /// URL with a file.
    fn preview_of(chars: usize) -> String {
        format!("data:image/png;base64,{}", "A".repeat(chars))
    }

    /// Whether the session with each of `handles` is where it started.
    async fn no_session_moved_on(state: &Engine, handles: &[&str]) -> bool {
        for handle in handles {
            if sent_so_far(state, handle).await != 0 {
                return false;
            }
        }
        true
    }

    #[tokio::test]
    async fn a_group_text_too_large_for_the_relays_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        // About 80 KB once encrypted and hex-encoded, as for one contact.
        let error = send_group_text(&state, &gid, "x".repeat(40_000), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(CommandError::from(error).code, ErrorCode::MessageTooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    #[tokio::test]
    async fn a_group_file_whose_preview_is_too_large_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        // A sticker whose 40,000-character data URL goes as its preview.
        let file = FileRef {
            thumb: Some(preview_of(40_000)),
            ..sample_file()
        };

        let Err(error) = announce_group_file(&state, &gid, file, None, SHORT_WAIT).await else {
            panic!("announced");
        };

        assert_eq!(error, SendError::TooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
    }

    #[tokio::test]
    async fn a_file_whose_announcement_cannot_fit_is_refused_before_its_upload() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let data = base64::engine::general_purpose::STANDARD.encode(b"a small sticker");
        let gid = "ab".repeat(32);

        for to_group in [None, Some(gid.as_str())] {
            let encrypted = encrypt_attachment(
                &state,
                "sticker.png",
                "image/png",
                &data,
                Some(preview_of(40_000)),
                to_group,
            )
            .await;

            // Refused here, it never reaches a file server.
            let Err(error) = encrypted else {
                panic!("it would be uploaded, to group {to_group:?}");
            };
            assert_eq!(error.code, ErrorCode::MessageTooLong, "{to_group:?}");
        }
        // A preview that fits goes on to the upload.
        let (_, _, file) = encrypt_attachment(
            &state,
            "sticker.png",
            "image/png",
            &data,
            Some(preview_of(8_000)),
            Some(&gid),
        )
        .await
        .unwrap();
        assert_eq!(file.thumb, Some(preview_of(8_000)));
    }

    #[test]
    fn every_preview_the_app_makes_fits_an_announcement() {
        // fitThumb (src/lib/media.ts) shrinks a photo's or a video's preview
        // until its data URL is at most THUMB_MAX_CHARS, and a sticker goes
        // with its picture inline only up to the same length
        // (sticker-limits.ts). Should that drift past what an announcement
        // holds, send_file would answer message_too_long for every such file
        // before its upload, and the composer offers to try again.
        let media = include_str!("../../../src/lib/media.ts");
        let max: usize = media
            .lines()
            .find_map(|line| line.trim().strip_prefix("export const THUMB_MAX_CHARS = "))
            .and_then(|value| value.trim_end().strip_suffix(';'))
            .map(|value| value.trim().replace('_', "").parse().expect("a number"))
            .expect("THUMB_MAX_CHARS in media.ts");
        // The longest name a file system gives (255 UTF-16 units, 3 bytes
        // each here), a long type, a file of 25 MiB and a group.
        let name = "字".repeat(255);
        let mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        let data = "A".repeat(25 * 1024 * 1024 / 3 * 4 + 4);
        let gid = "ab".repeat(32);
        let fits = |chars: usize| {
            announcement_fits(&name, mime, &data, Some(&"t".repeat(chars)), Some(&gid))
        };
        assert!(fits(max), "a preview of {max} characters");
        // The check can fail: a preview a fifth longer does not fit.
        assert!(!fits(max * 6 / 5));
    }

    #[tokio::test]
    async fn the_largest_frame_of_a_message_bounds_the_event_sealed_for_it() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        {
            let mut inner = state.inner.lock().await;
            add_session(&mut inner, &me, &bob, "bob");
            // The longest announcement a profile revision can make.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: u64::MAX,
                    ..Default::default()
                },
            );
        }
        let file = FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            thumb: Some(preview_of(8_000)),
            ..sample_file()
        };
        for envelope in [
            Envelope::Text {
                body: String::new(),
                id: new_msg_id(),
            },
            Envelope::Text {
                body: "ñandú \"citado\" \u{1}".repeat(500),
                id: new_msg_id(),
            },
            Envelope::Group {
                gid: "ab".repeat(32),
                ep: u64::MAX,
                body: "x".repeat(20_000),
            },
            Envelope::File {
                file,
                gid: Some("ab".repeat(32)),
                body: None,
            },
        ] {
            let plaintext = encode_envelope(&envelope);
            let ts = unix_now();

            let (event, _) = seal_for(&state, "bob", &plaintext, None, Some(ts), true)
                .await
                .unwrap();

            let sealed = event_frame_bytes(&event);
            let largest = largest_frame_bytes(&plaintext, ts);
            assert!(sealed <= largest, "{sealed} > {largest}");
            // Only the counters of the session can be shorter than the
            // widest: up to nine digits each.
            assert!(largest - sealed <= 18, "{largest} - {sealed}");
        }
    }

    #[test]
    fn when_no_member_takes_a_group_message_the_answer_says_why() {
        let failed = |errors: Vec<SendError>| -> Vec<(String, Result<(), SendError>)> {
            let names = ["bob", "carol", "dave"].map(String::from);
            names.into_iter().zip(errors.into_iter().map(Err)).collect()
        };
        // Every member failed the same way: that is the answer.
        let causes: [fn() -> SendError; 6] = [
            || SendError::TooLong,
            || SendError::Offline,
            || SendError::NoSession,
            || SendError::Sealed,
            || SendError::NotAccepted,
            || SendError::Failed("bad prekey".to_string()),
        ];
        for cause in causes {
            let all = failed(vec![cause(), cause(), cause()]);
            assert_eq!(group_receipt(NOW, all), Err(cause()));
        }
        // Different ways: no relay took it for anyone.
        let mixed = failed(vec![
            SendError::TooLong,
            SendError::NotAccepted,
            SendError::Offline,
        ]);
        assert_eq!(group_receipt(NOW, mixed), Err(SendError::NotAccepted));
        // One member at least took it: the receipt says who did not.
        let partly = vec![
            ("bob".to_string(), Ok(())),
            ("carol".to_string(), Err(SendError::TooLong)),
            ("dave".to_string(), Ok(())),
        ];
        assert_eq!(
            group_receipt(NOW, partly),
            Ok(GroupSendReceipt {
                ts: NOW,
                accepted: vec!["bob".to_string(), "dave".to_string()],
                failed: vec!["carol".to_string()],
            })
        );
    }

    /// What `lock_vault` does to the session, as a test can do it.
    fn lock(inner: &mut InnerState) {
        forget_session(inner, &TurnGate::default());
    }

    /// Me, with a session with bob, sending through a relay that holds its
    /// OK until `release` is told; and that relay's client.
    async fn held_ok_to_bob(
        release: &Arc<tokio::sync::Notify>,
    ) -> (Arc<Engine>, TestRelay, Arc<NostrClient>) {
        let relay = TestRelay::start(Answer::AcceptWhenReleased(Arc::clone(release))).await;
        let (me, bob) = (create_identity(), create_identity());
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");
        (state, relay, client)
    }

    /// The user locks just as the relay's OK comes in: `lock_vault` holds
    /// the session when the send has its OK, and wipes it.
    async fn lock_as_the_ok_comes_in(
        state: &Engine,
        relay: &TestRelay,
        client: &NostrClient,
        release: &tokio::sync::Notify,
    ) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the event to reach the relay", || relay.events().len() == 1).await;
        let mut locking = state.inner.lock().await;
        release.notify_one();
        wait_until("the OK", || client.awaiting_ok() == 0).await;
        lock(&mut locking);
    }

    /// What a locked session must not hold of a message sent during the lock.
    async fn kept_nothing(state: &Engine) {
        let inner = state.inner.lock().await;
        assert!(inner.history.is_empty(), "in the locked session's history");
        assert!(inner.outbox.is_empty(), "kept to replay");
    }

    #[tokio::test]
    async fn a_message_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move { send_text(&state, "bob", "texto secreto".to_string(), wait).await }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_file_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move {
                announce_file(&state, "bob", sample_file(), wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    /// Me in a group with bob, carol and dave, sending through a relay that
    /// takes bob's and carol's events at once and never answers dave's.
    async fn group_waiting_for_dave() -> (Arc<Engine>, String, TestRelay, Arc<NostrClient>) {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::SilentTo(pub_hex(&others[2]))).await;
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        let gid = group_of_three(&state, &me, &others).await;
        (state, gid, relay, client)
    }

    /// The user locks once bob's and carol's OKs are in, while the send
    /// still waits for dave's.
    async fn lock_while_waiting_for_dave(state: &Engine, relay: &TestRelay, client: &NostrClient) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the three events", || relay.events().len() == 3).await;
        wait_until("bob's and carol's OKs", || client.awaiting_ok() == 1).await;
        lock(&mut *state.inner.lock().await);
    }

    #[tokio::test]
    async fn a_group_message_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                let text = "texto secreto del grupo".to_string();
                send_group_text(&state, &gid, text, None, wait).await
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_group_file_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                announce_group_file(&state, &gid, sample_file(), None, wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_forward_with_no_relay_up_answers_offline_and_keeps_nothing() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let state = sending_state(&me, vec![unreachable_client(Arc::default())]).await;
        let gid = group_of_three(&state, &me, &others).await;

        for (target, is_group) in [("bob", false), (gid.as_str(), true)] {
            let error = forward_to(&state, target, is_group, sample_file())
                .await
                .unwrap_err();

            assert_eq!(error, SendError::Offline, "{target}");
            assert_eq!(CommandError::from(error).code, ErrorCode::Offline);
        }
        assert!(
            state.inner.lock().await.history.is_empty(),
            "shown as forwarded"
        );
        assert!(
            no_session_moved_on(&state, &["bob", "carol", "dave"]).await,
            "sealed to wait in a queue"
        );
    }

    #[tokio::test]
    async fn a_forward_goes_to_the_contact_or_every_member_and_is_kept() {
        use crate::nostr::test_relay::wait_until;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        forward_to(&state, "bob", false, sample_file())
            .await
            .unwrap();
        forward_to(&state, &gid, true, sample_file()).await.unwrap();

        wait_until("bob's and the group's", || relay.events().len() == 4).await;
        let inner = state.inner.lock().await;
        assert_eq!(inner.history["bob"].len(), 1);
        assert_eq!(inner.history[&group_convo(&gid)].len(), 1);
    }

    #[tokio::test]
    async fn a_member_is_not_added_while_no_relay_is_up() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            let gid = group_of_three(&state, &me, &others).await;
            let before = {
                let mut inner = state.inner.lock().await;
                inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
                inner.groups[&gid].clone()
            };
            let mut saved = false;

            let added = crate::groups::add_member(&state, &gid, "eve", |_| {
                saved = true;
                Ok(())
            })
            .await;

            let Err(error) = added else {
                panic!("added with no relay up");
            };
            assert_eq!(error.code, ErrorCode::Offline);
            assert_eq!(state.inner.lock().await.groups[&gid], before, "stored");
            assert!(!saved, "groups.json was written");
        }
    }

    #[tokio::test]
    async fn a_member_that_cannot_be_reached_does_not_stop_the_others() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        {
            let mut inner = state.inner.lock().await;
            inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
            // bob, the first member the roster goes to, cannot be reached:
            // his session is gone, and the prekey kept for him no longer
            // verifies, so no new one can start.
            let first = inner.groups[&gid]
                .members
                .iter()
                .find(|m| m.ik_sign_pub != ik(&me));
            assert_eq!(first.unwrap().ik_sign_pub, ik(&others[0]));
            inner.ratchets.remove("bob");
            inner.associated_data.remove("bob");
            inner.friends.get_mut("bob").unwrap().bundle.spk_sig = "00".repeat(64);
        }

        let info = crate::groups::add_member(&state, &gid, "eve", |_| Ok(()))
            .await
            .unwrap();

        assert!(info.members.contains(&"eve".to_string()));
        assert!(group::is_member(
            &state.inner.lock().await.groups[&gid],
            &ik(&eve)
        ));
        // carol and dave get the roster; eve gets the handshake that opens
        // her session, then the roster.
        crate::nostr::test_relay::wait_until("the rosters", || relay.events().len() == 4).await;
        let mut reached: Vec<String> = relay
            .events()
            .iter()
            .filter_map(|event| event.recipient().map(str::to_string))
            .collect();
        reached.sort();
        let mut expected = vec![
            pub_hex(&others[1]),
            pub_hex(&others[2]),
            pub_hex(&eve),
            pub_hex(&eve),
        ];
        expected.sort();
        assert_eq!(reached, expected);
    }

    #[tokio::test]
    async fn text_group_and_file_messages_say_that_this_trino_reads_profiles() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        let (mut bob_side, ad, gid) = {
            let mut inner = state.inner.lock().await;
            let (bob_side, ad) = add_session_read_by(&mut inner, &me, &bob, "bob");
            // Revision 7 of bob's profile is the one kept here.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: 7,
                    ..Default::default()
                },
            );
            let roster = roster_of(&me, &[(&bob, "bob")]);
            let gid = roster.group_id.clone();
            inner.groups.insert(gid.clone(), roster);
            (bob_side, ad, gid)
        };
        let file = Envelope::File {
            file: sample_file(),
            gid: None,
            body: None,
        };

        send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();
        send_acked(
            &state,
            "bob",
            &encode_envelope(&file),
            unix_now(),
            SHORT_WAIT,
        )
        .await
        .unwrap();

        let events = relay.events();
        assert_eq!(events.len(), 3);
        let opened: Vec<Vec<u8>> = events
            .iter()
            .map(|event| opened_by(event, &mut bob_side, &ad))
            .collect();
        // Each is still the message sent,
        assert!(
            matches!(decode_envelope(&opened[0]), Envelope::Text { body, .. } if body == "hola")
        );
        assert!(matches!(
            decode_envelope(&opened[1]),
            Envelope::Group { gid: to, body, .. } if to == gid && body == "hola grupo"
        ));
        assert_eq!(decode_envelope(&opened[2]), file);
        // and it says that this Trino reads profiles and which revision of
        // bob's it holds, which bob's Trino records.
        let mut bobs_profiles = profile::Profiles::default();
        for (event, plain) in events.iter().zip(&opened) {
            let fields: serde_json::Value = serde_json::from_slice(plain).unwrap();
            assert_eq!(
                fields["prof"],
                serde_json::json!({ "v": 1, "have": 7, "alert": 1 }),
                "{fields}"
            );
            profile::receive(&mut bobs_profiles, "me", plain, event.created_at);
            assert_eq!(bobs_profiles.contacts["me"].caps, profile::PROFILE_V);
            assert_eq!(bobs_profiles.contacts["me"].have, 7);
        }
    }

    // ---- UR-2: nothing goes to someone blocked (design tests 5 and 6) ----

    /// A call signal the core takes: a hang-up.
    const BYE: &str = r#"{"t":"bye","callId":"0123456789abcdef"}"#;

    fn block_contact(inner: &mut InnerState, handle: &str) {
        let target = crate::block::BlockTarget::Contact(handle.to_string());
        crate::block::block(inner, &target, crate::block::BlockOrigin::Contact, NOW).unwrap();
    }

    #[tokio::test]
    async fn ur2_5_no_text_file_forward_call_handshake_or_resend_goes_to_someone_blocked() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        {
            let mut inner = state.inner.lock().await;
            add_session(&mut inner, &me, &bob, "bob");
            remember_outgoing(&mut inner, "bob", "m1".into(), b"{}".to_vec());
            block_contact(&mut inner, "bob");
        }

        let text = send_text(&state, "bob", "hola".into(), SHORT_WAIT).await;
        let Err(file) = announce_file(&state, "bob", sample_file(), SHORT_WAIT).await else {
            panic!("a file went to someone blocked");
        };
        let forward = forward_to(&state, "bob", false, sample_file()).await;
        for error in [text.unwrap_err(), file, forward.unwrap_err()] {
            assert_eq!(error, SendError::Blocked);
            assert_eq!(CommandError::from(error).code, ErrorCode::Blocked);
        }
        assert_eq!(
            call_signal(&state, "bob", BYE.into()).await.unwrap_err(),
            "blocked"
        );
        let connect = crate::session::connect(&state, "bob".into()).await;
        let resync = crate::session::resync(&state, "bob".into()).await;
        assert_eq!(connect.unwrap_err(), "blocked");
        assert_eq!(resync.unwrap_err(), "blocked");
        assert_eq!(resend_buffered(&state, "bob").await, 0);

        assert!(relay.events().is_empty(), "something was published");
        assert_eq!(sent_so_far(&state, "bob").await, 0, "the session moved on");
        let inner = state.inner.lock().await;
        assert!(!inner.history.contains_key("bob"));
        assert!(
            inner.ratchets.contains_key("bob"),
            "resync dropped the session"
        );
    }

    #[tokio::test]
    async fn ur2_6_a_group_message_skips_someone_blocked_and_your_rosters_still_reach_them() {
        use crate::nostr::test_relay::wait_until;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        block_contact(&mut *state.inner.lock().await, "carol");

        let text = send_group_text(&state, &gid, "hola".into(), None, SHORT_WAIT).await;
        let file = announce_group_file(&state, &gid, sample_file(), None, SHORT_WAIT).await;
        let Ok(file) = file else {
            panic!("the group file went to nobody");
        };
        forward_to(&state, &gid, true, sample_file()).await.unwrap();

        for receipt in [text.unwrap(), file.receipt] {
            assert_eq!(receipt.accepted, ["bob", "dave"]);
            assert!(receipt.failed.is_empty(), "{:?}", receipt.failed);
        }
        wait_until("the forwards", || relay.events().len() == 6).await;
        let carol = pub_hex(&others[1]);
        assert!(relay
            .events()
            .iter()
            .all(|event| event.recipient() != Some(carol.as_str())));
        // As admin, the roster of a change reaches her too, so the group
        // does not break (R-25).
        crate::groups::rename(&state, gid.clone(), "otro".into())
            .await
            .unwrap();
        wait_until("the rosters", || relay.events().len() == 9).await;
        let to_carol = relay
            .events()
            .iter()
            .filter(|event| event.recipient() == Some(carol.as_str()))
            .count();
        assert_eq!(to_carol, 1);
    }
}
