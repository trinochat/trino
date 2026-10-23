//! The warning to a trusted contact (clave de emergencia CE-6, design §7.2;
//! CE-D4: the contact accepts first).
//!
//! **Whoever sets it** (Settings › Clave de emergencia › Qué pasa en la red):
//!
//! 1. chooses a contact whose Trino reads the warning: it says so in its
//!    messages' `prof` (`"alert":1`, profile.rs), as the profiles do;
//! 2. Trino makes `alert_key` (32 random bytes) and `alert_id` (16) and
//!    sends `{"ty":"alert-reg","v":1,"id":…,"k":…}` through the ratchet;
//! 3. the contact's Trino asks, and answers `alert-ack` with the relays it
//!    reads (up to 5) when the person accepted;
//! 4. accepted, the key, the id, those relays and the optional message go
//!    to the vault's shared block (`SharedAlert`), where the emergency path
//!    finds them (step E2). Never the contact's name or keys: whoever opens
//!    the block with the emergency key and an old copy of the vault does not
//!    learn who it is (§7.6). The store keeps who it is (`OwnAlert`).
//!
//! Choosing "Ninguna", another contact, or removing the emergency key sends
//! `{"ty":"alert-reg","v":1,"id":…,"off":true}` to the contact chosen
//! before, whose Trino closes that registration (§8.5).
//!
//! **The contact**: the question waits, one per contact, and a new
//! registration replaces the one pending (RC-10). Accepted, its Trino
//! listens to the registration's mailboxes, on connections of their own and
//! never the one its Nostr key subscribes on (RC-07, `watch`). A warning
//! comes once per registration; the ones after it are ignored.
//!
//! None of these is a message: no history, no `message-received`, on either
//! side (test 42). A contact whose Trino does not announce the warning never
//! gets one, since 0.1.0 shows an envelope it does not know as raw JSON.
//!
//! **The mailbox** (§7.2), one a day, so a relay sees no fixed address:
//!
//! ```text
//! s_e      = HKDF-SHA256(alert_key, info = "trino/alert/v1/epoch" ‖ e u32 BE)   e = UTC day
//! sk_e     = HKDF-SHA256(s_e, info = "mbox"), a secp256k1 scalar
//! mailbox  = x-only(sk_e · G), the `p` of the warning
//! k_e      = HKDF-SHA256(s_e, info = "enc")
//! ```
//!
//! The warning is an event of kind 4848 signed with a key of one use, never
//! an identity's, addressed to today's mailbox, with an `expiration` 6 to 8
//! days ahead, and as content `nonce ‖ AES-256-GCM(k_e, "trino/alert/v1" ‖
//! alert_id ‖ time u64 BE ‖ length u16 BE ‖ message ‖ zeros)`, padded to
//! `PADDED_LEN` and in base64. Its associated data is the label and the
//! mailbox. The contact listens to yesterday's, today's and tomorrow's
//! mailboxes, for clocks that are off. With P1 it becomes a 1059 like the
//! rest (§7.4).

use crate::command_error::{CommandError, ErrorCode};
use crate::crypto::{aes_gcm_decrypt, aes_gcm_encrypt, hkdf_expand, random_array};
use crate::events::EventSink;
use crate::nostr::{build_and_sign_event, NostrEvent, TRINO_KIND};
use crate::state::{FriendRecord, InnerState};
use crate::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zeroize::{Zeroize, Zeroizing};

/// The version of the warning's messages this Trino reads and sends, and
/// what it announces in `prof` (`"alert":1`).
pub const ALERT_V: u64 = 1;
/// The longest message, in Unicode scalar values (design §11.3).
pub const MAX_MESSAGE_CHARS: usize = 280;
/// The most relays an acceptance names (design §7.2 step 3).
pub const MAX_CONTACT_RELAYS: usize = 5;
/// The room those relays take in the JSON of the shared block.
const CONTACT_RELAYS_ROOM: usize = 512;
/// The longest relay URL taken.
const MAX_RELAY_URL: usize = 200;
const LABEL: &[u8] = b"trino/alert/v1";
const EPOCH_INFO: &[u8] = b"trino/alert/v1/epoch";
/// What the content is padded to: the label, the id, the time, the length
/// and the longest message (280 scalar values of 4 bytes), rounded up.
pub const PADDED_LEN: usize = 1280;
/// A mailbox lasts a UTC day.
pub const EPOCH_SECS: i64 = 86_400;
/// The warning expires (NIP-40) 6 to 8 days after it is made (P1 D6).
const MIN_EXPIRATION_SECS: i64 = 6 * EPOCH_SECS;
const MAX_EXPIRATION_SECS: i64 = 8 * EPOCH_SECS;
/// The class of traffic of the warning's connections (Tor design §2.7):
/// its own circuits, apart from the relays' of the session.
pub const ALERT_ISO: trino_net::IsoKind = trino_net::IsoKind::new("alert");
/// What the UI hears when a registration of either side changed, with the
/// contact's name: the question, the answer, a withdrawal or a warning.
pub const ALERT_EVENT: &str = "emergency-alert";

/// A message of the warning, as it travels through the ratchet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Wire {
    /// "Do you accept my warning?", with the registration's id and key, in
    /// lowercase hex.
    Reg { id: String, key: String },
    /// The registration `id` no longer holds.
    Off { id: String },
    /// The answer to `id`; accepted, with the relays the contact reads.
    Ack {
        id: String,
        ok: bool,
        relays: Vec<String>,
    },
}

/// What a decrypted message is to the warning.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Read {
    /// Not one of its messages: it goes on as before.
    NotAlert,
    /// One of its types that breaks a rule: dropped in silence, and never
    /// shown as text.
    Invalid,
    Wire(Wire),
}

/// Read a decrypted message.
pub fn read(plain: &[u8]) -> Read {
    let Ok(Value::Object(fields)) = serde_json::from_slice::<Value>(plain) else {
        return Read::NotAlert;
    };
    let wire = match fields.get("ty").and_then(Value::as_str) {
        Some("alert-reg") => read_reg(&fields),
        Some("alert-ack") => read_ack(&fields),
        _ => return Read::NotAlert,
    };
    wire.map_or(Read::Invalid, Read::Wire)
}

/// Whether `fields` are among `allowed`, and of version `ALERT_V`. A new
/// field takes a new version.
fn shaped(fields: &Map<String, Value>, allowed: &[&str]) -> bool {
    fields.get("v").and_then(Value::as_u64) == Some(ALERT_V)
        && fields.keys().all(|key| allowed.contains(&key.as_str()))
}

/// `value`, if it is `len` bytes in lowercase hex.
fn hex_field(value: Option<&Value>, len: usize) -> Option<String> {
    let text = value?.as_str()?;
    let valid =
        text.len() == len * 2 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    valid.then(|| text.to_string())
}

fn read_reg(fields: &Map<String, Value>) -> Option<Wire> {
    let id = hex_field(fields.get("id"), 16)?;
    if fields.contains_key("off") {
        let off = shaped(fields, &["ty", "v", "id", "off"])
            && fields.get("off") == Some(&Value::Bool(true));
        return off.then_some(Wire::Off { id });
    }
    if !shaped(fields, &["ty", "v", "id", "k"]) {
        return None;
    }
    let key = hex_field(fields.get("k"), 32)?;
    Some(Wire::Reg { id, key })
}

