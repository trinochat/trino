//! Contacts (W8): the full identity digest of every contact and of this
//! identity (K7); checking a contact code before saving anything, adding a
//! contact without ever overwriting a pinned key silently, and the alert
//! when a contact's keys change (K8).
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::{fp, persist_account, sanitized_inline_raster, NodeInfo};
use crate::command_error::{CommandError, ErrorCode};
use crate::identity::{decode_array_32, verify_bundle_binding, PublicBundle};
use crate::state::{AppState, FriendRecord, InnerState};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;
pub(crate) use trino_engine::contacts::{check_local_handle, not_found, sealed};
use trino_engine::group_contacts::{self, is_limited};

/// A contact code whose keys its identity key signed (K8).
#[derive(Clone, Debug)]
pub(crate) struct ContactCode {
    pub bundle: PublicBundle,
    /// The name the code suggests, trimmed; empty when it has none.
    pub handle: String,
    /// Its photo, when it carries a valid inline image.
    pub avatar: Option<String>,
    keys: ([u8; 32], [u8; 32], [u8; 32]),
}

/// What `preview_contact` answers: who the code is, and the contact that
/// already has its keys or its name.
#[derive(Debug, PartialEq, Serialize)]
pub struct ContactPreview {
    pub handle: String,
    pub fingerprint: String,
    pub identity_digest: String,
    pub existing: Option<ExistingContact>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ExistingContact {
    pub handle: String,
    /// It has exactly the code's keys. Otherwise it has the code's name, or
    /// shares only some of its keys.
    pub same_keys: bool,
    /// It is someone you blocked (UR-2): the confirmation to replace its
    /// keys says that the identity it had stays blocked.
    pub blocked: bool,
}

/// What `add_contact` did.
#[derive(Debug, PartialEq)]
pub(crate) enum Added {
    New,
    /// The same contact again: its newer prekey, and the photo if the code
    /// has one.
    Refreshed,
    /// Other keys under that name, after the user confirmed it. The session
    /// with the old keys is gone.
    Replaced,
    /// The code of a contact a group made and you had not accepted (UR-3):
    /// accepted now, under the name chosen if it was free, with what its
    /// request held in its chat.
    Accepted,
}

fn invalid_code(message: &str) -> CommandError {
    CommandError::new(ErrorCode::InvalidCode, message)
}

/// Lowercase hex of exactly 32 bytes. Keys are compared as strings all over
/// the app, and events arrive with lowercase keys: an upper-case copy would
/// pass every comparison as a different key.
fn is_canonical_key(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn same_keys(a: &PublicBundle, b: &PublicBundle) -> bool {
    a.ik_sign_pub == b.ik_sign_pub && a.ik_dh_pub == b.ik_dh_pub && a.nostr_pub == b.nostr_pub
}

fn shares_a_key(a: &PublicBundle, b: &PublicBundle) -> bool {
    a.ik_sign_pub == b.ik_sign_pub || a.ik_dh_pub == b.ik_dh_pub || a.nostr_pub == b.nostr_pub
}

/// The contact, other than `except`, that holds any of `bundle`'s keys: one
/// holding all three first, then the first name in order.
fn holder_of_keys<'a>(
    inner: &'a InnerState,
    bundle: &PublicBundle,
    except: Option<&str>,
) -> Option<&'a FriendRecord> {
    let candidates = || {
        inner
            .friends
            .values()
            .filter(move |f| Some(f.handle.as_str()) != except)
    };
    candidates()
        .filter(|f| same_keys(&f.bundle, bundle))
        .min_by(|a, b| a.handle.cmp(&b.handle))
        .or_else(|| {
            candidates()
                .filter(|f| shares_a_key(&f.bundle, bundle))
                .min_by(|a, b| a.handle.cmp(&b.handle))
        })
}

/// Drop everything kept for the session with `handle`: its ratchet, its
/// associated data, the recent messages kept to replay after a desync, and
/// the handshake mark of `old_nostr_pub`. Used when the user replaced the
/// contact's keys: none of it may ever reach the new keys.
fn forget_session_with(inner: &mut InnerState, handle: &str, old_nostr_pub: &str) {
    forget_session_state(inner, handle);
    inner.handshake_marks.remove(old_nostr_pub);
}

/// Drop the session kept under `handle`: its ratchet, its associated data,
/// the recent messages kept to replay after a desync (`resend_outbox`) and
/// when it last healed. What holds secrets or text is wiped.
fn forget_session_state(inner: &mut InnerState, handle: &str) {
    use zeroize::Zeroize;
    if let Some(mut ratchet) = inner.ratchets.remove(handle) {
        ratchet.zeroize_secrets();
    }
    if let Some(mut ad) = inner.associated_data.remove(handle) {
        ad.zeroize();
    }
    if let Some(mut outbox) = inner.outbox.remove(handle) {
        for (id, envelope, _) in &mut outbox {
            id.zeroize();
            envelope.zeroize();
        }
    }
    inner.resync_at.remove(handle);
}

/// Drop everything kept under `handle` but the contact itself: its session,
/// its chat, when it last raised a key mismatch and the profile it shares.
/// Returns whether a profile went, so profiles.bin must be written again.
///
/// A name no contact has can still hold some of it: a contact removed while
/// its files could not be written gets it back at the next unlock. Whoever
/// is added or renamed to that name must never inherit it: a session kept
/// there would encrypt to the old keys, and the messages kept to replay
/// would be sent to the newcomer.
fn forget_kept_under(inner: &mut InnerState, handle: &str) -> bool {
    use zeroize::Zeroize;
    forget_session_state(inner, handle);
    if let Some(mut items) = inner.history.remove(handle) {
        for item in &mut items {
            if let Some(text) = item.text.as_mut() {
                text.zeroize();
            }
            if let Some(file) = item.file.as_mut() {
                super::zeroize_file_ref(file);
            }
        }
    }
    inner.key_mismatch_at.remove(handle);
    inner.profiles.remove(handle)
}

