//! The tests of the news (Tor design §7, §6.4 and §11.6–§11.8: tests 42,
//! 43, 44, 55 and 57, with R-06). Tor is the in-memory `Mock`, trinochat.org
//! and the mirrors are servers of mock_http.rs with the test CA, and the
//! direct transport fails the test if anything touches it. The feeds are
//! signed here with keys made for the tests, except two files: the feed the
//! real "Trino Updates" key signed in July, and one GnuPG signed through
//! scripts/sign-announcement.mjs with a throwaway key.

use crate::mock::{Forbidden, Mock};
use crate::mock_http::{self, Reply};
use crate::news::{self, Freeze, News, NewsError, NewsStatus, Seen, Signer, Version};
use crate::*;
use pgp::composed::{
    ArmorOptions, DetachedSignature, KeyType, SecretKeyParamsBuilder, SignedSecretKey,
};
use pgp::crypto::hash::HashAlgorithm;
use pgp::types::{KeyDetails, Password};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

const DAY: u64 = 24 * 60 * 60;
/// 15 Oct 2026, noon UTC: "now" in these tests.
const NOW: u64 = 1_792_065_600;
const FEED_URL: &str = "https://trinochat.org/updates/feed.json";

/// A folder of its own under the system's temporary folder, removed at
/// the end. Never ~/.trino.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("trino-news-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---- Keys made for the tests ----

/// An Ed25519 key, as "Trino Updates" is, and its public half as a
/// `Signer` would take it.
struct TestKey {
    secret: SignedSecretKey,
    armored: String,
    fingerprint: String,
}

impl TestKey {
    fn new(name: &str) -> TestKey {
        let mut params = SecretKeyParamsBuilder::default();
        params
            .key_type(KeyType::Ed25519Legacy)
            .can_certify(true)
            .can_sign(true)
            .primary_user_id(format!("{name} <test@trino.invalid>"));
        let secret = params
            .build()
            .unwrap()
            .generate(rand::thread_rng())
            .unwrap();
        let public = secret.to_public_key();
        let armored = public.to_armored_string(ArmorOptions::default()).unwrap();
        let fingerprint = format!("{:X}", public.fingerprint());
        TestKey {
            secret,
            armored,
            fingerprint,
        }
    }

    fn signer(&self) -> Signer {
        Signer::from_armored(&self.armored, &self.fingerprint).unwrap()
    }

    /// The envelope the script writes: the payload as it is, and a
    /// detached signature over its bytes.
    fn envelope(&self, payload: &str) -> Vec<u8> {
        let signature = DetachedSignature::sign_binary_data(
            rand::thread_rng(),
            &self.secret.primary_key,
            &Password::empty(),
            HashAlgorithm::Sha256,
            payload.as_bytes(),
        )
        .unwrap()
        .to_armored_string(ArmorOptions::default())
        .unwrap();
        serde_json::to_vec(&serde_json::json!({ "payload": payload, "signature": signature }))
            .unwrap()
    }
}

static KEY: LazyLock<TestKey> = LazyLock::new(|| TestKey::new("Trino News Test"));

/// A payload with one announcement, `seq`, and the other fields as given.
fn payload(seq: u64, latest: Option<&str>, valid_until: Option<u64>) -> String {
    let mut value = serde_json::json!({
        "announcements": [{
            "id": format!("aviso-{seq}"),
            "title": "Trino 0.2.0",
            "body": "Ya puedes usar Tor.",
            "publishedAt": "2026-10-14T12:00:00-05:00",
            "version": "0.2.0",
            "url": "https://trinochat.org/"
        }],
        "seq": seq,
    });
    if let Some(latest) = latest {
        value["latest"] = latest.into();
    }
    if let Some(valid_until) = valid_until {
        value["validUntil"] = valid_until.into();
    }
    value.to_string()
}

// ---- The network side: Tor only, servers in the test ----

/// A `Net` whose Tor is `tor` and whose direct transport panics if used.
fn tor_only(tor: Option<Arc<Mock>>) -> Arc<Net> {
    Net::with_transports(tor.map(|t| t as Arc<dyn Transport>), Arc::new(Forbidden))
}

fn client(net: Arc<Net>) -> HttpClient {
    HttpClient::with_tls(net, mock_http::test_tls())
}

fn ok(body: &[u8]) -> Reply {
    mock_http::response("200 OK", "Content-Type: application/json\r\n", body)
}

