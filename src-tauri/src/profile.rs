//! The shared profile (W8, K12), "profile1": the name, photo and "about" each
//! side shares, end to end encrypted over the usual double ratchet.
//! docs/perfil-v1.md fixes the bytes.
//!
//! This part keeps what contacts share and what they announced:
//!
//! - a profile message (`{"ty":"profile",…}`) from a contact is applied when
//!   its revision is newer than the one kept, and never goes further: no
//!   history, no `message-received`. One that breaks a rule is dropped in
//!   silence;
//! - every text, group or file message records whether its sender reads
//!   profile messages (`prof`), and which revision of ours it holds. One
//!   without `prof` clears that: an older version sent it, or someone went
//!   back to one;
//! - all of it lives in profiles.bin, encrypted with a key of its own.
//!
//! Profiles live here, not in trino-core: changing the core takes a push and
//! a new pin. A child module of `commands`.

use super::dbg_log;
use crate::identity::Identity;
use crate::state::{profiles_path, InnerState};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::Path;
use zeroize::{Zeroize, Zeroizing};

/// The version of the profile messages this backend reads.
pub(crate) const PROFILE_V: u64 = 1;
/// Limits of a profile, in Unicode scalar values and decoded bytes.
pub(crate) const NAME_MAX_CHARS: usize = 64;
pub(crate) const ABOUT_MAX_CHARS: usize = 140;
pub(crate) const PHOTO_MAX_BYTES: usize = 24 * 1024;
pub(crate) const PROFILES_FILE: &str = "profiles.bin";
/// HKDF info of the profiles.bin key, apart from the history key's.
const PROFILES_KEY_INFO: &[u8] = b"trino-profiles-key-v1";

/// The shared profiles, as profiles.bin keeps them.
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct Profiles {
    /// This identity's "about". Its name and photo stay in config.json,
    /// which the unlock screen reads before anything is decrypted.
    #[serde(default)]
    pub about: String,
    /// The revision of this identity's profile. It only grows.
    #[serde(default)]
    pub rev: u64,
    /// What each contact shares and announced, by the contact's name here.
    #[serde(default)]
    pub contacts: HashMap<String, ContactProfile>,
}

/// What one contact shares, and what its Trino announced.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct ContactProfile {
    /// The revision of their profile kept here; 0 for none.
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub about: Option<String>,
    #[serde(default)]
    pub photo: Option<String>,
    /// Whether a profile message decided the photo: then `photo` wins over
    /// the one in their contact code, even when it is `None` (removed).
    #[serde(default)]
    pub photo_set: bool,
    /// The profile message version their Trino reads (`prof.v`); 0 when
    /// their newest message announced nothing.
    #[serde(default)]
    pub caps: u64,
    /// The revision of OUR profile they hold (`prof.have`).
    #[serde(default)]
    pub have: u64,
    /// `created_at` of their newest text, group or file message, so an
    /// older one arriving late never undoes it.
    #[serde(default)]
    pub seen_at: i64,
}

/// What a profile message says about the photo.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PhotoField {
    /// Left out: the photo does not change.
    Unchanged,
    /// `null`: the photo goes.
    Removed,
    Set(String),
}

/// A profile message that passed every rule.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProfileMessage {
    pub rev: u64,
    pub name: String,
    pub about: String,
    pub photo: PhotoField,
}

/// The rule a profile message broke. Only the tests read it: such a message
/// is dropped in silence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Refused {
    Version,
    Field,
    Rev,
    Name,
    About,
    Photo,
}

/// What receiving one decrypted message did to the profiles.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct Received {
    /// A profile message: it goes no further.
    pub consumed: bool,
    /// profiles.bin must be written again.
    pub save: bool,
    /// The UI must read the contacts again (`profile-updated`).
    pub notify: bool,
}