/// Move what `map` keeps under `old` to `new`.
fn move_entry<V>(map: &mut HashMap<String, V>, old: &str, new: &str) {
    if let Some(value) = map.remove(old) {
        map.insert(new.to_string(), value);
    }
}

/// Read a contact code: valid JSON, a bundle, and keys its identity key
/// signed. Nothing is saved.
pub(crate) fn parse_contact_code(bundle_json: &str) -> Result<ContactCode, CommandError> {
    let value: serde_json::Value =
        serde_json::from_str(bundle_json).map_err(|_| invalid_code("the code is not JSON"))?;
    let handle = value
        .get("handle")
        .and_then(|h| h.as_str())
        .map(|h| h.trim().to_string())
        .unwrap_or_default();
    let avatar = sanitized_inline_raster(
        value
            .get("avatar")
            .and_then(|a| a.as_str())
            .map(str::to_string),
    );
    let bundle: PublicBundle = serde_json::from_value(value)
        .map_err(|_| invalid_code("the code is not a contact bundle"))?;
    if ![&bundle.ik_sign_pub, &bundle.ik_dh_pub, &bundle.nostr_pub]
        .iter()
        .all(|key| is_canonical_key(key))
    {
        return Err(invalid_code("the keys are not lowercase hex"));
    }
    if !verify_bundle_binding(&bundle) {
        return Err(invalid_code(
            "bundle signature invalid (identity keys not bound)",
        ));
    }
    let keys = bundle_keys(&bundle).ok_or_else(|| invalid_code("the keys do not decode"))?;
    Ok(ContactCode {
        bundle,
        handle,
        avatar,
        keys,
    })
}

/// Who the code is, and who already has its keys or its name. Reads only.
pub(crate) fn preview(inner: &InnerState, code: &ContactCode) -> ContactPreview {
    let (ik_sign, ik_dh, nostr) = &code.keys;
    // A contact a group made with these keys is no contact of yours yet:
    // adding the code accepts them (UR-3).
    let limited = limited_holder(inner, &code.bundle);
    let existing = holder_of_keys(inner, &code.bundle, None)
        .filter(|friend| Some(&friend.handle) != limited.as_ref())
        .map(|f| ExistingContact {
            handle: f.handle.clone(),
            same_keys: same_keys(&f.bundle, &code.bundle),
            blocked: trino_engine::block::friend_blocked(inner, f),
        })
        .or_else(|| {
            inner.friends.get(&code.handle).map(|f| ExistingContact {
                handle: f.handle.clone(),
                same_keys: false,
                blocked: trino_engine::block::friend_blocked(inner, f),
            })
        });
    ContactPreview {
        handle: code.handle.clone(),
        fingerprint: fp(ik_sign, ik_dh, nostr),
        identity_digest: identity_digest(ik_sign, ik_dh, nostr),
        existing,
    }
}

/// Add the contact of `code` as `handle`, the name the user chose. A pinned
/// key is never overwritten silently:
///
/// - keys another contact holds, even one of the three, are
///   `already_contact` with that contact's name. Incoming events are matched
///   to contacts by key, so two contacts must never share one;
/// - the same keys under the same name refresh the contact (a newer prekey,
///   and the photo if the code has one) and keep everything else;
/// - other keys under a name in use are `name_taken`, unless
///   `replace_existing`: then the contact gets the new keys, the session
///   with the old ones is dropped, and the old fingerprint is kept until the
///   user acknowledges the change. The conversation stays.
///
/// A name no contact has yet must pass `check_local_handle`.
pub(crate) fn add_contact(
    inner: &mut InnerState,
    code: ContactCode,
    handle: &str,
    replace_existing: bool,
    now: i64,
) -> Result<(String, Added), CommandError> {
    let handle = handle.trim().to_string();
    if let Some(limited) = limited_holder(inner, &code.bundle) {
        return accept_from_code(inner, code, &limited, &handle, now);
    }
    if !inner.friends.contains_key(&handle) {
        check_local_handle(&handle)?;
    }
    if let Some(other) = holder_of_keys(inner, &code.bundle, Some(&handle)) {
        return Err(CommandError::already_contact(&other.handle));
    }
    let Some(friend) = inner.friends.get_mut(&handle) else {
        // A newcomer: nothing kept under this name is theirs.
        forget_kept_under(inner, &handle);
        inner.friends.insert(
            handle.clone(),
            FriendRecord {
                handle: handle.clone(),
                bundle: code.bundle,
                added_at: now,
                avatar: code.avatar,
                previous_fingerprint: None,
                key_changed_at: None,
                via_group: None,
                accepted_at: Some(now),
                devices: None,
            },
        );
        return Ok((handle, Added::New));
    };
    if same_keys(&friend.bundle, &code.bundle) {
        friend.bundle = code.bundle;
        if code.avatar.is_some() {
            friend.avatar = code.avatar;
        }
        return Ok((handle, Added::Refreshed));
    }
    if !replace_existing {
        return Err(CommandError::new(
            ErrorCode::NameTaken,
            "another contact has that name",
        ));
    }
    let (ik_sign, ik_dh, nostr) =
        bundle_keys(&friend.bundle).unwrap_or(([0u8; 32], [0u8; 32], [0u8; 32]));
    let old_nostr_pub = std::mem::replace(&mut friend.bundle, code.bundle).nostr_pub;
    friend.avatar = code.avatar;
    friend.previous_fingerprint = Some(fp(&ik_sign, &ik_dh, &nostr));
    friend.key_changed_at = Some(now);
    // The new keys came with a code, not with a group's roster.
    friend.via_group = None;
    forget_session_with(inner, &handle, &old_nostr_pub);
    // What the old keys shared (K12) is not what the new ones share.
    inner.profiles.remove(&handle);
    Ok((handle, Added::Replaced))
}

