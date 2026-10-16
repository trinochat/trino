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
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::fsutil::scratch::ScratchDir;
    use crate::identity::{create_identity, Identity};
    use crate::state::InnerState;
    use crate::store::session::Found;
    use std::path::Path;

    const NOW: i64 = 1_760_000_000;

    #[test]
    fn a_legacy_profiles_bin_that_does_not_decrypt_is_kept_aside_and_a_new_one_started() {
        let scratch = ScratchDir::new("profiles-damaged");
        let path = scratch.path().join(PROFILES_FILE);
        // Damaged, or another identity's: no key here opens it.
        let damaged = b"a nonce, then a ciphertext that no key here opens".to_vec();
        std::fs::write(&path, &damaged).unwrap();
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: legacy_cell(scratch.path(), &me),
            ..InnerState::default()
        };

        let found = legacy_found(&path, &me);
        load_found(&mut inner, found, NOW);

        // Its bytes stay, for whoever can still read them,
        let aside = scratch.path().join(DAMAGED_PROFILES_FILE);
        assert_eq!(std::fs::read(&aside).unwrap(), damaged);
        // and the session goes on with a new profiles.bin, sealed as
        // earlier versions seal it.
        assert!(!inner.profiles.not_loaded);
        assert_eq!(inner.profiles.rev, NOW as u64);
        let Found::Ready(json) = legacy_found(&path, &me) else {
            panic!("not saved")
        };
        let saved: Profiles = serde_json::from_slice(&json).unwrap();
        assert_eq!(saved.rev, NOW as u64);
    }

    #[test]
    fn a_legacy_profiles_bin_that_cannot_be_read_is_kept_and_never_written() {
        let scratch = ScratchDir::new("profiles-unreadable");
        // A directory where profiles.bin should be: reading it fails, and
        // not because it is missing, as a file another program holds would.
        let path = scratch.path().join(PROFILES_FILE);
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inside"), b"keep").unwrap();
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: legacy_cell(scratch.path(), &me),
            ..InnerState::default()
        };

        let found = legacy_found(&path, &me);
        load_found(&mut inner, found, NOW);

        assert!(inner.profiles.not_loaded);
        assert_eq!(inner.profiles.rev, 0, "no first revision over the old one");
        assert!(!scratch.path().join(DAMAGED_PROFILES_FILE).exists());
        // This session never writes profiles.bin, and the profile cannot be
        // edited: its revision would go back.
        assert!(try_save(&inner).is_err());
        let error = check_editable(&inner.profiles).unwrap_err();
        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(std::fs::read(path.join("inside")).unwrap(), b"keep");
        // Locking forgets that, with the rest.
        inner.profiles.forget();
        assert!(!inner.profiles.not_loaded);
    }

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
        let storage: String = include_str!("storage_cmds.rs").split_whitespace().collect();
        let wipe = storage
            .split("pub(super)fnwipe_home(")
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

    /// The files of an account not moved to the store yet, in `home`.
    fn legacy_cell(home: &Path, me: &Identity) -> crate::store::session::StorageCell {
        let files = crate::commands::DataFiles::in_home(home.to_path_buf());
        let cell = crate::store::session::StorageCell::default();
        cell.set(crate::store::session::Storage::Legacy(Box::new(
            crate::commands::storage_cmds::legacy_files(&files, me),
        )));
        cell
    }
}
