//! The shared profile (W8, K12), "profile1": the name, photo and "about" each
//! side shares, end to end encrypted over the usual double ratchet.
//! docs/perfil-v1.md fixes the bytes.
//!
//! 0.1.0 shows any envelope type it does not know as raw JSON, so a profile
//! message only ever goes to a contact whose Trino announced it reads them:
//!
//! - every outgoing text, group or file message announces it
//!   (`"prof":{"v":1,"have":N,"alert":1}`, `with_caps`), with the revision
//!   of that contact's profile held here, and that this Trino reads the
//!   warning to a trusted contact (alert.rs). 0.1.0 ignores the extra field;
//! - every incoming one records what its sender announced. One without
//!   `prof` clears it: an older version sent it, or someone went back to
//!   one. Only the newest message counts;
//! - a profile message (`{"ty":"profile",…}`) goes only to contacts that
//!   announced, after each change and again, once per session and
//!   revision, to one that announces an older revision than ours;
//! - one received is kept when its revision is newer than the one kept, and
//!   never goes further: no history, no `message-received`. One that breaks
//!   a rule is dropped in silence;
//! - all of it lives in the store's profiles.bin, sealed under a key of its
//!   own (cifrado local).
//!
//! Profiles live here, not in trino-core: changing the core takes a push and
//! a new pin. This module holds them as the session keeps them (this
//! identity's "about" and revision, what each contact shares and announced),
//! the rules a profile message must pass, sending, and profiles.bin (M4-0).

use crate::command_error::{CommandError, ErrorCode};
use crate::events::EventSink;
use crate::identity::Identity;
use crate::session::{dbg_log, ensure_session_inner, send_cipher_inner};
use crate::state::InnerState;
use crate::store::envelope::Slot;
use crate::store::session::{legacy_open, Found};
use crate::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;
use zeroize::{Zeroize, Zeroizing};

/// The version of the profile messages this backend reads and sends.
pub const PROFILE_V: u64 = 1;

/// The shared profiles, as profiles.bin keeps them.
#[derive(Default, Serialize, Deserialize)]
pub struct Profiles {
    /// This identity's "about". Its name and photo are in the account file
    /// (`account.bin` in the store), with the rest of the account.
    #[serde(default)]
    pub about: String,
    /// The revision of this identity's profile. It only grows.
    #[serde(default)]
    pub rev: u64,
    /// What each contact shares and announced, by the contact's name here.
    #[serde(default)]
    pub contacts: HashMap<String, ContactProfile>,
    /// (contact, revision) this session already sent this identity's
    /// profile to. Memory only: a new session sends again where needed.
    #[serde(skip)]
    pub sent: HashSet<(String, u64)>,
    /// The profiles were there at unlock but could not be read (`load_found`).
    #[serde(skip)]
    pub not_loaded: bool,
}

/// What one contact shares, and what its Trino announced.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ContactProfile {
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
    /// The version of the warning to a trusted contact their Trino reads
    /// (`prof.alert`, clave de emergencia CE-6); 0 for none.
    #[serde(default)]
    pub alert: u64,
    /// `created_at` of their newest text, group or file message, so an
    /// older one arriving late never undoes it.
    #[serde(default)]
    pub seen_at: i64,
}

/// What a profile message says about the photo.
#[derive(Clone, Debug, PartialEq)]
pub enum PhotoField {
    /// Left out: the photo does not change.
    Unchanged,
    /// `null`: the photo goes.
    Removed,
    Set(String),
}

/// A profile message that passed every rule.
#[derive(Clone, Debug, PartialEq)]
pub struct ProfileMessage {
    pub rev: u64,
    pub name: String,
    pub about: String,
    pub photo: PhotoField,
}

/// What receiving one decrypted message did to the profiles.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Received {
    /// A profile message: it goes no further.
    pub consumed: bool,
    /// profiles.bin must be written again.
    pub save: bool,
    /// The UI must read the contacts again (`profile-updated`).
    pub notify: bool,
    /// The sender reads profiles but holds an older revision of ours: send
    /// it again (once per session and revision).
    pub resend: bool,
}

/// Read `prof`: the version announced (1 or more), the revision held and
/// the version of the warning to a trusted contact read (0 for none), or
/// `None` when it is no valid announcement. Fields it does not know are a
/// newer version's own.
fn read_announcement(prof: &Value) -> Option<(u64, u64, u64)> {
    let version = prof.get("v")?.as_u64().filter(|v| *v >= 1)?;
    let have = prof.get("have")?.as_u64()?;
    let alert = prof.get("alert").and_then(Value::as_u64).unwrap_or(0);
    Some((version, have, alert))
}

fn wipe(text: &mut Option<String>) {
    if let Some(text) = text.as_mut() {
        text.zeroize();
    }
    *text = None;
}

impl Profiles {
    /// Keep `message` from `handle` if it is newer than the profile kept.
    pub fn apply(&mut self, handle: &str, message: ProfileMessage) -> bool {
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
    pub fn note_announcement(
        &mut self,
        handle: &str,
        prof: Option<&Value>,
        created_at: i64,
    ) -> Received {
        let (caps, have, alert) = prof.and_then(read_announcement).unwrap_or((0, 0, 0));
        if caps == 0 && !self.contacts.contains_key(handle) {
            return Received::default();
        }
        let kept = self.contacts.entry(handle.to_string()).or_default();
        if created_at < kept.seen_at {
            return Received::default();
        }
        kept.seen_at = created_at;
        let save = kept.caps != caps || kept.have != have || kept.alert != alert;
        let notify = (kept.caps >= 1) != (caps >= 1);
        kept.caps = caps;
        kept.have = have;
        kept.alert = alert;
        // Anti-entropy: a contact that reads profiles but holds an older
        // revision of ours lost it (24 h catch-up window, a relay down) or
        // never had it. Once per session and revision, so a contact that
        // cannot take it does not get it again with every message.
        let resend = caps >= PROFILE_V
            && have < self.rev
            && self.sent.insert((handle.to_string(), self.rev));
        Received {
            consumed: false,
            save,
            notify,
            resend,
        }
    }

    /// Move the profile of a contact renamed here, and what this session
    /// sent it. Returns whether profiles.bin changed.
    pub fn rename(&mut self, old: &str, new: &str) -> bool {
        let revisions: Vec<u64> = self
            .sent
            .iter()
            .filter(|(to, _)| to == old)
            .map(|(_, rev)| *rev)
            .collect();
        for rev in revisions {
            self.sent.remove(&(old.to_string(), rev));
            self.sent.insert((new.to_string(), rev));
        }
        match self.contacts.remove(old) {
            Some(kept) => {
                self.contacts.insert(new.to_string(), kept);
                true
            }
            None => false,
        }
    }

    /// Drop the profile of a contact removed here, and what this session
    /// sent it. Returns whether profiles.bin changed.
    pub fn remove(&mut self, handle: &str) -> bool {
        self.sent.retain(|(to, _)| to != handle);
        match self.contacts.remove(handle) {
            Some(mut kept) => {
                kept.forget();
                true
            }
            None => false,
        }
    }

    /// Wipe every profile from memory, as locking does.
    pub fn forget(&mut self) {
        self.about.zeroize();
        self.rev = 0;
        self.not_loaded = false;
        for kept in self.contacts.values_mut() {
            kept.forget();
        }
        self.contacts.clear();
        self.sent.clear();
    }
}

impl ContactProfile {
    pub fn forget(&mut self) {
        wipe(&mut self.name);
        wipe(&mut self.about);
        wipe(&mut self.photo);
    }
}

/// The format characters, general category Cf in Unicode 15.1. They show
/// nothing, and the bidi controls among them (U+202A to U+202E, U+2066 to
/// U+2069) reorder the text around them, so a name can pass for another.
const FORMAT_CHARS: [(char, char); 21] = [
    ('\u{00AD}', '\u{00AD}'),
    ('\u{0600}', '\u{0605}'),
    ('\u{061C}', '\u{061C}'),
    ('\u{06DD}', '\u{06DD}'),
    ('\u{070F}', '\u{070F}'),
    ('\u{0890}', '\u{0891}'),
    ('\u{08E2}', '\u{08E2}'),
    ('\u{180E}', '\u{180E}'),
    ('\u{200B}', '\u{200F}'),
    ('\u{202A}', '\u{202E}'),
    ('\u{2060}', '\u{2064}'),
    ('\u{2066}', '\u{206F}'),
    ('\u{FEFF}', '\u{FEFF}'),
    ('\u{FFF9}', '\u{FFFB}'),
    ('\u{110BD}', '\u{110BD}'),
    ('\u{110CD}', '\u{110CD}'),
    ('\u{13430}', '\u{1343F}'),
    ('\u{1BCA0}', '\u{1BCA3}'),
    ('\u{1D173}', '\u{1D17A}'),
    ('\u{E0001}', '\u{E0001}'),
    ('\u{E0020}', '\u{E007F}'),
];

pub fn is_format(c: char) -> bool {
    FORMAT_CHARS
        .iter()
        .any(|&(first, last)| (first..=last).contains(&c))
}

/// Whether `c` may be part of a name, or of an "about" with `line_breaks`:
/// no control character but the line break of an "about", no line or
/// paragraph separator, and no format character but the two joiners
/// (U+200C, U+200D), which emoji such as 👩‍💻 and scripts such as Persian
/// need.
pub fn allowed_char(c: char, line_breaks: bool) -> bool {
    match c {
        '\n' => line_breaks,
        '\u{200C}' | '\u{200D}' => true,
        '\u{2028}' | '\u{2029}' => false,
        c => !c.is_control() && !is_format(c),
    }
}

/// Whether `c` shows nothing by itself: white space, a control or format
/// character, a variation selector, the grapheme joiner, the Hangul fillers,
/// the inherent Khmer vowels, the Mongolian variation selectors and the
/// blank Braille pattern.
pub fn shows_nothing(c: char) -> bool {
    c.is_whitespace()
        || c.is_control()
        || is_format(c)
        || matches!(
            c,
            '\u{034F}'
                | '\u{115F}'
                | '\u{1160}'
                | '\u{17B4}'
                | '\u{17B5}'
                | '\u{180B}'..='\u{180D}'
                | '\u{180F}'
                | '\u{2800}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FFA0}'
                | '\u{E0100}'..='\u{E01EF}'
        )
}

/// A name a profile can carry: only allowed characters, and at least one
/// that shows. A contact's name here follows it too
/// (`contacts::check_local_handle`).
pub fn readable_name(name: &str) -> bool {
    name.chars().all(|c| allowed_char(c, false)) && !name.chars().all(shows_nothing)
}

/// `name`, which a peer chose, as it can be shown: without the characters a
/// readable name may not hold (control and format ones, the bidi overrides
/// and isolates among them), at most `max_chars` long, and `fallback` when
/// nothing in it shows (TRN-APP-03).
pub fn shown_name(name: &str, max_chars: usize, fallback: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|&c| allowed_char(c, false))
        .take(max_chars)
        .collect();
    if clean.chars().all(shows_nothing) {
        fallback.to_string()
    } else {
        clean
    }
}

