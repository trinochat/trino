//! The contact code `trino3:` (P1-13a; `diseno-vinculacion.md` §13.3 and
//! §11.2, D9): what one person pastes to start talking with another under
//! P1. The code of before, `trino2:`, carried the keys of the X3DH of
//! before; P1's handshake needs the other device's prekeys under its
//! account, so every contact is added again with this one.
//!
//! `trino3:` and then base64url, without padding, of these 434 bytes:
//!
//! ```text
//! version   1    1
//! A         32   the account key
//! gen       4    the generation of the account's list, big-endian
//! seq       8    its seq, big-endian
//! hash      16   the first 16 bytes of the list's SHA-256 (as in the echo)
//! entry     209  the primary's entry, as the list carries it
//! spk       100  the primary's signed prekey (id 4, key 32, sig 64)
//! R         32   this code's request mailbox, x-only secp256k1
//! R_dh      32   this code's request key, X25519
//! ```
//!
//! No device list (§3.4, RV-08), no post-quantum prekey (PQ-09: a
//! handshake from a code is PQ-11, §21.6), no name and no photo. A code
//! made on a linked device still points to the primary (RV-05, PB-21).
//! Reading checks the shape only; [`CodeV3::verify`] checks that the entry
//! is the account's primary and signed by its device, and that the prekey
//! is signed by it. Who `A` is, is what the person pasting trusts: the
//! list the device then sends must be signed by `A` (RV-06).

use crate::device::{peer_account, peer_device_dh, OwnDevice};
use crate::state::InnerState;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use trino_core::device::list::ENTRY_LEN;
use trino_core::device::Entry;
use trino_core::identity::{generate_nostr_keypair, generate_x25519, KeyPair};
use trino_core::pqxdh::{SignedSpk, SIGNED_SPK_LEN};

/// What every `trino3:` code starts with.
pub const PREFIX: &str = "trino3:";
/// The only version of the bytes so far.
pub const VERSION: u8 = 1;
/// How much of the list's SHA-256 the code carries.
pub const LIST_HASH_LEN: usize = 16;
/// The length of the bytes after the prefix.
pub const CODE_LEN: usize = 1 + 32 + 4 + 8 + LIST_HASH_LEN + ENTRY_LEN + SIGNED_SPK_LEN + 32 + 32;

/// A `trino3:` code, read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CodeV3 {
    /// `A`, the account key.
    pub account: [u8; 32],
    pub gen: u32,
    pub seq: u64,
    pub list_hash: [u8; LIST_HASH_LEN],
    /// The primary's entry.
    pub entry: Entry,
    /// The primary's signed prekey.
    pub spk: SignedSpk,
    /// `R`, the request mailbox of this code (P1-13 listens to it).
    pub r: [u8; 32],
    /// `R_dh`, the request key of this code.
    pub r_dh: [u8; 32],
}

/// Why a pasted text is not a code to add.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CodeError {
    /// A code of before: `trino1:`, `trino2:` or a bundle in JSON.
    Old,
    /// Not a `trino3:` code: no prefix, not base64url, or the wrong length.
    Format,
    /// A version this one does not read.
    Version(u8),
    /// The entry is not signed by its device for `A`, or it is not the
    /// primary.
    Entry,
    /// The prekey is not signed by the entry's device.
    Prekey,
}

impl CodeV3 {
    /// The code of this device's account, with the request keys `r` and
    /// `r_dh` (public). `None` when this device is not the primary: until
    /// linking (VI-8) it always is, and a linked one does not hold the
    /// primary's prekey (RV-05 is for then).
    pub fn of(device: &OwnDevice, r: [u8; 32], r_dh: [u8; 32]) -> Option<CodeV3> {
        let list = &device.list;
        let entry = list.primary()?;
        if entry.dev_dh != device.dev_dh().pub_bytes {
            return None;
        }
        let mut list_hash = [0u8; LIST_HASH_LEN];
        list_hash.copy_from_slice(&list.hash()[..LIST_HASH_LEN]);
        Some(CodeV3 {
            account: list.body.account,
            gen: list.body.gen,
            seq: list.body.seq,
            list_hash,
            entry: entry.clone(),
            spk: device.identity.device.signed_spk(),
            r,
            r_dh,
        })
    }

