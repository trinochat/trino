pub mod blossom;
pub mod nostr;

// The protocol and cryptography now live in the `trino-core` crate so they can
// be audited on their own and shared with the mobile client. They are re-exported
// here so `crate::identity::…`, `crate::ratchet::…` etc. keep resolving.
pub use trino_core::{call_signal, crypto, envelope, group, identity, ratchet, totp, vault, x3dh};

mod a11y;
mod command_error;
mod commands;
mod fsutil;
mod passphrase;
mod state;
mod store;
mod totp_enrollment;
mod turn;
// -- W7 --
mod call_log;
mod connection;
mod diag;
mod net;
mod security_cmds;
// -- cifrado local CL-6a --
mod system_events;
// -- cifrado local CL-6b --
mod clipboard;
mod traces;
#[cfg(desktop)]
mod window_renewal;

use state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// Emitted when the window is closed while a call holds the microphone or
/// camera. The frontend asks "hang up and close?"; on confirmation it hangs
/// up, clears the flag (`set_call_active`) and closes the window again.
#[cfg_attr(not(desktop), allow(dead_code))]
const CLOSE_DURING_CALL_EVENT: &str = "call-close-requested";
/// Emitted when "Salir" is chosen in the tray during a call. The frontend
/// hangs up (sending `bye`) and clears the flag; we exit once it is cleared or
/// after `QUIT_BYE_GRACE`, whichever comes first.
#[cfg_attr(not(desktop), allow(dead_code))]
const QUIT_DURING_CALL_EVENT: &str = "call-quit-requested";
#[cfg_attr(not(desktop), allow(dead_code))]
const QUIT_BYE_GRACE: Duration = Duration::from_millis(1500);

/// Poll `call_active` until the frontend clears it (the call was hung up and
/// its `bye` sent) or `timeout` passes. Returns whether it was cleared.
#[cfg_attr(not(desktop), allow(dead_code))]
fn wait_for_call_release(call_active: &AtomicBool, timeout: Duration, poll: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !call_active.load(Ordering::SeqCst) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::sleep(poll.min(deadline - now));
    }
}

/// The tray's menu, by id and label, in order: open the window, lock
/// (cifrado local CL-6a, design §7.2) and quit.
#[cfg_attr(not(desktop), allow(dead_code))]
fn tray_items() -> Vec<(&'static str, &'static str)> {
    vec![
        ("open", "Abrir trino"),
        ("lock", "Bloquear"),
        ("quit", "Salir"),
    ]
}