/// Limits of a profile, in Unicode scalar values and decoded bytes.
pub const NAME_MAX_CHARS: usize = 64;
pub const ABOUT_MAX_CHARS: usize = 140;
pub const PHOTO_MAX_BYTES: usize = 20 * 1024;
pub const PROFILES_FILE: &str = "profiles.bin";
/// Where an earlier version's profiles.bin that does not decrypt is kept
/// (`legacy_found`).
pub const DAMAGED_PROFILES_FILE: &str = "profiles.bin.damaged";
/// HKDF info of the profiles.bin key, apart from the history key's.
pub const PROFILES_KEY_INFO: &[u8] = b"trino-profiles-key-v1";

/// The rule a profile message broke. Only the tests read it: such a message
/// is dropped in silence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Refused {
    Version,
    Field,
    Rev,
    Name,
    About,
    Photo,
}

/// Unicode scalar values, as the limits count them: an emoji made of one
/// code point counts 1.
pub fn scalars(text: &str) -> usize {
    text.chars().count()
}

pub fn profile_invalid(message: &str) -> CommandError {
    CommandError::new(ErrorCode::ProfileInvalid, message)
}

/// An "about" a profile can carry: only allowed characters, line breaks
/// included.
pub fn readable_about(about: &str) -> bool {
    about.chars().all(|c| allowed_char(c, true))
}

/// A name for this identity's profile: trimmed, `None` when blank (the
/// current one stays). `current`, the name saved already, comes back as it
/// is: before profiles a name had no limit, and `current_message` gives
/// contacts what they take of it. Any other name over `NAME_MAX_CHARS`, or
/// that is not `readable_name`, is `profile_invalid`.
pub fn check_name(name: &str, current: Option<&str>) -> Result<Option<String>, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if current.map(str::trim) == Some(name) {
        return Ok(Some(name.to_string()));
    }
    if scalars(name) > NAME_MAX_CHARS {
        return Err(profile_invalid("the name is longer than 64 characters"));
    }
    if !readable_name(name) {
        return Err(profile_invalid(
            "the name holds a control, format or bidi character, or nothing that shows",
        ));
    }
    Ok(Some(name.to_string()))
}

/// An "about" for this identity's profile: trimmed, `profile_invalid` over
/// `ABOUT_MAX_CHARS` or when it is not `readable_about`.
pub fn check_about(about: &str) -> Result<String, CommandError> {
    let about = about.trim();
    if scalars(about) > ABOUT_MAX_CHARS {
        return Err(profile_invalid("the about is longer than 140 characters"));
    }
    if !readable_about(about) {
        return Err(profile_invalid(
            "the about holds a control, format or bidi character",
        ));
    }
    Ok(about.to_string())
}

/// A photo for this identity's profile: none, one `valid_photo` takes, or
/// `current`, the one saved already. Before profiles a photo could be a GIF
/// or up to 128 KiB: saving the name or the "about" sends it back, and it
/// stays, but contacts never get it (`current_message`).
pub fn check_photo(
    photo: Option<String>,
    current: Option<&str>,
) -> Result<Option<String>, CommandError> {
    match photo {
        Some(url) if Some(url.as_str()) != current && !valid_photo(&url) => Err(profile_invalid(
            "the photo is not a jpeg, png or webp image of at most 20 KiB",
        )),
        photo => Ok(photo),
    }
}

/// The next revision: the larger of the previous one + 1 and the clock.
pub fn next_rev(previous: u64, now: i64) -> u64 {
    previous.saturating_add(1).max(now.max(0) as u64)
}

/// A profile message as it goes out, in this field order.
#[derive(Serialize)]
pub struct WireProfile<'a> {
    ty: &'static str,
    v: u64,
    rev: u64,
    name: &'a str,
    about: &'a str,
    /// Left out: unchanged. `null`: removed.
    #[serde(skip_serializing_if = "Option::is_none")]
    photo: Option<Option<&'a str>>,
}

/// A profile message, as it goes out: compact UTF-8 JSON with the keys in
/// this order. `photo` is left out with `Unchanged`.
pub fn profile_message(rev: u64, name: &str, about: &str, photo: &PhotoField) -> Vec<u8> {
    let wire = WireProfile {
        ty: "profile",
        v: PROFILE_V,
        rev,
        name,
        about,
        photo: match photo {
            PhotoField::Unchanged => None,
            PhotoField::Removed => Some(None),
            PhotoField::Set(url) => Some(Some(url)),
        },
    };
    serde_json::to_vec(&wire).unwrap_or_default()
}

/// What `seal_for` encrypts for `handle`, for every message to a contact:
/// `plaintext` itself or, for a text, group or file envelope, the same
/// envelope announcing that this Trino reads profile messages and which
/// revision of `handle`'s profile it holds, and that it reads the warning
/// to a trusted contact (`"alert":1`, CE-6). Calls, rosters, handshakes,
/// profile messages and the warning's own go out unchanged.
pub fn with_caps(profiles: &Profiles, handle: &str, plaintext: &[u8]) -> Vec<u8> {
    let announces = matches!(
        serde_json::from_slice::<Value>(plaintext),
        Ok(Value::Object(fields))
            if matches!(fields.get("ty").and_then(Value::as_str), Some("text" | "grp" | "file"))
                && !fields.contains_key("prof")
    );
    // The envelope is compact JSON ending in `}`: the announcement goes in
    // as its last field, and the bytes before it stay as they were.
    match plaintext.strip_suffix(b"}") {
        Some(open) if announces => {
            let have = profiles.contacts.get(handle).map_or(0, |kept| kept.rev);
            let mut out = open.to_vec();
            out.extend_from_slice(
                format!(
                    r#","prof":{{"v":{PROFILE_V},"have":{have},"alert":{}}}}}"#,
                    crate::alert::ALERT_V
                )
                .as_bytes(),
            );
            out
        }
        _ => plaintext.to_vec(),
    }
}

/// Apply an edit of this identity's profile. `name`: `None` keeps the
/// current one. `photo`: `None` removes it, as before K12. `about`: `None`
/// keeps the current one, as callers from before K12 expect. Returns
/// whether anything changed; then the revision grows.
pub fn apply_update(
    inner: &mut InnerState,
    name: Option<String>,
    photo: Option<String>,
    about: Option<String>,
    now: i64,
) -> bool {
    let name = name
        .or_else(|| inner.handle.clone())
        .unwrap_or_else(|| "anon".to_string());
    let changed = inner.handle.as_deref() != Some(name.as_str())
        || inner.avatar != photo
        || about
            .as_ref()
            .is_some_and(|about| *about != inner.profiles.about);
    inner.handle = Some(name);
    inner.avatar = photo;
    if let Some(about) = about {
        inner.profiles.about.zeroize();
        inner.profiles.about = about;
    }
    if changed {
        inner.profiles.rev = next_rev(inner.profiles.rev, now);
    }
    changed
}