    /// The code as text: `trino3:` and its bytes in base64url.
    pub fn encode(&self) -> String {
        let mut out = Vec::with_capacity(CODE_LEN);
        out.push(VERSION);
        out.extend_from_slice(&self.account);
        out.extend_from_slice(&self.gen.to_be_bytes());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(&self.list_hash);
        out.extend_from_slice(&self.entry.to_bytes());
        out.extend_from_slice(&self.spk.encode());
        out.extend_from_slice(&self.r);
        out.extend_from_slice(&self.r_dh);
        format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(out))
    }

    /// Reads a pasted code: spaces and line breaks inside are ignored (a
    /// chat app may wrap it), and the prefix in any case.
    pub fn decode(text: &str) -> Result<CodeV3, CodeError> {
        if is_old(text) {
            return Err(CodeError::Old);
        }
        let code = without_spaces(text);
        let body = strip_prefix(&code, PREFIX).ok_or(CodeError::Format)?;
        let b = URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| CodeError::Format)?;
        match b.first() {
            Some(&VERSION) => {}
            Some(&other) if b.len() == CODE_LEN => return Err(CodeError::Version(other)),
            _ => return Err(CodeError::Format),
        }
        if b.len() != CODE_LEN {
            return Err(CodeError::Format);
        }
        let mut at = 1;
        let mut take = |n: usize| {
            let part = &b[at..at + n];
            at += n;
            part
        };
        let account = take(32).try_into().expect("32 bytes");
        let gen = u32::from_be_bytes(take(4).try_into().expect("4 bytes"));
        let seq = u64::from_be_bytes(take(8).try_into().expect("8 bytes"));
        let list_hash = take(LIST_HASH_LEN).try_into().expect("16 bytes");
        let entry = Entry::from_bytes(take(ENTRY_LEN)).map_err(|_| CodeError::Format)?;
        let spk = SignedSpk::decode(take(SIGNED_SPK_LEN)).map_err(|_| CodeError::Format)?;
        let r = take(32).try_into().expect("32 bytes");
        let r_dh = take(32).try_into().expect("32 bytes");
        Ok(CodeV3 {
            account,
            gen,
            seq,
            list_hash,
            entry,
            spk,
            r,
            r_dh,
        })
    }

    /// The entry is the primary of `A`, signed by its device both ways,
    /// and the prekey is signed by that device.
    pub fn verify(&self) -> Result<(), CodeError> {
        if !self.entry.is_primary() {
            return Err(CodeError::Entry);
        }
        self.entry
            .verify(&self.account)
            .map_err(|_| CodeError::Entry)?;
        self.spk
            .verify(&self.entry.dev_sign)
            .map_err(|_| CodeError::Prekey)
    }
}

// ---- A contact's code ------------------------------------------------------

/// Why a code does not reconnect the contact of its account.
#[derive(Debug, PartialEq, Eq)]
pub enum ReconnectError {
    /// No such contact.
    Unknown,
    /// The code's primary is not the device held for the contact (the
    /// `ik_dh` pinned when it was added, or its list's primary): a change
    /// of keys (K8, §13.2), never taken in silence.
    KeyChange,
    /// The code names the list held, by its `gen` and `seq`, with another
    /// hash: two lists of one account at one place (§3.5).
    Fork,
}

/// The contact whose account is the code's `A`, by its name here.
pub fn holder(inner: &InnerState, code: &CodeV3) -> Option<String> {
    inner
        .friends
        .values()
        .find(|friend| peer_account(friend) == Some(code.account))
        .map(|friend| friend.handle.clone())
}