/// One check of `mirrors` on `tor`, with `signer`, keeping what it saw in
/// `home`.
async fn check_on(
    tor: &Arc<Mock>,
    signer: &Signer,
    mirrors: &[&str],
    home: Option<&Path>,
    now: u64,
) -> News {
    let net = tor_only(Some(Arc::clone(tor)));
    let session = net.session();
    let client = client(net);
    let work = news::check(&client, &session, signer, mirrors, home, now);
    tokio::time::timeout(std::time::Duration::from_secs(10), work)
        .await
        .expect("a check with no deadline")
}

// ---- The keys and the signatures ----

#[test]
fn the_built_in_key_is_trino_updates() {
    assert_eq!(
        news::TRINO_UPDATES_FINGERPRINT,
        "4DE8E4BC5872E37566FA4114A62EE5607F666A6B"
    );
    assert_eq!(
        Signer::trino_updates().fingerprint(),
        news::TRINO_UPDATES_FINGERPRINT
    );
}

#[test]
fn the_feed_trino_updates_signed_in_july_verifies_in_rust() {
    // Signed by openpgp.js with the real key, as the app shipped it in
    // public/updates/feed.json: the same key, checked by rPGP.
    let envelope = include_bytes!("news/testdata/feed-2026-07-21.json");

    let feed = news::verify(Signer::trino_updates(), envelope).unwrap();

    assert_eq!(feed.seq, 1_784_672_307);
    assert_eq!(feed.latest, None);
    assert_eq!(feed.valid_until, None);
    assert_eq!(feed.announcements.len(), 1);
    assert_eq!(feed.announcements[0].id, "2026-07-17-mobile-themes");
    assert_eq!(feed.announcements[0].version.as_deref(), Some("0.1.0"));
}

#[test]
fn a_feed_the_script_signed_with_gnupg_verifies_in_rust() {
    // scripts/sign-announcement.mjs, run with a key made for this test
    // and thrown away (its secret half is nowhere): what gpg writes is
    // what rPGP reads.
    let signer = Signer::from_armored(
        include_str!("news/testdata/gpg-test-key.asc"),
        "12F5C03BBBF232BD36658188A50612F1AFBADA7A",
    )
    .unwrap();

    let feed = news::verify(&signer, include_bytes!("news/testdata/gpg-feed.json")).unwrap();

    assert_eq!(feed.seq, 1_790_000_000);
    assert_eq!(feed.latest, Some(Version::new(0, 2, 0)));
    assert_eq!(feed.valid_until, Some(1_794_603_881));
    assert_eq!(
        feed.announcements[0].url.as_deref(),
        Some("https://trinochat.org/")
    );
}

#[test]
fn a_changed_payload_or_another_key_is_refused() {
    let envelope = KEY.envelope(&payload(5, None, None));
    assert!(news::verify(&KEY.signer(), &envelope).is_ok());

    // One character of the payload changed after signing.
    let changed = String::from_utf8(envelope.clone())
        .unwrap()
        .replace("Ya puedes", "Ya puedas");
    assert_eq!(
        news::verify(&KEY.signer(), changed.as_bytes()).unwrap_err(),
        NewsError::Signature
    );

    // Signed by a key that is not the one asked for.
    let other = TestKey::new("Someone Else");
    assert_eq!(
        news::verify(&KEY.signer(), &other.envelope(&payload(5, None, None))).unwrap_err(),
        NewsError::Signature
    );
    assert_eq!(
        news::verify(Signer::trino_updates(), &envelope).unwrap_err(),
        NewsError::Signature
    );

    // A key is taken only under its own fingerprint.
    assert!(matches!(
        Signer::from_armored(&KEY.armored, news::TRINO_UPDATES_FINGERPRINT),
        Err(NewsError::Signer)
    ));

    // Not an envelope, or no signature in it.
    assert_eq!(
        news::verify(&KEY.signer(), b"<html>").unwrap_err(),
        NewsError::Envelope
    );
    let unsigned = serde_json::json!({ "payload": payload(5, None, None), "signature": "" });
    assert_eq!(
        news::verify(&KEY.signer(), unsigned.to_string().as_bytes()).unwrap_err(),
        NewsError::Signature
    );
}