/// Tray "Salir": give an active call the chance to send its `bye` first.
#[cfg(desktop)]
fn quit_app(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let call_active = std::sync::Arc::clone(&app.state::<AppState>().call_active);
    if !call_active.load(Ordering::SeqCst) {
        app.exit(0);
        return;
    }
    let _ = app.emit(QUIT_DURING_CALL_EVENT, ());
    let app = app.clone();
    std::thread::spawn(move || {
        wait_for_call_release(&call_active, QUIT_BYE_GRACE, Duration::from_millis(25));
        app.exit(0);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Desktop: the close button hides to the tray instead of quitting so
            // trino keeps receiving messages/calls in the background. Real quit
            // is via the tray menu ("Salir"). During a call, hiding would leave
            // the microphone open behind an invisible window, so the frontend
            // is asked to confirm and hang up first.
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::{Emitter, Manager};
                api.prevent_close();
                if window
                    .state::<AppState>()
                    .call_active
                    .load(Ordering::SeqCst)
                {
                    // Closed from the taskbar while minimized: bring it back so
                    // the confirmation is actually seen.
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    let _ = window.emit(CLOSE_DURING_CALL_EVENT, ());
                } else {
                    let _ = window.hide();
                }
            }
        })
        .setup(|_app| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                if let Ok(dir) = _app.path().app_data_dir() {
                    let trino_dir = dir.join("trino");
                    let _ = std::fs::create_dir_all(&trino_dir);
                    crate::state::set_trino_home(trino_dir);
                }
            }
            // Desktop: a system-tray icon so trino keeps running (connected,
            // receiving messages, ringing for calls) when the window is closed.
            // "Bloquear" locks from there (cifrado local CL-6a).
            #[cfg(desktop)]
            {
                use tauri::{
                    menu::{IsMenuItem, Menu, MenuItem},
                    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                    Manager,
                };
                let items = tray_items()
                    .into_iter()
                    .map(|(id, label)| MenuItem::with_id(_app, id, label, true, None::<&str>))
                    .collect::<tauri::Result<Vec<_>>>()?;
                let items: Vec<&dyn IsMenuItem<_>> = items
                    .iter()
                    .map(|item| item as &dyn IsMenuItem<_>)
                    .collect();
                let menu = Menu::with_items(_app, &items)?;
                let _ = TrayIconBuilder::with_id("trino-tray")
                    .icon(_app.default_window_icon().unwrap().clone())
                    .tooltip("trino")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "open" => window_renewal::show(app),
                        "lock" => commands::lock_cmds::tray_lock(app),
                        "quit" => quit_app(app),
                        _ => {}
                    })
                    .on_tray_icon_event(move |tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            window_renewal::show(&tray.app_handle().clone());
                        }
                    })
                    .build(_app)?;
                _app.manage(window_renewal::Renewal::default());
                if let Some(window) = _app.get_webview_window(window_renewal::MAIN) {
                    window_renewal::prepare(&window);
                }
            }
            // Windows: lock when Windows locks, sleeps or hibernates, unless
            // the account turned it off (design §7.2); and no heap in a crash
            // report of this process, which WER leaves out for this user
            // (design §8).
            #[cfg(windows)]
            {
                traces::limit_crash_reports();
                traces::exclude_from_crash_reports();
                let app = _app.handle().clone();
                system_events::listen(move |event| {
                    commands::lock_cmds::on_system_event(&app, event)
                });
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::totp_begin,
            commands::totp_verify,
            commands::forge,
            commands::unseal,
            commands::share_bundle,
            commands::relay_inspect_start,
            commands::relay_inspect_stop,
            commands::probe_node,
            commands::list_nodes,
            commands::connect_node,
            commands::send_message,
            commands::create_group,
            commands::list_groups,
            commands::add_group_member,
            commands::list_group_invites,
            commands::accept_group_invite,
            commands::decline_group_invite,
            commands::send_group_message,
            commands::send_file,
            commands::send_group_file,
            commands::fetch_file,
            commands::get_history,
            commands::get_profile,
            commands::update_profile,
            commands::forward_file,
            commands::remove_node,
            commands::rename_node,
            commands::block_node,
            commands::prune_expired,
            commands::import_sticker,
            commands::list_stickers,
            commands::delete_sticker,
            commands::get_call_config,
            turn::get_turn_servers,
            commands::send_call_signal,
            commands::set_call_active,
            commands::dev_log,
            commands::wipe,
            commands::lock_vault,
            commands::storage_cmds::store_choose,
            commands::storage_cmds::legacy_files_preview,
            commands::storage_cmds::legacy_files_import,
            commands::storage_cmds::legacy_files_remove,
            commands::prefs_cmds::prefs_save,
            commands::prefs_cmds::prefs_import,
            commands::prefs_cmds::prefs_get,
            commands::clipboard_cmds::clipboard_write_text,
            commands::clipboard_cmds::clipboard_write_image,
            commands::resend_outbox,
            commands::resync_session,
            commands::set_autostart,
            a11y::system_text_scale,
            // -- W7 --
            commands::get_autostart,
            security_cmds::check_passphrase,
            connection::connection_status,
            security_cmds::totp_enable,
            security_cmds::totp_disable,
            security_cmds::change_passphrase,
            call_log::record_call,
            call_log::list_call_history,
            // -- W8 --
            commands::contacts_cmds::preview_contact,
            commands::contacts_cmds::acknowledge_key_change,
            commands::groups_cmds::group_members,
            commands::groups_cmds::remove_group_member,
            commands::groups_cmds::rename_group,
            commands::groups_cmds::leave_group,
            commands::groups_cmds::delete_group,
            commands::history_cmds::delete_history_item,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // Each lock renews the window (cifrado local CL-6a).
            #[cfg(desktop)]
            window_renewal::on_run_event(_app, &_event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Design §12.6, test 69.
    #[test]
    fn the_tray_offers_lock() {
        assert_eq!(
            tray_items(),
            vec![
                ("open", "Abrir trino"),
                ("lock", "Bloquear"),
                ("quit", "Salir")
            ]
        );
    }

    /// Tor design §15, open question 4. src-tauri is a member of the
    /// workspace at the root, so every cargo command, the CI and `tauri
    /// build` included, reads the root Cargo.lock; a lock in src-tauri is
    /// never read and only drifts away from the real one.
    #[test]
    fn the_workspace_has_one_lockfile_at_the_root() {
        let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        assert!(
            app.join("../Cargo.lock").is_file(),
            "no Cargo.lock at the root"
        );
        assert!(
            !app.join("Cargo.lock").exists(),
            "src-tauri/Cargo.lock is never read: the workspace's lock is the root one"
        );
    }

    /// Tor design §2.8 and test 2 (R-07): clippy.toml disallows building
    /// trino-net's permit to go without Tor anywhere, and only these two
    /// files may do it under an `#[allow]`: the `net_connect_without_tor`
    /// command and the updater. The type's name is spelled in pieces so
    /// this file does not name it.
    #[test]
    fn only_two_files_name_direct_permit() {
        const PERMIT: &str = concat!("Direct", "Permit");
        const ALLOWED: [&str; 2] = ["commands.rs", "updater.rs"];
        fn sources(dir: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    sources(&path, found);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    found.push(path);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        sources(&root.join("src"), &mut files);
        files.push(root.join("build.rs"));
        assert!(files.len() > 20, "the sources were not found");

        for file in files {
            let name = file.file_name().unwrap().to_string_lossy().to_string();
            let source = std::fs::read_to_string(&file).unwrap();
            assert!(
                !source.contains(PERMIT) || ALLOWED.contains(&name.as_str()),
                "{} names {PERMIT}: only {ALLOWED:?} may",
                file.display()
            );
        }
    }

    #[test]
    fn quit_does_not_wait_when_no_call_is_active() {
        let flag = AtomicBool::new(false);
        let start = Instant::now();
        assert!(wait_for_call_release(
            &flag,
            Duration::from_secs(5),
            Duration::from_millis(5)
        ));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn quit_gives_up_after_the_timeout_if_the_frontend_never_answers() {
        let flag = AtomicBool::new(true);
        let start = Instant::now();
        assert!(!wait_for_call_release(
            &flag,
            Duration::from_millis(60),
            Duration::from_millis(5)
        ));
        assert!(start.elapsed() >= Duration::from_millis(60));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn quit_proceeds_as_soon_as_the_frontend_hangs_up() {
        let flag = Arc::new(AtomicBool::new(true));
        let frontend = Arc::clone(&flag);
        let hangup = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            frontend.store(false, Ordering::SeqCst);
        });
        let start = Instant::now();
        assert!(wait_for_call_release(
            &flag,
            Duration::from_secs(5),
            Duration::from_millis(5)
        ));
        assert!(start.elapsed() < Duration::from_secs(2));
        hangup.join().unwrap();
    }
}
