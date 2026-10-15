//! WebView2 answers the page's permission requests itself, with its own
//! "Permitir / Bloquear" prompt, unless the app answers first. On Windows
//! that prompt came up when a call turned the camera on, and the microphone
//! the first time. Every window (window_renewal.rs, the first one and each
//! one a lock renews) answers instead: the camera and the microphone, for
//! the app's own page only, and nothing else to anyone. Trino's own consent
//! stays in the page, which asks for the microphone or the camera only once
//! the person acts (a call, the camera button); this only keeps WebView2
//! from asking a second time. Whatever the answer, nothing is kept in the
//! WebView's profile, so it leaves no trace there and every request is
//! answered here again.
//!
//! The origin is stricter than where the window may go
//! (`navigation::allowed`): `blob:`, `data:` and `about:blank` are never the
//! app asking for media.

use tauri::Url;

/// What a page asks for, as far as the answer goes.
#[cfg_attr(not(desktop), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Camera,
    Microphone,
    /// Anything else: the clipboard, notifications, the location, sensors,
    /// MIDI, fonts, downloads, windows, and whatever WebView2 adds later.
    Other,
}

/// The answer to a request.
#[cfg_attr(not(desktop), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Answer {
    Allow,
    Deny,
    /// Left to WebView2, which shows its prompt: only the app's camera or
    /// microphone, and only when the answer could not be kept out of the
    /// profile (a WebView2 older than `SavesInProfile`), so an "allow" is
    /// never stored there.
    Ask,
}

/// The answer to `kind` asked by the page at `uri`. `dev_url` is the
/// development server's address, only in `tauri dev`. `unsaved` says
/// whether the answer is kept out of the WebView's profile.
#[cfg_attr(not(desktop), allow(dead_code))]
pub(crate) fn answer(uri: &str, kind: Kind, dev_url: Option<&Url>, unsaved: bool) -> Answer {
    let media = matches!(kind, Kind::Camera | Kind::Microphone);
    match Url::parse(uri) {
        Ok(url) if media && is_the_app(&url, dev_url) => {
            if unsaved {
                Answer::Allow
            } else {
                Answer::Ask
            }
        }
        _ => Answer::Deny,
    }
}

/// Whether `url` is on the app's own origin: tauri://localhost on Linux
/// and macOS, http(s)://tauri.localhost on Windows, with no port and no
/// user, or the development server's origin when one is given.
fn is_the_app(url: &Url, dev_url: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || dev_url.is_some_and(|dev| {
                    url.scheme() == dev.scheme()
                        && url.host_str() == dev.host_str()
                        && url.port_or_known_default() == dev.port_or_known_default()
                })
        }
        _ => false,
    }
}

/// Answer every permission request of this window's WebView, from now on.
/// `dev_url` as in `answer`.
#[cfg(desktop)]
pub(crate) fn on_new_window(_window: &tauri::WebviewWindow, _dev_url: Option<Url>) {
    #[cfg(windows)]
    let _ = _window.with_webview(move |webview| {
        // SAFETY: on the main thread, where WebView2 wants its calls, with
        // the controller of a webview that is alive.
        let _ = unsafe { win::answer_requests(&webview.controller(), _dev_url) };
    });
}

/// WebView2 through `webview2-com`, the version wry builds.
#[cfg(windows)]
mod win {
    use super::{answer, Answer, Kind};
    use tauri::Url;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2PermissionRequestedEventArgs,
        ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::{Interface, Result, PWSTR};

