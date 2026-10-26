//! Reportar (uso responsable UR-5, `Uso responsable/diseno.md` §6; U1 = B,
//! U2, U3 and U24; David's decision of 26 Oct: one month at most).
//!
//! - **What goes is what you chose** (U2): spam, only their key (as in
//!   Signal); harassment, impersonation, fraud and anything else, the
//!   messages you mark, up to 11 of theirs in that chat and your own if you
//!   mark them, never another member's; a child at risk and intimate images,
//!   only their key and your description. Photos and videos never go: only
//!   that they exist, their rough size and their day. The rule lives here,
//!   not in the UI (design test 24).
//! - **What never goes** (design test 23, R-17, R-18): any key of yours,
//!   your names, the ids of events, a group's id or name, the name you gave
//!   the contact, and the hour of anything (only its day and its order).
//! - **Sealed at once** for the key `kid` of Trino's reports (design §6.4),
//!   to exactly 16 KiB, with X25519, HKDF and AES-256-GCM from trino-core:
//!   it waits sealed, and nobody but Trino's key opens it.
//! - **Sent by Tor** (`REPORT_ISO`, a token of its own each time) to the
//!   Worker, with a proof of work bound to the envelope and the day. A
//!   refusal for the day waits for 00:00 UTC; anything else tries again
//!   later, more slowly each time. Three days without going, the UI offers
//!   abuso@trinochat.org; it can be cancelled while it waits.
//! - **The answer**, only if you asked (U3, R-17): a `reply_token` of 32
//!   random bytes in the report; Trino leaves its answer sealed with it,
//!   under its SHA-256, and only "Reportes enviados" shows it.
//! - **One month at most** (26 Oct): Trino deletes a report when it is
//!   resolved or 30 days after it came, so here a report, its envelope, its
//!   token and its answer go 30 days after it was made (`KEEP_FOR`). Until
//!   then "Reportes enviados" shows only its code, its day and whether it
//!   went (R-06): never its kind, whom or what.
//!
//! The Worker (UR-6) is not deployed and Trino's key not made (U12): this
//! build has no key (`REPORT_KEYS`), so nothing is sealed or sent, and the
//! UI offers the e-mail with "Copiar datos del reporte" (U24). A debug build
//! takes a local Worker from `TRINO_REPORTS_URL` and `TRINO_REPORTS_KEY`.

use crate::block::{self, BlockTarget, Who};
use crate::command_error::CommandError;
use crate::crypto::{aes_gcm_decrypt, aes_gcm_encrypt, hkdf_expand, random_array, sha256};
use crate::crypto::{NONCE_SIZE, TAG_SIZE};
use crate::identity::{generate_x25519, x25519_derive_shared};
use crate::requests::{Item, Via};
use crate::state::{HistItem, InnerState};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use trino_net::{Deadlines, HttpClient, IsoKind, Net, Request};
use zeroize::{Zeroize, Zeroizing};

const DAY: i64 = 24 * 60 * 60;
/// Every envelope measures this, whatever it carries (R-18).
pub const SEALED_LEN: usize = 16 * 1024;
/// What a report is kept here, from when it was made (26 Oct).
pub const KEEP_FOR: i64 = 30 * DAY;
/// Waiting this long, the UI offers the e-mail (R-05).
pub const FALLBACK_AFTER: i64 = 3 * DAY;
/// The proof of work, unless the Worker asks for more (R-05).
pub const POW_BITS: u32 = 20;
/// The most the app mines, whatever the Worker asks.
pub const MAX_POW_BITS: u32 = 26;
/// The messages one report takes: the one you touched and 10 more.
pub const MAX_PICKS: usize = 11;
/// Your description, at most.
pub const NOTE_MAX_CHARS: usize = 500;
/// Where reports go once the Worker exists (UR-6, RP1).
pub const REPORTS_URL: &str = "https://trinochat.org/api/v1/reports";
/// The public keys reports are sealed for, by `kid`: none until Trino's is
/// made (U12, UR-6). The highest `kid` seals.
pub const REPORT_KEYS: &[(u8, [u8; 32])] = &[];
/// The class of traffic of the reports (Tor design §2.7).
pub const REPORT_ISO: IsoKind = IsoKind::new("report");

/// The envelope's version byte.
const SEAL_VERSION: u8 = 0x01;
/// Salt and AAD of the envelope (design §6.4).
const LABEL: &[u8] = b"trino/report/v1";
/// The proof of work's domain.
const POW_LABEL: &[u8] = b"trino/report/pow/v1";
/// The key of an answer, from its token.
const REPLY_LABEL: &[u8] = b"trino/report/reply/v1";
/// Version, `kid`, the ephemeral key and the nonce.
const HEADER_LEN: usize = 2 + 32 + NONCE_SIZE;
/// What the envelope encrypts: the report, 0x80 and zeros up to this.
const PLAIN_LEN: usize = SEALED_LEN - HEADER_LEN - TAG_SIZE;
/// A message's text, at most, before it has to fit.
const MESSAGE_MAX_CHARS: usize = 1_000;
/// Trino's answer, at most.
const REPLY_MAX_CHARS: usize = 500;
const REPLY_MAX_BYTES: usize = 4 * 1024;
/// How often the answer is asked for.
const REPLY_EVERY: i64 = 6 * 60 * 60;
/// The first wait after a failure, doubled each time up to the last.
const FIRST_RETRY: i64 = 60;
const LAST_RETRY: i64 = 6 * 60 * 60;
/// The letters of a code: no 0, O, 1 or I.
const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/// What happened (design §6.2, paso 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Spam,
    Harassment,
    Impersonation,
    Fraud,
    Ncii,
    Child,
    Other,
}

impl Category {
    /// Intimate images and a child at risk: no content at all (U2, §8.2).
    pub fn takes_no_content(self) -> bool {
        matches!(self, Category::Ncii | Category::Child)
    }
}

/// What goes with it (design §6.2, paso 2).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    KeyOnly,
    Messages,
    DescriptionOnly,
}

/// A message you marked, named as "Borrar para mí" names one: when, whose
/// side, in a group whom, and its text or its file's SHA-256.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Pick {
    pub ts: i64,
    pub side: String,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
}

/// What the three steps chose.
#[derive(Clone, Debug, Deserialize)]
pub struct Draft {
    pub category: Category,
    pub mode: Mode,
    #[serde(default)]
    pub picks: Vec<Pick>,
    #[serde(default)]
    pub note: String,
    /// "Quiero ver la respuesta de Trino en este equipo".
    #[serde(default)]
    pub want_reply: bool,
}

/// The report, as it goes inside the envelope (design §6.3, version 1).
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub v: u8,
    pub id: String,
    pub day: String,
    pub category: Category,
    pub mode: Mode,
    pub reported: Reported,
    pub context: Context,
    pub messages: Vec<Message>,
    pub media: Vec<Media>,
    pub note: String,
    pub reply_token: Option<String>,
    pub app: String,
}

/// Without the messages or the description (TRN-CORE-05).
impl std::fmt::Debug for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Report")
            .field("id", &self.id)
            .field("category", &self.category)
            .field("mode", &self.mode)
            .field("messages", &self.messages.len())
            .field("media", &self.media.len())
            .finish()
    }
}

/// Whom it is about: the keys they proved they hold (R-02).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reported {
    pub ik_sign: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ik_dh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nostr_pub: Option<String>,
    pub fingerprint: String,
    /// The name they gave themselves; never one an admin wrote nor yours
    /// for them (R-10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub self_handle: Option<String>,
}

/// Where it happened, by kind and rough size only (R-18).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Context {
    /// "1:1", "group" or "request".
    #[serde(rename = "where")]
    pub place: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_size: Option<String>,
    /// For a request: "group", "link", "name" or "code".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

/// A message that goes: its order, its day and its text.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub order: u32,
    pub day: String,
    pub text: String,
    /// "reported" or "me".
    pub from: String,
}

impl std::fmt::Debug for Message {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Message {{ order: {}, from: {} }}",
            self.order, self.from
        )
    }
}

/// A photo, video or file that came: never its bytes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Media {
    pub kind: String,
    pub size: String,
    pub day: String,
}