#[test]
fn a_signed_payload_is_still_checked_field_by_field() {
    let refused = |payload: String| {
        let envelope = KEY.envelope(&payload);
        news::verify(&KEY.signer(), &envelope).unwrap_err()
    };
    let item = serde_json::json!({
        "id": "a", "title": "t", "body": "b", "publishedAt": "2026-10-14T12:00:00Z"
    });
    let with = |change: &dyn Fn(&mut serde_json::Value)| {
        let mut value = serde_json::json!({ "announcements": [item.clone()], "seq": 1 });
        change(&mut value);
        value.to_string()
    };

    assert!(news::verify(&KEY.signer(), &KEY.envelope(&with(&|_| {}))).is_ok());
    for (what, payload) in [
        (
            "no seq",
            with(&|v| {
                v.as_object_mut().unwrap().remove("seq");
            }),
        ),
        ("a negative seq", with(&|v| v["seq"] = (-1).into())),
        ("seq past 2^53", with(&|v| v["seq"] = (1u64 << 53).into())),
        (
            "no list",
            with(&|v| {
                v.as_object_mut().unwrap().remove("announcements");
            }),
        ),
        (
            "51 announcements",
            with(&|v| v["announcements"] = vec![item.clone(); 51].into()),
        ),
        (
            "a link without https",
            with(&|v| v["announcements"][0]["url"] = "http://trinochat.org/".into()),
        ),
        (
            "a date that is none",
            with(&|v| v["announcements"][0]["publishedAt"] = "ayer".into()),
        ),
        (
            "an empty title",
            with(&|v| v["announcements"][0]["title"] = "  ".into()),
        ),
        (
            "a title of 121",
            with(&|v| v["announcements"][0]["title"] = "x".repeat(121).into()),
        ),
        (
            "a body of 5001",
            with(&|v| v["announcements"][0]["body"] = "x".repeat(5001).into()),
        ),
        (
            "latest that is no version",
            with(&|v| v["latest"] = "v0.2".into()),
        ),
        (
            "validUntil as text",
            with(&|v| v["validUntil"] = "mañana".into()),
        ),
        ("not an object", "[]".to_string()),
    ] {
        assert!(
            matches!(refused(payload), NewsError::Payload(_)),
            "took {what}"
        );
    }

    // Over 512 KB, signed or not.
    let big = with(&|v| v["announcements"][0]["body"] = "x".repeat(600_000).into());
    assert!(matches!(
        refused(big),
        NewsError::Payload(_) | NewsError::Envelope
    ));
}

#[test]
fn versions_and_dates() {
    assert_eq!("0.2.0".parse::<Version>(), Ok(Version::new(0, 2, 0)));
    assert!(Version::new(0, 10, 0) > Version::new(0, 9, 9));
    assert!(Version::new(1, 0, 0) > Version::new(0, 99, 99));
    for bad in [
        "",
        "0.2",
        "0.2.0.1",
        "v0.2.0",
        "0.2.x",
        "0.2.0-beta",
        " 0.2.0",
    ] {
        assert!(bad.parse::<Version>().is_err(), "took {bad:?}");
    }
    assert_eq!(Version::new(0, 2, 0).to_string(), "0.2.0");

    for good in [
        "2026-10-14T12:00:00Z",
        "2026-07-17T09:30:00-05:00",
        "2026-07-17T09:30:00.123+01:00",
    ] {
        assert!(news::is_timestamp(good), "refused {good}");
    }
    for bad in [
        "2026-10-14",
        "14/10/2026",
        "2026-13-01T00:00:00Z",
        "2026-10-14T25:00:00Z",
    ] {
        assert!(!news::is_timestamp(bad), "took {bad}");
    }
}

// ---- Design test 44 (R-06): the built-in key, never one from the network ----

#[tokio::test]
async fn news_are_verified_in_rust_with_the_built_in_key_never_one_from_the_network() {
    // A feed signed by another key, which whoever serves it could also
    // serve as public-key.asc: the app never asks for it.
    let tor = Mock::new();
    let seen = mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(5, None, None)))],
    );

    let news = check_on(&tor, Signer::trino_updates(), &[FEED_URL], None, NOW).await;

    assert_eq!(news.status, NewsStatus::Untrusted);
    assert!(news.items.is_empty(), "unverified items reached the app");
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0]
            .head
            .starts_with("GET /updates/feed.json HTTP/1.1"),
        "{}",
        requests[0].head
    );
    // Through Tor, by name, on the news' own token.
    let (target, iso) = &tor.connections()[0];
    assert_eq!((target.host.as_str(), target.port), ("trinochat.org", 443));
    assert_eq!(iso.kind(), IsoKind::NEWS);
}