/// The contact a group made, not accepted, that has exactly these keys.
fn limited_holder(inner: &InnerState, bundle: &PublicBundle) -> Option<String> {
    inner
        .friends
        .values()
        .find(|friend| is_limited(friend) && same_keys(&friend.bundle, bundle))
        .map(|friend| friend.handle.clone())
}

/// The code of `limited`, a contact a group made (UR-3): adding it is
/// accepting them, under `handle` if that name is free and can name a
/// contact, else under the one they have. The code's newer prekey and its
/// photo are kept, as a refresh keeps them.
fn accept_from_code(
    inner: &mut InnerState,
    code: ContactCode,
    limited: &str,
    handle: &str,
    now: i64,
) -> Result<(String, Added), CommandError> {
    let free = !inner.friends.contains_key(handle) && check_local_handle(handle).is_ok();
    let name = if handle != limited && free {
        rename_contact(inner, limited, handle)?;
        handle.to_string()
    } else {
        limited.to_string()
    };
    let name = group_contacts::accept(inner, &name, now)?;
    if let Some(friend) = inner.friends.get_mut(&name) {
        friend.bundle = code.bundle;
        if code.avatar.is_some() {
            friend.avatar = code.avatar;
        }
    }
    Ok((name, Added::Accepted))
}

/// Remove the contact `handle` and everything kept here under its name
/// (`remove_node`). Returns whether a profile it shared went with it, so
/// profiles.bin must be written again.
pub(crate) fn remove_contact(inner: &mut InnerState, handle: &str) -> bool {
    inner.friends.remove(handle);
    if inner.current_peer.as_deref() == Some(handle) {
        inner.current_peer = None;
    }
    forget_kept_under(inner, handle)
}

/// Give the contact `old` the name `new`, trimmed (`rename_node`), with
/// everything kept here under its name: its session, the messages kept to
/// replay, its chat and the profile it shares. `None` when the name stays
/// the same; otherwise whether profiles.bin must be written again.
///
/// A name `check_local_handle` refuses is `invalid_name`, another
/// contact's is `name_taken`, and an unknown `old` is `not_found`.
pub(crate) fn rename_contact(
    inner: &mut InnerState,
    old: &str,
    new: &str,
) -> Result<Option<bool>, CommandError> {
    let new = new.trim();
    if old == new {
        return Ok(None);
    }
    check_local_handle(new)?;
    if inner.friends.contains_key(new) {
        return Err(CommandError::new(
            ErrorCode::NameTaken,
            "another contact has that name",
        ));
    }
    let mut record = inner
        .friends
        .remove(old)
        .ok_or_else(|| not_found("unknown contact"))?;
    // No contact has the new name: nothing kept under it is this one's.
    let dropped_profile = forget_kept_under(inner, new);
    record.handle = new.to_string();
    inner.friends.insert(new.to_string(), record);
    move_entry(&mut inner.ratchets, old, new);
    move_entry(&mut inner.associated_data, old, new);
    move_entry(&mut inner.history, old, new);
    move_entry(&mut inner.outbox, old, new);
    move_entry(&mut inner.resync_at, old, new);
    move_entry(&mut inner.key_mismatch_at, old, new);
    if inner.current_peer.as_deref() == Some(old) {
        inner.current_peer = Some(new.to_string());
    }
    let moved_profile = inner.profiles.rename(old, new);
    Ok(Some(dropped_profile || moved_profile))
}

/// The user saw that the keys of `handle` changed. Returns whether there was
/// anything to clear.
pub(crate) fn acknowledge(inner: &mut InnerState, handle: &str) -> Result<bool, CommandError> {
    let friend = inner
        .friends
        .get_mut(handle)
        .ok_or_else(|| not_found("unknown contact"))?;
    let had_change = friend.previous_fingerprint.is_some() || friend.key_changed_at.is_some();
    friend.previous_fingerprint = None;
    friend.key_changed_at = None;
    Ok(had_change)
}

/// Check a pasted contact code without saving anything (K8).
#[tauri::command]
pub async fn preview_contact(
    state: State<'_, AppState>,
    bundle_json: String,
) -> Result<ContactPreview, CommandError> {
    let code = parse_contact_code(&bundle_json)?;
    let inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(sealed());
    }
    Ok(preview(&inner, &code))
}

/// The user saw that a contact's keys changed (K8).
#[tauri::command]
pub async fn acknowledge_key_change(
    state: State<'_, AppState>,
    handle: String,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(sealed());
    }
    if acknowledge(&mut inner, &handle)? {
        persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    }
    Ok(())
}

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

/// The contacts `list_nodes` gives, the latest first: not those a group
/// made and you did not accept (UR-3). They are no chat of yours; the
/// group's members (`group_members`) still name them.
pub(super) fn listed(inner: &InnerState) -> Vec<NodeInfo> {
    let mut out: Vec<NodeInfo> = inner
        .friends
        .values()
        .filter(|friend| !is_limited(friend))
        .map(|friend| node_info(inner, friend))
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.added_at));
    out
}

