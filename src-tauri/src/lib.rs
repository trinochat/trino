pub mod blossom;
pub mod call_signal;
pub mod crypto;
pub mod envelope;
pub mod group;
pub mod identity;
pub mod nostr;
pub mod ratchet;
pub mod totp;
pub mod vault;
pub mod x3dh;

mod commands;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_window_event(|window, event| {
            // Desktop: the close button hides to the tray instead of quitting so
            // trino keeps receiving messages/calls in the background. Real quit
            // is via the tray menu ("Salir").
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
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
            #[cfg(desktop)]
            {
                use tauri::{
                    menu::{Menu, MenuItem},
                    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
                    Manager,
                };
                let show = |app: &tauri::AppHandle| {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    }
                };
                let open = MenuItem::with_id(_app, "open", "Abrir trino", true, None::<&str>)?;
                let quit = MenuItem::with_id(_app, "quit", "Salir", true, None::<&str>)?;
                let menu = Menu::with_items(_app, &[&open, &quit])?;
                let _ = TrayIconBuilder::with_id("trino-tray")
                    .icon(_app.default_window_icon().unwrap().clone())
                    .tooltip("trino")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "open" => show(app),
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(move |tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show(&tray.app_handle().clone());
                        }
                    })
                    .build(_app)?;
            }
            // Linux: WebKitGTK denies getUserMedia (mic/camera) unless we handle
            // the permission-request signal. Without this, calls silently fail on
            // Ubuntu (the call button does nothing; accepting sends a reject that
            // looks like the callee hung up). Grant media requests here.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use webkit2gtk::{
                    glib::prelude::Cast, PermissionRequestExt, SettingsExt,
                    UserMediaPermissionRequest, WebViewExt,
                };
                if let Some(win) = _app.get_webview_window("main") {
                    let _ = win.with_webview(|webview| {
                        let wv = webview.inner();
                        // getUserMedia is off by default in WebKitGTK — enable it.
                        if let Some(settings) = wv.settings() {
                            settings.set_enable_media_stream(true);
                            settings.set_enable_mediasource(true);
                        }
                        // Grant only getUserMedia. Deny geolocation, pointer lock,
                        // DRM and every other WebKit permission request.
                        wv.connect_permission_request(|_wv, req| {
                            if req.is::<UserMediaPermissionRequest>() {
                                req.allow();
                            } else {
                                req.deny();
                            }
                            true
                        });
                    });
                }
            }
            Ok(())
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::status,
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
            commands::send_call_signal,
            commands::dev_log,
            commands::wipe,
            commands::lock_vault,
            commands::resend_outbox,
            commands::resync_session,
            commands::set_autostart,
            commands::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