/// The report of `draft` about `target`: what goes, as the rules say,
/// whatever the UI asked. `id` names it; `reply_token`, if you asked for
/// the answer.
pub fn build(
    inner: &InnerState,
    target: &BlockTarget,
    draft: &Draft,
    id: &str,
    reply_token: Option<&str>,
    now: i64,
) -> Result<Report, CommandError> {
    let who = block::resolve(inner, target)?;
    let mode = match (draft.category.takes_no_content(), draft.mode) {
        (true, _) => Mode::DescriptionOnly,
        (false, Mode::Messages) => Mode::Messages,
        (false, _) => Mode::KeyOnly,
    };
    let (messages, media) = match mode {
        Mode::Messages => picked(inner, target, &who, &draft.picks),
        _ => (Vec::new(), Vec::new()),
    };
    let mut report = Report {
        v: 1,
        id: id.to_string(),
        day: day_of(now),
        category: draft.category,
        mode,
        reported: Reported {
            ik_sign: who.ik_sign.clone(),
            ik_dh: who.dh_proven.then(|| who.ik_dh.clone()),
            nostr_pub: who.nostr_proven.then(|| who.nostr.clone()),
            fingerprint: who.fingerprint.clone(),
            self_handle: self_handle(inner, target, &who),
        },
        context: context(inner, target),
        messages,
        media,
        note: crate::profile::shareable(&draft.note, true, NOTE_MAX_CHARS),
        reply_token: reply_token.map(str::to_string),
        app: app_version(),
    };
    fit(&mut report)?;
    Ok(report)
}

/// What a message or a file is, to be matched with a `Pick`.
struct Candidate {
    ts: i64,
    mine: bool,
    from: Option<String>,
    text: Option<String>,
    file: Option<(String, u64, String)>,
}

impl Candidate {
    fn of(item: &HistItem) -> Option<Candidate> {
        if item.call.is_some() {
            return None;
        }
        Some(Candidate {
            ts: item.ts,
            mine: item.side == "me",
            from: item.from.clone(),
            text: item.text.clone(),
            file: item
                .file
                .as_ref()
                .map(|file| (file.mime.clone(), file.size, file.sha256.clone())),
        })
    }

    fn matches(&self, pick: &Pick) -> bool {
        let side = if self.mine { "me" } else { "them" };
        (pick.text.is_some() || pick.sha256.is_some())
            && pick.ts == self.ts
            && pick.side == side
            && pick
                .from
                .as_ref()
                .is_none_or(|from| self.from.as_ref() == Some(from))
            && pick
                .text
                .as_ref()
                .is_none_or(|text| self.text.as_ref() == Some(text))
            && pick
                .sha256
                .as_ref()
                .is_none_or(|sha| self.file.as_ref().is_some_and(|file| &file.2 == sha))
    }
}

/// What may go of the chat of `target`: theirs and yours; in a group, only
/// the reported member's and yours (design test 26).
fn candidates(inner: &InnerState, target: &BlockTarget, who: &Who) -> Vec<Candidate> {
    match target {
        BlockTarget::Contact(handle) => inner
            .history
            .get(handle)
            .into_iter()
            .flatten()
            .filter_map(Candidate::of)
            .collect(),
        BlockTarget::Member { gid, .. } => inner
            .history
            .get(&crate::session::group_convo(gid))
            .into_iter()
            .flatten()
            .filter(|item| {
                item.side == "me"
                    || (who.contact.is_some() && item.from.as_ref() == who.contact.as_ref())
            })
            .filter_map(Candidate::of)
            .collect(),
        BlockTarget::Request(ik_sign) => inner
            .requests
            .get(ik_sign)
            .map(|request| request.items.iter().filter_map(of_request).collect())
            .unwrap_or_default(),
    }
}

fn of_request(item: &Item) -> Option<Candidate> {
    match item {
        Item::Text { text, at } => Some(Candidate {
            ts: *at,
            mine: false,
            from: None,
            text: Some(text.clone()),
            file: None,
        }),
        Item::File { file, at } => Some(Candidate {
            ts: *at,
            mine: false,
            from: None,
            text: None,
            file: Some((file.mime.clone(), file.size, file.sha256.clone())),
        }),
        Item::Call { .. } => None,
    }
}

/// The messages and files of `picks` that may go, in their order, at most
/// `MAX_PICKS`: texts as text, files only as their kind, size and day.
fn picked(
    inner: &InnerState,
    target: &BlockTarget,
    who: &Who,
    picks: &[Pick],
) -> (Vec<Message>, Vec<Media>) {
    let all = candidates(inner, target, who);
    let mut chosen: Vec<&Candidate> = Vec::new();
    for pick in picks {
        if chosen.len() >= MAX_PICKS {
            break;
        }
        if let Some(found) = all.iter().find(|candidate| {
            candidate.matches(pick) && !chosen.iter().any(|c| std::ptr::eq(*c, *candidate))
        }) {
            chosen.push(found);
        }
    }
    chosen.sort_by_key(|candidate| candidate.ts);
    let mut messages = Vec::new();
    let mut media = Vec::new();
    for candidate in chosen {
        let day = day_of(candidate.ts);
        if let Some((mime, size, _)) = &candidate.file {
            media.push(Media {
                kind: media_kind(mime).into(),
                size: rough_size(*size),
                day,
            });
        } else if let Some(text) = &candidate.text {
            messages.push(Message {
                order: messages.len() as u32 + 1,
                day,
                text: text.chars().take(MESSAGE_MAX_CHARS).collect(),
                from: if candidate.mine { "me" } else { "reported" }.into(),
            });
        }
    }
    (messages, media)
}

fn media_kind(mime: &str) -> &'static str {
    match mime.split('/').next() {
        Some("image") => "photo",
        Some("video") => "video",
        Some("audio") => "audio",
        _ => "file",
    }
}

/// "~1 MB", "~300 KB": one significant figure (R-18).
fn rough_size(bytes: u64) -> String {
    fn one_figure(n: u64) -> u64 {
        let mut scale = 1;
        while n / scale >= 10 {
            scale *= 10;
        }
        ((n + scale / 2) / scale * scale).max(1)
    }
    const MB: u64 = 1024 * 1024;
    if bytes >= MB {
        format!("~{} MB", one_figure((bytes + MB / 2) / MB))
    } else {
        format!("~{} KB", one_figure(bytes.div_ceil(1024)))
    }
}

/// The name they gave themselves: their profile's, or a request's when it
/// did not come from a group (whose name an admin wrote, R-10).
fn self_handle(inner: &InnerState, target: &BlockTarget, who: &Who) -> Option<String> {
    if let BlockTarget::Request(ik_sign) = target {
        if let Some(request) = inner.requests.get(ik_sign) {
            if !matches!(request.via, Via::Group { .. }) {
                return Some(request.name.clone());
            }
        }
    }
    let contact = who.contact.as_ref()?;
    inner.profiles.contacts.get(contact)?.name.clone()
}

/// Where it happened: the place, a group's size by ranges and where a
/// request came from (R-18).
fn context(inner: &InnerState, target: &BlockTarget) -> Context {
    match target {
        BlockTarget::Contact(_) => Context {
            place: "1:1".into(),
            group_size: None,
            via: None,
        },
        BlockTarget::Member { gid, .. } => Context {
            place: "group".into(),
            group_size: inner
                .groups
                .get(gid)
                .map(|roster| size_range(roster.members.len()).into()),
            via: None,
        },
        BlockTarget::Request(ik_sign) => Context {
            place: "request".into(),
            group_size: None,
            via: inner.requests.get(ik_sign).map(|request| {
                match request.via {
                    Via::Group { .. } => "group",
                    Via::Link { .. } => "link",
                    Via::Name => "name",
                    Via::Code { .. } => "code",
                }
                .into()
            }),
        },
    }
}

fn size_range(members: usize) -> &'static str {
    match members {
        0..=2 => "2",
        3..=10 => "3-10",
        11..=50 => "11-50",
        _ => "51+",
    }
}

/// The app's version without its patch (R-18): "0.1".
fn app_version() -> String {
    let version = env!("CARGO_PKG_VERSION");
    version.splitn(3, '.').take(2).collect::<Vec<_>>().join(".")
}

/// Make the report fit in the envelope: the longest message is cut in half
/// until it does.
fn fit(report: &mut Report) -> Result<(), CommandError> {
    loop {
        let len = serde_json::to_vec(report)
            .map_err(|error| CommandError::internal(error.to_string()))?
            .len();
        if len < PLAIN_LEN {
            return Ok(());
        }
        let Some(longest) = report
            .messages
            .iter_mut()
            .filter(|message| !message.text.is_empty())
            .max_by_key(|message| message.text.len())
        else {
            return Err(CommandError::internal("the report does not fit"));
        };
        let half = longest.text.chars().count() / 2;
        longest.text = longest.text.chars().take(half).collect();
    }
}