/// What `list_nodes` and `probe_node` say about one contact.
pub(super) fn node_info(inner: &InnerState, friend: &FriendRecord) -> NodeInfo {
    let keys = bundle_keys(&friend.bundle);
    // Keys that do not decode keep the fingerprint they always had (over
    // zeros), but get no digest: a digest of zeros would name nobody.
    let (ik_sign, ik_dh, nostr) = keys.unwrap_or(([0u8; 32], [0u8; 32], [0u8; 32]));
    // K12: what the contact shares. A photo its profile decided, even one it
    // removed, wins over the one in its contact code.
    let shared = inner.profiles.contacts.get(&friend.handle);
    let avatar = match shared {
        Some(profile) if profile.photo_set => profile.photo.clone(),
        _ => friend.avatar.clone(),
    };
    NodeInfo {
        handle: friend.handle.clone(),
        fingerprint: fp(&ik_sign, &ik_dh, &nostr),
        has_session: inner.ratchets.contains_key(&friend.handle),
        added_at: friend.added_at,
        avatar,
        blocked: trino_engine::block::friend_blocked(inner, friend),
        identity_digest: keys
            .map(|(ik_sign, ik_dh, nostr)| identity_digest(&ik_sign, &ik_dh, &nostr)),
        previous_fingerprint: friend.previous_fingerprint.clone(),
        key_changed_at: friend.key_changed_at,
        profile_name: shared.and_then(|profile| profile.name.clone()),
        about: shared.and_then(|profile| profile.about.clone()),
        profile_sync: shared.is_some_and(|profile| profile.caps >= super::profile::PROFILE_V),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::profile_of;
    use crate::identity::{create_identity, public_bundle_for, Identity};

    const NOW: i64 = 1_760_000_000;

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
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
            accepted_at: Some(0),
            devices: None,
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

    // ---- K8: checking a code, adding and replacing contacts ----

    fn code_json(id: &Identity, handle: &str) -> String {
        let mut bundle = serde_json::to_value(public_bundle_for(id)).unwrap();
        bundle["handle"] = serde_json::Value::String(handle.to_string());
        bundle.to_string()
    }

    fn code_of(id: &Identity, handle: &str) -> ContactCode {
        parse_contact_code(&code_json(id, handle)).unwrap()
    }

    fn fingerprint_of(id: &Identity) -> String {
        fp(
            &id.ik_sign.pub_bytes,
            &id.ik_dh.pub_bytes,
            &id.nostr.pub_bytes,
        )
    }

    /// A session with `peer`, as `connect_node` starts one.
    fn session_with(me: &Identity, peer: &Identity) -> (crate::ratchet::RatchetState, Vec<u8>) {
        let init = crate::x3dh::initiate(me, &public_bundle_for(peer)).unwrap();
        let spk = decode_array_32(&public_bundle_for(peer).spk_pub).unwrap();
        let ratchet = crate::ratchet::init_initiator(init.master_secret, spk).unwrap();
        (ratchet, init.associated_data)
    }

    /// Mara, whom the group g1 made a contact of and you did not accept.
    fn mara_from_a_group(inner: &mut InnerState, mara: &Identity) {
        let mut record = friend(mara, "mara-1a2b");
        record.added_at = NOW - 10;
        record.via_group = Some("g1".into());
        record.accepted_at = None;
        inner.friends.insert(record.handle.clone(), record);
    }

    #[test]
    fn ur3_a_contact_a_group_made_is_not_listed_until_accepted() {
        let (ana, mara) = (create_identity(), create_identity());
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        mara_from_a_group(&mut inner, &mara);
        let names = |inner: &InnerState| {
            listed(inner)
                .into_iter()
                .map(|node| node.handle)
                .collect::<Vec<_>>()
        };
        assert_eq!(names(&inner), ["ana"]);
        trino_engine::group_contacts::accept(&mut inner, "mara-1a2b", NOW).unwrap();
        assert_eq!(names(&inner), ["mara-1a2b", "ana"], "the latest first");
    }

    #[test]
    fn ur3_adding_the_code_of_a_contact_a_group_made_accepts_them() {
        let mara = create_identity();
        let mut inner = InnerState::default();
        mara_from_a_group(&mut inner, &mara);
        inner.history.insert("grp:g1".into(), vec![]);

        // The preview does not take her for a contact of yours.
        let preview = preview(&inner, &code_of(&mara, "Mara"));
        assert_eq!(preview.existing, None);

        let added = add_contact(&mut inner, code_of(&mara, "Mara"), "Mara", false, NOW).unwrap();

        assert_eq!(added, ("Mara".to_string(), Added::Accepted));
        assert!(!inner.friends.contains_key("mara-1a2b"));
        let record = &inner.friends["Mara"];
        assert_eq!(record.accepted_at, Some(NOW));
        assert_eq!(record.via_group.as_deref(), Some("g1"), "still the group's");
        assert_eq!(inner.friends.len(), 1);
    }

    #[test]
    fn ur3_under_a_name_taken_she_keeps_hers() {
        let (ana, mara) = (create_identity(), create_identity());
        let mut inner = InnerState::default();
        inner.friends.insert("Mara".into(), friend(&ana, "Mara"));
        mara_from_a_group(&mut inner, &mara);

        let added = add_contact(&mut inner, code_of(&mara, "Mara"), "Mara", false, NOW).unwrap();

        assert_eq!(added, ("mara-1a2b".to_string(), Added::Accepted));
        assert_eq!(inner.friends["mara-1a2b"].accepted_at, Some(NOW));
        assert_eq!(
            inner.friends["Mara"].bundle.ik_sign_pub,
            public_bundle_for(&ana).ik_sign_pub
        );
    }

    #[test]
    fn a_code_that_does_not_verify_is_invalid() {
        let ana = create_identity();
        let mut forged = serde_json::to_value(public_bundle_for(&ana)).unwrap();
        // Another identity's DH key: the binding signature no longer covers it.
        forged["ikDhPub"] = public_bundle_for(&create_identity()).ik_dh_pub.into();
        let mut upper = serde_json::to_value(public_bundle_for(&ana)).unwrap();
        upper["nostrPub"] = public_bundle_for(&ana).nostr_pub.to_uppercase().into();

        for bad in [
            forged.to_string(),
            upper.to_string(),
            "not json".to_string(),
            r#"{"handle":"ana"}"#.to_string(),
        ] {
            let error = parse_contact_code(&bad).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidCode, "{bad}");
        }
    }

    #[test]
    fn a_valid_code_gives_its_name_its_keys_and_any_photo() {
        let ana = create_identity();
        let mut json = serde_json::to_value(public_bundle_for(&ana)).unwrap();
        json["handle"] = "  Ana  ".into();
        json["avatar"] = "data:image/png;base64,iVBORw0KGgo=".into();

        let code = parse_contact_code(&json.to_string()).unwrap();

        assert_eq!(code.handle, "Ana");
        assert_eq!(
            code.avatar.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
        assert_eq!(code.bundle.ik_sign_pub, public_bundle_for(&ana).ik_sign_pub);
    }

    #[test]
    fn previewing_a_code_saves_nothing_and_names_the_clash() {
        let (ana, bob) = (create_identity(), create_identity());
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        let before: Vec<String> = inner.friends.keys().cloned().collect();

        // Nobody has these keys or this name.
        let fresh = preview(&inner, &code_of(&bob, "bob"));
        assert_eq!(fresh.handle, "bob");
        assert_eq!(fresh.fingerprint, fingerprint_of(&bob));
        assert_eq!(fresh.identity_digest, digest_of(&bob));
        assert_eq!(fresh.existing, None);

        // Ana's keys, under another name.
        let same = preview(&inner, &code_of(&ana, "Anita"));
        assert_eq!(
            same.existing,
            Some(ExistingContact {
                handle: "ana".into(),
                same_keys: true,
                blocked: false,
            })
        );

        // Ana's name, with Bob's keys.
        let name = preview(&inner, &code_of(&bob, "ana"));
        assert_eq!(
            name.existing,
            Some(ExistingContact {
                handle: "ana".into(),
                same_keys: false,
                blocked: false,
            })
        );

        let after: Vec<String> = inner.friends.keys().cloned().collect();
        assert_eq!(before, after);
        assert_eq!(
            inner.friends["ana"].bundle.ik_sign_pub,
            public_bundle_for(&ana).ik_sign_pub
        );
    }

    #[test]
    fn a_new_code_becomes_a_contact() {
        let ana = create_identity();
        let mut inner = InnerState::default();

        let added = add_contact(&mut inner, code_of(&ana, "ana"), "  Ana ", false, NOW).unwrap();

        assert_eq!(added, ("Ana".to_string(), Added::New));
        let stored = &inner.friends["Ana"];
        assert_eq!(stored.added_at, NOW);
        assert_eq!(stored.previous_fingerprint, None);
        assert_eq!(stored.key_changed_at, None);
    }

    #[test]
    fn a_name_held_by_other_keys_is_never_overwritten_without_asking() {
        let (ana, impostor) = (create_identity(), create_identity());
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));

        let error =
            add_contact(&mut inner, code_of(&impostor, "ana"), "ana", false, NOW).unwrap_err();

        assert_eq!(error.code, ErrorCode::NameTaken);
        assert_eq!(
            inner.friends["ana"].bundle.ik_sign_pub,
            public_bundle_for(&ana).ik_sign_pub
        );
    }

    #[test]
    fn the_same_keys_under_another_name_are_already_a_contact() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));

        for replace in [false, true] {
            let error =
                add_contact(&mut inner, code_of(&ana, "Anita"), "Anita", replace, NOW).unwrap_err();
            assert_eq!(error.code, ErrorCode::AlreadyContact);
            assert_eq!(error.handle.as_deref(), Some("ana"));
            assert_eq!(
                serde_json::to_value(&error).unwrap()["handle"],
                "ana",
                "the UI reads the name from `handle`"
            );
        }
        assert_eq!(inner.friends.len(), 1);
    }

    #[test]
    fn a_code_reusing_a_contacts_transport_key_is_refused() {
        // Anyone can sign a bundle over someone else's public keys. Events are
        // matched to contacts by Nostr key, so a second contact with Ana's
        // would take her messages.
        let ana = create_identity();
        let mut shadow = create_identity();
        shadow.nostr = ana.nostr.clone();
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));

        let error =
            add_contact(&mut inner, code_of(&shadow, "otra"), "otra", true, NOW).unwrap_err();

        assert_eq!(error.code, ErrorCode::AlreadyContact);
        assert_eq!(error.handle.as_deref(), Some("ana"));
        assert_eq!(inner.friends.len(), 1);
    }

    #[test]
    fn adding_the_same_contact_again_refreshes_it_and_keeps_its_photo() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        let mut stored = friend(&ana, "ana");
        stored.avatar = Some("data:image/png;base64,iVBORw0KGgo=".into());
        stored.added_at = NOW - 100;
        inner.friends.insert("ana".into(), stored);

        // A trino2: code carries no photo.
        let added = add_contact(&mut inner, code_of(&ana, "ana"), "ana", false, NOW).unwrap();

        assert_eq!(added, ("ana".to_string(), Added::Refreshed));
        let ana_now = &inner.friends["ana"];
        assert_eq!(
            ana_now.avatar.as_deref(),
            Some("data:image/png;base64,iVBORw0KGgo=")
        );
        assert_eq!(ana_now.added_at, NOW - 100);
        assert_eq!(ana_now.previous_fingerprint, None);
    }

    #[test]
    fn replacing_a_contact_resets_its_session_and_keeps_the_old_fingerprint() {
        let (me, ana, new_ana) = (create_identity(), create_identity(), create_identity());
        let mut inner = InnerState::default();
        let mut from_group = friend(&ana, "ana");
        from_group.via_group = Some("g1".into());
        inner.friends.insert("ana".into(), from_group);
        let (ratchet, ad) = session_with(&me, &ana);
        inner.ratchets.insert("ana".into(), ratchet);
        inner.associated_data.insert("ana".into(), ad);
        inner
            .outbox
            .insert("ana".into(), vec![("m1".into(), b"hola".to_vec(), NOW)]);
        inner.history.insert("ana".into(), vec![]);
        crate::commands::profile::receive(
            &mut inner.profiles,
            "ana",
            br#"{"ty":"profile","v":1,"rev":3,"name":"Ana vieja","about":""}"#,
            NOW,
        );

        let added = add_contact(&mut inner, code_of(&new_ana, "ana"), "ana", true, NOW).unwrap();

        assert_eq!(added, ("ana".to_string(), Added::Replaced));
        let replaced = &inner.friends["ana"];
        assert_eq!(
            replaced.bundle.ik_sign_pub,
            public_bundle_for(&new_ana).ik_sign_pub
        );
        assert_eq!(
            replaced.previous_fingerprint.as_deref(),
            Some(fingerprint_of(&ana).as_str())
        );
        assert_eq!(replaced.key_changed_at, Some(NOW));
        assert_eq!(replaced.via_group, None, "the new keys came with a code");
        assert!(
            !inner.ratchets.contains_key("ana"),
            "the old session must go"
        );
        assert!(!inner.associated_data.contains_key("ana"));
        // Recent messages must never be replayed to the new keys.
        assert!(!inner.outbox.contains_key("ana"));
        assert!(inner.history.contains_key("ana"), "the conversation stays");
        // What the old keys shared is not what the new ones share.
        assert!(!inner.profiles.contacts.contains_key("ana"));

        let node = node_info(&inner, &inner.friends["ana"]);
        assert_eq!(
            node.previous_fingerprint.as_deref(),
            Some(fingerprint_of(&ana).as_str())
        );
        assert_eq!(node.key_changed_at, Some(NOW));
        assert!(!node.has_session);
        assert_eq!(node.profile_name, None);
    }

    /// `id` as the contact `handle`, with everything kept here under that
    /// name: a session, a chat, messages kept to replay, when it last healed
    /// and raised a key mismatch, the profile it shares and the revision of
    /// this profile sent to it.
    fn kept_under(inner: &mut InnerState, me: &Identity, id: &Identity, handle: &str) {
        inner.friends.insert(handle.into(), friend(id, handle));
        let (ratchet, ad) = session_with(me, id);
        inner.ratchets.insert(handle.into(), ratchet);
        inner.associated_data.insert(handle.into(), ad);
        inner.history.insert(
            handle.into(),
            vec![serde_json::from_value(
                serde_json::json!({ "side": "me", "text": "hola", "ts": NOW }),
            )
            .unwrap()],
        );
        inner
            .outbox
            .insert(handle.into(), vec![("m1".into(), b"hola".to_vec(), NOW)]);
        inner.resync_at.insert(handle.into(), NOW);
        inner.key_mismatch_at.insert(handle.into(), NOW);
        shared(
            inner,
            handle,
            r#"{"ty":"profile","v":1,"rev":3,"name":"Ana","about":""}"#,
        );
        inner.profiles.sent.insert((handle.into(), 9));
    }

    /// What is kept here under `handle`, by kind.
    fn kinds_under(inner: &InnerState, handle: &str) -> Vec<&'static str> {
        [
            ("contact", inner.friends.contains_key(handle)),
            ("ratchet", inner.ratchets.contains_key(handle)),
            (
                "associated data",
                inner.associated_data.contains_key(handle),
            ),
            ("chat", inner.history.contains_key(handle)),
            ("outbox", inner.outbox.contains_key(handle)),
            ("resync", inner.resync_at.contains_key(handle)),
            ("key mismatch", inner.key_mismatch_at.contains_key(handle)),
            ("profile", inner.profiles.contacts.contains_key(handle)),
            (
                "profile sent",
                inner.profiles.sent.iter().any(|(to, _)| to == handle),
            ),
        ]
        .into_iter()
        .filter_map(|(kind, kept)| kept.then_some(kind))
        .collect()
    }

    const EVERYTHING: [&str; 9] = [
        "contact",
        "ratchet",
        "associated data",
        "chat",
        "outbox",
        "resync",
        "key mismatch",
        "profile",
        "profile sent",
    ];

    #[test]
    fn removing_a_contact_forgets_everything_kept_under_its_name() {
        let (me, ana, bob) = (create_identity(), create_identity(), create_identity());
        let mut inner = InnerState::default();
        kept_under(&mut inner, &me, &ana, "ana");
        kept_under(&mut inner, &me, &bob, "bob");
        inner.current_peer = Some("ana".into());

        assert!(remove_contact(&mut inner, "ana"), "profiles.bin changed");

        assert_eq!(kinds_under(&inner, "ana"), Vec::<&str>::new());
        assert_eq!(inner.current_peer, None);
        assert_eq!(
            kinds_under(&inner, "bob"),
            EVERYTHING,
            "other contacts stay"
        );
    }

    #[test]
    fn renaming_a_contact_moves_everything_kept_under_its_name() {
        let (me, ana, bob) = (create_identity(), create_identity(), create_identity());
        let mut inner = InnerState::default();
        kept_under(&mut inner, &me, &ana, "ana");
        kept_under(&mut inner, &me, &bob, "bob");
        inner.current_peer = Some("ana".into());

        let moved = rename_contact(&mut inner, "ana", "  Ana trabajo ").unwrap();

        assert_eq!(moved, Some(true), "profiles.bin changed");
        assert_eq!(kinds_under(&inner, "ana"), Vec::<&str>::new());
        assert_eq!(kinds_under(&inner, "Ana trabajo"), EVERYTHING);
        assert_eq!(inner.friends["Ana trabajo"].handle, "Ana trabajo");
        assert_eq!(inner.current_peer.as_deref(), Some("Ana trabajo"));
        assert_eq!(
            kinds_under(&inner, "bob"),
            EVERYTHING,
            "other contacts stay"
        );
    }

    #[test]
    fn a_contact_never_inherits_what_another_left_under_its_name() {
        // What a removed contact leaves behind when its files could not be
        // written: it comes back at the next unlock, with nobody by that name.
        let (me, gone, ana, bob) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let mut inner = InnerState::default();
        kept_under(&mut inner, &me, &gone, "ana");
        kept_under(&mut inner, &me, &gone, "Ana trabajo");
        inner.friends.clear();
        inner.friends.insert("bob".into(), friend(&bob, "bob"));

        // A new contact by that name,
        let added = add_contact(&mut inner, code_of(&ana, "ana"), "ana", false, NOW).unwrap();
        assert_eq!(added, ("ana".to_string(), Added::New));
        assert_eq!(kinds_under(&inner, "ana"), ["contact"]);
        // and a contact renamed to it.
        rename_contact(&mut inner, "bob", "Ana trabajo").unwrap();
        assert_eq!(kinds_under(&inner, "Ana trabajo"), ["contact"]);
    }

    /// Names a contact cannot have: the chats would read them as the
    /// announcements channel or a group (src/lib/convo.ts), or they reorder
    /// the text, break the line or show nothing.
    const UNUSABLE_NAMES: [&str; 9] = [
        "channel",
        "grp:",
        "grp:4f1c",
        "Ana\u{202E}",
        "An\u{7}a",
        "Ana\nLópez",
        "\u{200B}",
        "\u{3164}",
        "   ",
    ];

    #[test]
    fn a_new_contact_cannot_take_a_name_the_chats_read_as_something_else() {
        let ana = create_identity();
        let mut inner = InnerState::default();

        for name in UNUSABLE_NAMES {
            let error =
                add_contact(&mut inner, code_of(&ana, "ana"), name, false, NOW).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidName, "{name:?}");
        }

        assert!(inner.friends.is_empty());
        assert_eq!(
            serde_json::to_value(CommandError::new(ErrorCode::InvalidName, "x")).unwrap()["code"],
            "invalid_name"
        );
        // Only those keys mean something else.
        for name in [
            "Channel",
            "channel 2",
            "grp",
            "mi grp:x",
            "Ana 👩\u{200D}💻",
        ] {
            let mut inner = InnerState::default();
            let added = add_contact(&mut inner, code_of(&ana, "ana"), name, false, NOW).unwrap();
            assert_eq!(added, (name.to_string(), Added::New));
        }
    }

    #[test]
    fn a_contact_kept_under_such_a_name_can_be_refreshed_and_renamed_away() {
        // A name from before these rules stays until the user changes it.
        let ana = create_identity();
        let mut inner = InnerState::default();
        inner
            .friends
            .insert("grp:viejo".into(), friend(&ana, "grp:viejo"));

        let added = add_contact(
            &mut inner,
            code_of(&ana, "grp:viejo"),
            "grp:viejo",
            false,
            NOW,
        )
        .unwrap();

        assert_eq!(added, ("grp:viejo".to_string(), Added::Refreshed));
        assert_eq!(
            rename_contact(&mut inner, "grp:viejo", "Ana").unwrap(),
            Some(false)
        );
        assert!(inner.friends.contains_key("Ana"));
    }

    #[test]
    fn renaming_says_why_a_name_cannot_be_used() {
        let (ana, bob) = (create_identity(), create_identity());
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        inner.friends.insert("bob".into(), friend(&bob, "bob"));

        let taken = rename_contact(&mut inner, "ana", " bob ").unwrap_err();
        assert_eq!(taken.code, ErrorCode::NameTaken);
        assert_eq!(
            serde_json::to_value(&taken).unwrap()["code"],
            "name_taken",
            "the UI reads the code"
        );
        for name in UNUSABLE_NAMES {
            let error = rename_contact(&mut inner, "ana", name).unwrap_err();
            assert_eq!(error.code, ErrorCode::InvalidName, "{name:?}");
        }
        let missing = rename_contact(&mut inner, "nadie", "otro").unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);

        assert_eq!(rename_contact(&mut inner, "ana", " ana ").unwrap(), None);
        assert_eq!(
            inner.friends["ana"].bundle.ik_sign_pub,
            public_bundle_for(&ana).ik_sign_pub
        );
        assert_eq!(
            inner.friends["bob"].bundle.ik_sign_pub,
            public_bundle_for(&bob).ik_sign_pub
        );
    }

    #[test]
    fn acknowledging_a_key_change_clears_it() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        let mut changed = friend(&ana, "ana");
        changed.previous_fingerprint = Some("0000.0000.0000.0000".into());
        changed.key_changed_at = Some(NOW);
        inner.friends.insert("ana".into(), changed);

        assert!(acknowledge(&mut inner, "ana").unwrap());
        assert_eq!(inner.friends["ana"].previous_fingerprint, None);
        assert_eq!(inner.friends["ana"].key_changed_at, None);
        assert!(
            !acknowledge(&mut inner, "ana").unwrap(),
            "nothing left to clear"
        );
        assert_eq!(
            acknowledge(&mut inner, "nadie").unwrap_err().code,
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_friends_file_from_before_k8_still_loads() {
        let ana = public_bundle_for(&create_identity());
        let old = serde_json::json!({
            "handle": "me",
            "friends": [{ "handle": "ana", "bundle": ana, "addedAt": NOW }],
            "blocked": [],
        });

        let file: crate::state::FriendsFile = serde_json::from_value(old).unwrap();

        assert_eq!(file.friends[0].previous_fingerprint, None);
        assert_eq!(file.friends[0].key_changed_at, None);
    }

    // ---- K12: what a contact shares ----

    fn shared(inner: &mut InnerState, handle: &str, message: &str) {
        crate::commands::profile::receive(&mut inner.profiles, handle, message.as_bytes(), NOW);
    }

    #[test]
    fn a_contact_shows_the_profile_it_shares_next_to_the_name_given_here() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        let mut stored = friend(&ana, "Ana del trabajo");
        stored.avatar = Some("data:image/png;base64,Y29kZQ==".into());
        inner.friends.insert(stored.handle.clone(), stored.clone());

        // Nothing shared yet: the photo of the code.
        let before = node_info(&inner, &stored);
        assert_eq!(
            before.avatar.as_deref(),
            Some("data:image/png;base64,Y29kZQ==")
        );
        assert_eq!((before.profile_name, before.about), (None, None));
        assert!(!before.profile_sync);

        shared(
            &mut inner,
            "Ana del trabajo",
            r#"{"ty":"profile","v":1,"rev":3,"name":"Ana M","about":"Hola","photo":"data:image/png;base64,cGVyZmls"}"#,
        );
        shared(
            &mut inner,
            "Ana del trabajo",
            r#"{"ty":"text","body":"hola","prof":{"v":1,"have":0}}"#,
        );
        let after = node_info(&inner, &stored);

        assert_eq!(after.handle, "Ana del trabajo", "the name given here stays");
        assert_eq!(after.profile_name.as_deref(), Some("Ana M"));
        assert_eq!(after.about.as_deref(), Some("Hola"));
        assert_eq!(
            after.avatar.as_deref(),
            Some("data:image/png;base64,cGVyZmls")
        );
        assert!(after.profile_sync);
        let json = serde_json::to_value(&after).unwrap();
        assert_eq!(json["profile_name"], "Ana M");
        assert_eq!(json["about"], "Hola");
        assert_eq!(json["profile_sync"], true);
    }

    #[test]
    fn a_photo_the_contact_removed_is_not_shown_from_its_code() {
        let ana = create_identity();
        let mut inner = InnerState::default();
        let mut stored = friend(&ana, "ana");
        stored.avatar = Some("data:image/png;base64,Y29kZQ==".into());
        inner.friends.insert("ana".into(), stored.clone());

        shared(
            &mut inner,
            "ana",
            r#"{"ty":"profile","v":1,"rev":3,"name":"Ana","about":"","photo":null}"#,
        );

        assert_eq!(node_info(&inner, &stored).avatar, None);
    }

    #[test]
    fn the_profile_says_this_about_and_that_profiles_are_sent() {
        let inner = InnerState {
            identity: Some(create_identity()),
            handle: Some("ana".into()),
            profiles: crate::commands::profile::Profiles {
                about: "Sobre mí".into(),
                ..Default::default()
            },
            ..InnerState::default()
        };

        let profile = profile_of(&inner).unwrap();

        assert_eq!(profile.about, "Sobre mí");
        assert_eq!(profile.sync, 1);
        let json = serde_json::to_value(&profile).unwrap();
        assert_eq!(
            (json["about"].clone(), json["sync"].clone()),
            ("Sobre mí".into(), 1.into())
        );
    }

    // ---- UR-2: a blocked contact's keys replaced (design test 3) ----

    #[test]
    fn ur2_3_replacing_a_blocked_contacts_keys_asks_and_keeps_the_old_identity_blocked() {
        use trino_engine::block::{block, BlockOrigin, BlockTarget};
        let (me, ana, new_ana) = (create_identity(), create_identity(), create_identity());
        let mut inner = InnerState {
            identity: Some(me),
            ..InnerState::default()
        };
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        let target = BlockTarget::Contact("ana".into());
        block(&mut inner, &target, BlockOrigin::Contact, NOW).unwrap();
        assert!(node_info(&inner, &inner.friends["ana"]).blocked);

        // The confirmation knows the name is someone blocked.
        let code = code_of(&new_ana, "ana");
        let shown = preview(&inner, &code).existing.unwrap();
        assert_eq!(
            (shown.handle.as_str(), shown.same_keys, shown.blocked),
            ("ana", false, true)
        );
        let refused = add_contact(&mut inner, code.clone(), "ana", false, NOW).unwrap_err();
        assert_eq!(refused.code, ErrorCode::NameTaken);
        add_contact(&mut inner, code, "ana", true, NOW).unwrap();

        // Other keys are someone else: not blocked. The old identity still is,
        // whatever its keys: her old code again comes back blocked.
        assert!(!node_info(&inner, &inner.friends["ana"]).blocked);
        assert!(inner
            .blocked
            .blocks_identity(&public_bundle_for(&ana).ik_sign_pub));
        add_contact(&mut inner, code_of(&ana, "ana"), "ana-vieja", false, NOW).unwrap();
        assert!(node_info(&inner, &inner.friends["ana-vieja"]).blocked);
    }
}