/// Takes `code` (checked) for the contact `handle` of its account: the
/// handshake starts from it until a list at least as new arrives. True if
/// it was kept; false if the list held is newer than the code already,
/// which then adds nothing.
pub fn reconnect(
    inner: &mut InnerState,
    handle: &str,
    code: CodeV3,
) -> Result<bool, ReconnectError> {
    let friend = inner.friends.get(handle).ok_or(ReconnectError::Unknown)?;
    if peer_account(friend) != Some(code.account) {
        return Err(ReconnectError::Unknown);
    }
    // Until device linking (VI-9) a contact is one device: the code's
    // primary has to be it.
    if peer_device_dh(friend) != Some(code.entry.dev_dh) {
        return Err(ReconnectError::KeyChange);
    }
    if let Some(devices) = &friend.devices {
        let held = devices.chain.current();
        let at = (held.body.gen, held.body.seq);
        match (code.gen, code.seq).cmp(&at) {
            Ordering::Less => return Ok(false),
            Ordering::Equal if held.hash()[..LIST_HASH_LEN] != code.list_hash => {
                return Err(ReconnectError::Fork)
            }
            Ordering::Equal
                if devices
                    .chain
                    .device_for_dh(&code.entry.dev_dh)
                    .map(|entry| entry.dev_sign)
                    != Some(code.entry.dev_sign) =>
            {
                return Err(ReconnectError::KeyChange)
            }
            _ => {}
        }
    }
    if let Some(friend) = inner.friends.get_mut(handle) {
        friend.from_code = Some(code);
    }
    Ok(true)
}

/// Whether the contact `handle` needs a new code (P1-13a): nothing of its
/// account under P1 (no list, no code) and no session, as a contact
/// migrated from before P1 until one side pastes the other's code.
pub fn needs_code(inner: &InnerState, handle: &str) -> bool {
    inner.friends.get(handle).is_some_and(|friend| {
        friend.devices.is_none()
            && friend.from_code.is_none()
            && !crate::session::has_session(inner, handle)
    })
}

/// `FriendRecord::from_code` in the account file: the code as text.
pub mod serde_code {
    use super::CodeV3;
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(
        code: &Option<CodeV3>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        code.as_ref().map(CodeV3::encode).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<CodeV3>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|text| CodeV3::decode(&text).map_err(|_| D::Error::custom("not a trino3: code")))
            .transpose()
    }
}

// ---- This account's request keys ------------------------------------------

/// One code's request keys (§11.2): `R`, the secp256k1 mailbox requests
/// by that code arrive at, and `R_dh`, the X25519 key they are sealed to.
/// They are the account's, kept in the account file; receiving requests
/// by code is P1-13's. One is made with the account (or at the first
/// unlock of an account of before) and every code shared carries the
/// newest, until P1-13 lets the user revoke it and make another.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeKey {
    #[serde(with = "hex_pair")]
    pub r: KeyPair,
    #[serde(with = "hex_pair")]
    pub r_dh: KeyPair,
    pub created_at: i64,
}

impl PartialEq for CodeKey {
    fn eq(&self, other: &Self) -> bool {
        self.r.priv_bytes == other.r.priv_bytes
            && self.r.pub_bytes == other.r.pub_bytes
            && self.r_dh.priv_bytes == other.r_dh.priv_bytes
            && self.r_dh.pub_bytes == other.r_dh.pub_bytes
            && self.created_at == other.created_at
    }
}

impl CodeKey {
    /// A new pair of request keys, made at `now`.
    pub fn generate(now: i64) -> CodeKey {
        CodeKey {
            r: generate_nostr_keypair(),
            r_dh: generate_x25519(),
            created_at: now,
        }
    }
}

/// Makes this account's first request keys if it has none. True when it
/// made them, so the account file has to be written.
pub fn ensure_key(keys: &mut Vec<CodeKey>, now: i64) -> bool {
    if !keys.is_empty() {
        return false;
    }
    keys.push(CodeKey::generate(now));
    true
}

/// The `trino3:` code this device shares (`share_bundle`): its account's
/// primary and the newest request keys.
pub fn share_code(inner: &InnerState) -> Result<String, String> {
    let device = inner.device.as_ref().ok_or("vault sealed")?;
    let key = inner.code_keys.last().ok_or("no request keys yet")?;
    let code = CodeV3::of(device, key.r.pub_bytes, key.r_dh.pub_bytes)
        .ok_or("this device is not its account's primary")?;
    Ok(code.encode())
}