/// A code for a report: "R-7KQ2-9MXD", with no 0, O, 1 or I.
pub fn new_id() -> String {
    let bytes: [u8; 8] = random_array();
    let letter = |byte: u8| ALPHABET[(byte & 31) as usize] as char;
    let first: String = bytes[..4].iter().map(|b| letter(*b)).collect();
    let second: String = bytes[4..].iter().map(|b| letter(*b)).collect();
    format!("R-{first}-{second}")
}

/// A token for Trino's answer: 32 random bytes, in hex.
pub fn new_reply_token() -> String {
    hex::encode(random_array::<32>())
}

/// The key of the envelope: HKDF of the shared secret, bound to `kid`, the
/// ephemeral key and Trino's (design §6.4).
fn envelope_key(
    shared: &[u8; 32],
    kid: u8,
    eph_pub: &[u8; 32],
    report_pub: &[u8; 32],
) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    let info = [&[kid][..], eph_pub, report_pub].concat();
    hkdf_expand(shared, LABEL, &info, 32).map_err(|error| CommandError::internal(error.to_string()))
}

fn aad(kid: u8) -> Vec<u8> {
    [LABEL, &[kid]].concat()
}

/// `json` sealed for Trino's key `report_pub` of id `kid`, to `SEALED_LEN`.
pub fn seal(json: &[u8], kid: u8, report_pub: &[u8; 32]) -> Result<Vec<u8>, CommandError> {
    if json.len() >= PLAIN_LEN {
        return Err(CommandError::internal("the report does not fit"));
    }
    let eph = generate_x25519();
    let mut shared = x25519_derive_shared(&eph.priv_bytes, report_pub);
    let key = envelope_key(&shared, kid, &eph.pub_bytes, report_pub);
    shared.zeroize();
    let key = key?;
    let mut padded = Zeroizing::new(Vec::with_capacity(PLAIN_LEN));
    padded.extend_from_slice(json);
    padded.push(0x80);
    padded.resize(PLAIN_LEN, 0);
    let (ciphertext, nonce) = aes_gcm_encrypt(&key, &padded, Some(&aad(kid)))
        .map_err(|error| CommandError::internal(error.to_string()))?;
    let mut sealed = Vec::with_capacity(SEALED_LEN);
    sealed.push(SEAL_VERSION);
    sealed.push(kid);
    sealed.extend_from_slice(&eph.pub_bytes);
    sealed.extend_from_slice(&nonce);
    sealed.extend_from_slice(&ciphertext);
    debug_assert_eq!(sealed.len(), SEALED_LEN);
    Ok(sealed)
}

/// What `seal` sealed, with the private key of `kid`; what Trino's tool
/// does (UR-6). `None` if anything does not check out.
pub fn open(sealed: &[u8], kid: u8, report_priv: &[u8; 32]) -> Option<Vec<u8>> {
    if sealed.len() != SEALED_LEN || sealed[0] != SEAL_VERSION || sealed[1] != kid {
        return None;
    }
    let eph_pub: [u8; 32] = sealed[2..34].try_into().ok()?;
    let nonce = &sealed[34..HEADER_LEN];
    let report_pub = x25519_public(report_priv);
    let mut shared = x25519_derive_shared(report_priv, &eph_pub);
    let key = envelope_key(&shared, kid, &eph_pub, &report_pub).ok()?;
    shared.zeroize();
    let mut padded =
        Zeroizing::new(aes_gcm_decrypt(&key, &sealed[HEADER_LEN..], nonce, Some(&aad(kid))).ok()?);
    let end = padded.iter().rposition(|byte| *byte != 0)?;
    if padded[end] != 0x80 {
        return None;
    }
    padded.truncate(end);
    Some(padded.to_vec())
}

/// The public key of `private`: X25519 with the base point.
fn x25519_public(private: &[u8; 32]) -> [u8; 32] {
    let mut base = [0u8; 32];
    base[0] = 9;
    x25519_derive_shared(private, &base)
}

/// The digest the proof of work is counted on: bound to the envelope and
/// to the day (R-05).
pub fn pow_digest(sealed_sha256: &[u8; 32], day: &str, nonce: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(POW_LABEL);
    hasher.update(day.as_bytes());
    hasher.update(sealed_sha256);
    hasher.update(nonce.to_be_bytes());
    hasher.finalize().into()
}

/// How many leading zero bits `digest` has.
pub fn leading_zero_bits(digest: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for byte in digest {
        if *byte == 0 {
            bits += 8;
        } else {
            return bits + byte.leading_zeros();
        }
    }
    bits
}

/// A nonce whose `pow_digest` has `bits` leading zero bits.
pub fn mine(sealed: &[u8], day: &str, bits: u32) -> u64 {
    let hash = sha256(sealed);
    (0u64..)
        .find(|nonce| leading_zero_bits(&pow_digest(&hash, day, *nonce)) >= bits)
        .expect("a nonce is found long before u64 ends")
}

/// The UTC day of `ts`, as "2026-10-14".
pub fn day_of(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

/// One report here: its envelope while it waits, then only its code, its
/// day, the token of the answer you asked for and the answer.
#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub created_at: i64,
    /// The envelope, in base64, until it goes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sealed: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sent_at: Option<i64>,
    #[serde(default)]
    attempts: u32,
    #[serde(default)]
    next_at: i64,
    #[serde(default)]
    bits: u32,
    /// The Worker refused it for good: it will not go.
    #[serde(default)]
    refused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reply_token: Option<String>,
    #[serde(default)]
    reply_checked_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reply: Option<String>,
}

/// Without the envelope or the token.
impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry")
            .field("id", &self.id)
            .field("created_at", &self.created_at)
            .field("waiting", &self.sealed.is_some())
            .field("sent_at", &self.sent_at)
            .finish()
    }
}

/// The reports of this account, in `account.bin`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportBook {
    #[serde(default)]
    entries: Vec<Entry>,
}

/// Where a report stands, as "Reportes enviados" says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SentState {
    /// Sealed, waiting for Tor or the Worker: it can be cancelled.
    Waiting,
    Sent,
    /// The Worker refused it: it will not go.
    Refused,
}

/// One row of "Reportes enviados": the code, the day, whether it went and
/// Trino's answer. Never its kind, whom or what (R-06).
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SentView {
    pub id: String,
    pub created_at: i64,
    pub state: SentState,
    /// It has not gone in three days, or was refused: write to abuso@.
    pub write_instead: bool,
    pub reply: Option<String>,
}

impl ReportBook {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Take out what is 30 days old by `now`, with its envelope, its token
    /// and its answer (26 Oct). Whether anything went.
    pub fn prune(&mut self, now: i64) -> bool {
        let before = self.entries.len();
        self.entries.retain_mut(|entry| {
            let keep = now - entry.created_at < KEEP_FOR;
            if !keep {
                entry.wipe();
            }
            keep
        });
        self.entries.len() != before
    }

    /// Cancel the report `id` while it waits: it goes, and is never sent.
    pub fn cancel(&mut self, id: &str) -> Result<(), CommandError> {
        let at = self
            .entries
            .iter()
            .position(|entry| entry.id == id && entry.sealed.is_some())
            .ok_or_else(|| crate::contacts::not_found("no report waits with that code"))?;
        self.entries.remove(at).wipe();
        Ok(())
    }

    /// Empty it, as a lock does.
    pub fn forget(&mut self) {
        for entry in &mut self.entries {
            entry.wipe();
        }
        *self = ReportBook::default();
    }
}

impl Entry {
    fn wipe(&mut self) {
        for secret in [&mut self.sealed, &mut self.reply_token, &mut self.reply] {
            if let Some(value) = secret.as_mut() {
                value.zeroize();
            }
        }
    }

    fn state(&self) -> SentState {
        match (self.sent_at, self.refused) {
            (Some(_), _) => SentState::Sent,
            (None, true) => SentState::Refused,
            (None, false) => SentState::Waiting,
        }
    }
}

/// "Reportes enviados", the latest first; nothing 30 days old.
pub fn list(inner: &InnerState, now: i64) -> Vec<SentView> {
    let mut shown: Vec<SentView> = inner
        .reports
        .entries
        .iter()
        .filter(|entry| now - entry.created_at < KEEP_FOR)
        .map(|entry| {
            let state = entry.state();
            SentView {
                id: entry.id.clone(),
                created_at: entry.created_at,
                state,
                write_instead: state == SentState::Refused
                    || (state == SentState::Waiting && now - entry.created_at >= FALLBACK_AFTER),
                reply: entry.reply.clone(),
            }
        })
        .collect();
    shown.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(a.id.cmp(&b.id)));
    shown
}

