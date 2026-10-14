//! The news, "Novedades de Trino" (Tor design §7, R-06 and R-14): fetched
//! from trinochat.org through Tor and verified here, in Rust, never in the
//! WebView.
//!
//! - The feed is a JSON envelope, `{ "payload": "<the exact JSON signed>",
//!   "signature": "<an armored OpenPGP signature>" }`, as
//!   scripts/sign-announcement.mjs writes it.
//! - It is verified with rPGP against the "Trino Updates" key built into
//!   the program (`trino-updates.asc`, fingerprint
//!   `TRINO_UPDATES_FINGERPRINT`), never a key from the network: whoever
//!   serves a feed could serve a matching key. Then each field is checked
//!   against its limits (feed.rs).
//! - Every mirror is asked, each on a circuit of its own within the
//!   check's session, and the highest verified feed wins: a mirror serving
//!   an old feed, validly signed, does not hide a newer one (R-06).
//! - A feed below the highest this device has seen (`tor/seen.json`,
//!   seen.rs) is a replay, and untrusted.
//! - The app gets `News`: verified items only, or none and the bundled
//!   copy it ships; whether a feed was served that did not verify; the
//!   highest `latest` seen; and whether updates look frozen (§6.4).
//! - Without Tor ("Conectar sin Tor") nothing is asked: the news wait
//!   (§2.8). With Tor not ready, nothing is asked either, never direct.
//!
//! No Tauri here, so the engine M4 extracts and its Flutter UI reuse it
//! (R-14).

mod feed;
mod seen;

pub use feed::{is_timestamp, Announcement, BadVersion, Feed, Version, MAX_ANNOUNCEMENTS};
pub use seen::{Seen, SEEN_FILE, STALE_AFTER};

use crate::{Deadlines, HttpClient, HttpError, IsoKind, Mode, Request, Session};
use pgp::composed::{Deserializable, DetachedSignature, SignedPublicKey};
use pgp::packet::SignatureType;
use pgp::types::KeyDetails;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use thiserror::Error;

/// Where the feed is (§7). The web's onion joins when it exists, with its
/// own authorization.
pub const FEED_MIRRORS: [&str; 1] = ["https://trinochat.org/updates/feed.json"];

/// The most a feed may take, as the WebView capped it.
pub const MAX_FEED_BYTES: usize = 512_000;

/// The "Trino Updates" key: the only one whose signature makes news
/// verified. Its public half is `trino-updates.asc`, built into the
/// program; the private half never leaves its owner's GnuPG.
pub const TRINO_UPDATES_FINGERPRINT: &str = "4DE8E4BC5872E37566FA4114A62EE5607F666A6B";
const TRINO_UPDATES_KEY: &str = include_str!("trino-updates.asc");

/// How long a mirror gets (§3.1): 30 s to connect through Tor, a minute in
/// all.
pub const DEADLINES: Deadlines = Deadlines {
    connect: Duration::from_secs(30),
    total: Duration::from_secs(60),
    idle: Some(Duration::from_secs(30)),
};

pub(crate) const DAY: u64 = 24 * 60 * 60;

/// Why a feed is not taken. Short and fixed: never what the server sent.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum NewsError {
    /// Not the envelope, or too large.
    #[error("not a signed feed")]
    Envelope,
    /// No signature, or one that is not a good one by the signer's key.
    #[error("the signature does not check out")]
    Signature,
    /// The key is not the one with the fingerprint asked for, or its own
    /// signatures do not check out.
    #[error("not the signer's key")]
    Signer,
    /// Signed, but a field is missing or out of its limits.
    #[error("the feed's {0} is not valid")]
    Payload(&'static str),
}

/// The key a feed must be signed by.
pub struct Signer {
    key: SignedPublicKey,
    fingerprint: String,
}

impl Signer {
    /// "Trino Updates", from the program itself.
    pub fn trino_updates() -> &'static Signer {
        static SIGNER: LazyLock<Signer> = LazyLock::new(|| {
            Signer::from_armored(TRINO_UPDATES_KEY, TRINO_UPDATES_FINGERPRINT)
                .expect("the built-in Trino Updates key")
        });
        &SIGNER
    }

    /// The armored public key `armored`, if it is the one with
    /// `fingerprint` (40 hex digits) and its self-signatures check out.
    pub fn from_armored(armored: &str, fingerprint: &str) -> Result<Signer, NewsError> {
        let (key, _) = SignedPublicKey::from_string(armored).map_err(|_| NewsError::Signer)?;
        key.verify_bindings().map_err(|_| NewsError::Signer)?;
        let actual = format!("{:X}", key.fingerprint());
        if !actual.eq_ignore_ascii_case(fingerprint) {
            return Err(NewsError::Signer);
        }
        Ok(Signer {
            key,
            fingerprint: actual,
        })
    }

    /// Its fingerprint, upper-case hex.
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

/// The envelope as it travels.
#[derive(Deserialize)]
struct Envelope {
    payload: String,
    signature: String,
}

