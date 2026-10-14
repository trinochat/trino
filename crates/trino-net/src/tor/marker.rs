//! `tor/run.marker` (Tor design §6.5, point 3): the fallback for an Arti
//! too old for the network when nothing in the cache says so (private
//! bridges destroy it every session).
//!
//! With Trino open, an obsolete Arti ends the whole process with `exit(1)`
//! five seconds after a new consensus arrives, and nothing can catch it.
//! So the marker is written when Tor starts, notes when Tor became ready,
//! and goes when Tor stops cleanly or has run ten minutes since it was
//! ready. A marker found at the next start that says "ready" means the
//! process died within those ten minutes. Two such deaths in a row, and
//! Tor no longer starts by itself: the app shows the "old version" screen,
//! which says "Puede que", since another cause is possible (R-19), and
//! offers to try again.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const MARKER_FILE: &str = "run.marker";

/// How long Tor must run after it is ready for a death not to count.
pub const SURVIVAL: Duration = Duration::from_secs(10 * 60);

/// Deaths in a row after which Tor does not start by itself.
pub const STRIKES: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Starting,
    Ready,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    phase: Phase,
    /// Earlier runs that died right after Tor was ready, in a row.
    strikes: u8,
}

pub(crate) struct RunMarker {
    path: PathBuf,
    strikes: u8,
}

/// Two deaths in a row right after Tor was ready: do not start.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LikelyObsolete;

impl RunMarker {
    fn read(path: &Path) -> Option<Marker> {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    }

    fn write(&self, phase: Phase) {
        let marker = Marker {
            phase,
            strikes: self.strikes,
        };
        if let Ok(bytes) = serde_json::to_vec(&marker) {
            // Best effort: without it, only this fallback is lost.
            let _ = std::fs::write(&self.path, bytes);
        }
    }

    /// A start of Tor in `tor_home`: counts the death the marker left, if
    /// any, and writes it anew; or `LikelyObsolete` after `STRIKES` deaths
    /// in a row, leaving the marker as it is.
    pub(crate) fn begin(tor_home: &Path) -> Result<RunMarker, LikelyObsolete> {
        let path = tor_home.join(MARKER_FILE);
        let strikes = match RunMarker::read(&path) {
            // Died within SURVIVAL of being ready.
            Some(Marker {
                phase: Phase::Ready,
                strikes,
            }) => strikes.saturating_add(1),
            // Died before Tor was ready: not this cause, but not a clean run either.
            Some(Marker {
                phase: Phase::Starting,
                strikes,
            }) => strikes,
            None => 0,
        };
        if strikes >= STRIKES {
            return Err(LikelyObsolete);
        }
        let marker = RunMarker { path, strikes };
        marker.write(Phase::Starting);
        Ok(marker)
    }

    /// Tor became ready.
    pub(crate) fn ready(&self) {
        self.write(Phase::Ready);
    }

    /// Tor ran `SURVIVAL` since it was ready, or stopped cleanly: no death
    /// to count.
    pub(crate) fn clear(&self) {
        let _ = std::fs::remove_file(&self.path);
    }

    /// "Intentar de nuevo": forget the deaths counted in `tor_home`.
    pub(crate) fn forgive(tor_home: &Path) {
        let _ = std::fs::remove_file(tor_home.join(MARKER_FILE));
    }
}