fn read_ack(fields: &Map<String, Value>) -> Option<Wire> {
    if !shaped(fields, &["ty", "v", "id", "ok", "relays"]) {
        return None;
    }
    let id = hex_field(fields.get("id"), 16)?;
    let ok = fields.get("ok")?.as_bool()?;
    if !ok {
        return Some(Wire::Ack {
            id,
            ok,
            relays: Vec::new(),
        });
    }
    let named: Vec<String> = fields
        .get("relays")?
        .as_array()?
        .iter()
        .filter_map(|relay| relay.as_str().map(str::to_string))
        .collect();
    let relays = contact_relays(&named);
    (!relays.is_empty()).then_some(Wire::Ack { id, ok, relays })
}

impl Wire {
    /// The message as it goes through the ratchet: compact JSON, its fields
    /// in this order.
    pub fn to_bytes(&self) -> Vec<u8> {
        let quoted = |text: &str| serde_json::to_string(text).unwrap_or_default();
        let text = match self {
            Wire::Reg { id, key } => format!(
                r#"{{"ty":"alert-reg","v":{ALERT_V},"id":{},"k":{}}}"#,
                quoted(id),
                quoted(key)
            ),
            Wire::Off { id } => format!(
                r#"{{"ty":"alert-reg","v":{ALERT_V},"id":{},"off":true}}"#,
                quoted(id)
            ),
            Wire::Ack { id, ok, relays } => {
                let named = if *ok {
                    let relays = serde_json::to_string(relays).unwrap_or_else(|_| "[]".into());
                    format!(r#","relays":{relays}"#)
                } else {
                    String::new()
                };
                format!(
                    r#"{{"ty":"alert-ack","v":{ALERT_V},"id":{},"ok":{ok}{named}}}"#,
                    quoted(id)
                )
            }
        };
        text.into_bytes()
    }
}

/// Whether `url` is a relay a warning may go to: `wss://` or `ws://`, a
/// host, no spaces or controls, and not too long.
pub fn valid_relay(url: &str) -> bool {
    let Some(rest) = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
    else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    url.len() <= MAX_RELAY_URL
        && !host.is_empty()
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The relays among `urls` an acceptance names: the valid ones, at most
/// `MAX_CONTACT_RELAYS`, while they fit their room.
pub fn contact_relays(urls: &[String]) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    let mut room = CONTACT_RELAYS_ROOM;
    for url in urls.iter().filter(|url| valid_relay(url)) {
        // Quoted, and a comma.
        let len = url.len() + 3;
        if kept.len() == MAX_CONTACT_RELAYS || len > room {
            break;
        }
        if !kept.contains(url) {
            room -= len;
            kept.push(url.clone());
        }
    }
    kept
}

/// A message as the warning carries it: the characters a profile allows,
/// line breaks included, trimmed and cut to `MAX_MESSAGE_CHARS`.
pub fn clean_message(text: &str) -> String {
    crate::profile::shareable(text, true, MAX_MESSAGE_CHARS)
}

/// Where a registration of one's own stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertState {
    Waiting,
    Accepted,
    Declined,
}

/// The warning this account would send, as its store keeps it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnAlert {
    /// The contact's Nostr key: its name here can change.
    pub contact: String,
    pub id: String,
    pub key: String,
    pub state: AlertState,
    /// What the contact's acceptance named.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub relays: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

/// A question from a contact, waiting for the person's answer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ask {
    /// The contact's Nostr key.
    pub from: String,
    pub id: String,
    pub key: String,
}

/// A registration this account accepted: its mailboxes are listened to
/// until its warning comes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Watched {
    pub from: String,
    pub id: String,
    pub key: String,
    pub since: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fired: Option<Fired>,
}

/// A warning that came: when, and its message.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fired {
    pub at: i64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

/// Every registration of the account, both sides, in `account.bin`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertBook {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mine: Option<OwnAlert>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub asks: Vec<Ask>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watching: Vec<Watched>,
}

/// What the emergency path needs to send the warning, in the shared block:
/// no name, no key of the contact (design §7.2 step 4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedAlert {
    /// `alert_key`, hex.
    pub k: String,
    /// `alert_id`, hex.
    pub id: String,
    pub relays: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub msg: String,
}

/// What choosing a contact sends: an `off` to the contact chosen before,
/// if it was another, and a registration, if this one is new. Each with
/// the contact's Nostr key.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Outgoing {
    pub off: Option<(String, Wire)>,
    pub reg: Option<(String, Wire)>,
}

/// What a message of the warning changed, with the contact's Nostr key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Effect {
    Nothing,
    /// The contact asks (or asks again, replacing the question pending).
    Asked(String),
    /// The contact answered our registration.
    Answered(String),
    /// The contact withdrew its registration.
    Withdrawn(String),
}

impl AlertBook {
    /// Whether it holds nothing: an account that never used the warning.
    pub fn is_empty(&self) -> bool {
        self.mine.is_none() && self.asks.is_empty() && self.watching.is_empty()
    }

    /// Choose `contact` (its Nostr key) with `message`, which is cleaned
    /// first. The same contact keeps its registration, unless it said no:
    /// then it is asked again.
    pub fn choose(&mut self, contact: &str, message: &str) -> Outgoing {
        let message = clean_message(message);
        if let Some(mine) = self.mine.as_mut() {
            if mine.contact == contact && mine.state != AlertState::Declined {
                mine.message.zeroize();
                mine.message = message;
                return Outgoing::default();
            }
        }
        let before = self.clear();
        let key = Zeroizing::new(random_array::<32>());
        let mine = OwnAlert {
            contact: contact.to_string(),
            id: hex::encode(random_array::<16>()),
            key: hex::encode(*key),
            state: AlertState::Waiting,
            relays: Vec::new(),
            message,
        };
        let reg = Wire::Reg {
            id: mine.id.clone(),
            key: mine.key.clone(),
        };
        self.mine = Some(mine);
        Outgoing {
            // Asked again, the same contact gets the new question only.
            off: before.filter(|(to, _)| to != contact),
            reg: Some((contact.to_string(), reg)),
        }
    }

    /// "Ninguna", or the emergency key removed: the registration goes, and
    /// its contact is told.
    pub fn clear(&mut self) -> Option<(String, Wire)> {
        let mut mine = self.mine.take()?;
        let off = (
            mine.contact.clone(),
            Wire::Off {
                id: mine.id.clone(),
            },
        );
        mine.forget();
        Some(off)
    }

    /// What the shared block carries: the registration, once accepted.
    pub fn shared(&self) -> Option<SharedAlert> {
        let mine = self.mine.as_ref()?;
        let accepted = mine.state == AlertState::Accepted && !mine.relays.is_empty();
        accepted.then(|| SharedAlert {
            k: mine.key.clone(),
            id: mine.id.clone(),
            relays: mine.relays.clone(),
            msg: mine.message.clone(),
        })
    }