#[tokio::test]
async fn a_verified_feed_reaches_the_app_and_the_highest_seen_is_kept() {
    let scratch = Scratch::new("verified");
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(
            7,
            Some("0.2.0"),
            Some(NOW + 30 * DAY),
        )))],
    );

    let news = check_on(&tor, &KEY.signer(), &[FEED_URL], Some(scratch.path()), NOW).await;

    assert_eq!(news.status, NewsStatus::Verified);
    assert_eq!(news.items.len(), 1);
    assert_eq!(news.items[0].id, "aviso-7");
    assert_eq!(
        news.signer_fingerprint.as_deref(),
        Some(KEY.fingerprint.as_str())
    );
    assert_eq!(news.latest.as_deref(), Some("0.2.0"));
    assert_eq!(news.freeze, None);
    let seen = Seen::load(scratch.path());
    assert_eq!(seen.seq, 7);
    assert_eq!(seen.latest, Some(Version::new(0, 2, 0)));
    assert_eq!(seen.valid_until, Some(NOW + 30 * DAY));
    // Day by day only: the file never says when Trino was open to the
    // second.
    assert_eq!(seen.fresh_at, Some(NOW - NOW % DAY));
}

#[tokio::test]
async fn nothing_served_or_a_server_error_is_the_bundled_copy() {
    for reply in [
        mock_http::response("404 Not Found", "", b"no"),
        mock_http::response("200 OK", "", &vec![b'x'; news::MAX_FEED_BYTES + 1]),
    ] {
        let tor = Mock::new();
        mock_http::serve(&tor, "https://trinochat.org", vec![reply]);
        let news = check_on(&tor, &KEY.signer(), &[FEED_URL], None, NOW).await;
        assert_eq!(news.status, NewsStatus::Bundled);
        assert!(news.items.is_empty());
    }
    // Nobody listening.
    let news = check_on(&Mock::new(), &KEY.signer(), &[FEED_URL], None, NOW).await;
    assert_eq!(news.status, NewsStatus::Bundled);
}

// ---- Rollback (R-06): never below the highest seen ----

#[tokio::test]
async fn a_feed_below_the_highest_seen_is_untrusted_and_changes_nothing() {
    let scratch = Scratch::new("rollback");
    let kept = Seen {
        seq: 10,
        latest: Some(Version::new(0, 3, 0)),
        ..Seen::default()
    };
    kept.save(scratch.path()).unwrap();

    for older in [
        payload(9, Some("0.3.0"), None),  // a lower seq
        payload(11, Some("0.2.0"), None), // a higher seq saying an older latest
    ] {
        let tor = Mock::new();
        mock_http::serve(
            &tor,
            "https://trinochat.org",
            vec![ok(&KEY.envelope(&older))],
        );
        let news = check_on(&tor, &KEY.signer(), &[FEED_URL], Some(scratch.path()), NOW).await;
        assert_eq!(news.status, NewsStatus::Untrusted);
        assert!(news.items.is_empty());
        let seen = Seen::load(scratch.path());
        assert_eq!((seen.seq, seen.latest), (10, Some(Version::new(0, 3, 0))));
    }

    // The same seq again is fine: the feed did not change.
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(10, Some("0.3.0"), None)))],
    );
    let news = check_on(&tor, &KEY.signer(), &[FEED_URL], Some(scratch.path()), NOW).await;
    assert_eq!(news.status, NewsStatus::Verified);
}

// ---- Every mirror is asked, and the highest wins (R-06) ----

#[tokio::test]
async fn every_mirror_is_asked_and_the_highest_verified_feed_wins() {
    let mirror = "https://mirror.trino.invalid/news/feed.json";
    let tor = Mock::new();
    // An old feed, validly signed, on trinochat.org; a newer one on the
    // mirror; and garbage on a third.
    let first = mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(5, Some("0.1.0"), None)))],
    );
    let second = mock_http::serve(
        &tor,
        "https://mirror.trino.invalid",
        vec![ok(&KEY.envelope(&payload(9, Some("0.2.0"), None)))],
    );
    let third = mock_http::serve(&tor, "https://bad.trino.invalid", vec![ok(b"{}")]);

    let news = check_on(
        &tor,
        &KEY.signer(),
        &[FEED_URL, mirror, "https://bad.trino.invalid/feed.json"],
        None,
        NOW,
    )
    .await;

    assert_eq!(news.status, NewsStatus::Verified);
    assert_eq!(news.items[0].id, "aviso-9");
    assert_eq!(news.latest.as_deref(), Some("0.2.0"));
    for server in [&first, &second, &third] {
        assert_eq!(server.lock().unwrap().len(), 1, "a mirror was not asked");
    }
    // One check, one session; each mirror its own circuit.
    let tokens: Vec<Iso> = tor.connections().into_iter().map(|(_, iso)| iso).collect();
    assert_eq!(tokens.len(), 3);
    assert!(tokens.iter().all(|iso| iso.kind() == IsoKind::NEWS));
    assert_ne!(tokens[0], tokens[1]);
    assert_ne!(tokens[1], tokens[2]);
}