/// What the three steps say of whom you report, before anything is made.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Preview {
    /// Their fingerprint, as the confirmation shows it ("1A2B 3C4D …").
    pub fingerprint: String,
    /// The name they gave themselves, if known: the one that goes.
    pub self_handle: Option<String>,
    /// This build can seal a report (it has Trino's key); if not, the UI
    /// offers the e-mail (U24).
    pub can_send: bool,
}

/// `report_preview`: whom `target` names, for the confirmation.
pub fn preview(
    inner: &InnerState,
    target: &BlockTarget,
    keys: &[(u8, [u8; 32])],
) -> Result<Preview, CommandError> {
    let who = block::resolve(inner, target)?;
    Ok(Preview {
        self_handle: self_handle(inner, target, &who),
        fingerprint: who.fingerprint,
        can_send: !keys.is_empty(),
    })
}

/// What `create` did.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Created {
    pub id: String,
    pub day: String,
    /// Sealed and waiting to go; `false` when this build has no key, and
    /// nothing was kept: the UI offers the e-mail (U24).
    pub queued: bool,
}

/// Make the report of `draft` about `target`, seal it for the highest key
/// of `keys` and queue it. With no key, nothing is kept.
pub fn create(
    inner: &mut InnerState,
    target: &BlockTarget,
    draft: &Draft,
    keys: &[(u8, [u8; 32])],
    now: i64,
) -> Result<Created, CommandError> {
    let id = new_id();
    let Some((kid, report_pub)) = keys.iter().max_by_key(|(kid, _)| *kid) else {
        // Built all the same, so a target that does not exist still says so.
        build(inner, target, draft, &id, None, now)?;
        return Ok(Created {
            id,
            day: day_of(now),
            queued: false,
        });
    };
    let token = draft.want_reply.then(new_reply_token);
    let report = build(inner, target, draft, &id, token.as_deref(), now)?;
    let json = Zeroizing::new(
        serde_json::to_vec(&report).map_err(|error| CommandError::internal(error.to_string()))?,
    );
    let sealed = seal(&json, *kid, report_pub)?;
    inner.reports.prune(now);
    inner.reports.entries.push(Entry {
        id: id.clone(),
        created_at: now,
        sealed: Some(BASE64.encode(&sealed)),
        next_at: now,
        reply_token: token,
        ..Entry::default()
    });
    Ok(Created {
        id,
        day: report.day,
        queued: true,
    })
}

/// Where reports go, through which `Net`, with which keys.
pub struct ReportClient {
    net: Arc<Net>,
    http: HttpClient,
    url: String,
    keys: Vec<(u8, [u8; 32])>,
    timeout: Duration,
    /// The least proof of work mined: `POW_BITS`.
    pow_floor: u32,
}

impl ReportClient {
    /// The Worker and the keys of this build (none yet, UR-6), or in a
    /// debug build those of `TRINO_REPORTS_URL` and `TRINO_REPORTS_KEY`
    /// (`kid:hex`), to try it against a local Worker.
    pub fn configured(net: Arc<Net>) -> Self {
        let mut url = REPORTS_URL.to_string();
        if cfg!(debug_assertions) {
            if let Ok(local) = std::env::var("TRINO_REPORTS_URL") {
                url = local;
            }
        }
        ReportClient::new(
            Arc::clone(&net),
            HttpClient::new(net),
            url,
            configured_keys(),
        )
    }

    pub fn new(net: Arc<Net>, http: HttpClient, url: String, keys: Vec<(u8, [u8; 32])>) -> Self {
        ReportClient {
            net,
            http,
            url,
            keys,
            timeout: Duration::from_secs(60),
            pow_floor: POW_BITS,
        }
    }

    /// The keys reports are sealed for.
    pub fn keys(&self) -> &[(u8, [u8; 32])] {
        &self.keys
    }
}

/// The keys of this build (`REPORT_KEYS`, none yet), and in a debug build
/// the one of `TRINO_REPORTS_KEY` (`kid:hex`).
pub fn configured_keys() -> Vec<(u8, [u8; 32])> {
    let mut keys = REPORT_KEYS.to_vec();
    if cfg!(debug_assertions) {
        if let Some(key) = std::env::var("TRINO_REPORTS_KEY")
            .ok()
            .as_deref()
            .and_then(parse_key)
        {
            keys.push(key);
        }
    }
    keys
}

/// `kid:hex` as a key.
fn parse_key(text: &str) -> Option<(u8, [u8; 32])> {
    let (kid, key) = text.split_once(':')?;
    let key = crate::identity::decode_array_32(key.trim()).ok()?;
    Some((kid.trim().parse().ok()?, key))
}

/// What the Worker said to one envelope.
#[derive(Debug, PartialEq)]
enum Sent {
    Taken,
    /// The day's reports are full: after 00:00 UTC.
    Tomorrow,
    /// More proof of work, now.
    MoreWork(u32),
    /// It will not take it.
    Refused,
    /// Tor, the network or the Worker failed: later.
    Later,
}

/// What an answer's look found.
enum Answer {
    Text(String),
    NotYet,
    Later,
}

impl ReportClient {
    fn deadlines(&self) -> Deadlines {
        Deadlines {
            connect: self.timeout,
            total: self.timeout,
            idle: None,
        }
    }

    /// POST the envelope with its proof of work, on a token of its own.
    async fn post(&self, sealed: Vec<u8>, day: &str, nonce: u64) -> Sent {
        let iso = self.net.session().iso(REPORT_ISO, "send");
        let request = Request::post(&self.url)
            .and_then(|request| request.header("content-type", "application/octet-stream"))
            .and_then(|request| request.header("trino-pow-day", day))
            .and_then(|request| request.header("trino-pow-nonce", &nonce.to_string()));
        let Ok(request) = request else {
            return Sent::Refused;
        };
        let mut response = match self
            .http
            .send(request.body(sealed), &iso, self.deadlines())
            .await
        {
            Ok(response) => response,
            Err(_) => return Sent::Later,
        };
        let status = response.status();
        let body = response.read_capped(1024).await.unwrap_or_default();
        match status {
            200 | 201 => Sent::Taken,
            429 => Sent::Tomorrow,
            403 => match asked_bits(&body) {
                Some(bits) => Sent::MoreWork(bits),
                None => Sent::Later,
            },
            400 | 413 => Sent::Refused,
            _ => Sent::Later,
        }
    }

    /// Ask for the answer left under the SHA-256 of `token`.
    async fn answer(&self, token: &str) -> Answer {
        let Ok(bytes) = hex::decode(token) else {
            return Answer::NotYet;
        };
        let name = hex::encode(sha256(&bytes));
        let iso = self.net.session().iso(REPORT_ISO, "reply");
        let Ok(request) = Request::get(&format!("{}/reply/{name}", self.url)) else {
            return Answer::Later;
        };
        let mut response = match self.http.send(request, &iso, self.deadlines()).await {
            Ok(response) => response,
            Err(_) => return Answer::Later,
        };
        match response.status() {
            200 => match response.read_capped(REPLY_MAX_BYTES).await {
                Ok(body) => open_reply(token, &body).map_or(Answer::Later, Answer::Text),
                Err(_) => Answer::Later,
            },
            404 => Answer::NotYet,
            _ => Answer::Later,
        }
    }
}

/// The bits a 403 asks for, if it asks for more work within reason.
fn asked_bits(body: &[u8]) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_slice(body).ok()?;
    if value.get("error").and_then(|e| e.as_str()) != Some("pow") {
        return None;
    }
    let bits = u32::try_from(value.get("bits")?.as_u64()?).ok()?;
    (bits <= MAX_POW_BITS).then_some(bits)
}

/// The key an answer is sealed with, from its token.
fn reply_key(token: &str) -> Option<Zeroizing<Vec<u8>>> {
    let secret = Zeroizing::new(hex::decode(token).ok()?);
    hkdf_expand(&secret, REPLY_LABEL, b"answer", 32).ok()
}

/// The answer Trino left for `token`, sealed with it: `nonce ‖ AES-GCM` of
/// `{"v":1,"text":…}`. What Trino's tool does (UR-6).
pub fn seal_reply(token: &str, text: &str) -> Vec<u8> {
    let key = reply_key(token).expect("a token in hex");
    let json = serde_json::json!({ "v": 1, "text": text }).to_string();
    let (ciphertext, nonce) =
        aes_gcm_encrypt(&key, json.as_bytes(), Some(REPLY_LABEL)).expect("a key of 32 bytes");
    [&nonce[..], &ciphertext].concat()
}

