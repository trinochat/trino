//! The shared profile (W8, K12) is the engine's (`trino_engine::profile`,
//! M4-0c): the rules of a profile message, sending and profiles.bin. Here,
//! where it was, stays what the desktop app adds: sending the profile in
//! the background through Tauri's `AppState`.

use crate::state::AppState;
use std::sync::Arc;
pub(crate) use trino_engine::profile::*;

/// `send_in_background` through `app`.
pub(crate) fn resend_through(app: tauri::AppHandle) -> Resend {
    Arc::new(move |targets| send_in_background(&app, targets))
}

/// `send_profile` without waiting for it.
pub(crate) fn send_in_background(app: &tauri::AppHandle, targets: Vec<String>) {
    if targets.is_empty() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let state = app.state::<AppState>();
        send_profile(&state, targets).await;
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_profiles_are_written_only_through_the_storage_and_a_wipe_removes_them() {
        // The store and the legacy files write atomically (store/disk.rs,
        // store/session.rs); the profiles, the engine's since M4-0c, write
        // no file of their own.
        let code = include_str!("../../crates/trino-engine/src/profile.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            !code.contains("fs::write") && !code.contains("atomic_write"),
            "profiles written past the storage"
        );
        assert!(code.contains("inner.storage.write_profiles("));
        // Nor does what stays of them here.
        let app = include_str!("profile.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            !app.contains("fs::write") && !app.contains("atomic_write"),
            "profiles written past the storage, in the app"
        );
        // A wipe removes store/ whole, and what earlier versions left.
        let storage: String = include_str!("../../crates/trino-engine/src/storage.rs")
            .split_whitespace()
            .collect();
        let wipe = storage
            .split("pubfnwipe_home(")
            .nth(1)
            .and_then(|rest| rest.split("#[cfg(test)]").next())
            .unwrap();
        assert!(
            wipe.contains("profile::PROFILES_FILE"),
            "wipe leaves profiles.bin behind"
        );
        assert!(
            wipe.contains("profile::DAMAGED_PROFILES_FILE"),
            "wipe leaves the copy legacy_found kept aside behind"
        );
    }
}
