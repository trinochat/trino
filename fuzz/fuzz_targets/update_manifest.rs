//! What a mirror answers for the updater (trino-net update/): latest.json,
//! and the minisign signature in it, checked against Trino's real updater
//! key. Nothing a mirror sends is signed by that key, so this covers the
//! parsing before the signature: `manifest::parse` (through the
//! `fuzz_manifest` hook), `UpdateKey::check_comment` and
//! `UpdateKey::from_tauri`.
//!
//! Nothing may panic, and nothing unsigned may pass `check_comment`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use trino_net::update::{fuzz_manifest, Platform, UpdateKey};

fuzz_target!(|data: &[u8]| {
    let key = UpdateKey::trino();
    for platform in [Platform::WindowsX64, Platform::LinuxX64] {
        if let Some((_version, _url, signature)) = fuzz_manifest(data, platform) {
            assert!(
                key.check_comment(&signature, platform).is_err(),
                "an unsigned comment passed"
            );
        }
        if let Ok(text) = std::str::from_utf8(data) {
            assert!(
                key.check_comment(text, platform).is_err(),
                "an unsigned comment passed"
            );
        }
    }
    if let Ok(text) = std::str::from_utf8(data) {
        let _ = UpdateKey::from_tauri(text);
    }
});