#[test]
fn the_news_mirrors_are_trinochat_org_over_https() {
    // §7: the feed is on trinochat.org; the onion joins when it exists.
    assert_eq!(
        news::FEED_MIRRORS,
        ["https://trinochat.org/updates/feed.json"]
    );
    assert_eq!(news::MAX_FEED_BYTES, 512_000);
}

// ---- Design test 42, the news' half: no check without Tor ----

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the session's permit is what is under test
async fn no_check_runs_without_tor() {
    // "Conectar sin Tor": the news wait (§2.8); the direct transport is
    // never touched (it panics) and Tor is not asked either.
    let tor = Mock::new();
    let net = tor_only(Some(Arc::clone(&tor)));
    net.allow_direct(DirectPermit::for_session()).unwrap();
    let session = net.session();
    let news = news::check(
        &client(net),
        &session,
        &KEY.signer(),
        &[FEED_URL],
        None,
        NOW,
    )
    .await;
    assert_eq!(news.status, NewsStatus::Bundled);
    assert!(tor.connections().is_empty());

    // No Tor at all: the bundled copy, at once, and nothing direct.
    let net = tor_only(None);
    let session = net.session();
    let news = news::check(
        &client(net),
        &session,
        &KEY.signer(),
        &[FEED_URL],
        None,
        NOW,
    )
    .await;
    assert_eq!(news.status, NewsStatus::Bundled);
}

// ---- Design test 55 (R-06): an expired feed counts as a freeze ----

#[tokio::test]
async fn an_expired_news_feed_counts_as_a_freeze() {
    let scratch = Scratch::new("expired");
    // Fresh when fetched three days before its end...
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(
            7,
            Some("0.2.0"),
            Some(NOW + 3 * DAY),
        )))],
    );
    let news = check_on(&tor, &KEY.signer(), &[FEED_URL], Some(scratch.path()), NOW).await;
    assert_eq!(news.freeze, None);

    // ...and served, the same, every day after: still verified, but past
    // its validUntil it no longer says there is nothing newer.
    let later = NOW + 5 * DAY;
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(
            7,
            Some("0.2.0"),
            Some(NOW + 3 * DAY),
        )))],
    );
    let news = check_on(
        &tor,
        &KEY.signer(),
        &[FEED_URL],
        Some(scratch.path()),
        later,
    )
    .await;
    assert_eq!(news.status, NewsStatus::Verified);
    assert_eq!(news.freeze, Some(Freeze::Expired { days: 5 }));
    // The expired feed did not count as a fresh check.
    assert_eq!(Seen::load(scratch.path()).fresh_at, Some(NOW - NOW % DAY));
}

#[test]
fn fourteen_days_without_a_fresh_feed_count_as_a_freeze() {
    let fresh = Seen {
        seq: 7,
        valid_until: Some(NOW + 60 * DAY),
        fresh_at: Some(NOW),
        ..Seen::default()
    };
    assert_eq!(fresh.freeze(NOW + 14 * DAY, None), None);
    assert_eq!(
        fresh.freeze(NOW + 15 * DAY, None),
        Some(Freeze::Unchecked { days: 15 })
    );

    // Never a fresh feed: counted from the first check.
    let never = Seen {
        since: Some(NOW),
        ..Seen::default()
    };
    assert_eq!(never.freeze(NOW + 3 * DAY, None), None);
    assert_eq!(
        never.freeze(NOW + 20 * DAY, None),
        Some(Freeze::Unchecked { days: 20 })
    );

    // Never checked at all: nothing to say yet.
    assert_eq!(Seen::default().freeze(NOW, None), None);
}