/// The contacts this identity's profile goes to: every contact whose Trino
/// reads profile messages, those a group brought and you accepted
/// included, but not blocked ones nor those a group brought and you did not
/// accept (UR-3, R-09). Each is marked as sent at this revision.
pub fn targets(inner: &mut InnerState) -> Vec<String> {
    let rev = inner.profiles.rev;
    let mut handles: Vec<String> = inner
        .friends
        .values()
        .filter(|friend| !crate::block::friend_blocked(inner, friend))
        // Nor to a contact a group made and you did not accept (UR-3, R-09).
        .filter(|friend| !crate::group_contacts::is_limited(friend))
        .filter(|friend| {
            inner
                .profiles
                .contacts
                .get(&friend.handle)
                .is_some_and(|kept| kept.caps >= PROFILE_V)
        })
        .map(|friend| friend.handle.clone())
        .collect();
    handles.sort();
    for handle in &handles {
        inner.profiles.sent.insert((handle.clone(), rev));
    }
    handles
}

/// What a receiver takes of `text`: the characters it allows (`allowed_char`),
/// trimmed and cut to `max` scalar values.
pub fn shareable(text: &str, line_breaks: bool, max: usize) -> String {
    let allowed: String = text
        .chars()
        .filter(|&c| allowed_char(c, line_breaks))
        .collect();
    let cut: String = allowed.trim().chars().take(max).collect();
    cut.trim_end().to_string()
}

/// This identity's profile message as it stands, as receivers take it. A
/// name from before K12 longer than the limit is cut to it, and a name or
/// an "about" saved before the rules on characters goes without what
/// receivers refuse ("anon" when nothing that shows is left); a photo from
/// before K12 that a profile cannot carry is left out, so contacts keep the
/// one in its code.
pub fn current_message(inner: &InnerState) -> Vec<u8> {
    let name = shareable(
        inner.handle.as_deref().unwrap_or_default(),
        false,
        NAME_MAX_CHARS,
    );
    let name = if readable_name(&name) {
        name
    } else {
        "anon".to_string()
    };
    let about = shareable(&inner.profiles.about, true, ABOUT_MAX_CHARS);
    let photo = match inner.avatar.as_deref() {
        None => PhotoField::Removed,
        Some(url) if valid_photo(url) => PhotoField::Set(url.to_string()),
        Some(_) => PhotoField::Unchanged,
    };
    profile_message(inner.profiles.rev, &name, &about, &photo)
}

/// Send this identity's profile to `targets`, one at a time. A failure is
/// only logged, and that contact's mark is taken back, so its next
/// announcement tries again.
pub async fn send_profile(state: &Engine, targets: Vec<String>) {
    let (message, rev) = {
        let inner = state.inner.lock().await;
        if inner.identity.is_none() {
            return;
        }
        (current_message(&inner), inner.profiles.rev)
    };
    for handle in targets {
        let sent: Result<(), String> = async {
            ensure_session_inner(state, &handle).await?;
            send_cipher_inner(state, &handle, &message).await
        }
        .await;
        if sent.is_err() {
            dbg_log("  profile not sent to a contact");
            state
                .inner
                .lock()
                .await
                .profiles
                .sent
                .remove(&(handle, rev));
        }
    }
}

/// A profile photo: `data:image/(jpeg|png|webp);base64,` and standard base64
/// of at most `PHOTO_MAX_BYTES` bytes.
pub fn valid_photo(url: &str) -> bool {
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
pub fn bounded_text(value: Option<&Value>, max: usize, non_empty: bool) -> Option<String> {
    let text = value?.as_str()?.trim();
    let chars = text.chars().count();
    (chars <= max && (chars > 0 || !non_empty)).then(|| text.to_string())
}

/// Every field a profile message v1 has. Any other makes it invalid: a new
/// field takes a new version.
pub const PROFILE_FIELDS: [&str; 6] = ["ty", "v", "rev", "name", "about", "photo"];

pub fn read_profile(fields: &Map<String, Value>) -> Result<ProfileMessage, Refused> {
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
    let name = bounded_text(fields.get("name"), NAME_MAX_CHARS, true)
        .filter(|name| readable_name(name))
        .ok_or(Refused::Name)?;
    let about = bounded_text(fields.get("about"), ABOUT_MAX_CHARS, false)
        .filter(|about| readable_about(about))
        .ok_or(Refused::About)?;
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

/// Handle one decrypted message from `handle` (see the module comment).
pub fn receive(profiles: &mut Profiles, handle: &str, plain: &[u8], created_at: i64) -> Received {
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
                resend: false,
            }
        }
        Some("text" | "grp" | "file") => {
            profiles.note_announcement(handle, fields.get("prof"), created_at)
        }
        _ => Received::default(),
    }
}

/// The key earlier versions seal profiles.bin with: HKDF of the identity,
/// apart from the history key. An account not moved to the store yet still
/// uses it.
pub fn profiles_key(identity: &Identity) -> std::io::Result<Zeroizing<[u8; 32]>> {
    crate::session::legacy_key(crate::crypto::hkdf_expand(
        &identity.ik_sign.priv_bytes,
        &[0u8; 32],
        PROFILES_KEY_INFO,
        32,
    ))
}

/// Move the profiles.bin at `path` aside, to `DAMAGED_PROFILES_FILE` next to
/// it, replacing any copy put there before.
pub fn put_aside(path: &Path) -> std::io::Result<()> {
    std::fs::rename(path, path.with_file_name(DAMAGED_PROFILES_FILE))
}

/// What an account not moved to the store yet has in its profiles.bin at
/// `path`, as the store would say it. One that does not decrypt (damaged,
/// or another identity's) is put aside first, as `DAMAGED_PROFILES_FILE`,
/// for whoever can still read it, and the session starts afresh; one that
/// cannot be read now, or put aside, is held.
pub fn legacy_found(path: &Path, identity: &Identity) -> Found {
    let blob = match std::fs::read(path) {
        Ok(blob) => blob,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Found::Absent,
        Err(_) => return Found::Held,
    };
    let Ok(key) = profiles_key(identity) else {
        return Found::Held;
    };
    match legacy_open(&key, &blob) {
        Some(json) => Found::Ready(json),
        None => match put_aside(path) {
            Ok(()) => Found::Absent,
            Err(_) => Found::Held,
        },
    }
}

/// Load the profiles unlocking found into the session that `open_session`
/// is opening. This identity's profile gets its first revision here, so
/// contacts that announce support get it without waiting for an edit.
///
/// Only profiles that are not there start afresh. Profiles that wait for
/// the user's choice, could not be read now, or open but do not read, stay
/// as they are: this session neither writes them nor lets this profile
/// change (`not_loaded`), and the next unlock reads them again.
pub fn load_found(inner: &mut InnerState, found: Found, now: i64) {
    let loaded = match found {
        Found::Ready(json) => {
            let profiles = serde_json::from_slice::<Profiles>(&json).ok();
            if profiles.is_none() {
                inner.storage.hold(&Slot::Profiles);
            }
            profiles
        }
        Found::Absent => Some(Profiles::default()),
        Found::Held => None,
    };
    let Some(profiles) = loaded else {
        dbg_log("the profiles could not be read: kept as they are");
        inner.profiles = Profiles {
            not_loaded: true,
            ..Profiles::default()
        };
        return;
    };
    inner.profiles = profiles;
    if inner.profiles.rev == 0 {
        inner.profiles.rev = now.max(1) as u64;
        save(inner);
    }
}

/// Save the profiles of the open session, sealed. Never over profiles this
/// session could not read (`load_found`).
pub fn try_save(inner: &InnerState) -> std::io::Result<()> {
    if inner.profiles.not_loaded {
        return Err(std::io::Error::other(
            "the profiles could not be read at unlock: they stay as they are",
        ));
    }
    let json = Zeroizing::new(serde_json::to_vec(&inner.profiles).map_err(std::io::Error::other)?);
    inner.storage.write_profiles(&json)
}

/// Whether this identity's profile can be edited now: not while this
/// session could not read its profiles, which hold its revision and its
/// "about". `io` then: the next unlock reads them again.
pub fn check_editable(profiles: &Profiles) -> Result<(), CommandError> {
    if profiles.not_loaded {
        return Err(CommandError::new(
            ErrorCode::Io,
            "the profiles could not be read at unlock",
        ));
    }
    Ok(())
}

/// `try_save`, where a failure is only logged: the next change writes
/// everything again.
pub fn save(inner: &InnerState) {
    if try_save(inner).is_err() {
        dbg_log("the profiles could not be saved");
    }
}

