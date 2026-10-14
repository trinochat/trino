//! `tor/settings.json` (Tor design §2.5): how Tor is reached and when it
//! starts. In clear, outside the encrypted store, because Tor may start
//! before the unlock. It says the transport's kind and nothing more: never
//! a bridge line, never whether bridges are private (R-25).

use crate::TransportKind;
use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The file, in the Tor folder.
pub const SETTINGS_FILE: &str = "settings.json";

/// When Tor starts (decision 11).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StartWhen {
    /// When Trino opens, so it is ready by the unlock.
    #[default]
    Open,
    /// At the unlock, and stopped at the lock: "Conectar a Tor solo
    /// después de desbloquear" (§10.2), and always with private bridges.
    OnUnlock,
}

/// What `tor/settings.json` holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TorSettings {
    pub transport: TransportKind,
    pub start: StartWhen,
}

impl TorSettings {
    pub fn path(tor_home: &Path) -> PathBuf {
        tor_home.join(SETTINGS_FILE)
    }

    /// The settings in `tor_home`; the defaults (no bridge, start at open)
    /// when there are none or they cannot be read.
    pub fn load(tor_home: &Path) -> TorSettings {
        std::fs::read(TorSettings::path(tor_home))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    /// Write them in `tor_home`, through a temporary file, so a cut leaves
    /// the old ones or the new ones.
    pub fn save(&self, tor_home: &Path) -> io::Result<()> {
        std::fs::create_dir_all(tor_home)?;
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        let path = TorSettings::path(tor_home);
        let temporary = tor_home.join(format!(".{SETTINGS_FILE}.tmp"));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(&temporary, path)
    }
}