    /// A message of the warning from the contact `from` (its Nostr key).
    pub fn on_wire(&mut self, from: &str, wire: Wire) -> Effect {
        match wire {
            Wire::Reg { id, key } => {
                // One question per contact (RC-10): the new one replaces it.
                self.asks.retain(|ask| ask.from != from);
                self.asks.push(Ask {
                    from: from.to_string(),
                    id,
                    key,
                });
                Effect::Asked(from.to_string())
            }
            Wire::Off { id } => {
                let before = (self.asks.len(), self.watching.len());
                self.asks.retain(|ask| !(ask.from == from && ask.id == id));
                // A warning that came stays: its chat keeps saying so.
                self.watching.retain(|watched| {
                    !(watched.from == from && watched.id == id && watched.fired.is_none())
                });
                if before == (self.asks.len(), self.watching.len()) {
                    Effect::Nothing
                } else {
                    Effect::Withdrawn(from.to_string())
                }
            }
            Wire::Ack { id, ok, relays } => match self.mine.as_mut() {
                Some(mine)
                    if mine.contact == from
                        && mine.id == id
                        && mine.state == AlertState::Waiting =>
                {
                    if ok {
                        mine.state = AlertState::Accepted;
                        mine.relays = relays;
                    } else {
                        mine.state = AlertState::Declined;
                    }
                    Effect::Answered(from.to_string())
                }
                _ => Effect::Nothing,
            },
        }
    }

    /// The person answered the question of `from`: the answer to send, if
    /// there was a question. Accepted, its registration is listened to from
    /// `now` on, in place of any earlier one of that contact, and `relays`
    /// go in the answer.
    pub fn answer(
        &mut self,
        from: &str,
        accept: bool,
        relays: &[String],
        now: i64,
    ) -> Option<Wire> {
        let at = self.asks.iter().position(|ask| ask.from == from)?;
        let ask = self.asks.remove(at);
        if !accept {
            return Some(Wire::Ack {
                id: ask.id,
                ok: false,
                relays: Vec::new(),
            });
        }
        self.watching
            .retain(|watched| watched.from != from || watched.fired.is_some());
        let answer = Wire::Ack {
            id: ask.id.clone(),
            ok: true,
            relays: contact_relays(relays),
        };
        self.watching.push(Watched {
            from: ask.from,
            id: ask.id,
            key: ask.key,
            since: now,
            fired: None,
        });
        Some(answer)
    }

    /// The registrations listened to: each one's place, key and id.
    fn listened<'a>(
        &'a self,
        live: &'a impl Fn(&str) -> bool,
    ) -> impl Iterator<Item = (usize, Zeroizing<Vec<u8>>, Vec<u8>)> + 'a {
        self.watching
            .iter()
            .enumerate()
            .filter(move |(_, watched)| watched.fired.is_none() && live(&watched.from))
            .filter_map(|(at, watched)| {
                let key = Zeroizing::new(hex::decode(&watched.key).ok()?);
                let id = hex::decode(&watched.id).ok()?;
                Some((at, key, id))
            })
    }

    /// The mailboxes to listen to at `now`: yesterday's, today's and
    /// tomorrow's of each registration accepted whose warning has not come,
    /// from a contact `live` takes (one that is still a contact, and not
    /// blocked: §7.6).
    pub fn mailboxes(&self, now: i64, live: impl Fn(&str) -> bool) -> Vec<String> {
        let today = epoch_at(now);
        let mut boxes = Vec::new();
        for (_, key, _) in self.listened(&live) {
            for epoch in [today.saturating_sub(1), today, today + 1] {
                if let Some(mailbox) = mailbox(&key, epoch) {
                    boxes.push(mailbox.pubkey);
                }
            }
        }
        boxes.sort();
        boxes.dedup();
        boxes
    }

    /// A warning that came to one of the mailboxes: the contact's Nostr key
    /// when it is the first of its registration.
    pub fn on_mailbox(
        &mut self,
        event: &NostrEvent,
        now: i64,
        live: impl Fn(&str) -> bool,
    ) -> Option<String> {
        let (at, opened) = self
            .listened(&live)
            .find_map(|(at, key, id)| open(&key, &id, event, now).map(|opened| (at, opened)))?;
        let watched = &mut self.watching[at];
        watched.fired = Some(Fired {
            at: now,
            message: opened.message,
        });
        Some(watched.from.clone())
    }

    /// Wipe what it holds, as a lock does.
    pub fn forget(&mut self) {
        if let Some(mine) = self.mine.as_mut() {
            mine.forget();
        }
        self.mine = None;
        for ask in &mut self.asks {
            ask.key.zeroize();
        }
        self.asks.clear();
        for watched in &mut self.watching {
            watched.key.zeroize();
            if let Some(fired) = watched.fired.as_mut() {
                fired.message.zeroize();
            }
        }
        self.watching.clear();
    }
}

impl OwnAlert {
    fn forget(&mut self) {
        self.key.zeroize();
        self.message.zeroize();
    }
}

/// The UTC day of `unix`.
pub fn epoch_at(unix: i64) -> u32 {
    u32::try_from(unix.max(0) / EPOCH_SECS).unwrap_or(u32::MAX)
}

/// The mailbox of `key` on day `epoch`, and the key of what it carries.
pub struct Mailbox {
    /// x-only, hex: the `p` of the warning.
    pub pubkey: String,
    enc: Zeroizing<Vec<u8>>,
}

/// The mailbox of `key` on day `epoch`; none in the 2^-128 case where the
/// scalar is not one.
pub fn mailbox(key: &[u8], epoch: u32) -> Option<Mailbox> {
    let info = [EPOCH_INFO, &epoch.to_be_bytes()].concat();
    let day = hkdf_expand(key, &[], &info, 32).ok()?;
    let scalar = hkdf_expand(&day, &[], b"mbox", 32).ok()?;
    let secret = secp256k1::SecretKey::from_slice(&scalar).ok()?;
    let pair = secp256k1::Keypair::from_secret_key(secp256k1::SECP256K1, &secret);
    let (xonly, _) = pair.x_only_public_key();
    Some(Mailbox {
        pubkey: hex::encode(xonly.serialize()),
        enc: hkdf_expand(&day, &[], b"enc", 32).ok()?,
    })
}

/// The associated data of a warning to `mailbox`.
fn associated(mailbox: &str) -> Vec<u8> {
    [LABEL, mailbox.as_bytes()].concat()
}

/// What the emergency path sends at `now`: the warning, signed with a key
/// of one use and addressed to today's mailbox. None if the block's
/// registration does not read.
pub fn seal(alert: &SharedAlert, now: i64) -> Option<NostrEvent> {
    use base64::Engine;
    let key = Zeroizing::new(hex::decode(&alert.k).ok()?);
    let id = hex::decode(&alert.id).ok()?;
    if key.len() != 32 || id.len() != 16 {
        return None;
    }
    let mailbox = mailbox(&key, epoch_at(now))?;
    let message = clean_message(&alert.msg);
    let mut plain = Zeroizing::new(Vec::with_capacity(PADDED_LEN));
    plain.extend_from_slice(LABEL);
    plain.extend_from_slice(&id);
    plain.extend_from_slice(&u64::try_from(now).unwrap_or(0).to_be_bytes());
    // 280 scalar values take 1120 bytes at most.
    plain.extend_from_slice(&u16::try_from(message.len()).ok()?.to_be_bytes());
    plain.extend_from_slice(message.as_bytes());
    plain.resize(PADDED_LEN, 0);
    let aad = associated(&mailbox.pubkey);
    let (sealed, nonce) = aes_gcm_encrypt(&mailbox.enc, &plain, Some(&aad)).ok()?;
    let content = base64::engine::general_purpose::STANDARD.encode([&nonce[..], &sealed].concat());

    // A key of one use: never an identity's (design §7.2).
    let pair = secp256k1::Keypair::new(secp256k1::SECP256K1, &mut rand::thread_rng());
    let secret = Zeroizing::new(pair.secret_bytes());
    let (xonly, _) = pair.x_only_public_key();
    let spread = (MAX_EXPIRATION_SECS - MIN_EXPIRATION_SECS + 1) as u64;
    let expiration = now + MIN_EXPIRATION_SECS + (rand::random::<u64>() % spread) as i64;
    build_and_sign_event(
        &secret,
        &xonly.serialize(),
        TRINO_KIND,
        &content,
        vec![
            vec!["p".to_string(), mailbox.pubkey],
            vec!["expiration".to_string(), expiration.to_string()],
        ],
        Some(now),
    )
    .ok()
}