#[tokio::test]
async fn a_feed_without_valid_until_never_counts_as_fresh() {
    // An old feed, validly signed and replayed, must not reset the clock.
    let scratch = Scratch::new("no-valid-until");
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&KEY.envelope(&payload(7, None, None)))],
    );
    let news = check_on(&tor, &KEY.signer(), &[FEED_URL], Some(scratch.path()), NOW).await;
    assert_eq!(news.status, NewsStatus::Verified);
    let seen = Seen::load(scratch.path());
    assert_eq!(seen.fresh_at, None);
    assert_eq!(seen.since, Some(NOW - NOW % DAY));
}

// ---- Design test 43: newer than every mirror ----

#[test]
fn news_saying_newer_than_the_mirrors_warns_of_a_freeze() {
    let seen = Seen {
        seq: 7,
        latest: Some(Version::new(0, 3, 0)),
        valid_until: Some(NOW + 30 * DAY),
        fresh_at: Some(NOW),
        ..Seen::default()
    };
    // The updater (TOR-9) hands in the highest version any mirror offers.
    assert_eq!(
        seen.freeze(NOW, Some(&Version::new(0, 2, 0))),
        Some(Freeze::NotOffered {
            latest: "0.3.0".to_string()
        })
    );
    assert_eq!(seen.freeze(NOW, Some(&Version::new(0, 3, 0))), None);
    assert_eq!(seen.freeze(NOW, Some(&Version::new(0, 4, 0))), None);
    // Without the mirrors' answer there is nothing to compare.
    assert_eq!(seen.freeze(NOW, None), None);
}

// ---- Design test 57 (R-06): per device, and locked ----

#[test]
fn the_highest_seen_is_kept_per_device_and_the_old_min_seq_only_raises_it() {
    let scratch = Scratch::new("seen");
    // tor/seen.json, outside the encrypted store: read and raised with no
    // session at all.
    assert_eq!(Seen::path(scratch.path()), scratch.path().join("seen.json"));
    assert_eq!(Seen::load(scratch.path()), Seen::default());

    Seen::raise_seq(scratch.path(), 77).unwrap();
    assert_eq!(Seen::load(scratch.path()).seq, 77);
    Seen::raise_seq(scratch.path(), 12).unwrap();
    assert_eq!(Seen::load(scratch.path()).seq, 77, "lowered");

    // What it holds, and nothing else: public numbers, by the day.
    let text = std::fs::read_to_string(Seen::path(scratch.path())).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
    assert!(
        keys.iter()
            .all(|key| ["seq", "latest", "validUntil", "freshAt", "since"].contains(&key.as_str())),
        "{keys:?}"
    );

    // A file that is not one is as none.
    std::fs::write(Seen::path(scratch.path()), b"not json").unwrap();
    assert_eq!(Seen::load(scratch.path()), Seen::default());
}

#[test]
fn what_the_app_gets_is_camel_case_and_has_items_only_when_verified() {
    let news = News {
        status: NewsStatus::Untrusted,
        items: Vec::new(),
        signer_fingerprint: None,
        latest: Some("0.2.0".to_string()),
        freeze: Some(Freeze::Expired { days: 3 }),
    };
    assert_eq!(
        serde_json::to_value(&news).unwrap(),
        serde_json::json!({
            "status": "untrusted",
            "items": [],
            "signerFingerprint": null,
            "latest": "0.2.0",
            "freeze": { "kind": "expired", "days": 3 }
        })
    );
    assert_eq!(
        serde_json::to_value(Freeze::NotOffered {
            latest: "0.3.0".into()
        })
        .unwrap(),
        serde_json::json!({ "kind": "notOffered", "latest": "0.3.0" })
    );
    assert_eq!(
        serde_json::to_value(Freeze::Unchecked { days: 15 }).unwrap(),
        serde_json::json!({ "kind": "unchecked", "days": 15 })
    );
    let feed = news::verify(
        Signer::trino_updates(),
        include_bytes!("news/testdata/feed-2026-07-21.json"),
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&feed.announcements[0]).unwrap(),
        serde_json::json!({
            "id": "2026-07-17-mobile-themes",
            "title": "Trino móvil estrena una interfaz más familiar",
            "body": "La lista de chats, el compositor y las llamadas usan patrones móviles conocidos. También se añadieron estilos Trino, Corporativo y Simple con color de acento configurable.",
            "publishedAt": "2026-07-17T09:30:00-05:00",
            "version": "0.1.0"
        })
    );
}
