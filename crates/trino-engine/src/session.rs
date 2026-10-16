//! The session's core (M4-0c): what a session with a contact is made of
//! and what every part of the engine shares about it. The wire format of a
//! message, the fingerprint of an identity, the checks on the pictures a
//! contact sends, and the key a group's chat is kept under.

use crate::group::{FileRef, GroupRoster};
use base64::Engine;
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

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

pub fn sanitize_file_ref(mut file: FileRef) -> FileRef {
    file.thumb = sanitized_inline_raster(file.thumb);
    file
}

pub fn sanitize_roster(mut roster: GroupRoster) -> GroupRoster {
    roster.photo = roster.photo.map(sanitize_file_ref);
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
