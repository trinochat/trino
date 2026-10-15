//! The window never goes anywhere but the app (Tor design §3 L3, §4, R-10;
//! TOR-6). Without a navigation handler Tauri lets the WebView follow any
//! address, so a link or a script could load a remote page straight from
//! the network, outside Tor. The main window, and each one a lock renews
//! (window_renewal.rs), takes `allowed` as its handler: the app's own
//! origin, the development server in `tauri dev`, and the addresses that
//! never leave the device. Links go to the browser through `open_link`
//! (links_cmds.rs), never through the WebView.

use tauri::Url;

/// Whether the WebView may go to `url`. `dev_url` is the development
/// server's address, only in `tauri dev`.
pub(crate) fn allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    match url.scheme() {
        // The app as Tauri serves it: tauri://localhost on Linux and macOS,
        // http(s)://tauri.localhost on Windows.
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || dev_url.is_some_and(|dev| same_origin(url, dev))
        }
        // Never the network: a file the app made (a download), and the
        // empty page.
        "blob" | "data" => true,
        "about" => url.path() == "blank",
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    /// Design test 61 (R-10): the app's origin and nothing remote, in the
    /// main window and in the renewed ones (both take this handler, see
    /// `every_window_takes_the_guard`).
    #[test]
    fn navigation_to_any_remote_origin_is_denied() {
        for app in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "http://tauri.localhost/assets/index.js",
            "https://tauri.localhost/",
            "about:blank",
            "data:text/plain,hola",
            "blob:http://tauri.localhost/0b7c1d6e-6c0a-4b8e-9d1e-2a3b4c5d6e7f",
        ] {
            assert!(allowed(&url(app), None), "{app} is the app's");
        }
        for remote in [
            "https://example.org/articulo",
            "http://example.org/",
            "https://trinochat.org/",
            "http://tauri.localhost.example.org/",
            "http://tauri.localhost:8080/",
            "tauri://localhost.example.org/",
            "http://localhost:1420/",
            "http://127.0.0.1/",
            "file:///C:/Windows/win.ini",
            "mailto:ana@example.org",
            "ftp://example.org/",
            "ws://example.org/",
            "trino://invite/abc",
            "about:srcdoc",
        ] {
            assert!(!allowed(&url(remote), None), "{remote} must be denied");
        }
    }

    /// In `tauri dev`, the development server too, and only it.
    #[test]
    fn the_development_server_is_allowed_only_when_given() {
        let dev = url("http://localhost:1420");
        assert!(allowed(&url("http://localhost:1420/"), Some(&dev)));
        assert!(allowed(
            &url("http://localhost:1420/src/main.tsx"),
            Some(&dev)
        ));
        assert!(!allowed(&url("http://localhost:1421/"), Some(&dev)));
        assert!(!allowed(&url("https://localhost:1420/"), Some(&dev)));
        assert!(!allowed(&url("https://example.org/"), Some(&dev)));
        assert!(!allowed(&url("http://localhost:1420/"), None));
    }

    /// Both windows take the guard: the first one is not made from the
    /// configuration by Tauri (`create: false`), but by the app, through
    /// the same `open` a lock uses to renew it, which sets the handler.
    #[test]
    fn every_window_takes_the_guard() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = &config["app"]["windows"][0];
        assert_eq!(main["label"], "main");
        assert_eq!(
            main["create"], false,
            "Tauri would make it without the guard"
        );

        let renewal = include_str!("window_renewal.rs").replace("\r\n", "\n");
        let open = &renewal[renewal.find("fn open(").unwrap()..];
        let open = &open[..open.find("\n}\n").unwrap()];
        assert!(
            open.contains(".on_navigation(") && open.contains("navigation::allowed("),
            "window_renewal::open sets the guard"
        );

        let lib = include_str!("lib.rs");
        let setup = &lib[lib.find(".setup(").unwrap()..];
        assert!(
            setup.contains("window_renewal::open_main("),
            "the app opens its first window itself"
        );
    }
}