/// A key pair in the account file: both halves in hex.
mod hex_pair {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use trino_core::identity::KeyPair;
    use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

    #[derive(Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
    struct Stored {
        secret: String,
        public: String,
    }

    pub fn serialize<S: Serializer>(pair: &KeyPair, serializer: S) -> Result<S::Ok, S::Error> {
        Stored {
            secret: hex::encode(pair.priv_bytes),
            public: hex::encode(pair.pub_bytes),
        }
        .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<KeyPair, D::Error> {
        let stored = Stored::deserialize(deserializer)?;
        let bytes = |text: &str| -> Result<[u8; 32], D::Error> {
            let raw = Zeroizing::new(hex::decode(text).map_err(D::Error::custom)?);
            raw.as_slice()
                .try_into()
                .map_err(|_| D::Error::custom("a key is 32 bytes"))
        };
        Ok(KeyPair {
            priv_bytes: bytes(&stored.secret)?,
            pub_bytes: bytes(&stored.public)?,
        })
    }
}

/// Whether a pasted text is a code of before: `trino1:`, `trino2:` or a
/// bundle in JSON with an identity key. It says "Este código es de una
/// versión anterior de Trino" instead of "no es válido".
pub fn is_old(text: &str) -> bool {
    let code = without_spaces(text);
    let after = |prefix| strip_prefix(&code, prefix).is_some_and(|rest| !rest.is_empty());
    if after("trino1:") || after("trino2:") {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(text.trim())
        .is_ok_and(|value| value.get("ikSignPub").is_some_and(|key| key.is_string()))
}

/// The text without spaces or line breaks.
fn without_spaces(text: &str) -> String {
    text.chars().filter(|c| !c.is_whitespace()).collect()
}

/// `code` after `prefix`, which may be in any case.
fn strip_prefix<'a>(code: &'a str, prefix: &str) -> Option<&'a str> {
    let head = code.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &code[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::tests::own_device_of;
    use crate::identity::create_identity;
    use trino_core::device::list::FLAG_PRIMARY;

    const NOW: i64 = 1_793_000_000;

    /// The fixed vector, also in src/lib/contact-code.test.ts: every field
    /// a byte pattern, computed apart from this code.
    const VECTOR: &str = "trino3:ARERERERERERERERERERERERERERERERERERERERERERAAAAAQAAAAAAAAACIiIiIiIiIiIiIiIiIiIiIgECAwQBMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzNERERERERERERERERERERERERERERERERERERERERERAAAAAEAAAAAAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmCgsMDXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiJmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo";

    fn vector_code() -> CodeV3 {
        CodeV3 {
            account: [0x11; 32],
            gen: 1,
            seq: 2,
            list_hash: [0x22; LIST_HASH_LEN],
            entry: Entry {
                id: 0x0102_0304,
                flags: FLAG_PRIMARY,
                dev_sign: [0x33; 32],
                dev_dh: [0x44; 32],
                since: (1, 1),
                d_sig: [0x55; 64],
                dh_sig: [0x66; 64],
            },
            spk: SignedSpk {
                id: 0x0A0B_0C0D,
                public: [0x77; 32],
                sig: [0x88; 64],
            },
            r: [0x99; 32],
            r_dh: [0xAA; 32],
        }
    }

    #[test]
    fn the_fixed_vector_encodes_and_decodes() {
        assert_eq!(CODE_LEN, 434);
        let code = vector_code();
        assert_eq!(code.encode(), VECTOR);
        assert_eq!(VECTOR.len(), 7 + 579, "about 579 characters (§21.4)");
        assert_eq!(CodeV3::decode(VECTOR).unwrap(), code);
    }

    #[test]
    fn a_wrapped_code_with_its_prefix_in_capitals_still_reads() {
        let wrapped = format!(
            "  TRINO3:{}\n{}\r\n {} ",
            &VECTOR[7..200],
            &VECTOR[200..400],
            &VECTOR[400..]
        );
        assert_eq!(CodeV3::decode(&wrapped).unwrap(), vector_code());
    }

    #[test]
    fn a_code_of_another_shape_or_version_is_refused() {
        let bytes = URL_SAFE_NO_PAD.decode(&VECTOR[7..]).unwrap();
        let text = |b: &[u8]| format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(b));
        assert_eq!(
            CodeV3::decode(&text(&bytes[..CODE_LEN - 1])),
            Err(CodeError::Format)
        );
        assert_eq!(
            CodeV3::decode(&text(&[bytes.as_slice(), &[0]].concat())),
            Err(CodeError::Format)
        );
        let mut v2 = bytes.clone();
        v2[0] = 2;
        assert_eq!(CodeV3::decode(&text(&v2)), Err(CodeError::Version(2)));
        assert_eq!(CodeV3::decode("trino3:###"), Err(CodeError::Format));
        assert_eq!(CodeV3::decode(""), Err(CodeError::Format));
        assert_eq!(CodeV3::decode(&VECTOR[7..]), Err(CodeError::Format));
        // Padding is no part of the code, but a pasted one may carry it.
        let padded = format!("{VECTOR}=");
        assert_eq!(CodeV3::decode(&padded), Err(CodeError::Format));
        // An entry with flags this version does not know.
        let mut flags = bytes;
        flags[1 + 32 + 4 + 8 + LIST_HASH_LEN + 4] = 0x80;
        assert_eq!(CodeV3::decode(&text(&flags)), Err(CodeError::Format));
    }