    /// Every request of the page (and of its frames, which WebView2 passes
    /// on here once their own event goes unanswered) gets `answer`'s.
    pub(super) unsafe fn answer_requests(
        controller: &ICoreWebView2Controller,
        dev_url: Option<Url>,
    ) -> Result<()> {
        let webview = controller.CoreWebView2()?;
        let mut token = 0i64;
        webview.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                decide(&args, dev_url.as_ref())
            })),
            &mut token,
        )
    }

    unsafe fn decide(
        args: &ICoreWebView2PermissionRequestedEventArgs,
        dev_url: Option<&Url>,
    ) -> Result<()> {
        // Nothing is kept in the profile, whatever the answer. Without
        // this interface (a WebView2 older than 1.0.1823) the answer
        // would be kept, so the app's media is left to the prompt.
        let unsaved = args
            .cast::<ICoreWebView2PermissionRequestedEventArgs3>()
            .and_then(|args| args.SetSavesInProfile(false))
            .is_ok();
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        let mut uri = PWSTR::null();
        let answer = match (args.PermissionKind(&mut kind), args.Uri(&mut uri)) {
            (Ok(()), Ok(())) => answer(&take_pwstr(uri), kind_of(kind), dev_url, unsaved),
            (_, uri_read) => {
                if uri_read.is_ok() {
                    // Freed, though unused.
                    take_pwstr(uri);
                }
                Answer::Deny
            }
        };
        match answer {
            Answer::Allow => args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW),
            Answer::Deny => args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY),
            Answer::Ask => Ok(()),
        }
    }

    fn kind_of(kind: COREWEBVIEW2_PERMISSION_KIND) -> Kind {
        if kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA {
            Kind::Camera
        } else if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
            Kind::Microphone
        } else {
            Kind::Other
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    const APP: [&str; 7] = [
        "http://tauri.localhost",
        "http://tauri.localhost/",
        "http://tauri.localhost/index.html",
        "https://tauri.localhost/",
        "https://tauri.localhost/assets/index.js",
        "tauri://localhost",
        "tauri://localhost/",
    ];

    /// The app's own page gets its camera and microphone, with no prompt.
    #[test]
    fn the_app_gets_its_camera_and_microphone() {
        for uri in APP {
            for kind in [Kind::Camera, Kind::Microphone] {
                assert_eq!(
                    answer(uri, kind, None, true),
                    Answer::Allow,
                    "{uri} {kind:?}"
                );
            }
        }
    }

    /// Nothing else, not even to the app.
    #[test]
    fn the_app_gets_nothing_else() {
        for uri in APP {
            assert_eq!(answer(uri, Kind::Other, None, true), Answer::Deny, "{uri}");
            assert_eq!(answer(uri, Kind::Other, None, false), Answer::Deny, "{uri}");
        }
    }

    /// No other origin gets anything, the camera and microphone included:
    /// stricter than `navigation::allowed`, which lets the window go to
    /// `blob:`, `data:` and `about:blank`.
    #[test]
    fn every_other_origin_is_denied() {
        let dev = url("http://localhost:1420");
        for uri in [
            "about:blank",
            "about:srcdoc",
            "data:text/html,<p>hola</p>",
            "blob:http://tauri.localhost/0b7c1d6e-6c0a-4b8e-9d1e-2a3b4c5d6e7f",
            "https://example.org/",
            "http://example.org/",
            "https://trinochat.org/",
            "http://tauri.localhost.example.org/",
            "http://tauri.localhost:8080/",
            "https://tauri.localhost:8443/",
            "http://evil@tauri.localhost/",
            "http://ana:clave@tauri.localhost/",
            "tauri://localhost.example.org/",
            "tauri://localhost:1/",
            "tauri://tauri.localhost/",
            "http://localhost/",
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
            "file:///C:/Windows/win.ini",
            "ws://tauri.localhost/",
            "trino://invite/abc",
            "null",
            "",
            "tauri.localhost",
        ] {
            for kind in [Kind::Camera, Kind::Microphone, Kind::Other] {
                for unsaved in [true, false] {
                    for dev_url in [None, Some(&dev)] {
                        assert_eq!(
                            answer(uri, kind, dev_url, unsaved),
                            Answer::Deny,
                            "{uri:?} {kind:?} must be denied"
                        );
                    }
                }
            }
        }
    }

    /// In `tauri dev`, the development server too, and only it; never
    /// when no development server is given (a release build).
    #[test]
    fn the_development_server_only_when_given() {
        let dev = url("http://localhost:1420");
        for uri in [
            "http://localhost:1420",
            "http://localhost:1420/src/main.tsx",
        ] {
            assert_eq!(
                answer(uri, Kind::Camera, Some(&dev), true),
                Answer::Allow,
                "{uri}"
            );
            assert_eq!(answer(uri, Kind::Microphone, None, true), Answer::Deny);
            assert_eq!(answer(uri, Kind::Other, Some(&dev), true), Answer::Deny);
        }
    }

    /// When the answer could not be kept out of the profile, an "allow"
    /// would stay there: the app's camera and microphone are left to
    /// WebView2's prompt, as before, and everything else is still denied.
    #[test]
    fn an_allow_that_would_be_saved_is_left_to_the_prompt() {
        for uri in APP {
            for kind in [Kind::Camera, Kind::Microphone] {
                assert_eq!(answer(uri, kind, None, false), Answer::Ask, "{uri}");
            }
        }
        assert_eq!(
            answer("https://example.org/", Kind::Camera, None, false),
            Answer::Deny
        );
    }

    /// Every window answers: the first one and each one a lock renews go
    /// through `window_renewal::prepare`, which sets the handler.
    #[test]
    fn every_window_answers_the_requests() {
        let renewal = include_str!("window_renewal.rs").replace("\r\n", "\n");
        let prepare = &renewal[renewal.find("pub(crate) fn prepare(").unwrap()..];
        let prepare = &prepare[..prepare.find("\n}\n").unwrap()];
        assert!(
            prepare.contains("media_permission::on_new_window("),
            "window_renewal::prepare sets the handler"
        );
        let open = &renewal[renewal.find("fn open(").unwrap()..];
        let open = &open[..open.find("\n}\n").unwrap()];
        assert!(open.contains("prepare(&window"), "every window is prepared");

        let this = include_str!("media_permission.rs").replace("\r\n", "\n");
        assert!(
            // Split, so this test does not find itself.
            this.contains(concat!("add_Permission", "Requested("))
                && this.contains(concat!(".SetSaves", "InProfile(false)")),
            "WebView2's requests are answered and kept out of the profile"
        );
    }
}
