//! What a signed feed says, checked field by field after its signature
//! (the limits `src/lib/announcements.ts` had in the WebView): the
//! announcements, `seq`, and the two fields against a freeze, `latest` and
//! `validUntil` (Tor design §6.4 and §7).

use super::NewsError;
use serde::{Deserialize, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;

/// The most announcements one feed carries.
pub const MAX_ANNOUNCEMENTS: usize = 50;

/// The largest whole number JavaScript keeps exactly (2^53 - 1): `seq` is
/// one, and the script writes it from JavaScript.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A version of Trino, `major.minor.patch`: three numbers and nothing
/// else, as the script signs it and the installers are named.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    major: u32,
    minor: u32,
    patch: u32,
}

impl Version {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Version {
            major,
            minor,
            patch,
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Not `major.minor.patch`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BadVersion;

impl FromStr for Version {
    type Err = BadVersion;

    fn from_str(text: &str) -> Result<Self, BadVersion> {
        let mut parts = text.split('.');
        let mut number = || {
            let part = parts.next().ok_or(BadVersion)?;
            if part.is_empty() || part.len() > 9 || !part.bytes().all(|b| b.is_ascii_digit()) {
                return Err(BadVersion);
            }
            part.parse::<u32>().map_err(|_| BadVersion)
        };
        let version = Version::new(number()?, number()?, number()?);
        match parts.next() {
            None => Ok(version),
            Some(_) => Err(BadVersion),
        }
    }
}

impl Serialize for Version {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Version {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        text.parse()
            .map_err(|_| serde::de::Error::custom("not a version"))
    }
}

/// One post of "Novedades de Trino", as the app shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    pub title: String,
    pub body: String,
    /// RFC 3339, with its offset.
    pub published_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// https:// only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// A feed whose signature checked out, and whose fields did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Feed {
    /// Grows with every feed signed: one lower than the highest seen is a
    /// replay (R-06).
    pub seq: u64,
    /// The newest version published, when the feed says it.
    pub latest: Option<Version>,
    /// Until when the feed counts as current, in seconds since 1970.
    pub valid_until: Option<u64>,
    pub announcements: Vec<Announcement>,
}

/// The payload as it is signed, before its fields are checked.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    announcements: Vec<RawAnnouncement>,
    seq: u64,
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    valid_until: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAnnouncement {
    id: String,
    title: String,
    body: String,
    published_at: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// The payload's fields, each within its limits.
pub(super) fn parse(payload: &str) -> Result<Feed, NewsError> {
    let payload: Payload =
        serde_json::from_str(payload).map_err(|_| NewsError::Payload("not a feed"))?;
    if payload.seq > MAX_SAFE_INTEGER {
        return Err(NewsError::Payload("seq"));
    }
    if payload.announcements.len() > MAX_ANNOUNCEMENTS {
        return Err(NewsError::Payload("too many announcements"));
    }
    let latest = match payload.latest {
        Some(latest) => Some(
            latest
                .parse::<Version>()
                .map_err(|_| NewsError::Payload("latest"))?,
        ),
        None => None,
    };
    let announcements = payload
        .announcements
        .into_iter()
        .map(announcement)
        .collect::<Result<_, _>>()?;
    Ok(Feed {
        seq: payload.seq,
        latest,
        valid_until: payload.valid_until,
        announcements,
    })
}

fn announcement(raw: RawAnnouncement) -> Result<Announcement, NewsError> {
    let published_at = bounded(raw.published_at, "publishedAt", 64)?;
    if !is_timestamp(&published_at) {
        return Err(NewsError::Payload("publishedAt"));
    }
    let url = raw.url.map(|url| bounded(url, "url", 2_048)).transpose()?;
    if let Some(url) = &url {
        let https = url::Url::parse(url).is_ok_and(|url| url.scheme() == "https");
        if !https {
            return Err(NewsError::Payload("url"));
        }
    }
    Ok(Announcement {
        id: bounded(raw.id, "id", 96)?,
        title: bounded(raw.title, "title", 120)?,
        body: bounded(raw.body, "body", 5_000)?,
        published_at,
        version: raw
            .version
            .map(|version| bounded(version, "version", 48))
            .transpose()?,
        url,
    })
}

/// `value` trimmed, if it is not empty and has at most `max` characters.
fn bounded(value: String, field: &'static str, max: usize) -> Result<String, NewsError> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > max {
        return Err(NewsError::Payload(field));
    }
    Ok(trimmed.to_string())
}

/// Whether `text` is an RFC 3339 date and time with its offset, as
/// `2026-07-17T09:30:00-05:00` or `2026-10-14T12:00:00.123Z`: what the
/// app's `Date.parse` sorts the posts by.
pub fn is_timestamp(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = bytes.get(range)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let fixed = |at: usize, byte: u8| bytes.get(at) == Some(&byte);
    let (Some(_year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        digits(0..4),
        digits(5..7),
        digits(8..10),
        digits(11..13),
        digits(14..16),
        digits(17..19),
    ) else {
        return false;
    };
    let shape = fixed(4, b'-')
        && fixed(7, b'-')
        && matches!(bytes.get(10), Some(b'T' | b't'))
        && fixed(13, b':')
        && fixed(16, b':');
    let ranges = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour < 24
        && minute < 60
        && second <= 60;
    if !shape || !ranges {
        return false;
    }
    // Fractions of a second, then the offset.
    let mut rest = &text[19..];
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &fraction[digits..];
    }
    match rest.as_bytes() {
        [b'Z' | b'z'] => true,
        [b'+' | b'-', h1, h2, b':', m1, m2]
            if [h1, h2, m1, m2].iter().all(|b| b.is_ascii_digit()) =>
        {
            let number =
                |tens: u8, units: u8| u32::from(tens - b'0') * 10 + u32::from(units - b'0');
            number(*h1, *h2) < 24 && number(*m1, *m2) < 60
        }
        _ => false,
    }
}
