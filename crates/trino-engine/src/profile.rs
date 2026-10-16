//! The shared profiles (W8, K12) as the session keeps them: this
//! identity's "about" and revision, what each contact shares and announced,
//! and how a profile message or an announcement received changes them. The
//! rules a profile message must pass, sending, and profiles.bin are the
//! app's profile.rs; docs/perfil-v1.md fixes the bytes.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use zeroize::Zeroize;

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
