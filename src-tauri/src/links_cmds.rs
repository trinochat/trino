//! Links open in the browser, and only here (Tor design §3 L1, §4,
//! decision 16, R-10; TOR-6, PropTorSimple card 10).
//!
//! - The browser does not go through Tor: the page sees where you connect
//!   from. So `open_link` asks first ("Este enlace se abre en tu navegador,
//!   sin protección…") until the person ticks "No volver a preguntar", and
//!   that choice is kept here, in the account's `prefs.bin` under
//!   `net.linksNoAsk`, as one of the backend's own entries: the frontend
//!   neither gets it nor can set it by saving its preferences
//!   (prefs_cmds.rs). Without an open account (the first run, or locked),
//!   it always asks.
//! - Only http and https addresses with a host and no user or password
//!   open, and the question shows the address as it will open (its host
//!   in punycode), so a look-alike name cannot hide.
//! - The WebView cannot open addresses by itself any more: the opener
//!   plugin's permission is gone from the capability, and this is the one
//!   place that calls it.
//!
//! A child module of `commands`, so it reaches the helpers there.

use super::*;
use tauri::Url;

/// The entry of `prefs.bin` that holds "No volver a preguntar".
pub(crate) const LINKS_NO_ASK: &str = "net.linksNoAsk";

/// Longer than any address worth opening.
const MAX_LINK_CHARS: usize = 4096;

/// What `open_link` did.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum LinkAnswer {
    /// Nothing opened: ask first, showing `address`, as it would open.
    Ask { address: String },
    /// Opened in the browser. `remembered`: "No volver a preguntar" is kept.
    Opened { remembered: bool },
}

/// `raw` as an address the browser may open: http or https, with a host,
/// without a user or a password.
pub(crate) fn web_address(raw: &str) -> Result<Url, CommandError> {
    let refused = || CommandError::internal("not a web address");
    if raw.len() > MAX_LINK_CHARS {
        return Err(refused());
    }
    let url = Url::parse(raw.trim()).map_err(|_| refused())?;
    let web = matches!(url.scheme(), "http" | "https");
    if !web || url.host_str().is_none_or(str::is_empty) {
        return Err(refused());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refused());
    }
    Ok(url)
}

/// Whether opening a link asks first in the session of `inner`.
pub(crate) fn asks(inner: &InnerState) -> bool {
    inner.identity.is_none()
        || prefs_cmds::current_map(inner)
            .get(LINKS_NO_ASK)
            .map(String::as_str)
            != Some("1")
}

/// What to do with a link in the session of `inner`: ask, or open. A yes
/// with "No volver a preguntar" keeps that choice when the account can.
pub(crate) fn decide(
    inner: &InnerState,
    url: &Url,
    confirmed: bool,
    dont_ask_again: bool,
) -> LinkAnswer {
    let asking = asks(inner);
    if asking && !confirmed {
        return LinkAnswer::Ask {
            address: url.to_string(),
        };
    }
    let remembered = if asking && dont_ask_again {
        prefs_cmds::set_backend_pref(inner, LINKS_NO_ASK, Some("1")).is_ok()
    } else {
        !asking
    };
    LinkAnswer::Opened { remembered }
}

/// Open `url` in the system's browser: the only call to the opener.
fn open_in_browser(app: &tauri::AppHandle, url: &Url) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| CommandError::internal(e.to_string()))
}

