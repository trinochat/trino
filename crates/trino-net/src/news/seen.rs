//! `tor/seen.json` (Tor design §6.4 and §7, R-06): the highest feed this
//! device has seen, so a replayed older one is refused and a freeze is
//! noticed. Per device, in the clear beside tor/settings.json and outside
//! the encrypted store, because the check runs locked and before there is
//! an account. It holds only public numbers (a feed's `seq`, `latest` and
//! `validUntil`) and two days, never a time of day: when the last fresh
//! feed came, and when the first check was.

use super::feed::{Feed, Version};
use super::{Freeze, DAY};
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The file, in the Tor folder.
pub const SEEN_FILE: &str = "seen.json";

/// With no fresh feed for longer than this, updates count as frozen
/// (§6.4: "lo mismo si pasan 14 días sin poder comprobar nada").
pub const STALE_AFTER: u64 = 14 * DAY;

/// What `tor/seen.json` holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Seen {
    /// The highest `seq` verified, or taken from the account's old
    /// `minSeq` once.
    pub seq: u64,
    /// The highest `latest` verified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<Version>,
    /// The latest `validUntil` verified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<u64>,
    /// The day (its first second, UTC) a feed last came that was still
    /// within its `validUntil`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fresh_at: Option<u64>,
    /// The day of the first check: the freeze's clock until a fresh feed
    /// comes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

/// The first second of the day `time` is in (UTC).
pub(super) fn day_of(time: u64) -> u64 {
    time - time % DAY
}

impl Seen {
    pub fn path(tor_home: &Path) -> PathBuf {
        tor_home.join(SEEN_FILE)
    }

    /// What `tor_home` keeps; nothing seen when there is no file or it
    /// cannot be read.
    pub fn load(tor_home: &Path) -> Seen {
        std::fs::read(Seen::path(tor_home))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Write it in `tor_home` through a temporary file, so a cut leaves the
    /// old one or the new one.
    pub fn save(&self, tor_home: &Path) -> io::Result<()> {
        std::fs::create_dir_all(tor_home)?;
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        let temporary = tor_home.join(format!(".{SEEN_FILE}.tmp"));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, Seen::path(tor_home))
    }

    /// Raise the highest `seq` to `seq`, never lowering it: the account's
    /// `minSeq` of before, taken at the unlock (§7).
    pub fn raise_seq(tor_home: &Path, seq: u64) -> io::Result<()> {
        let _guard = super::lock_seen();
        let mut seen = Seen::load(tor_home);
        if seq <= seen.seq {
            return Ok(());
        }
        seen.seq = seq;
        seen.save(tor_home)
    }

    /// Take the account's old `minSeq`, which the WebView kept and nothing
    /// signed (TRN-NET-06): never above `now`, since a `seq` is the time its
    /// feed was signed, nor above what a feed may carry. A made-up value so
    /// cannot make every later feed a replay; a real one is below now.
    pub fn take_old_seq(tor_home: &Path, seq: u64, now: u64) -> io::Result<()> {
        Seen::raise_seq(tor_home, seq.min(now).min(super::feed::MAX_SAFE_INTEGER))
    }

    /// Whether `feed` is not below what was seen: its `seq`, and its
    /// `latest` if both have one.
    pub fn admits(&self, feed: &Feed) -> bool {
        let latest_ok = match (&feed.latest, &self.latest) {
            (Some(theirs), Some(ours)) => theirs >= ours,
            (None, Some(_)) => true,
            (_, None) => true,
        };
        feed.seq >= self.seq && latest_ok
    }

    /// Take a verified `feed`, admitted, seen at `now`.
    pub fn take(&mut self, feed: &Feed, now: u64) {
        self.seq = self.seq.max(feed.seq);
        if let Some(latest) = feed.latest {
            self.latest = Some(self.latest.map_or(latest, |ours| ours.max(latest)));
        }
        if let Some(valid_until) = feed.valid_until {
            self.valid_until = Some(
                self.valid_until
                    .map_or(valid_until, |ours| ours.max(valid_until)),
            );
            if valid_until > now {
                self.fresh_at = Some(day_of(now));
            }
        }
    }

    /// Whether updates look frozen at `now` (§6.4), given the highest
    /// version any mirror offers, once the updater has asked them
    /// (`offered`):
    ///
    /// - the news say a `latest` no mirror offers;
    /// - the newest feed is past its `validUntil`;
    /// - no fresh feed for more than 14 days (counted from the first check
    ///   while there has been none).
    pub fn freeze(&self, now: u64, offered: Option<&Version>) -> Option<Freeze> {
        if let (Some(latest), Some(offered)) = (self.latest, offered) {
            if latest > *offered {
                return Some(Freeze::NotOffered {
                    latest: latest.to_string(),
                });
            }
        }
        let since = self.fresh_at.or(self.since);
        let days = since.map(|since| now.saturating_sub(since) / DAY);
        if self
            .valid_until
            .is_some_and(|valid_until| valid_until < now)
        {
            return Some(Freeze::Expired {
                days: days.unwrap_or(0),
            });
        }
        match (since, days) {
            (Some(since), Some(days)) if now.saturating_sub(since) > STALE_AFTER => {
                Some(Freeze::Unchecked { days })
            }
            _ => None,
        }
    }
}