/// The text of an answer, cleaned as a profile's is.
fn open_reply(token: &str, body: &[u8]) -> Option<String> {
    let key = reply_key(token)?;
    if body.len() <= NONCE_SIZE {
        return None;
    }
    let (nonce, ciphertext) = body.split_at(NONCE_SIZE);
    let plain = Zeroizing::new(aes_gcm_decrypt(&key, ciphertext, nonce, Some(REPLY_LABEL)).ok()?);
    let value: serde_json::Value = serde_json::from_slice(&plain).ok()?;
    let text = value.get("text")?.as_str()?;
    let text = crate::profile::shareable(text, false, REPLY_MAX_CHARS);
    (!text.is_empty()).then_some(text)
}

/// The wait after the `attempts`-th failure.
fn backoff(attempts: u32) -> i64 {
    FIRST_RETRY
        .saturating_mul(1i64 << attempts.min(20))
        .min(LAST_RETRY)
}

/// Send what waits and is due, and ask for the answers that are due, by
/// `client`. Whether anything changed, saved then.
pub async fn deliver(inner: &Arc<Mutex<InnerState>>, client: &ReportClient, now: i64) -> bool {
    let (sends, looks, pruned) = {
        let mut guard = inner.lock().await;
        let pruned = guard.reports.prune(now);
        let sends: Vec<(String, Vec<u8>, u32)> = guard
            .reports
            .entries
            .iter()
            .filter(|entry| entry.sealed.is_some() && !entry.refused && entry.next_at <= now)
            .filter_map(|entry| {
                let sealed = BASE64.decode(entry.sealed.as_deref()?).ok()?;
                Some((entry.id.clone(), sealed, entry.bits.max(client.pow_floor)))
            })
            .collect();
        let looks: Vec<(String, String)> = guard
            .reports
            .entries
            .iter()
            .filter(|entry| entry.sent_at.is_some() && entry.reply.is_none())
            .filter(|entry| entry.reply_checked_at + REPLY_EVERY <= now)
            .filter_map(|entry| Some((entry.id.clone(), entry.reply_token.clone()?)))
            .collect();
        (sends, looks, pruned)
    };
    let mut changed = pruned;
    for (id, sealed, bits) in sends {
        let day = day_of(now);
        let nonce = {
            let (sealed, day) = (sealed.clone(), day.clone());
            tokio::task::spawn_blocking(move || mine(&sealed, &day, bits))
                .await
                .unwrap_or_default()
        };
        let sent = client.post(sealed, &day, nonce).await;
        let mut guard = inner.lock().await;
        // Cancelled meanwhile: nothing to keep of it.
        let Some(entry) = guard
            .reports
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
        else {
            continue;
        };
        match sent {
            Sent::Taken => {
                if let Some(sealed) = entry.sealed.as_mut() {
                    sealed.zeroize();
                }
                entry.sealed = None;
                entry.sent_at = Some(now);
            }
            Sent::Tomorrow => entry.next_at = (now / DAY + 1) * DAY,
            Sent::MoreWork(more) if more > entry.bits.max(client.pow_floor) => {
                entry.bits = more;
                entry.next_at = now;
            }
            Sent::Refused => entry.refused = true,
            Sent::MoreWork(_) | Sent::Later => {
                entry.attempts = entry.attempts.saturating_add(1);
                entry.next_at = now + backoff(entry.attempts);
            }
        }
        changed = true;
    }
    for (id, token) in looks {
        let answer = client.answer(&token).await;
        let mut guard = inner.lock().await;
        let Some(entry) = guard
            .reports
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
        else {
            continue;
        };
        match answer {
            Answer::Text(text) => entry.reply = Some(text),
            Answer::NotYet | Answer::Later => entry.reply_checked_at = now,
        }
        changed = true;
    }
    if changed {
        let guard = inner.lock().await;
        if crate::storage::persist_account(&guard).is_err() {
            crate::session::dbg_log("the reports could not be saved");
        }
    }
    changed
}

/// When `deliver` has something to do next, if ever: an envelope due, an
/// answer to look for, or a report to forget.
pub fn next_wake(book: &ReportBook, _now: i64) -> Option<i64> {
    book.entries
        .iter()
        .filter_map(|entry| {
            let send = (entry.sealed.is_some() && !entry.refused).then_some(entry.next_at);
            let look =
                (entry.sent_at.is_some() && entry.reply.is_none() && entry.reply_token.is_some())
                    .then_some(entry.reply_checked_at + REPLY_EVERY);
            [send, look].into_iter().flatten().min()
        })
        .min()
}

/// What the UI hears when the reports changed: nothing of them.
pub const REPORTS_EVENT: &str = "reports-changed";