    #[test]
    fn the_codes_of_before_are_told_apart() {
        let v1 = create_identity();
        let json = crate::account::own_bundle_json(&v1, "ana", None).unwrap();
        assert!(is_old(&json));
        assert!(is_old(&format!("  {json}\n")));
        assert!(is_old(&format!(
            "trino1:{}",
            URL_SAFE_NO_PAD.encode(json.as_bytes())
        )));
        assert!(is_old("TRINO2:AQNhbmE"));
        assert!(is_old("trino2:\nAQNhbmE"));
        assert!(!is_old(VECTOR));
        assert!(!is_old("hola"));
        assert!(!is_old("{\"a\":1}"));
        assert!(!is_old("trino1:"));
        assert_eq!(CodeV3::decode(&json), Err(CodeError::Old));
        assert_eq!(CodeV3::decode("trino2:AQNhbmE"), Err(CodeError::Old));
    }

    #[test]
    fn this_device_s_code_names_its_primary_and_verifies() {
        let v1 = create_identity();
        let device = own_device_of(&v1, NOW);
        let code = CodeV3::of(&device, [0x99; 32], [0xAA; 32]).unwrap();
        assert_eq!(code.account, v1.ik_sign.pub_bytes);
        assert_eq!((code.gen, code.seq), (1, 1));
        assert_eq!(code.list_hash, device.list.hash()[..LIST_HASH_LEN]);
        assert_eq!(code.entry, device.list.body.entries[0]);
        assert_eq!(code.entry.dev_dh, v1.ik_dh.pub_bytes);
        assert_eq!(code.spk, device.identity.device.signed_spk());
        assert_eq!((code.r, code.r_dh), ([0x99; 32], [0xAA; 32]));
        code.verify().unwrap();
        let text = code.encode();
        assert_eq!(text.len(), 586);
        let back = CodeV3::decode(&text).unwrap();
        assert_eq!(back, code);
        back.verify().unwrap();
    }