/// The feed in `envelope`, if `signer` signed its payload, exactly those
/// bytes, and its fields are within their limits.
pub fn verify(signer: &Signer, envelope: &[u8]) -> Result<Feed, NewsError> {
    if envelope.len() > MAX_FEED_BYTES {
        return Err(NewsError::Envelope);
    }
    let envelope: Envelope = serde_json::from_slice(envelope).map_err(|_| NewsError::Envelope)?;
    let (signature, _) =
        DetachedSignature::from_string(&envelope.signature).map_err(|_| NewsError::Signature)?;
    // A signature over data, binary or text; never a key's certification
    // or anything else the key may have signed.
    let data = matches!(
        signature.signature.typ(),
        Some(SignatureType::Binary | SignatureType::Text)
    );
    if !data {
        return Err(NewsError::Signature);
    }
    signature
        .verify(&signer.key, envelope.payload.as_bytes())
        .map_err(|_| NewsError::Signature)?;
    feed::parse(&envelope.payload)
}

/// What the app gets of a check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NewsStatus {
    /// A feed verified: its items are the news.
    Verified,
    /// No feed came (not reachable, not there, or no Tor): the copy the
    /// app ships, which the installer vouches for.
    Bundled,
    /// A feed came that did not verify, or was below the highest seen: an
    /// attack, not a missing file, and the app says so.
    Untrusted,
}

/// Why updates look frozen (§6.4), for the warning the UI shows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Freeze {
    /// The news say `latest` is out, and no mirror offers it: "Hay una
    /// versión nueva que no pudimos bajar."
    NotOffered { latest: String },
    /// The newest feed is past its `validUntil`: "No pudimos comprobar si
    /// hay versiones nuevas desde hace {days} días."
    Expired { days: u64 },
    /// No fresh feed for more than 14 days: the same words.
    Unchecked { days: u64 },
}

/// One check, as the app gets it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct News {
    pub status: NewsStatus,
    /// The verified feed's announcements; empty unless `Verified`.
    pub items: Vec<Announcement>,
    /// Whose key verified them.
    pub signer_fingerprint: Option<String>,
    /// The highest `latest` this device has seen.
    pub latest: Option<String>,
    /// Whether updates look frozen. The mirrors' versions come with the
    /// updater (TOR-9); until then only an expired or stale feed counts.
    pub freeze: Option<Freeze>,
}

/// One read-modify-write of seen.json at a time in this process.
pub(crate) fn lock_seen() -> MutexGuard<'static, ()> {
    static SEEN: Mutex<()> = Mutex::new(());
    SEEN.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What one mirror gave.
enum Answer {
    /// Nothing usable came: not reachable, not 200, or too large.
    Nothing,
    /// A feed came, verified or not.
    Feed(Result<Feed, NewsError>),
}

/// Ask one mirror for the feed, with a GET and nothing else.
async fn ask(client: &HttpClient, session: &Session, signer: &Signer, url: &str) -> Answer {
    let iso = session.iso(IsoKind::NEWS, url);
    let fetched: Result<Vec<u8>, HttpError> = async {
        let mut response = client.send(Request::get(url)?, &iso, DEADLINES).await?;
        if response.status() != 200 {
            return Err(HttpError::Network);
        }
        response.read_capped(MAX_FEED_BYTES).await
    }
    .await;
    match fetched {
        Ok(body) => Answer::Feed(verify(signer, &body)),
        Err(_) => Answer::Nothing,
    }
}

/// Check the news on every one of `mirrors` through `client`'s Tor, within
/// `session` (the check's own, or the updater's), against `signer`, at
/// `now` (seconds since 1970). What was seen is kept in `tor_home`'s
/// seen.json when there is one.
pub async fn check(
    client: &HttpClient,
    session: &Session,
    signer: &Signer,
    mirrors: &[&str],
    tor_home: Option<&Path>,
    now: u64,
) -> News {
    let load = || tor_home.map(Seen::load).unwrap_or_default();
    if client.net().mode() == Mode::Direct {
        // "Conectar sin Tor": the news can wait for Tor (§2.8).
        return news(NewsStatus::Bundled, None, &load(), now);
    }

    let answers =
        futures_util::future::join_all(mirrors.iter().map(|url| ask(client, session, signer, url)))
            .await;

    let _guard = lock_seen();
    let mut seen = load();
    seen.since.get_or_insert(seen::day_of(now));
    let mut served = false;
    let mut best: Option<Feed> = None;
    for answer in answers {
        let Answer::Feed(feed) = answer else {
            continue;
        };
        served = true;
        if let Ok(feed) = feed {
            if seen.admits(&feed) && best.as_ref().is_none_or(|best| feed.seq > best.seq) {
                best = Some(feed);
            }
        }
    }
    let status = match (&best, served) {
        (Some(_), _) => NewsStatus::Verified,
        (None, true) => NewsStatus::Untrusted,
        (None, false) => NewsStatus::Bundled,
    };
    if let Some(feed) = &best {
        seen.take(feed, now);
    }
    if let Some(tor_home) = tor_home {
        // Not kept now, kept at the next check: nothing lost but a day.
        let _ = seen.save(tor_home);
    }
    news(status, best.map(|feed| feed.announcements), &seen, now).with_signer(status, signer)
}

fn news(status: NewsStatus, items: Option<Vec<Announcement>>, seen: &Seen, now: u64) -> News {
    News {
        status,
        items: items.unwrap_or_default(),
        signer_fingerprint: None,
        latest: seen.latest.map(|latest| latest.to_string()),
        freeze: seen.freeze(now, None),
    }
}

impl News {
    fn with_signer(mut self, status: NewsStatus, signer: &Signer) -> News {
        if status == NewsStatus::Verified {
            self.signer_fingerprint = Some(signer.fingerprint().to_string());
        }
        self
    }
}