/// A profile photo: `data:image/(jpeg|png|webp);base64,` and standard base64
/// of at most `PHOTO_MAX_BYTES` bytes.
pub(crate) fn valid_photo(url: &str) -> bool {
    use base64::Engine;
    let Some((meta, payload)) = url.split_once(',') else {
        return false;
    };
    if !matches!(
        meta,
        "data:image/jpeg;base64" | "data:image/png;base64" | "data:image/webp;base64"
    ) {
        return false;
    }
    // Checked before decoding, so a huge string costs nothing.
    if payload.is_empty() || payload.len() > PHOTO_MAX_BYTES.div_ceil(3) * 4 {
        return false;
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .is_ok_and(|bytes| bytes.len() <= PHOTO_MAX_BYTES)
}

/// `value` trimmed, if it is a string of at most `max` scalar values (and
/// at least one, with `non_empty`).
fn bounded_text(value: Option<&Value>, max: usize, non_empty: bool) -> Option<String> {
    let text = value?.as_str()?.trim();
    let chars = text.chars().count();
    (chars <= max && (chars > 0 || !non_empty)).then(|| text.to_string())
}

/// Every field a profile message v1 has. Any other makes it invalid: a new
/// field takes a new version.
const PROFILE_FIELDS: [&str; 6] = ["ty", "v", "rev", "name", "about", "photo"];

fn read_profile(fields: &Map<String, Value>) -> Result<ProfileMessage, Refused> {
    if fields.get("v").and_then(Value::as_u64) != Some(PROFILE_V) {
        return Err(Refused::Version);
    }
    if fields
        .keys()
        .any(|key| !PROFILE_FIELDS.contains(&key.as_str()))
    {
        return Err(Refused::Field);
    }
    let rev = fields
        .get("rev")
        .and_then(Value::as_u64)
        .filter(|rev| *rev > 0)
        .ok_or(Refused::Rev)?;
    let name = bounded_text(fields.get("name"), NAME_MAX_CHARS, true).ok_or(Refused::Name)?;
    let about = bounded_text(fields.get("about"), ABOUT_MAX_CHARS, false).ok_or(Refused::About)?;
    let photo = match fields.get("photo") {
        None => PhotoField::Unchanged,
        Some(Value::Null) => PhotoField::Removed,
        Some(Value::String(url)) if valid_photo(url) => PhotoField::Set(url.clone()),
        Some(_) => return Err(Refused::Photo),
    };
    Ok(ProfileMessage {
        rev,
        name,
        about,
        photo,
    })
}

/// Read `prof`: the version announced (1 or more) and the revision held, or
/// `None` when it is no valid announcement. Fields it does not know are a
/// newer version's own.
fn read_announcement(prof: &Value) -> Option<(u64, u64)> {
    let version = prof.get("v")?.as_u64().filter(|v| *v >= 1)?;
    let have = prof.get("have")?.as_u64()?;
    Some((version, have))
}

fn wipe(text: &mut Option<String>) {
    if let Some(text) = text.as_mut() {
        text.zeroize();
    }
    *text = None;
}

impl Profiles {
    /// Keep `message` from `handle` if it is newer than the profile kept.
    fn apply(&mut self, handle: &str, message: ProfileMessage) -> bool {
        let kept = self.contacts.entry(handle.to_string()).or_default();
        if message.rev <= kept.rev {
            return false;
        }
        kept.rev = message.rev;
        wipe(&mut kept.name);
        kept.name = Some(message.name);
        wipe(&mut kept.about);
        kept.about = Some(message.about);
        match message.photo {
            PhotoField::Unchanged => {}
            PhotoField::Removed => {
                wipe(&mut kept.photo);
                kept.photo_set = true;
            }
            PhotoField::Set(url) => {
                wipe(&mut kept.photo);
                kept.photo = Some(url);
                kept.photo_set = true;
            }
        }
        true
    }

    /// Record what a text, group or file message of `handle` announced. Only
    /// the newest message counts: relays deliver in any order, and the
    /// catch-up after a restart often newest first.
    fn note_announcement(
        &mut self,
        handle: &str,
        prof: Option<&Value>,
        created_at: i64,
    ) -> Received {
        let (caps, have) = prof.and_then(read_announcement).unwrap_or((0, 0));
        if caps == 0 && !self.contacts.contains_key(handle) {
            return Received::default();
        }
        let kept = self.contacts.entry(handle.to_string()).or_default();
        if created_at < kept.seen_at {
            return Received::default();
        }
        kept.seen_at = created_at;
        let save = kept.caps != caps || kept.have != have;
        let notify = (kept.caps >= 1) != (caps >= 1);
        kept.caps = caps;
        kept.have = have;
        Received {
            consumed: false,
            save,
            notify,
        }
    }

    /// Move the profile of a contact renamed here.
    pub(crate) fn rename(&mut self, old: &str, new: &str) -> bool {
        match self.contacts.remove(old) {
            Some(kept) => {
                self.contacts.insert(new.to_string(), kept);
                true
            }
            None => false,
        }
    }

    /// Drop the profile of a contact removed here.
    pub(crate) fn remove(&mut self, handle: &str) -> bool {
        match self.contacts.remove(handle) {
            Some(mut kept) => {
                kept.forget();
                true
            }
            None => false,
        }
    }

    /// Wipe every profile from memory, as locking does.
    pub(crate) fn forget(&mut self) {
        self.about.zeroize();
        self.rev = 0;
        for kept in self.contacts.values_mut() {
            kept.forget();
        }
        self.contacts.clear();
    }
}

impl ContactProfile {
    fn forget(&mut self) {
        wipe(&mut self.name);
        wipe(&mut self.about);
        wipe(&mut self.photo);
    }
}

/// Handle one decrypted message from `handle` (see the module comment).
pub(crate) fn receive(
    profiles: &mut Profiles,
    handle: &str,
    plain: &[u8],
    created_at: i64,
) -> Received {
    let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(plain) else {
        return Received::default();
    };
    match fields.get("ty").and_then(Value::as_str) {
        Some("profile") => {
            let applied = match read_profile(&fields) {
                Ok(message) => profiles.apply(handle, message),
                Err(_) => false,
            };
            Received {
                consumed: true,
                save: applied,
                notify: applied,
            }
        }
        Some("text" | "grp" | "file") => {
            profiles.note_announcement(handle, fields.get("prof"), created_at)
        }
        _ => Received::default(),
    }
}

/// The key of profiles.bin: HKDF of the identity, apart from the history key.
fn profiles_key(identity: &Identity) -> std::io::Result<Zeroizing<[u8; 32]>> {
    let okm = Zeroizing::new(
        crate::crypto::hkdf_expand(
            &identity.ik_sign.priv_bytes,
            &[0u8; 32],
            PROFILES_KEY_INFO,
            32,
        )
        .map_err(|error| std::io::Error::other(error.to_string()))?,
    );
    let mut key = Zeroizing::new([0u8; 32]);
    key.copy_from_slice(&okm);
    Ok(key)
}

/// Write `profiles` to `path`, encrypted: `nonce ‖ ciphertext`, as
/// history.bin, and atomically.
pub(crate) fn save_at(
    profiles: &Profiles,
    identity: &Identity,
    path: &Path,
) -> std::io::Result<()> {
    let key = profiles_key(identity)?;
    let json = Zeroizing::new(serde_json::to_vec(profiles).map_err(std::io::Error::other)?);
    let (ciphertext, nonce) = crate::crypto::aes_gcm_encrypt(&*key, &json, None)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut blob = Vec::with_capacity(nonce.len() + ciphertext.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    crate::fsutil::atomic_write(path, &blob)
}

/// Read profiles.bin at `path`. A file that is missing, damaged or another
/// identity's reads as no profiles at all.
pub(crate) fn load_at(path: &Path, identity: &Identity) -> Profiles {
    let (Ok(blob), Ok(key)) = (std::fs::read(path), profiles_key(identity)) else {
        return Profiles::default();
    };
    if blob.len() < crate::crypto::NONCE_SIZE {
        return Profiles::default();
    }
    let (nonce, ciphertext) = blob.split_at(crate::crypto::NONCE_SIZE);
    crate::crypto::aes_gcm_decrypt(&*key, ciphertext, nonce, None)
        .ok()
        .map(Zeroizing::new)
        .and_then(|json| serde_json::from_slice(&json).ok())
        .unwrap_or_default()
}

/// Load profiles.bin into the session that `open_session` is opening. This
/// identity's profile gets its first revision here, so contacts that
/// announce support get it without waiting for an edit.
pub(crate) fn load_into(inner: &mut InnerState, path: &Path, now: i64) {
    let Some(identity) = inner.identity.as_ref() else {
        return;
    };
    inner.profiles = load_at(path, identity);
    if inner.profiles.rev == 0 {
        inner.profiles.rev = now.max(1) as u64;
        if save_at(&inner.profiles, identity, path).is_err() {
            dbg_log("profiles.bin could not be saved");
        }
    }
}

/// Write profiles.bin for the open session. A failure is only logged: the
/// next change writes everything again.
pub(crate) fn save(inner: &InnerState) {
    let Some(identity) = inner.identity.as_ref() else {
        return;
    };
    if save_at(&inner.profiles, identity, &profiles_path()).is_err() {
        dbg_log("profiles.bin could not be saved");
    }
}

/// The hook in `handle_incoming_event`, just before the envelope is decoded.
/// Returns whether the message ends here (a profile message).
pub(crate) fn on_message(
    app: &tauri::AppHandle,
    inner: &mut InnerState,
    handle: &str,
    plain: &[u8],
    created_at: i64,
) -> bool {
    use tauri::Emitter;
    let received = receive(&mut inner.profiles, handle, plain, created_at);
    if received.save {
        save(inner);
    }
    if received.notify {
        let _ = app.emit(
            "profile-updated",
            ProfileUpdatedEvent {
                handle: handle.to_string(),
            },
        );
    }
    received.consumed
}

/// A contact's shared profile changed (K12): read the contacts again.
#[derive(Serialize, Clone)]
pub struct ProfileUpdatedEvent {
    pub handle: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::identity::create_identity;
    use base64::Engine;

    const NOW: i64 = 1_760_000_000;
    /// A 1x1 PNG.
    const PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    /// A profile message; `photo` is the raw JSON of the field, or `None`
    /// to leave it out.
    fn msg(rev: i64, name: &str, about: &str, photo: Option<&str>) -> Vec<u8> {
        let name = serde_json::to_string(name).unwrap();
        let about = serde_json::to_string(about).unwrap();
        let photo = photo
            .map(|p| format!(r#","photo":{p}"#))
            .unwrap_or_default();
        format!(r#"{{"ty":"profile","v":1,"rev":{rev},"name":{name},"about":{about}{photo}}}"#)
            .into_bytes()
    }

    fn photo(url: &str) -> String {
        serde_json::to_string(url).unwrap()
    }

    fn jpeg_of(bytes: usize) -> String {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(vec![0u8; bytes])
        )
    }

    fn text_with(prof: &str) -> Vec<u8> {
        format!(r#"{{"ty":"text","body":"hola","id":"m1"{prof}}}"#).into_bytes()
    }

    /// The profile message in `plain`, checked, as `receive` checks it:
    /// `None` when it is no profile message at all.
    fn parse_profile(plain: &[u8]) -> Option<Result<ProfileMessage, Refused>> {
        let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(plain) else {
            return None;
        };
        if fields.get("ty").and_then(Value::as_str) != Some("profile") {
            return None;
        }
        Some(read_profile(&fields))
    }

    // ---- Reading a profile message ----

    #[test]
    fn a_valid_profile_message_parses() {
        let parsed = parse_profile(&msg(9, "  Ana  ", " Sobre mí 🙂 ", Some(&photo(PNG))));
        assert_eq!(
            parsed,
            Some(Ok(ProfileMessage {
                rev: 9,
                name: "Ana".into(),
                about: "Sobre mí 🙂".into(),
                photo: PhotoField::Set(PNG.into()),
            }))
        );
        let removed = parse_profile(&msg(2, "Ana", "", Some("null")));
        assert_eq!(removed.unwrap().unwrap().photo, PhotoField::Removed);
        let any_order = parse_profile(br#"{"about":"","name":"Ana","rev":2,"v":1,"ty":"profile"}"#);
        assert_eq!(any_order.unwrap().unwrap().photo, PhotoField::Unchanged);
        let largest = jpeg_of(PHOTO_MAX_BYTES).replace("jpeg", "webp");
        let full = msg(
            1,
            &"ñ".repeat(NAME_MAX_CHARS),
            &"🙂".repeat(ABOUT_MAX_CHARS),
            Some(&photo(&largest)),
        );
        assert!(parse_profile(&full).unwrap().is_ok());
        assert_eq!(parse_profile(br#"{"ty":"text","body":"x"}"#), None);
        assert_eq!(parse_profile(b"__trino_handshake__"), None);
    }

    #[test]
    fn a_profile_message_that_breaks_a_rule_is_refused() {
        let long_name = "a".repeat(NAME_MAX_CHARS + 1);
        let long_about = "🙂".repeat(ABOUT_MAX_CHARS + 1);
        let big = photo(&jpeg_of(PHOTO_MAX_BYTES + 1));
        let gif = photo(&PNG.replace("image/png", "image/gif"));
        let not_base64 = photo("data:image/png;base64,not base64!");
        let link = photo("https://example.com/a.png");
        let cases: Vec<(Vec<u8>, Refused)> = vec![
            (msg(1, &long_name, "", None), Refused::Name),
            (msg(1, "   ", "", None), Refused::Name),
            (msg(1, "Ana", &long_about, None), Refused::About),
            (msg(1, "Ana", "", Some(&big)), Refused::Photo),
            (msg(1, "Ana", "", Some(&gif)), Refused::Photo),
            (msg(1, "Ana", "", Some(&not_base64)), Refused::Photo),
            (msg(1, "Ana", "", Some(&link)), Refused::Photo),
            (msg(1, "Ana", "", Some("7")), Refused::Photo),
            (msg(0, "Ana", "", None), Refused::Rev),
            (msg(-3, "Ana", "", None), Refused::Rev),
            (
                br#"{"ty":"profile","v":1,"rev":"3","name":"Ana","about":""}"#.to_vec(),
                Refused::Rev,
            ),
            (
                br#"{"ty":"profile","v":2,"rev":3,"name":"Ana","about":""}"#.to_vec(),
                Refused::Version,
            ),
            (
                br#"{"ty":"profile","rev":3,"name":"Ana","about":""}"#.to_vec(),
                Refused::Version,
            ),
            (
                br#"{"ty":"profile","v":1,"rev":3,"name":"Ana","about":"","x":1}"#.to_vec(),
                Refused::Field,
            ),
            (
                br#"{"ty":"profile","v":1,"rev":3,"name":"Ana"}"#.to_vec(),
                Refused::About,
            ),
            (
                br#"{"ty":"profile","v":1,"rev":3,"name":7,"about":""}"#.to_vec(),
                Refused::Name,
            ),
        ];
        for (bad, why) in cases {
            let text: String = String::from_utf8_lossy(&bad).chars().take(80).collect();
            assert_eq!(parse_profile(&bad), Some(Err(why)), "{text}");
        }
    }

    // ---- Receiving ----

    #[test]
    fn a_newer_profile_is_kept_and_an_older_one_dropped_and_neither_goes_further() {
        let mut profiles = Profiles::default();

        let first = receive(
            &mut profiles,
            "ana",
            &msg(5, "Ana", "Hola", Some(&photo(PNG))),
            NOW,
        );
        assert_eq!(
            first,
            Received {
                consumed: true,
                save: true,
                notify: true
            }
        );
        let ana = &profiles.contacts["ana"];
        assert_eq!(ana.rev, 5);
        assert_eq!(ana.name.as_deref(), Some("Ana"));
        assert_eq!(ana.about.as_deref(), Some("Hola"));
        assert_eq!(ana.photo.as_deref(), Some(PNG));

        let stale = receive(&mut profiles, "ana", &msg(5, "Vieja", "", None), NOW);
        assert_eq!(
            stale,
            Received {
                consumed: true,
                ..Received::default()
            }
        );
        assert_eq!(profiles.contacts["ana"].name.as_deref(), Some("Ana"));

        // Left out, the photo stays; null removes it.
        receive(&mut profiles, "ana", &msg(6, "Ana M", "", None), NOW);
        assert_eq!(profiles.contacts["ana"].photo.as_deref(), Some(PNG));
        assert_eq!(profiles.contacts["ana"].name.as_deref(), Some("Ana M"));
        receive(
            &mut profiles,
            "ana",
            &msg(7, "Ana M", "", Some("null")),
            NOW,
        );
        assert_eq!(profiles.contacts["ana"].photo, None);
        assert!(profiles.contacts["ana"].photo_set);
    }

    #[test]
    fn a_profile_message_that_breaks_a_rule_is_dropped_in_silence() {
        let mut profiles = Profiles::default();

        let out = receive(
            &mut profiles,
            "ana",
            br#"{"ty":"profile","v":9,"rev":5,"name":"Ana","about":""}"#,
            NOW,
        );

        assert_eq!(
            out,
            Received {
                consumed: true,
                ..Received::default()
            }
        );
        assert_eq!(profiles.contacts.get("ana").map_or(0, |c| c.rev), 0);
    }

    #[test]
    fn a_profile_message_never_reaches_the_chat() {
        let mut inner = InnerState::default();
        let out = receive(
            &mut inner.profiles,
            "ana",
            &msg(5, "Ana", "Hola", None),
            NOW,
        );
        assert!(
            out.consumed,
            "handle_incoming_event stops before the envelope"
        );
        assert!(inner.history.is_empty());
    }

    #[test]
    fn announcements_set_and_clear_what_a_contact_reads() {
        let mut profiles = Profiles::default();
        let announced = text_with(r#","prof":{"v":1,"have":3}"#);

        let out = receive(&mut profiles, "ana", &announced, NOW);
        assert_eq!(
            out,
            Received {
                consumed: false,
                save: true,
                notify: true
            }
        );
        let ana = &profiles.contacts["ana"];
        assert_eq!((ana.caps, ana.have), (1, 3));

        // The same again changes nothing worth a write.
        let again = receive(&mut profiles, "ana", &announced, NOW + 1);
        assert_eq!(again, Received::default());

        // Calls, rosters and handshakes say nothing about it.
        for other in [
            br#"{"ty":"call","call":"{}"}"#.to_vec(),
            br#"{"ty":"roster","roster":{}}"#.to_vec(),
            b"__trino_handshake__".to_vec(),
        ] {
            let out = receive(&mut profiles, "ana", &other, NOW + 2);
            assert_eq!(out, Received::default());
        }
        assert_eq!(profiles.contacts["ana"].caps, 1);

        // A group message without it: an older version, or back to one.
        let bare = br#"{"ty":"grp","gid":"g1","ep":1,"body":"hola"}"#;
        let out = receive(&mut profiles, "ana", bare, NOW + 3);
        assert_eq!(
            out,
            Received {
                consumed: false,
                save: true,
                notify: true
            }
        );
        assert_eq!(profiles.contacts["ana"].caps, 0);

        // An older message arriving late never undoes a newer one.
        let late = receive(&mut profiles, "ana", &announced, NOW + 2);
        assert_eq!(late, Received::default());
        assert_eq!(profiles.contacts["ana"].caps, 0);
    }

    #[test]
    fn a_broken_announcement_counts_as_none() {
        let mut profiles = Profiles::default();
        let good = text_with(r#","prof":{"v":1,"have":0}"#);
        let mut at = NOW;
        for prof in [
            r#","prof":{"v":0,"have":0}"#,
            r#","prof":"1""#,
            r#","prof":{"have":2}"#,
            r#","prof":{"v":1}"#,
        ] {
            receive(&mut profiles, "ana", &good, at);
            assert_eq!(profiles.contacts["ana"].caps, 1);
            receive(&mut profiles, "ana", &text_with(prof), at + 1);
            assert_eq!(profiles.contacts["ana"].caps, 0, "{prof}");
            at += 10;
        }
        // A newer version that also reads v1: its other fields are its own.
        let newer = text_with(r#","prof":{"v":2,"have":4,"x":true}"#);
        receive(&mut profiles, "ana", &newer, at);
        let ana = &profiles.contacts["ana"];
        assert_eq!((ana.caps, ana.have), (2, 4));
    }

    // ---- On disk and in memory ----

    #[test]
    fn profiles_bin_is_encrypted_and_comes_back_on_reload() {
        let scratch = ScratchDir::new("profiles-bin");
        let path = scratch.path().join(PROFILES_FILE);
        let me = create_identity();
        let mut profiles = Profiles {
            about: "Mi secreto sobre mí".into(),
            rev: 12,
            ..Profiles::default()
        };
        let theirs = msg(5, "Ana Nombre", "Sobre Ana", Some(&photo(PNG)));
        receive(&mut profiles, "ana", &theirs, NOW);
        receive(
            &mut profiles,
            "ana",
            &text_with(r#","prof":{"v":1,"have":12}"#),
            NOW,
        );

        save_at(&profiles, &me, &path).unwrap();

        let raw = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).to_string();
        for secret in [
            "Mi secreto",
            "Ana Nombre",
            "Sobre Ana",
            "iVBORw0KGgo",
            "ana",
            "rev",
        ] {
            assert!(!raw.contains(secret), "{secret} in the clear");
        }
        let reloaded = load_at(&path, &me);
        assert_eq!(reloaded.about, "Mi secreto sobre mí");
        assert_eq!(reloaded.rev, 12);
        assert_eq!(reloaded.contacts["ana"], profiles.contacts["ana"]);
        // Another identity reads nothing, and neither does a damaged file.
        assert_eq!(load_at(&path, &create_identity()).rev, 0);
        std::fs::write(&path, b"short").unwrap();
        assert_eq!(load_at(&path, &me).rev, 0);
    }

    #[test]
    fn the_profiles_key_is_not_the_history_key() {
        let me = create_identity();
        let key = profiles_key(&me).unwrap();
        assert_ne!(*key, crate::commands::derive_history_key(&me));
        assert_ne!(*key, [0u8; 32]);
        assert_eq!(*key, *profiles_key(&me).unwrap(), "stable");
        assert_ne!(*key, *profiles_key(&create_identity()).unwrap());
    }

    #[test]
    fn opening_a_session_loads_the_profiles_and_gives_this_profile_a_first_revision() {
        let scratch = ScratchDir::new("profiles-open");
        let path = scratch.path().join(PROFILES_FILE);
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };

        load_into(&mut inner, &path, NOW);

        assert_eq!(inner.profiles.rev, NOW as u64);
        assert_eq!(load_at(&path, &me).rev, NOW as u64, "saved");
        // Later sessions keep it.
        let mut again = InnerState {
            identity: Some(me),
            ..InnerState::default()
        };
        load_into(&mut again, &path, NOW + 999);
        assert_eq!(again.profiles.rev, NOW as u64);
    }

    #[test]
    fn renaming_moves_a_contacts_profile_and_removing_drops_it() {
        let mut profiles = Profiles::default();
        receive(&mut profiles, "ana", &msg(5, "Ana", "", None), NOW);

        assert!(profiles.rename("ana", "Anita"));
        assert!(!profiles.contacts.contains_key("ana"));
        assert_eq!(profiles.contacts["Anita"].rev, 5);
        assert!(!profiles.rename("nadie", "otro"));

        assert!(profiles.remove("Anita"));
        assert!(profiles.contacts.is_empty());
        assert!(!profiles.remove("Anita"));
    }

    #[test]
    fn locking_forgets_every_profile() {
        let mut profiles = Profiles {
            about: "Hola".into(),
            rev: 3,
            ..Profiles::default()
        };
        let theirs = msg(5, "Ana", "x", Some(&photo(PNG)));
        receive(&mut profiles, "ana", &theirs, NOW);

        profiles.forget();

        assert_eq!(profiles.about, "");
        assert_eq!(profiles.rev, 0);
        assert!(profiles.contacts.is_empty());
    }

    #[test]
    fn profiles_bin_is_only_written_atomically_and_a_wipe_removes_it() {
        let code = include_str!("profile.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            !code.contains("fs::write"),
            "a crash halfway would leave it half written"
        );
        assert!(code.contains("fsutil::atomic_write(path"));
        let commands: String = include_str!("commands.rs").split_whitespace().collect();
        let wipe = commands
            .split("pubasyncfnwipe(")
            .nth(1)
            .and_then(|rest| rest.split("#[tauri::command]").next())
            .unwrap();
        assert!(
            wipe.contains("profiles_path(),"),
            "wipe leaves profiles.bin behind"
        );
    }
}