    #[test]
    fn a_code_key_holds_a_mailbox_key_and_an_x25519_key() {
        let key = CodeKey::generate(NOW);
        assert_eq!(key.created_at, NOW);
        // R is a secp256k1 key whose x-only public half is its tag.
        let secp = secp256k1::Secp256k1::new();
        let pair = secp256k1::Keypair::from_seckey_slice(&secp, &key.r.priv_bytes).unwrap();
        assert_eq!(pair.x_only_public_key().0.serialize(), key.r.pub_bytes);
        // R_dh agrees with any X25519 key from both ends.
        let other = trino_core::identity::generate_x25519();
        assert_eq!(
            trino_core::identity::x25519_derive_shared(&key.r_dh.priv_bytes, &other.pub_bytes),
            trino_core::identity::x25519_derive_shared(&other.priv_bytes, &key.r_dh.pub_bytes)
        );
        assert_ne!(CodeKey::generate(NOW).r.pub_bytes, key.r.pub_bytes);

        let json = serde_json::to_value(&key).unwrap();
        assert_eq!(json["r"]["public"], hex::encode(key.r.pub_bytes));
        assert_eq!(json["createdAt"], NOW);
        let back: CodeKey = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back, key);
        let mut short = json;
        short["rDh"]["secret"] = serde_json::Value::String("00".into());
        assert!(serde_json::from_value::<CodeKey>(short).is_err());
    }

    #[test]
    fn an_account_gets_its_request_keys_once() {
        let mut keys = Vec::new();
        assert!(ensure_key(&mut keys, NOW));
        assert_eq!(keys.len(), 1);
        let first = keys[0].clone();
        assert!(!ensure_key(&mut keys, NOW + 60));
        assert_eq!(keys, vec![first]);
    }

    #[test]
    fn the_shared_code_carries_this_device_and_the_newest_request_keys() {
        let v1 = create_identity();
        let mut inner = InnerState {
            identity: Some(v1.clone()),
            device: Some(own_device_of(&v1, NOW)),
            ..Default::default()
        };
        assert!(share_code(&inner).is_err(), "no request keys yet");
        let old = CodeKey::generate(NOW - 10);
        let new = CodeKey::generate(NOW);
        inner.code_keys = vec![old, new.clone()];

        let text = share_code(&inner).unwrap();
        let code = CodeV3::decode(&text).unwrap();
        code.verify().unwrap();
        assert_eq!(code.account, v1.ik_sign.pub_bytes);
        assert_eq!(code.entry.dev_dh, v1.ik_dh.pub_bytes);
        assert_eq!((code.r, code.r_dh), (new.r.pub_bytes, new.r_dh.pub_bytes));

        inner.device = None;
        assert!(share_code(&inner).is_err(), "sealed");
    }

    // ---- A contact's code (P1-13a.3) ---------------------------------------

    use crate::nostr::NostrEvent;
    use crate::p1::tests::{person, Person};
    use crate::p1::{initiate, open, seal, Opened, KIND_MESSAGE};
    use crate::send::SendError;
    use crate::state::FriendRecord;

    /// The code `who` shares.
    fn code_of(who: &Person) -> CodeV3 {
        CodeV3::of(who.device(), [0x99; 32], [0xAA; 32]).unwrap()
    }

    /// What an admitted event gives: the envelope, whether it started a
    /// session, and the replies. Panics if it was dropped.
    fn admitted(opened: Opened) -> (Option<Vec<u8>>, bool, Vec<NostrEvent>) {
        match opened {
            Opened::Contact {
                envelope,
                established,
                replies,
                ..
            } => (envelope.map(|e| e.to_vec()), established, replies),
            Opened::Drop(why) => panic!("dropped: {why}"),
            Opened::Undecryptable { .. } => panic!("undecryptable"),
        }
    }

    /// Ana and Bea, contacts of each other since before P1: neither holds
    /// anything of the other's account under P1.
    fn migrated() -> (Person, Person) {
        let mut ana = person();
        let mut bea = person();
        ana.add("bea", &bea, None);
        bea.add("ana", &ana, None);
        (ana, bea)
    }

    #[test]
    fn one_side_pasting_the_other_s_code_reconnects_both() {
        let (mut ana, mut bea) = migrated();
        assert!(needs_code(&ana.inner, "bea"));
        assert!(needs_code(&bea.inner, "ana"));
        assert_eq!(
            initiate(&mut bea.inner, "ana", NOW).unwrap_err(),
            SendError::NoPrekeys
        );

        // Bea pastes Ana's code: it is Ana's account, and it reconnects her.
        let code = code_of(&ana);
        assert_eq!(holder(&bea.inner, &code), Some("ana".to_string()));
        assert_eq!(holder(&ana.inner, &code), None, "nobody here is Ana");
        assert_eq!(reconnect(&mut bea.inner, "ana", code.clone()), Ok(true));
        assert_eq!(bea.inner.friends.len(), 1);
        assert_eq!(bea.inner.friends["ana"].from_code, Some(code));
        assert!(!needs_code(&bea.inner, "ana"));

        // Her handshake is PQ-11 (the code has no post-quantum prekey).
        let hello = initiate(&mut bea.inner, "ana", NOW).unwrap();
        assert!(bea.inner.mailboxes.pq11.contains_key("ana"));
        let (_, established, replies) = admitted(open(&mut ana.inner, &hello, NOW + 5));
        assert!(established, "Ana's chat opens when the handshake arrives");
        assert!(!needs_code(&ana.inner, "bea"));
        assert_eq!(replies.len(), 2, "the type 4 and Ana's full list");

        let (_, established, back) = admitted(open(&mut bea.inner, &replies[0], NOW + 10));
        assert!(established);
        let held = &bea.inner.friends["ana"];
        assert!(held.devices.is_some(), "Ana's list, taken");
        assert_eq!(held.from_code, None, "the code is no longer needed");
        admitted(open(&mut bea.inner, &replies[1], NOW + 11));
        for event in &back {
            admitted(open(&mut ana.inner, event, NOW + 12));
        }

        // And they talk both ways.
        let hello_ana: &[u8] = b"{\"a\":1}";
        let to_ana = seal(
            &mut bea.inner,
            "ana",
            hello_ana,
            None,
            KIND_MESSAGE,
            NOW + 20,
        )
        .unwrap();
        let (envelope, _, _) = admitted(open(&mut ana.inner, &to_ana, NOW + 21));
        assert_eq!(envelope.as_deref(), Some(hello_ana));
        let hello_bea: &[u8] = b"{\"b\":2}";
        let to_bea = seal(
            &mut ana.inner,
            "bea",
            hello_bea,
            None,
            KIND_MESSAGE,
            NOW + 30,
        )
        .unwrap();
        let (envelope, _, _) = admitted(open(&mut bea.inner, &to_bea, NOW + 31));
        assert_eq!(envelope.as_deref(), Some(hello_bea));
    }

    #[test]
    fn a_code_whose_primary_is_not_the_device_pinned_is_a_change_of_keys() {
        let (ana, mut bea) = migrated();
        // Ana's account key, another X25519 key: not the device Bea pinned.
        let mut other = ana.v1.clone();
        other.ik_dh = create_identity().ik_dh;
        let impostor = own_device_of(&other, NOW);
        let code = CodeV3::of(&impostor, [1; 32], [2; 32]).unwrap();
        code.verify().unwrap();
        assert_eq!(holder(&bea.inner, &code), Some("ana".to_string()));
        assert_eq!(
            reconnect(&mut bea.inner, "ana", code.clone()),
            Err(ReconnectError::KeyChange)
        );
        assert_eq!(bea.inner.friends["ana"].from_code, None);
        assert_eq!(
            reconnect(&mut bea.inner, "nadie", code),
            Err(ReconnectError::Unknown)
        );
    }

    #[test]
    fn a_code_against_the_list_held_is_kept_only_if_it_agrees() {
        let (ana, mut bea) = migrated();
        // Bea already holds Ana's list.
        let hers = ana.device().compact_bundle();
        crate::device::take_bundle(&mut bea.inner, "ana", hers, NOW as u64).unwrap();
        let code = code_of(&ana);
        // The same list: kept (its prekey may be newer).
        assert_eq!(reconnect(&mut bea.inner, "ana", code.clone()), Ok(true));
        // The same place in the chain with another hash: a fork.
        bea.inner.friends.get_mut("ana").unwrap().from_code = None;
        let mut forked = code.clone();
        forked.list_hash[0] ^= 1;
        assert_eq!(
            reconnect(&mut bea.inner, "ana", forked),
            Err(ReconnectError::Fork)
        );
        // Older than the list held: nothing to take.
        let mut older = code;
        older.seq = 0;
        assert_eq!(reconnect(&mut bea.inner, "ana", older), Ok(false));
        assert_eq!(bea.inner.friends["ana"].from_code, None);
    }

    #[test]
    fn a_first_list_older_than_the_code_does_not_open_the_session() {
        let (mut ana, mut bea) = migrated();
        // A code that says Ana's list is at seq 5; her device sends seq 1.
        let mut code = code_of(&ana);
        code.seq = 5;
        reconnect(&mut bea.inner, "ana", code).unwrap();
        let hello = initiate(&mut bea.inner, "ana", NOW).unwrap();
        let (_, _, replies) = admitted(open(&mut ana.inner, &hello, NOW + 5));
        match open(&mut bea.inner, &replies[0], NOW + 10) {
            Opened::Drop(why) => assert_eq!(why, "first reply without a list that checks"),
            _ => panic!("admitted a list older than the code"),
        }
        assert!(bea.inner.friends["ana"].devices.is_none());
        assert!(bea.inner.friends["ana"].from_code.is_some());
    }

    #[test]
    fn the_code_is_kept_with_the_contact() {
        let (ana, mut bea) = migrated();
        reconnect(&mut bea.inner, "ana", code_of(&ana)).unwrap();
        let record = bea.inner.friends["ana"].clone();
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!(json["fromCode"], code_of(&ana).encode());
        let back: FriendRecord = serde_json::from_value(json.clone()).unwrap();
        assert_eq!(back.from_code, record.from_code);
        // A record without it reads as one without it, and one that does
        // not read is refused whole.
        let mut plain = json.clone();
        plain.as_object_mut().unwrap().remove("fromCode");
        let plain: FriendRecord = serde_json::from_value(plain).unwrap();
        assert!(plain.from_code.is_none());
        assert!(serde_json::to_value(&plain)
            .unwrap()
            .get("fromCode")
            .is_none());
        let mut bad = json;
        bad["fromCode"] = serde_json::Value::String("trino3:AAAA".into());
        assert!(serde_json::from_value::<FriendRecord>(bad).is_err());
    }

    #[test]
    fn a_contact_with_a_list_needs_no_code() {
        let (mut ana, bea) = migrated();
        assert!(!needs_code(&ana.inner, "nadie"));
        let hers = bea.device().compact_bundle();
        crate::device::take_bundle(&mut ana.inner, "bea", hers, NOW as u64).unwrap();
        assert!(!needs_code(&ana.inner, "bea"), "it holds her list");
    }

    #[test]
    fn a_code_whose_signatures_do_not_hold_is_refused() {
        let device = own_device_of(&create_identity(), NOW);
        let code = CodeV3::of(&device, [1; 32], [2; 32]).unwrap();

        // Another account than the one the entry was signed for.
        let mut other = code.clone();
        other.account = create_identity().ik_sign.pub_bytes;
        assert_eq!(other.verify(), Err(CodeError::Entry));

        let mut forged = code.clone();
        forged.entry.dh_sig[0] ^= 1;
        assert_eq!(forged.verify(), Err(CodeError::Entry));

        let mut not_primary = code.clone();
        not_primary.entry.flags = 0;
        assert_eq!(not_primary.verify(), Err(CodeError::Entry));

        let mut prekey = code.clone();
        prekey.spk.sig[0] ^= 1;
        assert_eq!(prekey.verify(), Err(CodeError::Prekey));

        // Its own prekey, but signed by someone else's device.
        let mut theirs = code;
        theirs.spk = own_device_of(&create_identity(), NOW)
            .identity
            .device
            .signed_spk();
        assert_eq!(theirs.verify(), Err(CodeError::Prekey));
    }
}
