//! Every lock renews the window (cifrado local CL-6a, design §7.2): the
//! window is destroyed and opened again where it was, so its WebView starts
//! over and the one that showed the chats goes with what it showed.
//! Reloading the page, or going to `about:blank`, could keep the same
//! renderer process and what it held (design §18.2), so neither is enough.
//!
//! Tauri keeps one window per label, and frees "main" only once the old
//! window is destroyed: the lock destroys it (`renew`), and the new one opens
//! as the event loop reports it gone (`on_run_event`). Destroying it does not
//! ask the frontend, as closing does. The new window opens hidden and shows
//! once its page has loaded, so no blank window flashes in between; one that
//! was hidden in the tray stays hidden, and a minimized one comes back
//! minimized.
//!
//! The window carries what tauri.conf.json gives it, kept out of captures
//! from the start (SC-1); main.tsx applies the stored choice again.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// The app's window, as tauri.conf.json and the capabilities name it.
pub(crate) const MAIN: &str = "main";

/// The window being renewed.
#[derive(Default)]
pub(crate) struct Renewal {
    /// Where the window was, from the moment it is destroyed until the new
    /// one opens.
    pending: Mutex<Option<Placement>>,
    /// From the destruction until a window opens again: the app must not
    /// quit for lack of windows meanwhile.
    active: AtomicBool,
}

/// Where the window was and how, to open the new one the same way.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Placement {
    visible: bool,
    minimized: bool,
    maximized: bool,
    focused: bool,
    /// Position and size in logical pixels, when the window is neither
    /// minimized nor maximized.
    frame: Option<(f64, f64, f64, f64)>,
}

impl Placement {
    fn of(window: &WebviewWindow) -> Placement {
        let minimized = window.is_minimized().unwrap_or(false);
        let maximized = window.is_maximized().unwrap_or(false);
        let scale = window.scale_factor().unwrap_or(1.0);
        let frame = match (
            minimized || maximized,
            window.outer_position(),
            window.inner_size(),
        ) {
            (false, Ok(position), Ok(size)) => {
                let position = position.to_logical::<f64>(scale);
                let size = size.to_logical::<f64>(scale);
                Some((position.x, position.y, size.width, size.height))
            }
            _ => None,
        };
        Placement {
            visible: window.is_visible().unwrap_or(true),
            minimized,
            maximized,
            focused: window.is_focused().unwrap_or(false),
            frame,
        }
    }
}

/// Destroy the window, to open it again once it is gone. Once at a time: a
/// renewal under way is not started twice.
pub(crate) fn renew(app: &AppHandle) {
    let renewal = app.state::<Renewal>();
    let Some(window) = app.get_webview_window(MAIN) else {
        return;
    };
    // Read before taking the lock: these getters wait for the event loop,
    // which takes the same lock as the window goes.
    let placement = Placement::of(&window);
    {
        let mut pending = renewal
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if pending.is_some() {
            return;
        }
        *pending = Some(placement);
    }
    renewal.active.store(true, Ordering::SeqCst);
    if window.destroy().is_err() {
        // The old window stays, on its unlock screen.
        renewal
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        renewal.active.store(false, Ordering::SeqCst);
    }
}

/// The event loop's side: open the new window as the old one is gone, and
/// keep the app running meanwhile.
pub(crate) fn on_run_event(app: &AppHandle, event: &RunEvent) {
    let renewal = app.state::<Renewal>();
    match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::Destroyed,
            ..
        } if label == MAIN => {
            let placement = renewal
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            // If it cannot open now, "Abrir trino" in the tray tries again.
            if placement.is_some() && open(app, placement).is_ok() {
                renewal.active.store(false, Ordering::SeqCst);
            }
        }
        RunEvent::ExitRequested {
            code: None, api, ..
        } if renewal.active.load(Ordering::SeqCst) => {
            api.prevent_exit();
        }
        _ => {}
    }
}

/// Show the window, or open it if a renewal could not.
pub(crate) fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else if open(app, None).is_ok() {
        app.state::<Renewal>().active.store(false, Ordering::SeqCst);
    }
}

/// Open the app's first window. tauri.conf.json does not let Tauri make it
/// (`create: false`), so it takes the navigation guard as the renewed ones
/// do.
pub(crate) fn open_main(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    open(app, None)
}

/// Open the window of tauri.conf.json: where `placement` says, shown once
/// its page has loaded, or as the config says.
fn open(app: &AppHandle, placement: Option<Placement>) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN)
        .cloned()
        .ok_or(tauri::Error::WindowNotFound)?;
    // It never goes anywhere but the app (Tor design §4, R-10).
    let dev_url = dev_url(app);
    let mut builder = WebviewWindowBuilder::from_config(app, &config)?
        .on_navigation(move |url| crate::navigation::allowed(url, dev_url.as_ref()));
    if let Some(placement) = placement {
        builder = builder
            .visible(false)
            .maximized(placement.maximized)
            .focused(placement.focused);
        if let Some((x, y, width, height)) = placement.frame {
            builder = builder.position(x, y).inner_size(width, height);
        }
        let waiting = AtomicBool::new(placement.visible);
        builder = builder.on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || !waiting.swap(false, Ordering::SeqCst)
            {
                return;
            }
            if placement.minimized {
                let _ = window.minimize();
            } else {
                let _ = window.show();
                if placement.focused {
                    let _ = window.set_focus();
                }
            }
        });
    }
    let window = builder.build()?;
    prepare(&window);
    Ok(window)
}

/// The development server's address, only in `tauri dev`.
fn dev_url(app: &AppHandle) -> Option<tauri::Url> {
    if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// What every new window needs before its page runs.
pub(crate) fn prepare(_window: &WebviewWindow) {
    // Its downloads leave no history, and the history and minidumps of
    // before go (cifrado local CL-6b, src/traces.rs).
    crate::traces::on_new_window(_window);
    // WebView2 asks nothing: the app's camera and microphone are allowed,
    // everything else is denied, and nothing stays in its profile
    // (src/media_permission.rs). Trino's own consent stays in the page.
    crate::media_permission::on_new_window(_window, dev_url(_window.app_handle()));
    // Linux: WebKitGTK denies getUserMedia (mic/camera) unless we handle
    // the permission-request signal. Without this, calls silently fail on
    // Ubuntu (the call button does nothing; accepting sends a reject that
    // looks like the callee hung up). Grant media requests here.
    #[cfg(target_os = "linux")]
    {
        // ObjectExt, not Cast: `is::<T>()` lives on ObjectExt in glib
        // 0.18. This only ever compiles on Linux, so nothing caught it
        // until CI started building for Ubuntu.
        use webkit2gtk::{
            glib::prelude::ObjectExt, PermissionRequestExt, SettingsExt,
            UserMediaPermissionRequest, WebViewExt,
        };
        let _ = _window.with_webview(|webview| {
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