/// Open a link in the browser, asking first unless the person said not to.
/// `confirmed`: the yes to the question; `dont_ask_again`: its checkbox.
#[tauri::command]
pub async fn open_link(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    confirmed: bool,
    dont_ask_again: bool,
) -> Result<LinkAnswer, CommandError> {
    let url = web_address(&url)?;
    let answer = {
        let inner = state.inner.lock().await;
        decide(&inner, &url, confirmed, dont_ask_again)
    };
    if matches!(answer, LinkAnswer::Opened { .. }) {
        open_in_browser(&app, &url)?;
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use std::collections::BTreeMap;

    fn link() -> Url {
        web_address("https://example.org/articulo").unwrap()
    }

    #[test]
    fn only_web_addresses_with_a_host_open() {
        for good in [
            "https://example.org/articulo",
            "http://example.org",
            "https://example.org/a?b=c#d",
        ] {
            assert!(web_address(good).is_ok(), "{good}");
        }
        for bad in [
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
            "mailto:ana@example.org",
            "trino://invite/abc",
            "ftp://example.org/",
            "https://",
            "https://ana:clave@example.org/",
            "https://ana@example.org/",
            "example.org",
            "",
        ] {
            assert!(web_address(bad).is_err(), "{bad} must be refused");
        }
        let long = format!("https://example.org/{}", "a".repeat(MAX_LINK_CHARS));
        assert!(web_address(&long).is_err());
    }

    /// The question shows the address as it opens: a look-alike host in
    /// punycode, not as it was written.
    #[test]
    fn the_question_shows_the_address_as_it_opens() {
        let inner = InnerState::default();
        let url = web_address("https://exаmple.org/x").unwrap(); // a Cyrillic "а"
        assert_eq!(
            decide(&inner, &url, false, false),
            LinkAnswer::Ask {
                address: "https://xn--exmple-4nf.org/x".to_string()
            }
        );
    }

    /// Design test 48 (Rust side): with no "No volver a preguntar", every
    /// link asks first; the yes opens it.
    #[test]
    fn a_link_asks_first_and_opens_after_the_yes() {
        let scratch = ScratchDir::new("links-ask");
        let inner = super::super::bridges_cmds::tests::unlocked_account(scratch.path());
        assert!(asks(&inner));
        assert_eq!(
            decide(&inner, &link(), false, false),
            LinkAnswer::Ask {
                address: "https://example.org/articulo".to_string()
            }
        );
        assert_eq!(
            decide(&inner, &link(), true, false),
            LinkAnswer::Opened { remembered: false }
        );
        // A yes without the box asks again next time.
        assert!(asks(&inner));
    }

    /// "No volver a preguntar" is kept in the account, as the backend's
    /// own entry: the next links open without asking, and the frontend can
    /// neither see it nor set it.
    #[test]
    fn a_link_with_tor_on_asks_once_unless_dismissed() {
        let scratch = ScratchDir::new("links-dismissed");
        let inner = super::super::bridges_cmds::tests::unlocked_account(scratch.path());
        assert_eq!(
            decide(&inner, &link(), true, true),
            LinkAnswer::Opened { remembered: true }
        );
        assert!(!asks(&inner));
        assert_eq!(
            decide(&inner, &link(), false, false),
            LinkAnswer::Opened { remembered: true }
        );

        let (shown, _) = prefs_cmds::prefs_of(&inner);
        assert!(shown.unwrap_or_default().get(LINKS_NO_ASK).is_none());
        // Saving the frontend's copy keeps it, and cannot add it either.
        prefs_cmds::save_in(&inner, &BTreeMap::new()).unwrap();
        assert!(!asks(&inner));

        let other = ScratchDir::new("links-forged");
        let fresh = super::super::bridges_cmds::tests::unlocked_account(other.path());
        let mut forged = BTreeMap::new();
        forged.insert(LINKS_NO_ASK.to_string(), "1".to_string());
        prefs_cmds::save_in(&fresh, &forged).unwrap();
        assert!(asks(&fresh), "the frontend cannot turn the question off");
    }

    /// Without an open account there is nowhere to keep the choice: it
    /// always asks, and the box keeps nothing.
    #[test]
    fn without_an_account_a_link_always_asks() {
        let inner = InnerState::default();
        assert!(asks(&inner));
        assert_eq!(
            decide(&inner, &link(), true, true),
            LinkAnswer::Opened { remembered: false }
        );
        assert!(asks(&inner));
    }

    /// Design test 62 (R-10): the WebView cannot open addresses itself, and
    /// this module is the only one that calls the opener.
    #[test]
    fn only_open_link_opens_urls_and_the_js_capability_cannot() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].to_string();
        assert!(!permissions.contains("opener:"), "{permissions}");

        let app = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut callers = Vec::new();
        // The engine (M4-0) opens nothing either.
        let mut stack = vec![app.join("src"), app.join("../crates/trino-engine/src")];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if text.contains(concat!(".open", "_url("))
                        || text.contains(concat!(".open", "_path("))
                    {
                        callers.push(path.file_name().unwrap().to_string_lossy().into_owned());
                    }
                }
            }
        }
        assert_eq!(callers, vec!["links_cmds.rs".to_string()]);
    }

    /// The command is registered, so the frontend reaches it.
    #[test]
    fn open_link_is_a_command() {
        let lib = include_str!("lib.rs");
        assert!(lib.contains("commands::links_cmds::open_link,"));
    }
}
