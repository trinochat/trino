//! latest.json (Tor design §6.2), as Tauri's updater and the release
//! script write it:
//!
//! ```json
//! { "version": "0.2.0", "pub_date": "…",
//!   "platforms": { "windows-x86_64": { "url": "…", "signature": "<tauri signer sign>" } } }
//! ```
//!
//! It is not signed, so only what a signature can vouch for is taken from
//! it: the version announced (checked against the signed one), and for
//! this platform, where the installer is and its signature. Anything else
//! (`notes`, `pub_date`) is never read (R-06, design test 54).

use crate::news::Version;
use serde::Deserialize;
use std::collections::BTreeMap;

/// The platforms a release is for, by latest.json's names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    /// Windows on x86-64: the NSIS installer, installed per user.
    WindowsX64,
    /// Linux on x86-64: the AppImage, as tauri-bundler names it
    /// (`<productName>_<version>_amd64.AppImage`). Running as an AppImage,
    /// Trino replaces it on the yes (appimage.rs, TOR-13); otherwise (a
    /// .deb, an .rpm) the release is saved in Downloads (§6.1).
    LinuxX64,
}

/// How the bundles name Trino: its product name, and the forms GitHub and
/// older builds give it.
const PRODUCT_NAMES: [&str; 3] = ["Trino Chat", "Trino.Chat", "TrinoChat"];

impl Platform {
    /// The platform this build runs on, if releases are made for it.
    pub fn current() -> Option<Platform> {
        if cfg!(all(windows, target_arch = "x86_64")) {
            Some(Platform::WindowsX64)
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            Some(Platform::LinuxX64)
        } else {
            None
        }
    }

    /// Its name in latest.json.
    pub fn key(self) -> &'static str {
        match self {
            Platform::WindowsX64 => "windows-x86_64",
            Platform::LinuxX64 => "linux-x86_64",
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Platform::WindowsX64 => "_x64-setup.exe",
            Platform::LinuxX64 => "_amd64.AppImage",
        }
    }

    /// The version in `file`, if it is the name of Trino's bundle for this
    /// platform: `<product>_<major.minor.patch><suffix>`, nothing more (no
    /// folder, no other product, no pre-release).
    pub(crate) fn version_in(self, file: &str) -> Option<Version> {
        let middle = file.strip_suffix(self.suffix())?;
        PRODUCT_NAMES.iter().find_map(|name| {
            middle
                .strip_prefix(name)?
                .strip_prefix('_')?
                .parse::<Version>()
                .ok()
        })
    }
}

/// What a manifest says for one platform.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Entry {
    pub version: Version,
    pub url: String,
    pub signature: String,
}

#[derive(Deserialize)]
struct Raw {
    version: String,
    #[serde(default)]
    platforms: BTreeMap<String, RawEntry>,
}

#[derive(Deserialize)]
struct RawEntry {
    url: String,
    signature: String,
}

/// The entry for `platform` in the manifest `bytes`, if it is one and has
/// it. A leading "v" in the version, as tags have, is taken.
pub(crate) fn parse(bytes: &[u8], platform: Platform) -> Option<Entry> {
    let mut raw: Raw = serde_json::from_slice(bytes).ok()?;
    let text = raw.version.strip_prefix('v').unwrap_or(&raw.version);
    let version = text.parse().ok()?;
    let entry = raw.platforms.remove(platform.key())?;
    Some(Entry {
        version,
        url: entry.url,
        signature: entry.signature,
    })
}
