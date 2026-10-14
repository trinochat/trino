//! When the updater checks (Tor design §6.3, decision 4): once a day, at a
//! random time within the day, with Trino open (locked too, unless Tor
//! starts at unlock), and only while "Buscar actualizaciones cada día" is
//! on, which it is by default. Off, "Buscar ahora" is still there.
//!
//! `tor/update.json` keeps the switch and the day of the last check a
//! mirror answered, beside seen.json and for the same reason: it is read
//! locked and before there is an account, so outside the store. It says
//! only whether daily checks are on and a day, never a time of day.

use rand::Rng;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// The file, in the Tor folder.
pub const UPDATE_FILE: &str = "update.json";

const DAY: u64 = 24 * 60 * 60;

/// A check that gave nothing (Tor not ready, no mirror answered) is tried
/// again this long after, drawn at random: never at once, so a mirror
/// that is down is not asked in a loop.
pub const RETRY_MIN: u64 = 30 * 60;
pub const RETRY_MAX: u64 = 90 * 60;

/// What `tor/update.json` holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdateSettings {
    /// "Buscar actualizaciones cada día": on by default (decision 4).
    pub daily: bool,
    /// The day (its first second, UTC) of the last check a mirror answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_day: Option<u64>,
}

impl Default for UpdateSettings {
    fn default() -> Self {
        UpdateSettings {
            daily: true,
            checked_day: None,
        }
    }
}

/// One read-modify-write of update.json at a time in this process.
fn lock_file() -> MutexGuard<'static, ()> {
    static FILE: Mutex<()> = Mutex::new(());
    FILE.lock().unwrap_or_else(PoisonError::into_inner)
}

fn day_of(time: u64) -> u64 {
    time - time % DAY
}

impl UpdateSettings {
    pub fn path(tor_home: &Path) -> PathBuf {
        tor_home.join(UPDATE_FILE)
    }

    /// What `tor_home` keeps: on and never checked when there is no file
    /// or it cannot be read.
    pub fn load(tor_home: &Path) -> UpdateSettings {
        std::fs::read(UpdateSettings::path(tor_home))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Write it in `tor_home` through a temporary file, so a cut leaves the
    /// old one or the new one.
    pub fn save(&self, tor_home: &Path) -> io::Result<()> {
        std::fs::create_dir_all(tor_home)?;
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        let temporary = tor_home.join(format!(".{UPDATE_FILE}.tmp"));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, UpdateSettings::path(tor_home))
    }

    fn change(tor_home: &Path, change: impl FnOnce(&mut UpdateSettings)) -> io::Result<()> {
        let _guard = lock_file();
        let mut settings = UpdateSettings::load(tor_home);
        change(&mut settings);
        settings.save(tor_home)
    }

    /// Turn the daily check on or off, keeping the rest.
    pub fn set_daily(tor_home: &Path, on: bool) -> io::Result<()> {
        UpdateSettings::change(tor_home, |settings| settings.daily = on)
    }

    /// Keep that a mirror answered a check at `now`.
    pub fn record_check(tor_home: &Path, now: u64) -> io::Result<()> {
        UpdateSettings::change(tor_home, |settings| settings.checked(now))
    }

    /// That a mirror answered a check at `now`: the day is kept, never the
    /// time.
    pub fn checked(&mut self, now: u64) {
        self.checked_day = Some(day_of(now));
    }

    /// When the next daily check is due, from `now` (seconds since 1970),
    /// or never with the switch off: at a random time in what is left of
    /// today if today has had none, or else at a random time tomorrow.
    pub fn next_check(&self, now: u64, rng: &mut impl Rng) -> Option<u64> {
        if !self.daily {
            return None;
        }
        let tomorrow = day_of(now) + DAY;
        if self.checked_day == Some(day_of(now)) {
            Some(tomorrow + rng.gen_range(0..DAY))
        } else {
            Some(now + rng.gen_range(0..tomorrow - now))
        }
    }
}

/// When to try again after a check at `now` that gave nothing.
pub fn retry_at(now: u64, rng: &mut impl Rng) -> u64 {
    now + rng.gen_range(RETRY_MIN..=RETRY_MAX)
}
