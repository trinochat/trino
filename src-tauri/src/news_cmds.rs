//! The news in the app (Tor design §7, R-06): "Novedades de Trino" come
//! from trino-net, fetched through Tor and verified in Rust against the
//! "Trino Updates" key built into the program. The WebView gets only what
//! `news_fetch` says, and it never fetches or verifies anything itself.
//!
//! - `news_fetch` needs no session: what this device has seen is in
//!   `tor/seen.json`, outside the store, so the updater (TOR-9) can check
//!   the news locked and before an account, with the same code.
//! - The account's old `trino:announcements:minSeq`, the highest `seq` the
//!   WebView kept in the preferences, is taken once into seen.json: at the
//!   unlock from the store, and at the one import of what the WebView kept
//!   before the store. The frontend never gets it again, and the next save
//!   of the preferences drops it (prefs_cmds.rs, `RETIRED_PREFS`).

use crate::command_error::CommandError;
use crate::state::AppState;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
pub(crate) use trino_engine::prefs::OLD_MIN_SEQ;
use trino_net::news::{self, News, Seen, Signer};
use trino_net::{HttpClient, Net};

/// The news now: every mirror through Tor, in a session of its own (Tor
/// design §2.7), verified against "Trino Updates", with what this device
/// has seen in its Tor folder.
pub(crate) async fn fetch(client: &HttpClient, now: u64) -> News {
    let net = client.net();
    let session = net.session();
    news::check(
        client,
        &session,
        Signer::trino_updates(),
        &news::FEED_MIRRORS,
        net.tor_home(),
        now,
    )
    .await
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The old `minSeq` among the entries the import took, if any.
pub(crate) fn old_min_seq_in(entries: &BTreeMap<String, String>) -> Option<u64> {
    entries.get(OLD_MIN_SEQ)?.trim().parse().ok()
}

/// Raise what this device has seen to the old `minSeq`, never lowering it.
pub(crate) fn take_old_min_seq(net: &Net, seq: Option<u64>) {
    if let (Some(seq), Some(tor_home)) = (seq, net.tor_home()) {
        // Not kept now (a full disk), taken again at the next unlock.
        let _ = Seen::raise_seq(tor_home, seq);
    }
}

/// "Novedades de Trino": what the channel shows. `{ status: verified |
/// bundled | untrusted, items, signerFingerprint, latest, freeze }`; the
/// items are there only when verified.
#[tauri::command]
pub async fn news_fetch(state: State<'_, AppState>) -> Result<News, CommandError> {
    let client = HttpClient::new(Arc::clone(&state.net));
    Ok(fetch(&client, now()).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::net_cmds::tests::{becomes, fake_tor};
    use trino_engine::prefs::old_min_seq;
    use trino_net::mock::Mock;
    use trino_net::news::NewsStatus;
    use trino_net::{mock_http, NetStatus, TransportKind};

    /// Signed by "Trino Updates" itself in July (by openpgp.js), as the app
    /// shipped it in public/updates/feed.json.
    const JULY_FEED: &[u8] =
        include_bytes!("../../crates/trino-net/src/news/testdata/feed-2026-07-21.json");
    const JULY_SEQ: u64 = 1_784_672_307;
    /// Signed through scripts/sign-announcement.mjs by a throwaway key:
    /// a good signature, by a key that is not "Trino Updates".
    const OTHER_KEYS_FEED: &[u8] =
        include_bytes!("../../crates/trino-net/src/news/testdata/gpg-feed.json");
    const NOW: u64 = 1_792_065_600;

    /// A ready Tor (a `FakeTor` over the returned `Mock`) whose folder is in
    /// `scratch`, a direct transport that fails the test, and a client that
    /// trusts the test CA, as trinochat.org's test server uses.
    async fn ready(scratch: &ScratchDir) -> (HttpClient, Arc<Mock>) {
        let (net, fake, mock) = fake_tor(&scratch.path().join(crate::state::TOR_DIR));
        net.start();
        fake.ready();
        becomes(
            &net,
            NetStatus::Ready {
                transport: TransportKind::None,
            },
        )
        .await;
        (HttpClient::with_tls(net, mock_http::test_tls()), mock)
    }

    fn serve(mock: &Mock, feed: &[u8]) {
        mock_http::serve(
            mock,
            "https://trinochat.org",
            vec![mock_http::response("200 OK", "", feed)],
        );
    }

    /// Design test 58 (R-06).
    #[tokio::test]
    async fn the_webview_only_gets_verified_news() {
        let scratch = ScratchDir::new("news-webview");
        let (client, mock) = ready(&scratch).await;

        // A good signature by another key: nothing of it reaches the
        // WebView, which is told the feed did not verify.
        serve(&mock, OTHER_KEYS_FEED);
        let untrusted = serde_json::to_value(fetch(&client, NOW).await).unwrap();
        assert_eq!(untrusted["status"], "untrusted");
        assert_eq!(untrusted["items"], serde_json::json!([]));
        assert!(!untrusted.to_string().contains("Un aviso de prueba"));

        // Trino Updates' own: its items, and whose key.
        serve(&mock, JULY_FEED);
        let verified = serde_json::to_value(fetch(&client, NOW).await).unwrap();
        assert_eq!(verified["status"], "verified");
        assert_eq!(verified["items"][0]["id"], "2026-07-17-mobile-themes");
        assert_eq!(
            verified["signerFingerprint"],
            "4DE8E4BC5872E37566FA4114A62EE5607F666A6B"
        );
        client.net().stop();
    }

    /// Design test 57 (R-06), the app's half: no session needed, the
    /// highest seen kept in tor/, and the old minSeq raising it.
    #[tokio::test]
    async fn the_news_need_no_session_and_keep_the_highest_seen_in_tor() {
        let scratch = ScratchDir::new("news-seen");
        let (client, mock) = ready(&scratch).await;
        let tor_home = scratch.path().join(crate::state::TOR_DIR);

        // `fetch` takes no session at all: it runs locked.
        serve(&mock, JULY_FEED);
        assert_eq!(fetch(&client, NOW).await.status, NewsStatus::Verified);
        assert_eq!(Seen::load(&tor_home).seq, JULY_SEQ);

        // An account that had seen a later feed: after its unlock, the July
        // one is a replay.
        take_old_min_seq(client.net(), Some(JULY_SEQ + 1));
        assert_eq!(Seen::load(&tor_home).seq, JULY_SEQ + 1);
        serve(&mock, JULY_FEED);
        assert_eq!(fetch(&client, NOW).await.status, NewsStatus::Untrusted);

        // Never lowered.
        take_old_min_seq(client.net(), Some(1));
        assert_eq!(Seen::load(&tor_home).seq, JULY_SEQ + 1);
        client.net().stop();
    }

    #[test]
    fn the_old_min_seq_is_read_from_the_preferences_and_the_import() {
        let prefs = serde_json::json!({ OLD_MIN_SEQ: "1784672307", "autolock": "1" });
        assert_eq!(old_min_seq(Some(&prefs)), Some(JULY_SEQ));
        for bad in [
            serde_json::json!({}),
            serde_json::json!({ OLD_MIN_SEQ: "-4" }),
            serde_json::json!({ OLD_MIN_SEQ: "x" }),
            serde_json::json!({ OLD_MIN_SEQ: 7 }),
        ] {
            assert_eq!(old_min_seq(Some(&bad)), None, "{bad}");
        }
        assert_eq!(old_min_seq(None), None);

        let taken: BTreeMap<String, String> = [(OLD_MIN_SEQ.to_string(), "9".to_string())].into();
        assert_eq!(old_min_seq_in(&taken), Some(9));
        assert_eq!(old_min_seq_in(&BTreeMap::new()), None);
    }
}