/// Send the session's reports as they come due, by `client`, until a lock
/// ends the session or a later watcher replaces this one. `report_watch`
/// wakes it when one is made.
pub fn watch(
    events: Arc<dyn crate::events::EventSink>,
    inner: Arc<Mutex<InnerState>>,
    client: Arc<ReportClient>,
    nostr_pub: String,
) {
    tokio::spawn(async move {
        let (me, wake) = {
            let mut guard = inner.lock().await;
            guard.report_watcher += 1;
            (guard.report_watcher, Arc::clone(&guard.report_watch))
        };
        loop {
            {
                let guard = inner.lock().await;
                let mine = guard
                    .identity
                    .as_ref()
                    .is_some_and(|identity| hex::encode(identity.nostr.pub_bytes) == nostr_pub);
                if !mine || guard.report_watcher != me {
                    return;
                }
            }
            let now = crate::session::unix_now();
            if deliver(&inner, &client, now).await {
                events.emit(REPORTS_EVENT, &serde_json::json!({}));
            }
            let next = next_wake(&inner.lock().await.reports, now);
            let pause = next.map_or(3_600, |at| {
                (at - crate::session::unix_now()).clamp(30, 3_600)
            });
            tokio::select! {
                () = wake.notified() => {}
                () = tokio::time::sleep(Duration::from_secs(pause as u64)) => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::group::FileRef;
    use crate::identity::{create_identity, generate_x25519, Identity};
    use crate::session::tests::{friend, ik, roster_of, NOW};
    use crate::state::HistItem;
    use std::sync::Mutex as StdMutex;
    use trino_net::mock::{Forbidden, Mock};
    use trino_net::mock_http::{self, Received, Reply};
    use trino_net::Transport;

    /// A key of Trino's reports made for the tests: never a real one.
    fn test_key() -> (u8, crate::identity::KeyPair) {
        (7, generate_x25519())
    }

    fn text_item(side: &str, from: Option<&str>, text: &str, ts: i64) -> HistItem {
        HistItem {
            side: side.into(),
            from: from.map(str::to_string),
            text: Some(text.into()),
            file: None,
            call: None,
            ts,
        }
    }

    fn photo() -> FileRef {
        FileRef {
            url: "https://blossom.example/abc".into(),
            key: "cd".repeat(32),
            sha256: "e".repeat(64),
            mime: "image/jpeg".into(),
            name: "foto.jpg".into(),
            size: 1_150_000,
            thumb: Some("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==".into()),
        }
    }

    /// Me, with Lina as the contact "Lina Ríos" (her profile says "lina"),
    /// and her chat: three of hers, one of mine and a photo.
    fn me_and_lina() -> (Identity, Identity, InnerState) {
        let (me, lina) = (create_identity(), create_identity());
        let mut inner = InnerState {
            identity: Some(me.clone()),
            handle: Some("rechita".into()),
            ..InnerState::default()
        };
        inner
            .friends
            .insert("Lina Ríos".into(), friend(&lina, "Lina Ríos"));
        inner
            .profiles
            .contacts
            .entry("Lina Ríos".into())
            .or_default()
            .name = Some("lina".into());
        let day = 1791916200; // 13 Oct 2026, 18:30 UTC
        let mut photo_item = text_item("them", None, "", day + 120);
        photo_item.text = None;
        photo_item.file = Some(photo());
        inner.history.insert(
            "Lina Ríos".into(),
            vec![
                text_item("them", None, "Si no me contestas, voy a ir a tu casa.", day),
                text_item("me", None, "Por favor, déjame en paz.", day + 60),
                photo_item,
                text_item("them", None, "Sé dónde trabajas.", day + 180),
            ],
        );
        (me, lina, inner)
    }

    fn pick(item: &HistItem) -> Pick {
        Pick {
            ts: item.ts,
            side: item.side.clone(),
            from: item.from.clone(),
            text: item.text.clone(),
            sha256: item.file.as_ref().map(|file| file.sha256.clone()),
        }
    }

    fn draft(category: Category, mode: Mode, picks: Vec<Pick>) -> Draft {
        Draft {
            category,
            mode,
            picks,
            note: "Me escribe todos los días aunque le pedí que no.".into(),
            want_reply: false,
        }
    }

    fn lina() -> BlockTarget {
        BlockTarget::Contact("Lina Ríos".into())
    }

    fn all_of_hers(inner: &InnerState) -> Vec<Pick> {
        inner.history["Lina Ríos"].iter().map(pick).collect()
    }

    #[test]
    fn a_report_says_whom_what_and_when_by_the_day() {
        let (_, lina_id, mut inner) = me_and_lina();
        // Her Nostr and DH keys are proven: she wrote to me.
        let _ = &mut inner;
        let picks = all_of_hers(&inner);
        let report = build(
            &inner,
            &lina(),
            &draft(Category::Harassment, Mode::Messages, picks),
            "R-7KQ2-9MXD",
            None,
            NOW,
        )
        .unwrap();
        assert_eq!(report.v, 1);
        assert_eq!(report.id, "R-7KQ2-9MXD");
        assert_eq!(report.day, day_of(NOW));
        assert_eq!(report.reported.ik_sign, ik(&lina_id));
        assert!(report.reported.nostr_pub.is_some() && report.reported.ik_dh.is_some());
        assert_eq!(report.reported.self_handle.as_deref(), Some("lina"));
        assert_eq!(report.context.place, "1:1");
        let texts: Vec<(&str, &str)> = report
            .messages
            .iter()
            .map(|m| (m.from.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            [
                ("reported", "Si no me contestas, voy a ir a tu casa."),
                ("me", "Por favor, déjame en paz."),
                ("reported", "Sé dónde trabajas."),
            ]
        );
        assert_eq!(
            report.messages.iter().map(|m| m.order).collect::<Vec<_>>(),
            [1, 2, 3]
        );
        assert_eq!(report.messages[0].day, "2026-10-13");
        assert_eq!(
            report.media,
            [Media {
                kind: "photo".into(),
                size: "~1 MB".into(),
                day: "2026-10-13".into()
            }]
        );
        assert_eq!(
            report.note,
            "Me escribe todos los días aunque le pedí que no."
        );
        assert_eq!(report.reply_token, None);
        assert!(!report.app.is_empty() && report.app.matches('.').count() == 1);
    }

    /// Design test 23 (R-17, R-18): no key of mine, no name of mine, no id
    /// of an event, no group's id or name, not the name I gave her, no hour.
    #[test]
    fn ur5_23_the_report_carries_nothing_of_mine_nor_an_hour() {
        let (me, _, inner) = me_and_lina();
        let report = build(
            &inner,
            &lina(),
            &draft(Category::Harassment, Mode::Messages, all_of_hers(&inner)),
            "R-7KQ2-9MXD",
            Some(&"ab".repeat(32)),
            NOW,
        )
        .unwrap();
        let json = serde_json::to_string(&report).unwrap();
        for mine in [
            hex::encode(me.ik_sign.pub_bytes),
            hex::encode(me.ik_dh.pub_bytes),
            hex::encode(me.nostr.pub_bytes),
            "rechita".into(),
            "Lina Ríos".into(),
            NOW.to_string(),
            "1791916200".into(),
            "18:30".into(),
        ] {
            assert!(!json.contains(&mine), "{mine} in the report");
        }
        for field in ["\"ts\"", "event", "gid", "group_id", "\"at\""] {
            assert!(!json.contains(field), "{field} in the report");
        }
        assert_eq!(
            report.reply_token.as_deref(),
            Some("ab".repeat(32).as_str())
        );
    }

    /// Design test 24: a child at risk and intimate images carry no
    /// message nor any media, whatever the UI sent.
    #[test]
    fn ur5_24_a_child_at_risk_and_intimate_images_carry_no_content() {
        let (_, _, inner) = me_and_lina();
        for category in [Category::Child, Category::Ncii] {
            let report = build(
                &inner,
                &lina(),
                &draft(category, Mode::Messages, all_of_hers(&inner)),
                "R-AAAA-BBBB",
                None,
                NOW,
            )
            .unwrap();
            assert_eq!(report.mode, Mode::DescriptionOnly, "{category:?}");
            assert!(report.messages.is_empty() && report.media.is_empty());
            assert_eq!(
                report.note,
                "Me escribe todos los días aunque le pedí que no."
            );
        }
        // Spam with only the key carries none either.
        let report = build(
            &inner,
            &lina(),
            &draft(Category::Spam, Mode::KeyOnly, all_of_hers(&inner)),
            "R-AAAA-BBBB",
            None,
            NOW,
        )
        .unwrap();
        assert!(report.messages.is_empty() && report.media.is_empty());
    }

    /// Design test 25: never the bytes of a picture or video, its address,
    /// its key nor its name.
    #[test]
    fn ur5_25_never_the_bytes_of_a_photo() {
        let (_, _, inner) = me_and_lina();
        let report = build(
            &inner,
            &lina(),
            &draft(Category::Harassment, Mode::Messages, all_of_hers(&inner)),
            "R-AAAA-BBBB",
            None,
            NOW,
        )
        .unwrap();
        let json = serde_json::to_string(&report).unwrap();
        for leak in [
            "data:",
            "/9j/",
            "blossom",
            &"cd".repeat(32),
            "foto.jpg",
            &"e".repeat(64),
        ] {
            assert!(!json.contains(leak), "{leak} in the report");
        }
    }

    /// Design test 26: in a group, only the reported member's messages and
    /// mine that I marked; never another member's.
    #[test]
    fn ur5_26_in_a_group_only_theirs_and_mine() {
        let (me, ana, papa) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&me, &[(&ana, "ana"), (&papa, "papá")]);
        let gid = roster.group_id.clone();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };
        inner.friends.insert("ana".into(), friend(&ana, "ana"));
        inner.friends.insert("papá".into(), friend(&papa, "papá"));
        inner.groups.insert(gid.clone(), roster);
        let items = vec![
            text_item("them", Some("ana"), "de ana", NOW - 30),
            text_item("them", Some("papá"), "de papá", NOW - 20),
            text_item("me", None, "mío", NOW - 10),
        ];
        let picks = items.iter().map(pick).collect();
        inner
            .history
            .insert(crate::session::group_convo(&gid), items);
        let target = BlockTarget::Member {
            gid: gid.clone(),
            ik_sign: ik(&ana),
        };
        let report = build(
            &inner,
            &target,
            &draft(Category::Harassment, Mode::Messages, picks),
            "R-AAAA-BBBB",
            None,
            NOW,
        )
        .unwrap();
        let texts: Vec<&str> = report.messages.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, ["de ana", "mío"]);
        assert_eq!(report.context.place, "group");
        assert_eq!(report.context.group_size.as_deref(), Some("3-10"));
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains(&gid) && !json.contains("amigos"));
    }

    #[test]
    fn at_most_eleven_messages_and_five_hundred_characters() {
        let (_, _, mut inner) = me_and_lina();
        let many: Vec<HistItem> = (0..20)
            .map(|n| text_item("them", None, &format!("mensaje {n}"), NOW - 100 + n))
            .collect();
        let picks = many.iter().map(pick).collect();
        inner.history.insert("Lina Ríos".into(), many);
        let mut long = draft(Category::Other, Mode::Messages, picks);
        long.note = "a".repeat(800);
        let report = build(&inner, &lina(), &long, "R-AAAA-BBBB", None, NOW).unwrap();
        assert_eq!(report.messages.len(), MAX_PICKS);
        assert_eq!(report.note.chars().count(), NOTE_MAX_CHARS);
    }

    /// A request: what it held, by where it came from.
    #[test]
    fn a_request_is_reported_with_what_it_held() {
        let (me, stranger) = (create_identity(), create_identity());
        let mut inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };
        let incoming = crate::requests::Incoming {
            bundle: crate::identity::public_bundle_for(&stranger),
            name: "ana".into(),
            via: crate::requests::Via::Name,
            item: crate::requests::Item::Text {
                text: "hola, compra aquí".into(),
                at: NOW - 5,
            },
            nostr_proven: true,
            dh_proven: false,
        };
        crate::requests::receive(&mut inner, incoming, NOW);
        let picks = vec![Pick {
            ts: NOW - 5,
            side: "them".into(),
            text: Some("hola, compra aquí".into()),
            ..Pick::default()
        }];
        let report = build(
            &inner,
            &BlockTarget::Request(ik(&stranger)),
            &draft(Category::Spam, Mode::Messages, picks),
            "R-AAAA-BBBB",
            None,
            NOW,
        )
        .unwrap();
        assert_eq!(report.context.place, "request");
        assert_eq!(report.context.via.as_deref(), Some("name"));
        assert_eq!(report.reported.self_handle.as_deref(), Some("ana"));
        assert!(report.reported.nostr_pub.is_some());
        assert_eq!(report.reported.ik_dh, None, "not proven");
        assert_eq!(report.messages[0].text, "hola, compra aquí");
    }

    #[test]
    fn the_preview_names_her_by_her_own_name_and_says_if_it_can_go() {
        let (_, lina_id, inner) = me_and_lina();
        let shown = preview(&inner, &lina(), REPORT_KEYS).unwrap();
        let fp = crate::block::bundle_fingerprint(&crate::identity::public_bundle_for(&lina_id));
        assert_eq!(shown.fingerprint, fp);
        assert_eq!(shown.self_handle.as_deref(), Some("lina"));
        assert!(!shown.can_send, "no key of Trino's yet");
        let key = test_key();
        assert!(
            preview(&inner, &lina(), &[(key.0, key.1.pub_bytes)])
                .unwrap()
                .can_send
        );
        assert!(preview(&inner, &BlockTarget::Contact("nadie".into()), REPORT_KEYS).is_err());
    }

    #[test]
    fn a_code_has_no_letters_that_pass_for_others() {
        for _ in 0..50 {
            let id = new_id();
            assert_eq!(id.len(), 11, "{id}");
            assert!(id.starts_with("R-") && &id[6..7] == "-", "{id}");
            assert!(
                id[2..]
                    .chars()
                    .all(|c| c == '-' || "23456789ABCDEFGHJKLMNPQRSTUVWXYZ".contains(c)),
                "{id}"
            );
        }
        assert_ne!(new_id(), new_id());
    }

    /// Design test 27 (R-18, R-32): 16 KiB exactly; it opens with the key
    /// of its `kid` and with no other; another `kid` or a changed byte fail.
    #[test]
    fn ur5_27_the_envelope_is_16_kib_and_opens_only_with_its_key() {
        let (kid, key) = test_key();
        let json = br#"{"v":1,"id":"R-AAAA-BBBB"}"#;
        let sealed = seal(json, kid, &key.pub_bytes).unwrap();
        assert_eq!(sealed.len(), SEALED_LEN);
        assert_eq!((sealed[0], sealed[1]), (1, kid));
        assert_eq!(open(&sealed, kid, &key.priv_bytes).unwrap(), json);
        assert_eq!(open(&sealed, kid, &generate_x25519().priv_bytes), None);
        assert_eq!(open(&sealed, kid + 1, &key.priv_bytes), None);
        let mut other_kid = sealed.clone();
        other_kid[1] = kid + 1;
        assert_eq!(open(&other_kid, kid + 1, &key.priv_bytes), None);
        let mut altered = sealed.clone();
        altered[SEALED_LEN - 1] ^= 1;
        assert_eq!(open(&altered, kid, &key.priv_bytes), None);
        // A long report still measures the same.
        let long = vec![b'a'; 16_000];
        assert_eq!(seal(&long, kid, &key.pub_bytes).unwrap().len(), SEALED_LEN);
        assert!(seal(&vec![b'a'; SEALED_LEN], kid, &key.pub_bytes).is_err());
    }

    #[test]
    fn the_proof_of_work_is_bound_to_the_envelope_and_the_day() {
        let sealed = vec![9u8; SEALED_LEN];
        let nonce = mine(&sealed, "2026-10-26", 12);
        let hash = crate::crypto::sha256(&sealed);
        assert!(leading_zero_bits(&pow_digest(&hash, "2026-10-26", nonce)) >= 12);
        assert_ne!(
            pow_digest(&hash, "2026-10-27", nonce),
            pow_digest(&hash, "2026-10-26", nonce)
        );
        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
        let mut one = [0u8; 32];
        one[1] = 0b0001_0000;
        assert_eq!(leading_zero_bits(&one), 11);
    }

    /// The Worker on an in-memory Tor whose trinochat.org speaks TLS with
    /// the test CA: each connection gets the next reply. Nothing leaves.
    struct Worker {
        client: ReportClient,
        seen: Arc<StdMutex<Vec<Received>>>,
        tor: Arc<Mock>,
    }

    fn worker(replies: Vec<Reply>, keys: Vec<(u8, [u8; 32])>) -> Worker {
        let tor = Mock::new();
        let net = Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn Transport>),
            Arc::new(Forbidden),
        );
        let seen = mock_http::serve(&tor, "https://trinochat.org", replies);
        let http = HttpClient::with_tls(Arc::clone(&net), mock_http::test_tls());
        let mut client = ReportClient::new(net, http, REPORTS_URL.into(), keys);
        client.timeout = Duration::from_secs(5);
        // Little work, so the tests are quick; production mines POW_BITS.
        client.pow_floor = TEST_BITS;
        Worker { client, seen, tor }
    }

    const TEST_BITS: u32 = 8;

    #[test]
    fn production_mines_twenty_bits_at_least() {
        let client = ReportClient::configured(Net::with_transports(None, Arc::new(Forbidden)));
        assert_eq!(client.pow_floor, POW_BITS);
        assert_eq!(POW_BITS, 20);
        assert_eq!(client.url, REPORTS_URL);
    }

    fn reply(status: &str, body: &str) -> Reply {
        mock_http::response(
            status,
            "Content-Type: application/json\r\n",
            body.as_bytes(),
        )
    }

    /// Lina's report made, queued and sealed for the test key, asking for
    /// the answer; the session as the watcher holds it.
    fn queued(
        want_reply: bool,
    ) -> (
        Arc<tokio::sync::Mutex<InnerState>>,
        Created,
        (u8, crate::identity::KeyPair),
    ) {
        let (_, _, mut inner) = me_and_lina();
        let key = test_key();
        let mut chosen = draft(Category::Harassment, Mode::KeyOnly, vec![]);
        chosen.want_reply = want_reply;
        let created = create(
            &mut inner,
            &lina(),
            &chosen,
            &[(key.0, key.1.pub_bytes)],
            NOW,
        )
        .unwrap();
        (Arc::new(tokio::sync::Mutex::new(inner)), created, key)
    }

    #[test]
    fn with_no_key_nothing_is_kept_and_the_ui_offers_the_mail() {
        let (_, _, mut inner) = me_and_lina();
        let created = create(
            &mut inner,
            &lina(),
            &draft(Category::Spam, Mode::KeyOnly, vec![]),
            REPORT_KEYS,
            NOW,
        )
        .unwrap();
        assert!(!created.queued);
        assert!(inner.reports.is_empty());
        assert!(REPORT_KEYS.is_empty(), "no key of Trino's yet (U12, UR-6)");
    }

    /// Design test 29 (R-06): the queue keeps the envelope sealed, survives
    /// a restart (account.bin) and can be cancelled.
    #[tokio::test]
    async fn ur5_29_the_queue_keeps_it_sealed_across_a_restart_and_it_can_be_cancelled() {
        let (inner, created, key) = queued(false);
        let inner = inner.lock().await;
        assert!(created.queued);
        let saved = serde_json::to_string(&crate::storage::account_of(&inner)).unwrap();
        assert!(!saved.contains("Si no me contestas"), "nothing in clear");
        assert!(!saved.contains("harassment"), "not even the kind");
        let back: crate::store::session::AccountFile = serde_json::from_str(&saved).unwrap();
        let mut book = back.reports;
        assert_eq!(book, inner.reports);
        let sealed = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            book.entries[0].sealed.as_deref().unwrap(),
        )
        .unwrap();
        let json = open(&sealed, key.0, &key.1.priv_bytes).unwrap();
        let report: Report = serde_json::from_slice(&json).unwrap();
        assert_eq!(report.id, created.id);
        book.cancel(&created.id).unwrap();
        assert!(book.is_empty());
        assert!(book.cancel(&created.id).is_err());
    }

    /// It goes by Tor on a token of its own (design test 31), as the
    /// envelope alone with its proof of work; then only its code and day
    /// stay.
    #[tokio::test]
    async fn ur5_31_it_goes_by_tor_with_its_proof_of_work_and_then_only_its_code_stays() {
        let (inner, created, key) = queued(false);
        let w = worker(
            vec![reply("201 Created", "{}")],
            vec![(key.0, key.1.pub_bytes)],
        );
        let sealed_before = {
            let guard = inner.lock().await;
            guard.reports.entries[0].sealed.clone().unwrap()
        };
        assert!(deliver(&inner, &w.client, NOW).await);
        let seen = w.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        let head = &seen[0].head;
        assert!(head.starts_with("POST /api/v1/reports "), "{head}");
        let body = &seen[0].body;
        assert_eq!(body.len(), SEALED_LEN);
        assert_eq!(
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body),
            sealed_before
        );
        let day = mock_http::header(head, "trino-pow-day").unwrap();
        let nonce: u64 = mock_http::header(head, "trino-pow-nonce")
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(day, day_of(NOW));
        let digest = pow_digest(&crate::crypto::sha256(body), &day, nonce);
        assert!(leading_zero_bits(&digest) >= TEST_BITS);
        let connections = w.tor.connections();
        assert_eq!(connections.len(), 1);
        assert_eq!(
            connections[0].0,
            trino_net::Target::new("trinochat.org", 443)
        );
        assert_eq!(connections[0].1.kind(), REPORT_ISO);
        let guard = inner.lock().await;
        let shown = list(&guard, NOW);
        assert_eq!(
            shown,
            [SentView {
                id: created.id.clone(),
                created_at: NOW,
                state: SentState::Sent,
                write_instead: false,
                reply: None
            }]
        );
        assert_eq!(guard.reports.entries[0].sealed, None, "the envelope went");
        assert_eq!(next_wake(&guard.reports, NOW), None);
    }

    /// Design test 29 (R-05): a refusal for the day waits for 00:00 UTC; a
    /// request for more work mines more at once; a network failure waits
    /// a while; with Tor not ready nothing goes direct.
    #[tokio::test]
    async fn ur5_29_it_waits_for_midnight_mines_more_and_tries_again_later() {
        let (inner, _, key) = queued(false);
        let keys = vec![(key.0, key.1.pub_bytes)];
        let w = worker(
            vec![
                reply("429 Too Many Requests", "{}"),
                reply("403 Forbidden", r#"{"error":"pow","bits":12}"#),
                reply("503 Service Unavailable", "{}"),
            ],
            keys.clone(),
        );
        assert!(deliver(&inner, &w.client, NOW).await);
        let midnight = (NOW / DAY + 1) * DAY;
        assert_eq!(next_wake(&inner.lock().await.reports, NOW), Some(midnight));
        // Before midnight nothing goes.
        assert!(!deliver(&inner, &w.client, midnight - 1).await);
        assert_eq!(w.seen.lock().unwrap().len(), 1);

        assert!(deliver(&inner, &w.client, midnight).await);
        assert_eq!(inner.lock().await.reports.entries[0].bits, 12);
        assert_eq!(
            next_wake(&inner.lock().await.reports, midnight),
            Some(midnight)
        );
        assert!(deliver(&inner, &w.client, midnight).await);
        let seen = w.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 3);
        let nonce: u64 = mock_http::header(&seen[2].head, "trino-pow-nonce")
            .unwrap()
            .parse()
            .unwrap();
        let day = mock_http::header(&seen[2].head, "trino-pow-day").unwrap();
        let digest = pow_digest(&crate::crypto::sha256(&seen[2].body), &day, nonce);
        assert!(leading_zero_bits(&digest) >= 12);
        let later = next_wake(&inner.lock().await.reports, midnight).unwrap();
        assert!(later > midnight, "a while later");
        assert_eq!(
            list(&*inner.lock().await, midnight)[0].state,
            SentState::Waiting
        );

        // Tor not ready: it stays, and nothing went direct.
        let offline = ReportClient::new(
            Net::with_transports(None, Arc::new(Forbidden)),
            HttpClient::new(Net::with_transports(None, Arc::new(Forbidden))),
            REPORTS_URL.into(),
            keys,
        );
        deliver(&inner, &offline, later).await;
        assert_eq!(
            list(&*inner.lock().await, later)[0].state,
            SentState::Waiting
        );
        // Three days waiting: the UI offers the e-mail.
        assert!(list(&*inner.lock().await, NOW + FALLBACK_AFTER)[0].write_instead);
    }

    #[tokio::test]
    async fn a_report_the_worker_refuses_for_good_is_not_tried_again() {
        let (inner, _, key) = queued(false);
        let w = worker(
            vec![reply("400 Bad Request", "{}")],
            vec![(key.0, key.1.pub_bytes)],
        );
        assert!(deliver(&inner, &w.client, NOW).await);
        let guard = inner.lock().await;
        let shown = list(&guard, NOW);
        assert_eq!(shown[0].state, SentState::Refused);
        assert!(shown[0].write_instead);
        assert_eq!(next_wake(&guard.reports, NOW), None);
    }

    /// The answer (U3, R-17): asked for by the SHA-256 of the token, opened
    /// with it, shown only in "Reportes enviados".
    #[tokio::test]
    async fn the_answer_is_fetched_by_the_hash_of_the_token_and_opened_with_it() {
        let (inner, created, key) = queued(true);
        let token = inner.lock().await.reports.entries[0]
            .reply_token
            .clone()
            .unwrap();
        let answer = seal_reply(&token, "no pudo hacer nada.");
        let w = worker(
            vec![
                reply("201 Created", "{}"),
                reply("404 Not Found", "{}"),
                mock_http::response(
                    "200 OK",
                    "Content-Type: application/octet-stream\r\n",
                    &answer,
                ),
            ],
            vec![(key.0, key.1.pub_bytes)],
        );
        deliver(&inner, &w.client, NOW).await;
        // The first look finds nothing yet.
        deliver(&inner, &w.client, NOW).await;
        assert_eq!(list(&*inner.lock().await, NOW)[0].reply, None);
        let next = next_wake(&inner.lock().await.reports, NOW).unwrap();
        assert!(next > NOW);
        assert!(deliver(&inner, &w.client, next).await);
        let seen = w.seen.lock().unwrap().clone();
        let hash = hex::encode(crate::crypto::sha256(&hex::decode(&token).unwrap()));
        assert!(
            seen[1]
                .head
                .starts_with(&format!("GET /api/v1/reports/reply/{hash} ")),
            "{}",
            seen[1].head
        );
        assert!(!seen[1].head.contains(&token), "never the token itself");
        let shown = list(&*inner.lock().await, next);
        assert_eq!(shown[0].id, created.id);
        assert_eq!(shown[0].reply.as_deref(), Some("no pudo hacer nada."));
        assert_eq!(next_wake(&inner.lock().await.reports, next), None);
    }

    /// Design test 30 and David's decision of 26 Oct: only the code and the
    /// day, and 30 days after it was made it goes, with its envelope, its
    /// token and its answer.
    #[tokio::test]
    async fn ur5_30_reports_sent_show_only_the_code_and_go_after_30_days() {
        let (inner, _, _) = queued(true);
        let mut guard = inner.lock().await;
        let shown = serde_json::to_value(list(&guard, NOW)).unwrap();
        let keys: Vec<&str> = shown[0]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            ["created_at", "id", "reply", "state", "write_instead"]
        );
        assert!(!guard.reports.prune(NOW + KEEP_FOR - 1));
        assert_eq!(list(&guard, NOW + KEEP_FOR - 1).len(), 1);
        assert!(
            list(&guard, NOW + KEEP_FOR).is_empty(),
            "not shown past 30 days"
        );
        assert!(guard.reports.prune(NOW + KEEP_FOR));
        assert!(guard.reports.is_empty());
        let saved = serde_json::to_value(crate::storage::account_of(&guard)).unwrap();
        assert!(
            saved.get("reports").is_none(),
            "nothing left in account.bin"
        );
    }

    /// The code that sends reports names no socket and no permit to go
    /// without Tor (design test 31): it goes by `HttpClient` alone.
    #[test]
    fn ur5_31_nothing_here_goes_without_tor() {
        let code = include_str!("report.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for banned in [
            concat!("Direct", "Permit"),
            concat!("Tcp", "Stream"),
            concat!("connect_for", "_update"),
            concat!("for_", "update"),
        ] {
            assert!(!code.contains(banned), "report.rs names {banned}");
        }
        assert!(code.contains("REPORT_ISO"));
    }

    #[test]
    fn a_debug_key_reads_as_kid_and_hex() {
        assert_eq!(
            parse_key(&format!("3:{}", "ab".repeat(32))),
            Some((3, [0xab; 32]))
        );
        assert_eq!(parse_key("3:xyz"), None);
        assert_eq!(parse_key("nope"), None);
    }
}