/// A warning opened: when it was made, and its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Opened {
    pub sent_at: i64,
    pub message: String,
}

/// Open `event` as a warning of the registration `key`, `id`, if it went to
/// one of its mailboxes around `now`.
pub fn open(key: &[u8], id: &[u8], event: &NostrEvent, now: i64) -> Option<Opened> {
    use base64::Engine;
    if event.kind != TRINO_KIND {
        return None;
    }
    let to = event.recipient()?;
    let today = epoch_at(now);
    let mailbox = [today.saturating_sub(1), today, today + 1]
        .into_iter()
        .filter_map(|epoch| mailbox(key, epoch))
        .find(|mailbox| mailbox.pubkey == to)?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(&event.content)
        .ok()?;
    let (nonce, sealed) = raw.split_at_checked(12)?;
    let plain =
        Zeroizing::new(aes_gcm_decrypt(&mailbox.enc, sealed, nonce, Some(&associated(to))).ok()?);
    if plain.len() != PADDED_LEN {
        return None;
    }
    let body = plain.strip_prefix(LABEL)?;
    let (their_id, body) = body.split_at_checked(16)?;
    let (time, body) = body.split_at_checked(8)?;
    let (len, body) = body.split_at_checked(2)?;
    if their_id != id {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([len[0], len[1]]));
    let text = std::str::from_utf8(body.get(..len)?).ok()?;
    Some(Opened {
        sent_at: i64::try_from(u64::from_be_bytes(time.try_into().ok()?)).ok()?,
        message: clean_message(text),
    })
}

// ---- In the session ----

/// What the UI hears (`ALERT_EVENT`): which contact, and what happened.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AlertEvent {
    pub handle: String,
    /// "asked", "answered", "withdrawn" or "warned".
    pub what: &'static str,
}

/// The contacts the warning can go to (design §7.2 step 1): those whose
/// Trino announced it, and not blocked. By name, sorted.
pub fn candidates(inner: &InnerState) -> Vec<String> {
    let mut handles: Vec<String> = inner
        .friends
        .values()
        .filter(|friend| !inner.blocked.contains(&friend.bundle.nostr_pub))
        .filter(|friend| {
            inner
                .profiles
                .contacts
                .get(&friend.handle)
                .is_some_and(|kept| kept.alert >= ALERT_V)
        })
        .map(|friend| friend.handle.clone())
        .collect();
    handles.sort();
    handles
}

/// The contact whose Nostr key is `nostr_pub`, by its name here.
fn handle_of(inner: &InnerState, nostr_pub: &str) -> Option<String> {
    inner
        .friends
        .values()
        .find(|friend| friend.bundle.nostr_pub == nostr_pub)
        .map(|friend| friend.handle.clone())
}

/// Whether `nostr_pub` is a contact still, and not blocked (§7.6).
fn is_live(inner: &InnerState, nostr_pub: &str) -> bool {
    !inner.blocked.contains(nostr_pub)
        && inner
            .friends
            .values()
            .any(|friend| friend.bundle.nostr_pub == nostr_pub)
}

/// Keep the book with the account, its warning in the vault's shared block
/// (`persist_account`), and have the mailboxes listened to follow.
fn keep(inner: &InnerState) -> Result<(), CommandError> {
    inner.alert_watch.notify_one();
    crate::storage::persist_account(inner).map_err(|error| CommandError::new(ErrorCode::Io, error))
}

fn tell(events: &dyn EventSink, handle: String, what: &'static str) {
    events.emit(ALERT_EVENT, &AlertEvent { handle, what });
}

/// The hook in `handle_incoming_event` after the profiles': a message of
/// the warning from `friend` ends here, never as text. Whether it was one.
pub fn on_message(
    events: &dyn EventSink,
    inner: &mut InnerState,
    friend: &FriendRecord,
    plain: &[u8],
) -> bool {
    let wire = match read(plain) {
        Read::NotAlert => return false,
        Read::Invalid => {
            crate::session::dbg_log("  DROP: a broken message of the warning");
            return true;
        }
        Read::Wire(wire) => wire,
    };
    let what = match inner.alerts.on_wire(&friend.bundle.nostr_pub, wire) {
        Effect::Nothing => return true,
        Effect::Asked(_) => "asked",
        Effect::Answered(_) => "answered",
        Effect::Withdrawn(_) => "withdrawn",
    };
    if keep(inner).is_err() {
        crate::session::dbg_log("the warning's registrations could not be saved");
    }
    tell(events, friend.handle.clone(), what);
    true
}

/// RC-08: an event to one of the mailboxes listened to goes to the warning
/// before anything looks for its sender, since its key is of one use.
/// Whether it was one.
pub fn route(events: &dyn EventSink, inner: &mut InnerState, event: &NostrEvent, now: i64) -> bool {
    let Some(to) = event.recipient() else {
        return false;
    };
    let live = |from: &str| is_live(inner, from);
    if !inner
        .alerts
        .mailboxes(now, live)
        .iter()
        .any(|mailbox| mailbox == to)
    {
        return false;
    }
    let mut book = std::mem::take(&mut inner.alerts);
    let fired = book.on_mailbox(event, now, |from| is_live(inner, from));
    inner.alerts = book;
    if let Some(from) = fired {
        if keep(inner).is_err() {
            crate::session::dbg_log("the warning's registrations could not be saved");
        }
        if let Some(handle) = handle_of(inner, &from) {
            tell(events, handle, "warned");
        }
    }
    true
}

/// Send `wire` to the contact whose Nostr key is `to`, through the ratchet.
async fn send(state: &Engine, to: &str, wire: &Wire) -> Result<(), CommandError> {
    let handle = {
        let inner = state.inner.lock().await;
        handle_of(&inner, to)
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "no such contact"))?
    };
    crate::session::ensure_session(state, &handle).await?;
    crate::session::publish_sealed(state, &handle, &wire.to_bytes(), None).await?;
    Ok(())
}

/// "Qué pasa en la red" › Guardar: the warning to `handle` with `message`,
/// or none. A contact that is not among the `candidates` is `not_found`,
/// and nothing changes. The new registration goes out first: if it cannot,
/// nothing changes either. The contact chosen before is told after, as
/// well as it can be.
pub async fn choose(
    state: &Engine,
    handle: Option<&str>,
    message: &str,
) -> Result<(), CommandError> {
    let (outgoing, before) = {
        let mut inner = state.inner.lock().await;
        let before = inner.alerts.clone();
        let outgoing = match handle {
            None => Outgoing {
                off: inner.alerts.clear(),
                reg: None,
            },
            Some(handle) => {
                if !candidates(&inner)
                    .iter()
                    .any(|candidate| candidate == handle)
                {
                    return Err(CommandError::new(
                        ErrorCode::NotFound,
                        "not a contact the warning can go to",
                    ));
                }
                let to = inner.friends[handle].bundle.nostr_pub.clone();
                inner.alerts.choose(&to, message)
            }
        };
        (outgoing, before)
    };
    if let Some((to, reg)) = &outgoing.reg {
        if let Err(error) = send(state, to, reg).await {
            state.inner.lock().await.alerts = before;
            return Err(error);
        }
    }
    let kept = keep(&*state.inner.lock().await);
    if let Some((to, off)) = &outgoing.off {
        if send(state, to, off).await.is_err() {
            crate::session::dbg_log("the contact of before could not be told");
        }
    }
    kept
}

