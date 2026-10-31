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

use crate::device::OwnDevice;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use trino_core::device::list::ENTRY_LEN;
use trino_core::device::Entry;
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