/// The hook in `handle_incoming_event`, just before the envelope is decoded.
/// Returns whether the message ends here (a profile message). The UI hears
/// of a profile that changed through `events`, and `resend` sends ours
/// again to a contact holding an older one.
pub fn on_message(
    events: &dyn EventSink,
    resend: &Resend,
    inner: &mut InnerState,
    handle: &str,
    plain: &[u8],
    created_at: i64,
) -> bool {
    let received = receive(&mut inner.profiles, handle, plain, created_at);
    if received.save {
        save(inner);
    }
    if received.notify {
        events.emit(
            "profile-updated",
            &ProfileUpdatedEvent {
                handle: handle.to_string(),
            },
        );
    }
    // A contact a group made and you did not accept never gets it (UR-3).
    if received.resend && !crate::group_contacts::handle_is_limited(inner, handle) {
        resend(vec![handle.to_string()]);
    }
    received.consumed
}

/// A contact's shared profile changed (K12): read the contacts again.
#[derive(Serialize, Clone)]
pub struct ProfileUpdatedEvent {
    pub handle: String,
}

/// Sends the profile again to the contacts given, without waiting: what
/// `on_message` does for a contact that asks for it. The host makes it
/// (the desktop app's sends it through its own `AppState`), since the
/// receive path holds the session's state, not the host.
pub type Resend = Arc<dyn Fn(Vec<String>) + Send + Sync>;

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

    /// What a name or an "about" may not hold: control characters (Cc),
    /// format characters (Cf) such as the bidi controls, zero-width spaces
    /// and tags, and the line and paragraph separators.
    const REFUSED_CHARS: [char; 17] = [
        '\u{0000}',
        '\u{0007}',
        '\t',
        '\r',
        '\u{0085}',
        '\u{00AD}',
        '\u{061C}',
        '\u{200B}',
        '\u{200E}',
        '\u{202A}',
        '\u{202E}',
        '\u{2066}',
        '\u{2069}',
        '\u{2028}',
        '\u{2029}',
        '\u{FEFF}',
        '\u{E0041}',
    ];

    /// Names with nothing that shows: a joiner, a Hangul filler, the blank
    /// Braille pattern, a variation selector, a grapheme joiner.
    const BLANK_NAMES: [&str; 6] = [
        "\u{200D}",
        "\u{3164}",
        "\u{2800}",
        "\u{FE0F}",
        "\u{115F}\u{1160}",
        "\u{034F}",
    ];

    #[test]
    fn a_name_or_about_with_control_format_or_bidi_characters_is_refused() {
        for c in REFUSED_CHARS {
            let code = c as u32;
            let name = format!("An{c}a");
            assert_eq!(
                parse_profile(&msg(1, &name, "", None)),
                Some(Err(Refused::Name)),
                "U+{code:04X} in a name"
            );
            let about = format!("Sobre{c}mí");
            assert_eq!(
                parse_profile(&msg(1, "Ana", &about, None)),
                Some(Err(Refused::About)),
                "U+{code:04X} in an about"
            );
        }
        // A line break is fine in an "about", which has three lines in
        // Settings, and nowhere else.
        let lines = parse_profile(&msg(1, "Ana", "Línea 1\nLínea 2", None));
        assert_eq!(lines.unwrap().unwrap().about, "Línea 1\nLínea 2");
        assert_eq!(
            parse_profile(&msg(1, "Ana\nLópez", "", None)),
            Some(Err(Refused::Name))
        );
        // The joiners stay: emoji such as 👩‍💻 and scripts such as Persian
        // need them.
        let joined = parse_profile(&msg(1, "Ana 👩\u{200D}💻", "می\u{200C}خواهم", None));
        assert_eq!(joined.unwrap().unwrap().name, "Ana 👩\u{200D}💻");
    }

    #[test]
    fn a_name_with_nothing_that_shows_is_refused() {
        for blank in BLANK_NAMES {
            assert_eq!(
                parse_profile(&msg(1, blank, "", None)),
                Some(Err(Refused::Name)),
                "{blank:?}"
            );
        }
        // Next to something that shows, they are fine.
        let filler = parse_profile(&msg(1, "Ana\u{3164}", "", None));
        assert_eq!(filler.unwrap().unwrap().name, "Ana\u{3164}");
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
                notify: true,
                resend: false
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

    /// Whether, in the receive path `body`, the profile hook takes a message
    /// and returns before anything decodes it as a chat envelope. Spaces and
    /// line breaks do not count.
    fn the_hook_comes_first(body: &str) -> bool {
        let code: String = body.split_whitespace().collect();
        let (Some(hook), Some(decoded)) = (
            code.find("ifprofile::on_message("),
            code.find("matchdecode_envelope(&plain)")
                .or_else(|| code.find("matchdecode_envelope(plain)")),
        ) else {
            return false;
        };
        hook < decoded
            && !code[..hook].contains("decode_envelope(")
            && code[hook..decoded].contains("){return;}")
    }

    #[test]
    fn handle_incoming_event_stops_at_a_profile_message_before_the_chat() {
        // `receive` only sees the profiles: whether a message it consumed
        // stays out of the history and of `message-received` depends on
        // where handle_incoming_event calls the hook. Merges move code around
        // there, and every other test would still pass with the hook below.
        let session = include_str!("session.rs").replace("\r\n", "\n");
        let start = session
            .find("async fn handle_incoming_event(")
            .expect("the receive path");
        // The receive path ends in `dispatch`, which decodes the envelope.
        let body = &session[start..];
        let dispatch = body.find("\nfn dispatch(").expect("its dispatch");
        let end = dispatch + body[dispatch..].find("\n}\n").expect("its end");
        let body = &body[..end];

        assert!(the_hook_comes_first(body));
        // The check sees the hook below the decoding, or one that does not
        // return.
        let hook = "if profile::on_message(&app, &mut inner, &h, &plain, at) {\n return;\n }";
        let decode = "match decode_envelope(&plain) {\n Envelope::Text { body, id } => {}\n }";
        assert!(the_hook_comes_first(&format!("{hook}\n{decode}")));
        assert!(!the_hook_comes_first(&format!("{decode}\n{hook}")));
        let ignored = hook
            .replace("if ", "let _ = ")
            .replace(" {\n return;\n }", ";");
        assert!(!the_hook_comes_first(&format!("{ignored}\n{decode}")));
        let early = format!("let early = decode_envelope(&plain);\n{hook}\n{decode}");
        assert!(!the_hook_comes_first(&early));
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
                notify: true,
                resend: false
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
                notify: true,
                resend: false
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

    /// CE-6 (design §7.2 step 1): whether the contact's Trino reads the
    /// warning to a trusted contact, from its newest message only.
    #[test]
    fn the_warning_to_a_trusted_contact_is_announced_in_prof_too() {
        let mut profiles = Profiles::default();
        let alert = |prof: &str| text_with(prof);
        receive(
            &mut profiles,
            "ana",
            &alert(r#","prof":{"v":1,"have":0,"alert":1}"#),
            NOW,
        );
        assert_eq!(profiles.contacts["ana"].alert, 1);
        let older = receive(
            &mut profiles,
            "ana",
            &alert(r#","prof":{"v":1,"have":0}"#),
            NOW + 1,
        );
        assert_eq!(profiles.contacts["ana"].alert, 0, "an older Trino again");
        assert!(older.save);
        for odd in [r#""alert":"1""#, r#""alert":-1"#, r#""alert":0"#] {
            let prof = format!(r#","prof":{{"v":1,"have":0,{odd}}}"#);
            receive(&mut profiles, "ana", &alert(&prof), NOW + 2);
            assert_eq!(profiles.contacts["ana"].alert, 0, "{odd}");
        }
        // A newer version of the warning still reads version 1.
        receive(
            &mut profiles,
            "ana",
            &alert(r#","prof":{"v":1,"have":0,"alert":2}"#),
            NOW + 3,
        );
        assert_eq!(profiles.contacts["ana"].alert, 2);
        // Without a valid `prof`, nothing is read: no profiles, no warning.
        receive(
            &mut profiles,
            "ana",
            &alert(r#","prof":{"have":0,"alert":1}"#),
            NOW + 4,
        );
        assert_eq!(profiles.contacts["ana"].alert, 0);
    }

    // ---- On disk and in memory ----

    /// The profiles of the store in `home`, as the next unlock reads them.
    fn reloaded(home: &Path) -> Profiles {
        match crate::store::session::testing::reopen(home).profiles {
            Found::Ready(json) => serde_json::from_slice(&json).unwrap(),
            _ => panic!("no profiles in the store"),
        }
    }

    /// The shortest run of bytes looked for in a sealed file. Sealed bytes
    /// look random, so a shorter one turns up in them by chance: "ana" or
    /// "rev" in the 4 KB this test seals, about once in 1,500 files (2 in
    /// 3,000 when measured for TOR-12), and this test once failed that way.
    /// An 8-byte one, about once in 10^12 files, even counting every piece
    /// of the plaintext.
    const SHORTEST_NEEDLE: usize = 8;

    /// Every run of `SHORTEST_NEEDLE` bytes in `raw`.
    fn pieces(raw: &[u8]) -> std::collections::HashSet<&[u8]> {
        raw.windows(SHORTEST_NEEDLE).collect()
    }

    /// Whether `needle` is in `raw`, byte for byte.
    fn holds(raw: &[u8], needle: &[u8]) -> bool {
        assert!(
            needle.len() >= SHORTEST_NEEDLE,
            "{:?} is too short to look for in sealed bytes",
            String::from_utf8_lossy(needle)
        );
        raw.windows(needle.len()).any(|window| window == needle)
    }

    #[test]
    fn profiles_are_sealed_in_the_store_and_come_back_on_reload() {
        // A contact's name here, long enough to look for (`SHORTEST_NEEDLE`).
        const ANA: &str = "ana-del-almacen";
        let scratch = ScratchDir::new("profiles-bin");
        let mut inner = InnerState {
            identity: Some(create_identity()),
            storage: crate::store::session::testing::store_cell(scratch.path()),
            ..InnerState::default()
        };
        inner.profiles = Profiles {
            about: "Mi secreto sobre mí".into(),
            rev: 12,
            ..Profiles::default()
        };
        let theirs = msg(5, "Ana Nombre", "Sobre Ana", Some(&photo(PNG)));
        receive(&mut inner.profiles, ANA, &theirs, NOW);
        receive(
            &mut inner.profiles,
            ANA,
            &text_with(r#","prof":{"v":1,"have":12}"#),
            NOW,
        );

        try_save(&inner).unwrap();

        let path = scratch.path().join("store").join(PROFILES_FILE);
        let raw = std::fs::read(&path).unwrap();
        for secret in [
            "Mi secreto",
            "Ana Nombre",
            "Sobre Ana",
            "iVBORw0KGgo",
            ANA,
            r#""rev":12"#,
        ] {
            assert!(!holds(&raw, secret.as_bytes()), "{secret} in the clear");
        }
        // Nor any other piece of what was sealed, field names included.
        let sealed = pieces(&raw);
        let plain = serde_json::to_vec(&inner.profiles).unwrap();
        for piece in plain.windows(SHORTEST_NEEDLE) {
            assert!(
                !sealed.contains(piece),
                "{:?} in the clear",
                String::from_utf8_lossy(piece)
            );
        }
        let back = reloaded(scratch.path());
        assert_eq!(back.about, "Mi secreto sobre mí");
        assert_eq!(back.rev, 12);
        assert_eq!(back.contacts[ANA], inner.profiles.contacts[ANA]);
    }

    #[test]
    fn the_profiles_key_is_not_the_history_key() {
        let me = create_identity();
        let key = profiles_key(&me).unwrap();
        assert_ne!(*key, *crate::session::derive_history_key(&me).unwrap());
        assert_ne!(*key, [0u8; 32]);
        assert_eq!(*key, *profiles_key(&me).unwrap(), "stable");
        assert_ne!(*key, *profiles_key(&create_identity()).unwrap());
    }

    #[test]
    fn opening_a_session_loads_the_profiles_and_gives_this_profile_a_first_revision() {
        let scratch = ScratchDir::new("profiles-open");
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: crate::store::session::testing::store_cell(scratch.path()),
            ..InnerState::default()
        };

        load_found(&mut inner, Found::Absent, NOW);

        assert_eq!(inner.profiles.rev, NOW as u64);
        assert_eq!(reloaded(scratch.path()).rev, NOW as u64, "saved");
        // Later sessions keep it.
        drop(inner);
        let mut again = InnerState {
            identity: Some(me),
            ..InnerState::default()
        };
        let found = crate::store::session::testing::reopen(scratch.path()).profiles;
        load_found(&mut again, found, NOW + 999);
        assert_eq!(again.profiles.rev, NOW as u64);
    }

    #[test]
    fn profiles_that_open_but_do_not_read_are_held_and_never_written() {
        let scratch = ScratchDir::new("profiles-held");
        let mut inner = InnerState {
            identity: Some(create_identity()),
            storage: crate::store::session::testing::store_cell(scratch.path()),
            ..InnerState::default()
        };

        load_found(
            &mut inner,
            Found::Ready(Zeroizing::new(b"[1,2]".to_vec())),
            NOW,
        );

        assert!(inner.profiles.not_loaded);
        assert!(try_save(&inner).is_err());
        assert!(inner.storage.write_profiles(b"{}").is_err(), "not held");
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
    fn what_this_profile_sent_follows_a_renamed_contact_and_goes_with_a_removed_one() {
        let mut profiles = Profiles::default();
        receive(&mut profiles, "ana", &msg(5, "Ana", "", None), NOW);
        profiles.sent.insert(("ana".into(), 4));
        profiles.sent.insert(("bob".into(), 4));

        profiles.rename("ana", "Anita");
        assert!(profiles.sent.contains(&("Anita".to_string(), 4)));
        assert!(!profiles.sent.contains(&("ana".to_string(), 4)));

        profiles.remove("Anita");
        assert!(!profiles.sent.iter().any(|(to, _)| to == "Anita"));
        assert!(
            profiles.sent.contains(&("bob".to_string(), 4)),
            "others stay"
        );
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

    // ---- Sending: the announcement in every text, group and file message ----

    use crate::envelope::{decode_envelope, encode_envelope, Envelope};
    use crate::group::FileRef;
    use crate::identity::public_bundle_for;
    use crate::state::FriendRecord;

    /// The envelope decoder of 0.1.0: a frozen copy of trino-core's
    /// `envelope.rs` at 1bac851, the core of that version. It reads what
    /// `with_caps` sends exactly as a 0.1.0 client will.
    mod compat_v010 {
        use serde::Deserialize;

        #[derive(Debug, PartialEq, Deserialize)]
        pub struct FileRef {
            pub url: String,
            pub key: String,
            pub sha256: String,
            pub mime: String,
            pub name: String,
            pub size: u64,
            #[serde(default)]
            pub thumb: Option<String>,
        }

        #[derive(Debug, PartialEq, Deserialize)]
        #[serde(tag = "ty")]
        pub enum Envelope {
            #[serde(rename = "text")]
            Text {
                body: String,
                #[serde(default)]
                id: String,
            },
            #[serde(rename = "grp")]
            Group { gid: String, ep: u64, body: String },
            #[serde(rename = "roster")]
            Roster { roster: serde_json::Value },
            #[serde(rename = "file")]
            File {
                file: FileRef,
                #[serde(default)]
                gid: Option<String>,
                #[serde(default)]
                body: Option<String>,
            },
            #[serde(rename = "call")]
            Call { call: String },
        }

        pub fn decode_envelope(plaintext: &[u8]) -> Envelope {
            let raw = String::from_utf8_lossy(plaintext).to_string();
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(ty) = val.get("ty").and_then(|v| v.as_str()) {
                    if matches!(ty, "text" | "grp" | "roster" | "file" | "call") {
                        if let Ok(env) = serde_json::from_value::<Envelope>(val) {
                            return env;
                        }
                    }
                }
            }
            Envelope::Text {
                body: raw,
                id: String::new(),
            }
        }
    }

    fn file_ref() -> FileRef {
        FileRef {
            url: "https://blossom.example/abc".into(),
            key: "11".repeat(32),
            sha256: "22".repeat(32),
            mime: "image/jpeg".into(),
            name: "foto.jpg".into(),
            size: 1234,
            thumb: None,
        }
    }

    /// Profiles holding revision `rev` of `handle`'s profile.
    fn holding(handle: &str, rev: u64) -> Profiles {
        let mut profiles = Profiles::default();
        profiles.contacts.insert(
            handle.to_string(),
            ContactProfile {
                rev,
                ..ContactProfile::default()
            },
        );
        profiles
    }

    #[test]
    fn text_group_and_file_messages_announce_support_and_what_is_held() {
        let text = encode_envelope(&Envelope::Text {
            body: "hola".into(),
            id: "m1".into(),
        });

        let announced = with_caps(&holding("ana", 7), "ana", &text);

        assert_eq!(
            String::from_utf8(announced).unwrap(),
            r#"{"ty":"text","body":"hola","id":"m1","prof":{"v":1,"have":7,"alert":1}}"#
        );
        let unknown = with_caps(&holding("ana", 7), "bob", &text);
        assert!(String::from_utf8(unknown)
            .unwrap()
            .ends_with(r#","prof":{"v":1,"have":0,"alert":1}}"#));
    }

    #[test]
    fn version_0_1_0_reads_announced_messages_as_the_same_messages() {
        let profiles = holding("ana", 3);
        let cases = [
            Envelope::Text {
                body: "hola \"ana\" ñ 🙂 }".into(),
                id: "m1".into(),
            },
            Envelope::Text {
                body: "sin id".into(),
                id: String::new(),
            },
            Envelope::Group {
                gid: "g1".into(),
                ep: 4,
                body: "hola grupo".into(),
            },
            Envelope::File {
                file: file_ref(),
                gid: None,
                body: None,
            },
            Envelope::File {
                file: file_ref(),
                gid: Some("g1".into()),
                body: Some("pie".into()),
            },
        ];
        for envelope in cases {
            let plain = encode_envelope(&envelope);
            let announced = with_caps(&profiles, "ana", &plain);
            assert_ne!(announced, plain, "{envelope:?} announces nothing");
            // 0.1.0 sees exactly what it saw before: never raw JSON.
            let old = compat_v010::decode_envelope(&announced);
            assert_eq!(old, compat_v010::decode_envelope(&plain), "{envelope:?}");
            assert!(
                !matches!(&old, compat_v010::Envelope::Text { body, .. } if body.contains("\"prof\"")),
                "{envelope:?} shows as JSON on 0.1.0"
            );
            // This version too, and it records the announcement.
            assert_eq!(decode_envelope(&announced), envelope);
            let mut receiver = Profiles::default();
            receive(&mut receiver, "me", &announced, NOW);
            assert_eq!(receiver.contacts["me"].caps, PROFILE_V);
            assert_eq!(receiver.contacts["me"].have, 3);
            // And that it reads the warning to a trusted contact (CE-6).
            assert_eq!(receiver.contacts["me"].alert, crate::alert::ALERT_V);
        }
    }

    #[test]
    fn calls_rosters_handshakes_and_profiles_go_out_unchanged() {
        let profiles = holding("ana", 3);
        let call = encode_envelope(&Envelope::Call {
            call: r#"{"type":"bye"}"#.into(),
        });
        for plain in [
            call,
            br#"{"ty":"roster","roster":{"groupId":"g1"}}"#.to_vec(),
            b"__trino_handshake__".to_vec(),
            profile_message(5, "Ana", "", &PhotoField::Removed),
            b"texto viejo sin sobre".to_vec(),
            text_with(r#","prof":{"v":1,"have":1}"#),
        ] {
            assert_eq!(with_caps(&profiles, "ana", &plain), plain);
        }
    }

    // ---- Sending: the profile message ----

    #[test]
    fn the_profile_message_has_fixed_bytes() {
        let full = profile_message(1_760_000_000, "Ana", "Hola", &PhotoField::Set(PNG.into()));
        assert_eq!(
            String::from_utf8(full).unwrap(),
            format!(
                r#"{{"ty":"profile","v":1,"rev":1760000000,"name":"Ana","about":"Hola","photo":"{PNG}"}}"#
            )
        );
        assert_eq!(
            String::from_utf8(profile_message(2, "Ana", "", &PhotoField::Removed)).unwrap(),
            r#"{"ty":"profile","v":1,"rev":2,"name":"Ana","about":"","photo":null}"#
        );
        assert_eq!(
            String::from_utf8(profile_message(
                3,
                "Ñandú \"A\"",
                "🙂",
                &PhotoField::Unchanged
            ))
            .unwrap(),
            r#"{"ty":"profile","v":1,"rev":3,"name":"Ñandú \"A\"","about":"🙂"}"#
        );
    }

    #[test]
    fn a_profile_message_reads_back_as_itself() {
        for photo in [
            PhotoField::Set(PNG.into()),
            PhotoField::Removed,
            PhotoField::Unchanged,
        ] {
            let sent = profile_message(8, "Ana", "Sobre mí", &photo);
            assert_eq!(
                parse_profile(&sent),
                Some(Ok(ProfileMessage {
                    rev: 8,
                    name: "Ana".into(),
                    about: "Sobre mí".into(),
                    photo,
                }))
            );
        }
    }

    // ---- Sending: who gets it, and when ----

    fn friend(handle: &str) -> FriendRecord {
        FriendRecord {
            handle: handle.to_string(),
            bundle: public_bundle_for(&create_identity()),
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
    fn the_profile_goes_to_every_contact_that_reads_it_and_to_nobody_else() {
        let mut inner = InnerState::default();
        let mut carol = friend("carol");
        carol.via_group = Some("g1".into());
        let dan = friend("dan");
        inner
            .blocked
            .insert(crate::block::BlockedIdentity::before_ur2(
                dan.bundle.nostr_pub.clone(),
                None,
                0,
            ));
        for contact in [friend("ana"), friend("bob"), carol, dan, friend("eva")] {
            inner.friends.insert(contact.handle.clone(), contact);
        }
        for (handle, caps) in [("ana", 1), ("bob", 0), ("carol", 1), ("dan", 1)] {
            inner.profiles.contacts.insert(
                handle.into(),
                ContactProfile {
                    caps,
                    ..ContactProfile::default()
                },
            );
        }
        inner.profiles.rev = 4;

        let targets = targets(&mut inner);

        // Not bob nor eva (older versions: they would see JSON), not dan
        // (blocked); carol came with a group and gets it too.
        assert_eq!(targets, ["ana", "carol"]);
        assert!(inner.profiles.sent.contains(&("ana".to_string(), 4)));
        assert!(inner.profiles.sent.contains(&("carol".to_string(), 4)));
    }

    #[test]
    fn a_contact_behind_on_this_profile_gets_it_again_once_per_revision() {
        let mut profiles = Profiles {
            rev: 10,
            ..Profiles::default()
        };
        let behind = |have: u64| text_with(&format!(r#","prof":{{"v":1,"have":{have}}}"#));

        assert!(receive(&mut profiles, "ana", &behind(3), NOW).resend);
        assert!(
            !receive(&mut profiles, "ana", &behind(3), NOW + 1).resend,
            "once per session and revision"
        );
        assert!(
            !receive(&mut profiles, "ana", &behind(10), NOW + 2).resend,
            "up to date"
        );
        assert!(
            receive(&mut profiles, "bob", &behind(0), NOW).resend,
            "per contact"
        );
        assert!(
            !receive(&mut profiles, "eva", &text_with(""), NOW).resend,
            "never to an older version"
        );

        profiles.rev = 11;
        assert!(
            receive(&mut profiles, "ana", &behind(10), NOW + 3).resend,
            "a new revision"
        );
    }

    #[test]
    fn a_contact_the_profile_just_went_to_is_not_sent_it_again() {
        let mut inner = InnerState::default();
        inner.friends.insert("ana".into(), friend("ana"));
        inner.profiles.rev = 4;
        receive(
            &mut inner.profiles,
            "ana",
            &text_with(r#","prof":{"v":1,"have":4}"#),
            NOW,
        );
        inner.profiles.rev = 5;

        assert_eq!(targets(&mut inner), ["ana"]);

        // Sent before ours arrived: still behind, but already on its way.
        let behind = text_with(r#","prof":{"v":1,"have":4}"#);
        assert!(!receive(&mut inner.profiles, "ana", &behind, NOW + 1).resend);
        // Had that send failed, the mark is taken back and this one sends.
        inner.profiles.sent.remove(&("ana".to_string(), 5));
        assert!(receive(&mut inner.profiles, "ana", &behind, NOW + 2).resend);
    }

    #[test]
    fn this_profile_message_cuts_an_old_name_and_leaves_out_a_photo_it_cannot_carry() {
        let long = "n".repeat(NAME_MAX_CHARS + 10);
        let mut inner = InnerState {
            handle: Some(format!("  {long}  ")),
            avatar: Some("data:image/gif;base64,R0lGODlh".into()),
            ..InnerState::default()
        };
        inner.profiles.rev = 6;
        inner.profiles.about = "Hola".into();

        let message = parse_profile(&current_message(&inner)).unwrap().unwrap();

        assert_eq!(message.name, "n".repeat(NAME_MAX_CHARS));
        assert_eq!(
            message.photo,
            PhotoField::Unchanged,
            "they keep the photo of the code"
        );
        assert_eq!((message.rev, message.about.as_str()), (6, "Hola"));

        inner.avatar = Some(PNG.into());
        let with_photo = parse_profile(&current_message(&inner)).unwrap().unwrap();
        assert_eq!(with_photo.photo, PhotoField::Set(PNG.into()));
        inner.avatar = None;
        let without = parse_profile(&current_message(&inner)).unwrap().unwrap();
        assert_eq!(without.photo, PhotoField::Removed);
    }

    // ---- Editing this identity's profile ----

    #[test]
    fn the_revision_only_grows_and_only_when_something_changed() {
        let mut inner = InnerState {
            handle: Some("Ana".into()),
            ..InnerState::default()
        };
        inner.profiles.rev = NOW as u64 + 50;

        assert!(!apply_update(
            &mut inner,
            Some("Ana".into()),
            None,
            None,
            NOW
        ));
        assert_eq!(inner.profiles.rev, NOW as u64 + 50);

        assert!(apply_update(
            &mut inner,
            Some("Ana M".into()),
            None,
            None,
            NOW
        ));
        assert_eq!(
            inner.profiles.rev,
            NOW as u64 + 51,
            "the previous + 1, when the clock is behind"
        );
        assert_eq!(inner.handle.as_deref(), Some("Ana M"));

        assert!(apply_update(
            &mut inner,
            None,
            Some(PNG.into()),
            None,
            NOW + 500
        ));
        assert_eq!(inner.profiles.rev, NOW as u64 + 500, "or the clock");
        assert_eq!(inner.avatar.as_deref(), Some(PNG));

        let about = Some("Hola".to_string());
        assert!(apply_update(
            &mut inner,
            None,
            Some(PNG.into()),
            about.clone(),
            NOW + 500
        ));
        assert_eq!(inner.profiles.about, "Hola");
        assert_eq!(inner.profiles.rev, NOW as u64 + 501);
        assert!(!apply_update(
            &mut inner,
            None,
            Some(PNG.into()),
            about,
            NOW + 900
        ));
        assert_eq!(next_rev(u64::MAX, NOW), u64::MAX, "never wraps around");
    }

    #[test]
    fn without_about_the_update_works_as_before() {
        let mut inner = InnerState {
            handle: Some("Ana".into()),
            ..InnerState::default()
        };
        inner.profiles.about = "Se queda".into();

        // A blank name keeps the current one, and no `about` keeps it too.
        apply_update(&mut inner, None, Some(PNG.into()), None, NOW);
        assert_eq!(inner.handle.as_deref(), Some("Ana"));
        assert_eq!(inner.avatar.as_deref(), Some(PNG));
        assert_eq!(inner.profiles.about, "Se queda");

        // No photo removes it, as before.
        apply_update(&mut inner, None, None, None, NOW);
        assert_eq!(inner.avatar, None);
        // An empty "about" clears it.
        apply_update(&mut inner, None, None, Some(String::new()), NOW);
        assert_eq!(inner.profiles.about, "");
    }

    #[test]
    fn an_edit_over_the_limits_is_profile_invalid() {
        let long_name = "a".repeat(NAME_MAX_CHARS + 1);
        let long_about = "🙂".repeat(ABOUT_MAX_CHARS + 1);
        let big_photo = jpeg_of(PHOTO_MAX_BYTES + 1);
        let gif = "data:image/gif;base64,R0lGODlh".to_string();
        for error in [
            check_name(&long_name, None).unwrap_err(),
            check_about(&long_about).unwrap_err(),
            check_photo(Some(big_photo), None).unwrap_err(),
            check_photo(Some(gif), None).unwrap_err(),
        ] {
            assert_eq!(error.code, ErrorCode::ProfileInvalid);
        }
        assert_eq!(check_name("  Ana  ", None).unwrap().as_deref(), Some("Ana"));
        assert_eq!(
            check_name(&"ñ".repeat(NAME_MAX_CHARS), None)
                .unwrap()
                .unwrap()
                .chars()
                .count(),
            NAME_MAX_CHARS
        );
        assert_eq!(check_name("   ", None).unwrap(), None);
        assert_eq!(check_about("  Hola \n").unwrap(), "Hola");
        assert_eq!(
            check_about(&"🙂".repeat(ABOUT_MAX_CHARS))
                .unwrap()
                .chars()
                .count(),
            ABOUT_MAX_CHARS
        );
        assert_eq!(check_photo(None, Some(PNG)).unwrap(), None);
        assert_eq!(
            check_photo(Some(PNG.into()), None).unwrap().as_deref(),
            Some(PNG)
        );
    }

    #[test]
    fn a_photo_saved_before_profiles_can_stay_while_the_rest_changes() {
        // Before profiles a photo could be a GIF or up to 128 KiB. Saving the
        // name or the "about" sends the same photo back: it stays here, and
        // `current_message` leaves it out of what contacts get.
        let old = jpeg_of(PHOTO_MAX_BYTES + 1);
        let kept = check_photo(Some(old.clone()), Some(&old)).unwrap();
        assert_eq!(kept.as_deref(), Some(old.as_str()));
        let gif = "data:image/gif;base64,R0lGODlh".to_string();
        assert_eq!(
            check_photo(Some(gif.clone()), Some(&gif)).unwrap(),
            Some(gif)
        );
        // A new photo over the limits is still refused.
        let error = check_photo(Some(jpeg_of(PHOTO_MAX_BYTES + 2)), Some(&old)).unwrap_err();
        assert_eq!(error.code, ErrorCode::ProfileInvalid);
    }

    #[test]
    fn the_name_already_saved_can_stay_while_the_rest_changes() {
        // Names from before profiles had no limit. Saving the photo or the
        // "about" sends the same name back: it stays here, and
        // `current_message` gives contacts what they take of it.
        let old = "n".repeat(NAME_MAX_CHARS + 6);
        for sent in [old.clone(), format!("  {old} ")] {
            let kept = check_name(&sent, Some(&old)).unwrap();
            assert_eq!(kept.as_deref(), Some(old.as_str()));
        }
        let bidi = "Ana\u{202E}zepóL";
        assert_eq!(check_name(bidi, Some(bidi)).unwrap().as_deref(), Some(bidi));
        // A new name over the limits is still refused.
        for new in ["m".repeat(NAME_MAX_CHARS + 6), format!("{old}x")] {
            let error = check_name(&new, Some(&old)).unwrap_err();
            assert_eq!(error.code, ErrorCode::ProfileInvalid);
        }
    }

    #[test]
    fn an_edit_with_control_format_or_bidi_characters_is_profile_invalid() {
        for c in REFUSED_CHARS {
            let code = c as u32;
            let name = check_name(&format!("An{c}a"), Some("Ana"));
            assert_eq!(
                name.unwrap_err().code,
                ErrorCode::ProfileInvalid,
                "U+{code:04X} in a name"
            );
            let about = check_about(&format!("Sobre{c}mí"));
            assert_eq!(
                about.unwrap_err().code,
                ErrorCode::ProfileInvalid,
                "U+{code:04X} in an about"
            );
        }
        for blank in BLANK_NAMES {
            let error = check_name(blank, Some("Ana")).unwrap_err();
            assert_eq!(error.code, ErrorCode::ProfileInvalid, "{blank:?}");
        }
        assert!(check_name("Ana\nLópez", None).is_err());
        assert_eq!(
            check_about(" Línea 1\nLínea 2 ").unwrap(),
            "Línea 1\nLínea 2"
        );
        assert_eq!(
            check_name("Ana 👩\u{200D}💻", None).unwrap().as_deref(),
            Some("Ana 👩\u{200D}💻")
        );
    }

    #[test]
    fn this_profile_message_leaves_out_what_receivers_refuse() {
        // A name from before profiles, and an "about" saved before these
        // rules, may hold what receivers refuse: the message never does.
        let mut inner = InnerState {
            handle: Some("Ana\u{202E} Ló\u{7}pez".into()),
            ..InnerState::default()
        };
        inner.profiles.rev = 6;
        inner.profiles.about = "Hola\u{2066} mundo\t\nfin".into();

        let message = parse_profile(&current_message(&inner)).unwrap().unwrap();

        assert_eq!(message.name, "Ana López");
        assert_eq!(message.about, "Hola mundo\nfin");
        inner.handle = Some("\u{3164}\u{200B}".into());
        let blank = parse_profile(&current_message(&inner)).unwrap().unwrap();
        assert_eq!(blank.name, "anon");
    }

    #[test]
    fn locking_also_forgets_what_was_sent_this_session() {
        let mut profiles = Profiles::default();
        profiles.sent.insert(("ana".into(), 3));
        profiles.forget();
        assert!(profiles.sent.is_empty());
    }

    /// The value of `export const <name> = <integers multiplied>;` in the
    /// TypeScript `source`, as src/lib writes its constants.
    fn ts_constant(source: &str, name: &str) -> Option<usize> {
        let declaration = format!("export const {name} = ");
        let value = source
            .lines()
            .find_map(|line| line.trim().strip_prefix(declaration.as_str()))?;
        value
            .trim_end()
            .strip_suffix(';')?
            .split('*')
            .map(|factor| factor.trim().replace('_', "").parse::<usize>().ok())
            .product()
    }

    #[test]
    fn the_photo_limit_is_the_one_the_app_makes_photos_for() {
        // makeAvatar (src/lib/avatar.ts) shrinks a photo until it fits in
        // AVATAR_MAX_BYTES. Above PHOTO_MAX_BYTES every larger photo it made
        // would be profile_invalid; below it, photos would be smaller than
        // they can be. The two must not drift.
        let avatar = include_str!("../../../src/lib/avatar.ts");
        assert_eq!(
            ts_constant(avatar, "AVATAR_MAX_BYTES"),
            Some(PHOTO_MAX_BYTES)
        );
        // The reader tells other values, and no value, apart.
        let drifted = "export const AVATAR_MAX_BYTES = 24 * 1024;";
        assert_eq!(ts_constant(drifted, "AVATAR_MAX_BYTES"), Some(24 * 1024));
        assert_eq!(
            ts_constant("const AVATAR_MAX_BYTES = 1;", "AVATAR_MAX_BYTES"),
            None
        );
    }

    /// Relays drop events over 64 KB without a word (trino-rediseno.md, on
    /// stickers). This leaves 4 KB for relays that count otherwise.
    const RELAY_FRAME_BUDGET: usize = 60 * 1024;

    #[test]
    fn the_largest_profile_message_fits_in_a_relay_event() {
        // The worst case a receiver takes: a name and an "about" of
        // characters four bytes long in UTF-8, the largest photo and the
        // largest revision. JSON writes nothing longer, but for the control
        // characters it escapes to six bytes, which names and "about"s may
        // not hold. A message made of those still fits: it bounds them all.
        let photo = PhotoField::Set(jpeg_of(PHOTO_MAX_BYTES));
        let largest = profile_message(
            u64::MAX,
            &"🙂".repeat(NAME_MAX_CHARS),
            &"🙂".repeat(ABOUT_MAX_CHARS),
            &photo,
        );
        assert!(parse_profile(&largest).unwrap().is_ok());
        let escaped = profile_message(
            u64::MAX,
            &"\u{1}".repeat(NAME_MAX_CHARS),
            &"\u{1}".repeat(ABOUT_MAX_CHARS),
            &photo,
        );
        assert_eq!(parse_profile(&escaped), Some(Err(Refused::Name)));

        for plain in [largest, escaped] {
            let frame = relay_frame_bytes(&plain);
            assert!(frame <= RELAY_FRAME_BUDGET, "{frame} bytes on the wire");
        }
    }

    /// `plain` sealed as send_cipher_inner seals it under P1 (a profile at
    /// its 40 KiB step), as a relay receives it.
    fn relay_frame_bytes(plain: &[u8]) -> usize {
        let (mut ana, _bea) = crate::p1::tests::talking(true);
        let (step, kind) = crate::session::step_for(plain);
        let event = crate::p1::seal(
            &mut ana.inner,
            "bea",
            plain,
            step,
            kind,
            crate::p1::tests::NOW,
        )
        .unwrap();
        crate::session::event_frame_bytes(&event)
    }

    /// The JSON object on a line of the doc: from its first `{` to its last `}`.
    fn json_on(line: &str) -> Option<String> {
        let start = line.find('{')?;
        let end = line.rfind('}')?;
        Some(line[start..=end].to_string())
    }

    #[test]
    fn the_vectors_in_the_doc_hold() {
        let doc = include_str!("../../../docs/perfil-v1.md");

        // What the rules refuse, and what shows nothing by itself but white
        // space and the joiners of emoji, is written as a `\u` escape: the
        // doc reads the same in any viewer, and nothing in it reorders text.
        let unseen = |c: char| {
            shows_nothing(c) && !c.is_whitespace() && !matches!(c, '\u{200C}' | '\u{200D}')
        };
        let raw: Vec<String> = doc
            .chars()
            .filter(|&c| c != '\r' && (!allowed_char(c, true) || unseen(c)))
            .map(|c| format!("U+{:04X}", c as u32))
            .collect();
        assert!(raw.is_empty(), "written as they are: {raw:?}");

        // The announcement: each `in` line becomes the `out` line below it.
        let lines: Vec<&str> = doc.lines().collect();
        let mut pairs = 0;
        for pair in lines.windows(2) {
            let (Some(input), Some(output)) =
                (pair[0].strip_prefix("in "), pair[1].strip_prefix("out "))
            else {
                continue;
            };
            let have: u64 = input
                .rsplit("have = ")
                .next()
                .and_then(|rest| rest.trim().trim_end_matches(')').parse().ok())
                .unwrap();
            let announced = with_caps(
                &holding("ana", have),
                "ana",
                json_on(input).unwrap().as_bytes(),
            );
            assert_eq!(
                String::from_utf8(announced).unwrap(),
                json_on(output).unwrap()
            );
            pairs += 1;
        }
        assert_eq!(pairs, 2);

        // The vectors: the first block reads and encodes back byte for byte,
        // and nothing in the second one is ever taken.
        let vectors = doc.split("## Vectors").nth(1).unwrap();
        let blocks: Vec<&str> = vectors.split("```").skip(1).step_by(2).collect();
        let valid: Vec<String> = blocks[0].lines().filter_map(json_on).collect();
        let invalid: Vec<String> = blocks[1].lines().filter_map(json_on).collect();
        assert_eq!((valid.len(), invalid.len()), (4, 15));
        for line in &valid {
            let message = parse_profile(line.as_bytes()).unwrap().unwrap();
            let again = profile_message(message.rev, &message.name, &message.about, &message.photo);
            assert_eq!(String::from_utf8(again).unwrap(), *line);
        }
        for line in &invalid {
            assert!(
                matches!(parse_profile(line.as_bytes()), Some(Err(_))),
                "{line}"
            );
        }
    }

    // ---- M4-0b: what the hook tells, through the engine's sink ----

    #[test]
    fn the_hook_tells_the_ui_through_its_sink_and_resends_through_its_resend() {
        let sink = crate::events::RecordingSink::new();
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let resend: Resend = {
            let asked = std::sync::Arc::clone(&asked);
            std::sync::Arc::new(move |targets| asked.lock().unwrap().push(targets))
        };
        let mut inner = InnerState::default();
        inner.profiles.rev = 10;

        // A newer profile of ana's: kept, and the UI reads the contacts again.
        let profile = msg(5, "Ana", "Hola", None);
        assert!(on_message(
            &*sink, &resend, &mut inner, "ana", &profile, NOW
        ));
        // A text from bob, who holds an older profile of ours: it goes again.
        let behind = text_with(r#","prof":{"v":1,"have":3}"#);
        assert!(!on_message(
            &*sink, &resend, &mut inner, "bob", &behind, NOW
        ));

        assert_eq!(
            sink.events(),
            [
                (
                    "profile-updated".to_string(),
                    r#"{"handle":"ana"}"#.to_string()
                ),
                (
                    "profile-updated".to_string(),
                    r#"{"handle":"bob"}"#.to_string()
                ),
            ]
        );
        assert_eq!(*asked.lock().unwrap(), [vec!["bob".to_string()]]);
    }

    // ---- M4-0c: from the app, now that the account's files are here ----

    #[test]
    fn a_legacy_profiles_bin_that_does_not_decrypt_is_kept_aside_and_a_new_one_started() {
        let scratch = ScratchDir::new("profiles-damaged");
        let path = scratch.path().join(PROFILES_FILE);
        // Damaged, or another identity's: no key here opens it.
        let damaged = b"a nonce, then a ciphertext that no key here opens".to_vec();
        std::fs::write(&path, &damaged).unwrap();
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: legacy_cell(scratch.path(), &me),
            ..InnerState::default()
        };

        let found = legacy_found(&path, &me);
        load_found(&mut inner, found, NOW);

        // Its bytes stay, for whoever can still read them,
        let aside = scratch.path().join(DAMAGED_PROFILES_FILE);
        assert_eq!(std::fs::read(&aside).unwrap(), damaged);
        // and the session goes on with a new profiles.bin, sealed as
        // earlier versions seal it.
        assert!(!inner.profiles.not_loaded);
        assert_eq!(inner.profiles.rev, NOW as u64);
        let Found::Ready(json) = legacy_found(&path, &me) else {
            panic!("not saved")
        };
        let saved: Profiles = serde_json::from_slice(&json).unwrap();
        assert_eq!(saved.rev, NOW as u64);
    }

    #[test]
    fn a_legacy_profiles_bin_that_cannot_be_read_is_kept_and_never_written() {
        let scratch = ScratchDir::new("profiles-unreadable");
        // A directory where profiles.bin should be: reading it fails, and
        // not because it is missing, as a file another program holds would.
        let path = scratch.path().join(PROFILES_FILE);
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inside"), b"keep").unwrap();
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: legacy_cell(scratch.path(), &me),
            ..InnerState::default()
        };

        let found = legacy_found(&path, &me);
        load_found(&mut inner, found, NOW);

        assert!(inner.profiles.not_loaded);
        assert_eq!(inner.profiles.rev, 0, "no first revision over the old one");
        assert!(!scratch.path().join(DAMAGED_PROFILES_FILE).exists());
        // This session never writes profiles.bin, and the profile cannot be
        // edited: its revision would go back.
        assert!(try_save(&inner).is_err());
        let error = check_editable(&inner.profiles).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(std::fs::read(path.join("inside")).unwrap(), b"keep");
        // Locking forgets that, with the rest.
        inner.profiles.forget();
        assert!(!inner.profiles.not_loaded);
    }

    /// The files of an account not moved to the store yet, in `home`.
    fn legacy_cell(home: &Path, me: &Identity) -> crate::store::session::StorageCell {
        let files = crate::account::DataFiles::in_home(home.to_path_buf());
        let cell = crate::store::session::StorageCell::default();
        cell.set(crate::store::session::Storage::Legacy(Box::new(
            crate::storage::legacy_files(&files, me).unwrap(),
        )));
        cell
    }
}