/// The contact's answer to the question of `handle`: accepted, with the
/// relays this account reads.
pub async fn answer(state: &Engine, handle: &str, accept: bool) -> Result<(), CommandError> {
    let (from, wire) = {
        let mut inner = state.inner.lock().await;
        let from = inner
            .friends
            .get(handle)
            .map(|friend| friend.bundle.nostr_pub.clone())
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "no such contact"))?;
        let relays = crate::state::relays_to_use(&inner.relay_urls);
        let now = crate::session::unix_now();
        let wire = inner
            .alerts
            .answer(&from, accept, &relays, now)
            .ok_or_else(|| CommandError::new(ErrorCode::NotFound, "no question of that contact"))?;
        keep(&inner)?;
        (from, wire)
    };
    send(state, &from, &wire).await
}

/// What "Qué pasa en la red" shows of the warning chosen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OwnView {
    /// The contact's name here.
    pub contact: String,
    pub state: AlertState,
    pub message: String,
}

pub fn own_view(inner: &InnerState) -> Option<OwnView> {
    let mine = inner.alerts.mine.as_ref()?;
    Some(OwnView {
        contact: handle_of(inner, &mine.contact)?,
        state: mine.state,
        message: mine.message.clone(),
    })
}

/// A warning that came, as its chat shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Warning {
    pub handle: String,
    pub at: i64,
    pub message: String,
}

/// What the chats show: the questions waiting, and the warnings that came.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ContactAlerts {
    pub asks: Vec<String>,
    pub warnings: Vec<Warning>,
}

