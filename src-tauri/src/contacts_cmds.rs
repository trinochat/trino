//! Contacts (W8): the full identity digest of every contact and of this
//! identity (K7).
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::{fp, NodeInfo};
use crate::identity::{decode_array_32, PublicBundle};
use crate::state::{FriendRecord, InnerState};

/// SHA-256 of the identity signing key, the identity DH key and the Nostr
/// key, as 64 lowercase hex digits (K7). It names an identity in full, where
/// `fp` shows only its first 8 bytes; the SAS (docs/sas-v2.md) is derived
/// from it.
pub(crate) fn identity_digest(ik_sign: &[u8; 32], ik_dh: &[u8; 32], nostr: &[u8; 32]) -> String {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(ik_sign);
    input.extend_from_slice(ik_dh);
    input.extend_from_slice(nostr);
    hex::encode(crate::crypto::sha256(&input))
}

/// The three identity keys of a bundle, or `None` if one does not decode.
pub(crate) fn bundle_keys(bundle: &PublicBundle) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    Some((
        decode_array_32(&bundle.ik_sign_pub).ok()?,
        decode_array_32(&bundle.ik_dh_pub).ok()?,
        decode_array_32(&bundle.nostr_pub).ok()?,
    ))
}

/// What `list_nodes` and `probe_node` say about one contact.
pub(super) fn node_info(inner: &InnerState, friend: &FriendRecord) -> NodeInfo {
    let keys = bundle_keys(&friend.bundle);
    // Keys that do not decode keep the fingerprint they always had (over
    // zeros), but get no digest: a digest of zeros would name nobody.
    let (ik_sign, ik_dh, nostr) = keys.unwrap_or(([0u8; 32], [0u8; 32], [0u8; 32]));
    NodeInfo {
        handle: friend.handle.clone(),
        fingerprint: fp(&ik_sign, &ik_dh, &nostr),
        has_session: inner.ratchets.contains_key(&friend.handle),
        added_at: friend.added_at,
        avatar: friend.avatar.clone(),
        blocked: inner.blocked.contains(&friend.bundle.nostr_pub),
        identity_digest: keys
            .map(|(ik_sign, ik_dh, nostr)| identity_digest(&ik_sign, &ik_dh, &nostr)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::profile_of;
    use crate::identity::{create_identity, public_bundle_for, Identity};

    fn digest_of(id: &Identity) -> String {
        identity_digest(
            &id.ik_sign.pub_bytes,
            &id.ik_dh.pub_bytes,
            &id.nostr.pub_bytes,
        )
    }

    fn friend(id: &Identity, handle: &str) -> FriendRecord {
        FriendRecord {
            handle: handle.to_string(),
            bundle: public_bundle_for(id),
            added_at: 0,
            avatar: None,
        }
    }

    #[test]
    fn the_identity_digest_is_the_sha256_of_the_three_keys_in_full_hex() {
        // Computed apart, with Python's hashlib:
        // sha256(bytes([1]*32 + [2]*32 + [3]*32)).hexdigest()
        assert_eq!(
            identity_digest(&[1; 32], &[2; 32], &[3; 32]),
            "8a2e491356cfdb05a1d13785e0794d7cd163f91af79a146c976b1d2ac643b679"
        );
        let digest = digest_of(&create_identity());
        assert_eq!(digest.len(), 64);
        assert!(digest
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));
    }

    #[test]
    fn the_identity_digest_is_stable_and_changes_with_every_key() {
        let base = identity_digest(&[1; 32], &[2; 32], &[3; 32]);
        assert_eq!(identity_digest(&[1; 32], &[2; 32], &[3; 32]), base);
        for other in [
            identity_digest(&[9; 32], &[2; 32], &[3; 32]),
            identity_digest(&[1; 32], &[9; 32], &[3; 32]),
            identity_digest(&[1; 32], &[2; 32], &[9; 32]),
            // The order of the keys counts.
            identity_digest(&[2; 32], &[1; 32], &[3; 32]),
        ] {
            assert_ne!(other, base);
        }
    }

    #[test]
    fn the_fingerprint_is_the_first_8_bytes_of_the_digest() {
        assert_eq!(fp(&[1; 32], &[2; 32], &[3; 32]), "8a2e.4913.56cf.db05");
        let id = create_identity();
        let digest = digest_of(&id);
        let fingerprint = fp(
            &id.ik_sign.pub_bytes,
            &id.ik_dh.pub_bytes,
            &id.nostr.pub_bytes,
        );
        assert_eq!(fingerprint.replace('.', ""), digest[..16]);
    }

    #[test]
    fn every_contact_carries_its_digest() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        let record = friend(&ana, "ana");
        inner.friends.insert("ana".into(), record.clone());

        let node = node_info(&inner, &record);

        assert_eq!(
            node.identity_digest.as_deref(),
            Some(digest_of(&ana).as_str())
        );
        assert_eq!(node.fingerprint.replace('.', ""), digest_of(&ana)[..16]);
        let json = serde_json::to_value(&node).unwrap();
        assert_eq!(json["identity_digest"], digest_of(&ana));
    }

    #[test]
    fn a_contact_whose_keys_do_not_decode_has_no_digest() {
        let mut record = friend(&create_identity(), "ana");
        record.bundle.nostr_pub = "not hex".into();

        let node = node_info(&InnerState::default(), &record);

        assert_eq!(node.identity_digest, None);
        assert_eq!(
            serde_json::to_value(&node).unwrap()["identity_digest"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn the_profile_carries_this_identitys_digest() {
        let me = create_identity();
        let inner = InnerState {
            identity: Some(me.clone()),
            handle: Some("ana".into()),
            ..InnerState::default()
        };

        let profile = profile_of(&inner).unwrap();

        assert_eq!(profile.identity_digest, digest_of(&me));
        assert_eq!(profile.fingerprint.replace('.', ""), digest_of(&me)[..16]);
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(json["identity_digest"], digest_of(&me));
        assert!(profile_of(&InnerState::default()).is_err(), "sealed");
    }
}