pub fn contact_view(inner: &InnerState) -> ContactAlerts {
    let book = &inner.alerts;
    let asks = book
        .asks
        .iter()
        .filter(|ask| is_live(inner, &ask.from))
        .filter_map(|ask| handle_of(inner, &ask.from))
        .collect();
    let warnings = book
        .watching
        .iter()
        .filter_map(|watched| {
            let fired = watched.fired.as_ref()?;
            Some(Warning {
                handle: handle_of(inner, &watched.from)?,
                at: fired.at,
                message: fired.message.clone(),
            })
        })
        .collect();
    ContactAlerts { asks, warnings }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use crate::events::RecordingSink;
    use crate::identity::{create_identity, Identity};
    use crate::nostr::test_relay::{wait_until, Answer, TestRelay};
    use crate::profile::ContactProfile;
    use crate::session::handle_incoming_event;
    use crate::session::tests::{add_session_read_by, friend, sending_state};
    use std::sync::Arc;

    /// Ana, who sets the warning, and Bob, her contact, each with their
    /// Trino, both on one test relay. Bob's Trino reads the warning.
    struct Pair {
        relay: TestRelay,
        ana: Engine,
        bob: Engine,
        ana_id: Identity,
        bob_id: Identity,
        ana_sink: Arc<RecordingSink>,
        bob_sink: Arc<RecordingSink>,
        delivered: usize,
    }

    fn announcing(alert: u64) -> ContactProfile {
        ContactProfile {
            caps: 1,
            alert,
            ..ContactProfile::default()
        }
    }

    impl Pair {
        async fn new() -> Pair {
            let relay = TestRelay::start(Answer::Accept).await;
            let (ana_id, bob_id) = (create_identity(), create_identity());
            let ana = sending_state(&ana_id, vec![relay.client().await]).await;
            let bob = sending_state(&bob_id, vec![relay.client().await]).await;
            {
                let mut a = ana.inner.lock().await;
                let mut b = bob.inner.lock().await;
                let (ratchet, ad) = add_session_read_by(&mut a, &ana_id, &bob_id, "Bob");
                a.profiles
                    .contacts
                    .insert("Bob".into(), announcing(ALERT_V));
                a.handle = Some("Ana".into());
                b.handle = Some("Bob".into());
                b.relay_urls = vec!["wss://bob.example".into()];
                b.friends.insert("Ana".into(), friend(&ana_id, "Ana"));
                b.ratchets.insert("Ana".into(), ratchet);
                b.associated_data.insert("Ana".into(), ad);
            }
            Pair {
                relay,
                ana,
                bob,
                ana_id,
                bob_id,
                ana_sink: RecordingSink::new(),
                bob_sink: RecordingSink::new(),
                delivered: 0,
            }
        }

        /// What reached the relay since the last call, each to its
        /// addressee's Trino.
        async fn deliver(&mut self, expected: usize) {
            let wanted = self.delivered + expected;
            wait_until("the events", || self.relay.events().len() >= wanted).await;
            let events = self.relay.events();
            let resend: crate::profile::Resend = Arc::new(|_| {});
            for event in &events[self.delivered..] {
                let (engine, sink) =
                    if event.recipient() == Some(&hex::encode(self.bob_id.nostr.pub_bytes)) {
                        (&self.bob, &self.bob_sink)
                    } else {
                        (&self.ana, &self.ana_sink)
                    };
                handle_incoming_event(&**sink, &resend, Arc::clone(&engine.inner), event.clone())
                    .await;
            }
            self.delivered = events.len();
        }
    }

    /// Test 41: only a contact whose Trino reads the warning is offered,
    /// and only one of them gets a registration.
    #[tokio::test]
    async fn alert_reg_goes_only_to_contacts_that_announce_it() {
        let pair = Pair::new().await;
        let (carol, dan) = (create_identity(), create_identity());
        {
            let mut inner = pair.ana.inner.lock().await;
            add_session_read_by(&mut inner, &pair.ana_id, &carol, "Carol");
            add_session_read_by(&mut inner, &pair.ana_id, &dan, "Dan");
            // Carol reads profiles, but not the warning; Dan reads it, but
            // is blocked.
            inner
                .profiles
                .contacts
                .insert("Carol".into(), announcing(0));
            inner
                .profiles
                .contacts
                .insert("Dan".into(), announcing(ALERT_V));
            inner.blocked.insert(hex::encode(dan.nostr.pub_bytes));
            assert_eq!(candidates(&inner), ["Bob"]);
        }
        for refused in ["Carol", "Dan", "Nadie"] {
            let error = choose(&pair.ana, Some(refused), "").await.unwrap_err();
            assert_eq!(
                error.code,
                crate::command_error::ErrorCode::NotFound,
                "{refused}"
            );
        }
        assert!(pair.ana.inner.lock().await.alerts.is_empty());
        assert!(pair.relay.events().is_empty(), "nothing went out");

        choose(&pair.ana, Some("Bob"), "hola").await.unwrap();
        wait_until("the registration", || pair.relay.events().len() == 1).await;
        let event = &pair.relay.events()[0];
        assert_eq!(
            event.recipient(),
            Some(hex::encode(pair.bob_id.nostr.pub_bytes).as_str())
        );
        let own = own_view(&*pair.ana.inner.lock().await).unwrap();
        assert_eq!(own.contact, "Bob");
        assert_eq!(own.state, AlertState::Waiting);
    }

    /// Test 42: the question and the answer go through the ratchet, and
    /// neither lands in a history or tells the UI of a message.
    #[tokio::test]
    async fn no_alert_registration_lands_in_history() {
        let mut pair = Pair::new().await;
        choose(&pair.ana, Some("Bob"), "Si no te escribo, ya sabes.")
            .await
            .unwrap();
        pair.deliver(1).await;
        {
            let bob = pair.bob.inner.lock().await;
            assert!(bob.history.is_empty(), "{:?}", bob.history.keys());
            assert_eq!(contact_view(&bob).asks, ["Ana"]);
        }
        assert_eq!(pair.bob_sink.names(), [ALERT_EVENT]);
        assert!(pair.bob_sink.events()[0].1.contains(r#""what":"asked""#));

        answer(&pair.bob, "Ana", true).await.unwrap();
        assert_eq!(
            answer(&pair.bob, "Ana", true).await.unwrap_err().code,
            crate::command_error::ErrorCode::NotFound,
            "answered already"
        );
        pair.deliver(1).await;
        let ana = pair.ana.inner.lock().await;
        assert!(ana.history.is_empty());
        assert_eq!(pair.ana_sink.names(), [ALERT_EVENT]);
        let own = own_view(&ana).unwrap();
        assert_eq!(own.state, AlertState::Accepted);
        assert_eq!(own.message, "Si no te escribo, ya sabes.");
        assert_eq!(ana.alerts.shared().unwrap().relays, ["wss://bob.example"]);
        let bob = pair.bob.inner.lock().await;
        assert!(bob.history.is_empty());
        assert!(contact_view(&bob).asks.is_empty());
        assert_eq!(bob.alerts.watching.len(), 1);
    }

    /// RC-08: the warning is signed with a key of one use, a stranger's:
    /// it reaches the warning before any sender lookup, which would drop it
    /// as a stranger's (`handshake-needed`).
    #[tokio::test]
    async fn an_event_to_an_alert_mailbox_is_routed_before_the_sender_lookup() {
        let mut pair = Pair::new().await;
        choose(&pair.ana, Some("Bob"), "hola").await.unwrap();
        pair.deliver(1).await;
        answer(&pair.bob, "Ana", true).await.unwrap();
        pair.deliver(1).await;
        let shared = pair.ana.inner.lock().await.alerts.shared().unwrap();
        let warning = seal(&shared, crate::session::unix_now()).unwrap();

        let resend: crate::profile::Resend = Arc::new(|_| {});
        let sink = RecordingSink::new();
        handle_incoming_event(
            &*sink,
            &resend,
            Arc::clone(&pair.bob.inner),
            warning.clone(),
        )
        .await;
        assert_eq!(sink.names(), [ALERT_EVENT]);
        assert!(sink.events()[0].1.contains(r#""what":"warned""#));
        let view = contact_view(&*pair.bob.inner.lock().await);
        assert_eq!(view.warnings.len(), 1);
        assert_eq!(view.warnings[0].handle, "Ana");
        assert_eq!(view.warnings[0].message, "hola");
        // Once: the same again tells nothing, and is no stranger's either.
        handle_incoming_event(&*sink, &resend, Arc::clone(&pair.bob.inner), warning).await;
        assert_eq!(sink.names(), [ALERT_EVENT]);
    }

    /// Withdrawn ("Ninguna" or another contact): the contact's Trino stops
    /// listening, and a warning that came stays in its chat.
    #[tokio::test]
    async fn choosing_none_withdraws_the_registration() {
        let mut pair = Pair::new().await;
        choose(&pair.ana, Some("Bob"), "").await.unwrap();
        pair.deliver(1).await;
        answer(&pair.bob, "Ana", true).await.unwrap();
        pair.deliver(1).await;
        choose(&pair.ana, None, "").await.unwrap();
        assert!(pair.ana.inner.lock().await.alerts.is_empty());
        pair.deliver(1).await;
        let bob = pair.bob.inner.lock().await;
        assert!(bob.alerts.watching.is_empty());
        assert!(bob.history.is_empty());
    }

    /// The book is sealed in the store with the account, and comes back at
    /// the next unlock.
    #[tokio::test]
    async fn the_book_is_kept_with_the_account() {
        let scratch = crate::fsutil::scratch::ScratchDir::new("alert-book");
        let pair = Pair::new().await;
        pair.ana.inner.lock().await.storage =
            crate::store::session::testing::store_cell(scratch.path());
        choose(&pair.ana, Some("Bob"), "guardado").await.unwrap();
        let reopened = crate::store::session::testing::reopen(scratch.path());
        let json = crate::store::session::testing::ready(reopened.account);
        let account: crate::store::session::AccountFile = serde_json::from_slice(&json).unwrap();
        assert_eq!(account.alerts.mine.unwrap().message, "guardado");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr::verify_event;

    const NOW: i64 = 1_760_000_000;
    const ANA: &str = "aa";
    const BOB: &str = "bb";

    fn id_of(byte: u8) -> String {
        hex::encode([byte; 16])
    }

    fn key_of(byte: u8) -> String {
        hex::encode([byte; 32])
    }

    fn shared(message: &str) -> SharedAlert {
        SharedAlert {
            k: key_of(7),
            id: id_of(3),
            relays: vec!["wss://contacto.example".into()],
            msg: message.into(),
        }
    }

    fn reg_from(book: &mut AlertBook, from: &str, byte: u8) -> Effect {
        book.on_wire(
            from,
            Wire::Reg {
                id: id_of(byte),
                key: key_of(byte),
            },
        )
    }

    #[test]
    fn the_messages_go_and_come_back_as_they_were() {
        let messages = [
            Wire::Reg {
                id: id_of(1),
                key: key_of(2),
            },
            Wire::Off { id: id_of(1) },
            Wire::Ack {
                id: id_of(1),
                ok: true,
                relays: vec!["wss://uno.example".into(), "wss://dos.example".into()],
            },
            Wire::Ack {
                id: id_of(1),
                ok: false,
                relays: vec![],
            },
        ];
        for wire in messages {
            assert_eq!(read(&wire.to_bytes()), Read::Wire(wire.clone()), "{wire:?}");
        }
        assert_eq!(
            Wire::Reg {
                id: id_of(1),
                key: key_of(2)
            }
            .to_bytes(),
            format!(
                r#"{{"ty":"alert-reg","v":1,"id":"{}","k":"{}"}}"#,
                id_of(1),
                key_of(2)
            )
            .into_bytes()
        );
        assert_eq!(
            Wire::Off { id: id_of(1) }.to_bytes(),
            format!(
                r#"{{"ty":"alert-reg","v":1,"id":"{}","off":true}}"#,
                id_of(1)
            )
            .into_bytes()
        );
    }

    #[test]
    fn other_messages_are_not_the_warnings_and_broken_ones_go_nowhere() {
        for other in [
            &br#"{"ty":"text","body":"hola","id":"m1"}"#[..],
            br#"{"ty":"profile","v":1,"rev":1,"name":"A","about":""}"#,
            b"__trino_handshake__",
            b"texto viejo",
        ] {
            assert_eq!(read(other), Read::NotAlert);
        }
        let id = id_of(1);
        let key = key_of(2);
        for broken in [
            format!(r#"{{"ty":"alert-reg","v":2,"id":"{id}","k":"{key}"}}"#),
            format!(r#"{{"ty":"alert-reg","v":1,"id":"{id}"}}"#),
            format!(r#"{{"ty":"alert-reg","v":1,"id":"abc","k":"{key}"}}"#),
            format!(
                r#"{{"ty":"alert-reg","v":1,"id":"{id}","k":"{}"}}"#,
                "zz".repeat(32)
            ),
            format!(r#"{{"ty":"alert-reg","v":1,"id":"{id}","k":"{key}","x":1}}"#),
            format!(r#"{{"ty":"alert-reg","v":1,"id":"{id}","off":false}}"#),
            format!(r#"{{"ty":"alert-ack","v":1,"id":"{id}","ok":true,"relays":[]}}"#),
            format!(
                r#"{{"ty":"alert-ack","v":1,"id":"{id}","ok":true,"relays":["https://web.example"]}}"#
            ),
            format!(r#"{{"ty":"alert-ack","v":1,"id":"{id}","ok":"yes"}}"#),
            r#"{"ty":"alert-ack"}"#.to_string(),
        ] {
            assert_eq!(read(broken.as_bytes()), Read::Invalid, "{broken}");
        }
        // An acceptance keeps its valid relays, at most five.
        let many: Vec<String> = (0..8).map(|i| format!("\"wss://r{i}.example\"")).collect();
        let ack = format!(
            r#"{{"ty":"alert-ack","v":1,"id":"{id}","ok":true,"relays":["ws://bad host",{}]}}"#,
            many.join(",")
        );
        match read(ack.as_bytes()) {
            Read::Wire(Wire::Ack { relays, .. }) => {
                assert_eq!(relays.len(), MAX_CONTACT_RELAYS);
                assert_eq!(relays[0], "wss://r0.example");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn only_relays_with_a_host_and_no_spaces_are_taken() {
        assert!(valid_relay("wss://nos.lol"));
        assert!(valid_relay("ws://relay-3.trino.invalid"));
        assert!(valid_relay("wss://abc.onion/ruta"));
        for bad in [
            "https://nos.lol",
            "wss://",
            "wss://con espacio.example",
            "wss://control\u{7}.example",
            "nos.lol",
            &format!("wss://{}.example", "r".repeat(MAX_RELAY_URL)),
        ] {
            assert!(!valid_relay(bad), "{bad}");
        }
        // Valid, and long enough that only two fit the room.
        let long: Vec<String> = (0..5)
            .map(|i| format!("wss://{}{i}.example", "r".repeat(180)))
            .collect();
        let kept = contact_relays(&long);
        assert!(
            !kept.is_empty() && kept.len() < long.len(),
            "{}",
            kept.len()
        );
    }

    /// Design §7.2: the question, one per contact (RC-10), then the answer.
    #[test]
    fn a_new_registration_replaces_the_question_pending() {
        let mut book = AlertBook::default();
        assert_eq!(reg_from(&mut book, ANA, 1), Effect::Asked(ANA.into()));
        assert_eq!(reg_from(&mut book, ANA, 2), Effect::Asked(ANA.into()));
        assert_eq!(reg_from(&mut book, BOB, 3), Effect::Asked(BOB.into()));
        assert_eq!(book.asks.len(), 2);
        assert_eq!(
            book.asks.iter().find(|ask| ask.from == ANA).unwrap().id,
            id_of(2)
        );

        // Withdrawn before any answer: the question goes.
        assert_eq!(
            book.on_wire(BOB, Wire::Off { id: id_of(3) }),
            Effect::Withdrawn(BOB.into())
        );
        assert!(book.asks.iter().all(|ask| ask.from != BOB));
        // Another's id withdraws nothing.
        assert_eq!(
            book.on_wire(BOB, Wire::Off { id: id_of(2) }),
            Effect::Nothing
        );
        assert_eq!(
            book.answer(BOB, true, &[], NOW),
            None,
            "no question of Bob's"
        );

        let relays = vec!["wss://mio.example".to_string()];
        let answer = book.answer(ANA, true, &relays, NOW).unwrap();
        assert_eq!(
            answer,
            Wire::Ack {
                id: id_of(2),
                ok: true,
                relays: relays.clone()
            }
        );
        assert!(book.asks.is_empty());
        assert_eq!(book.watching.len(), 1);
        assert_eq!(book.watching[0].since, NOW);

        // Asked again and declined: the one accepted stays until another is.
        reg_from(&mut book, ANA, 4);
        assert_eq!(
            book.answer(ANA, false, &relays, NOW + 1),
            Some(Wire::Ack {
                id: id_of(4),
                ok: false,
                relays: vec![]
            })
        );
        assert_eq!(book.watching[0].id, id_of(2));
        reg_from(&mut book, ANA, 5);
        book.answer(ANA, true, &relays, NOW + 2);
        assert_eq!(book.watching.len(), 1, "a new one replaces the one before");
        assert_eq!(book.watching[0].id, id_of(5));

        // Withdrawn after accepting: it is no longer listened to.
        book.on_wire(ANA, Wire::Off { id: id_of(5) });
        assert!(book.watching.is_empty());
    }

    #[test]
    fn choosing_a_contact_registers_it_and_tells_the_one_before() {
        let mut book = AlertBook::default();
        let first = book.choose(ANA, "  Si no te escribo en dos días,\u{202e} ya sabes.  ");
        let (to, reg) = first.reg.clone().unwrap();
        assert_eq!(to, ANA);
        let Wire::Reg { id, key } = reg else {
            panic!("{reg:?}")
        };
        assert_eq!((id.len(), key.len()), (32, 64));
        assert_eq!(first.off, None);
        let mine = book.mine.clone().unwrap();
        assert_eq!(mine.state, AlertState::Waiting);
        assert_eq!(mine.message, "Si no te escribo en dos días, ya sabes.");
        assert_eq!(
            book.shared(),
            None,
            "nothing goes to the block until accepted"
        );

        // The same contact: the message changes, and nothing is sent.
        let again = book.choose(ANA, "otro mensaje");
        assert_eq!(again, Outgoing::default());
        assert_eq!(book.mine.as_ref().unwrap().id, id);
        assert_eq!(book.mine.as_ref().unwrap().message, "otro mensaje");

        // Ana accepts, with her relays: the block gets it.
        let relays = vec!["wss://ana.example".to_string()];
        assert_eq!(
            book.on_wire(
                ANA,
                Wire::Ack {
                    id: id.clone(),
                    ok: true,
                    relays: relays.clone()
                }
            ),
            Effect::Answered(ANA.into())
        );
        assert_eq!(
            book.shared(),
            Some(SharedAlert {
                k: key.clone(),
                id: id.clone(),
                relays: relays.clone(),
                msg: "otro mensaje".into()
            })
        );
        // An answer from someone else, or to another id, changes nothing.
        assert_eq!(
            book.on_wire(
                BOB,
                Wire::Ack {
                    id: id.clone(),
                    ok: false,
                    relays: vec![]
                }
            ),
            Effect::Nothing
        );
        assert_eq!(
            book.on_wire(
                ANA,
                Wire::Ack {
                    id: id_of(9),
                    ok: false,
                    relays: vec![]
                }
            ),
            Effect::Nothing
        );

        // Another contact: Ana is told, Bob is asked, nothing in the block.
        let moved = book.choose(BOB, "");
        assert_eq!(
            moved.off,
            Some((ANA.to_string(), Wire::Off { id: id.clone() }))
        );
        assert_eq!(moved.reg.as_ref().unwrap().0, BOB);
        assert_eq!(book.shared(), None);
        // Bob says no; choosing him again asks again.
        let bob_id = book.mine.as_ref().unwrap().id.clone();
        book.on_wire(
            BOB,
            Wire::Ack {
                id: bob_id.clone(),
                ok: false,
                relays: vec![],
            },
        );
        assert_eq!(book.mine.as_ref().unwrap().state, AlertState::Declined);
        let asked_again = book.choose(BOB, "");
        assert!(asked_again.reg.is_some());
        assert_ne!(book.mine.as_ref().unwrap().id, bob_id);

        // "Ninguna": Bob is told, and nothing is left.
        let off = book.clear().unwrap();
        assert_eq!(off.0, BOB);
        assert!(book.mine.is_none());
        assert_eq!(book.clear(), None);
    }

    #[test]
    fn a_message_is_cut_to_280_and_keeps_its_line_breaks() {
        let long = "ñ".repeat(400);
        assert_eq!(clean_message(&long).chars().count(), MAX_MESSAGE_CHARS);
        assert_eq!(clean_message("uno\ndos"), "uno\ndos");
    }

    #[test]
    fn the_mailbox_changes_every_day_and_its_key_does_not_show() {
        let key = [7u8; 32];
        let today = epoch_at(NOW);
        assert_eq!(epoch_at(NOW + EPOCH_SECS), today + 1);
        let a = mailbox(&key, today).unwrap();
        let b = mailbox(&key, today + 1).unwrap();
        assert_ne!(a.pubkey, b.pubkey);
        assert_eq!(a.pubkey.len(), 64);
        assert_eq!(
            a.pubkey,
            mailbox(&key, today).unwrap().pubkey,
            "the same each time"
        );
        assert_ne!(a.pubkey, mailbox(&[8u8; 32], today).unwrap().pubkey);
        assert!(!a.pubkey.contains(&hex::encode(key)));
    }

    /// Test 37: signed with a key of one use, to today's mailbox, with its
    /// expiration, and only the registration opens it.
    #[test]
    fn the_alert_is_signed_with_a_one_time_key_and_addressed_to_the_alert_mailbox() {
        let alert = shared("Si no te escribo en dos días, ya sabes qué hacer.");
        let one = seal(&alert, NOW).unwrap();
        let two = seal(&alert, NOW).unwrap();
        assert!(verify_event(&one));
        assert_eq!(one.kind, TRINO_KIND);
        assert_ne!(one.pubkey, two.pubkey, "a new key each time");
        let mailbox = mailbox(&[7u8; 32], epoch_at(NOW)).unwrap();
        assert_eq!(one.recipient(), Some(mailbox.pubkey.as_str()));
        let expiration: i64 = one.tags.iter().find(|tag| tag[0] == "expiration").unwrap()[1]
            .parse()
            .unwrap();
        assert!((NOW + 6 * EPOCH_SECS..=NOW + 8 * EPOCH_SECS).contains(&expiration));
        assert_eq!(one.tags.len(), 2, "nothing else: {:?}", one.tags);

        // Every warning has the same size, with a message or without.
        let empty = seal(&shared(""), NOW).unwrap();
        let full = seal(&shared(&"🙂".repeat(MAX_MESSAGE_CHARS)), NOW).unwrap();
        assert_eq!(one.content.len(), empty.content.len());
        assert_eq!(one.content.len(), full.content.len());
        assert!(!one.content.contains("escribo"));

        let opened = open(&[7u8; 32], &[3u8; 16], &one, NOW + 60).unwrap();
        assert_eq!(opened.sent_at, NOW);
        assert_eq!(opened.message, alert.msg);
        assert_eq!(
            open(&[7u8; 32], &[3u8; 16], &full, NOW).unwrap().message,
            "🙂".repeat(MAX_MESSAGE_CHARS)
        );
        // Another registration's key or id opens nothing.
        assert_eq!(open(&[8u8; 32], &[3u8; 16], &one, NOW), None);
        assert_eq!(open(&[7u8; 32], &[4u8; 16], &one, NOW), None);
        // A changed byte opens nothing.
        let mut changed = one.clone();
        changed.content.replace_range(
            20..21,
            if &one.content[20..21] == "A" {
                "B"
            } else {
                "A"
            },
        );
        assert_eq!(open(&[7u8; 32], &[3u8; 16], &changed, NOW), None);
        // Nor a warning of days ago, past what is listened to.
        assert_eq!(
            open(&[7u8; 32], &[3u8; 16], &one, NOW + 3 * EPOCH_SECS),
            None
        );
    }

    /// Test 40, the contact's side: a warning per registration; a relay that
    /// gives it again shows nothing new.
    #[test]
    fn the_contact_accepts_once_and_ignores_repeated_alerts() {
        let mut book = AlertBook::default();
        let alert = shared("hola");
        book.on_wire(
            ANA,
            Wire::Reg {
                id: alert.id.clone(),
                key: alert.k.clone(),
            },
        );
        let live = |_: &str| true;
        let event = seal(&alert, NOW).unwrap();
        assert_eq!(book.on_mailbox(&event, NOW, live), None, "not accepted yet");
        assert!(book.mailboxes(NOW, live).is_empty());

        book.answer(ANA, true, &["wss://mio.example".to_string()], NOW);
        let listened = book.mailboxes(NOW, live);
        assert_eq!(listened.len(), 3, "yesterday, today and tomorrow");
        assert!(listened.contains(&event.recipient().unwrap().to_string()));
        // A contact removed or blocked is not listened to (§7.6).
        assert!(book.mailboxes(NOW, |from| from != ANA).is_empty());
        assert_eq!(book.on_mailbox(&event, NOW, |from| from != ANA), None);

        assert_eq!(
            book.on_mailbox(&event, NOW + 5, live),
            Some(ANA.to_string())
        );
        let fired = book.watching[0].fired.clone().unwrap();
        assert_eq!(
            fired,
            Fired {
                at: NOW + 5,
                message: "hola".into()
            }
        );
        assert_eq!(book.on_mailbox(&event, NOW + 9, live), None, "once");
        let second = seal(&alert, NOW + 60).unwrap();
        assert_eq!(
            book.on_mailbox(&second, NOW + 60, live),
            None,
            "once per registration"
        );
        assert_eq!(book.watching[0].fired.as_ref().unwrap().at, NOW + 5);
        assert!(
            book.mailboxes(NOW, live).is_empty(),
            "nothing more to listen to"
        );
    }

    #[test]
    fn the_book_survives_the_store_and_a_lock_wipes_it() {
        let mut book = AlertBook::default();
        book.choose(ANA, "mensaje");
        reg_from(&mut book, BOB, 2);
        let json = serde_json::to_string(&book).unwrap();
        assert_eq!(serde_json::from_str::<AlertBook>(&json).unwrap(), book);
        assert_eq!(serde_json::to_string(&AlertBook::default()).unwrap(), "{}");
        book.forget();
        assert_eq!(book, AlertBook::default());
    }
}
