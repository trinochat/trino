//! Tor in a `Net` (Tor design §2.3–§2.6, §11.2; TOR-5). No network: Tor
//! is `FakeTor` over the in-memory `Mock`, and the direct transport
//! panics if touched. The one test with Arti and the real Tor network is
//! `#[ignore]` and named so.

use crate::mock::{FakeTor, Forbidden, Mock};
use crate::status::Watch;
use crate::tor::marker::{MARKER_FILE, STRIKES};
use crate::*;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A folder of its own under the system's temporary folder, removed at
/// the end. Never ~/.trino.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("trino-net-{name}-{}-{n}", std::process::id()));
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

/// A `Net` whose Tor is a `FakeTor` keeping its files in `tor_home`, and
/// whose direct transport panics if used.
fn fake_net(tor_home: &Path) -> (Arc<Net>, Arc<FakeTor>, Arc<Mock>) {
    let mock = Mock::new();
    let fake = FakeTor::new(Arc::clone(&mock));
    let config = NetConfig {
        tor_home: tor_home.to_path_buf(),
        pt: None,
    };
    let net = Net::with_backend(
        config,
        Arc::clone(&fake) as Arc<dyn TorBackend>,
        Arc::new(Forbidden),
    );
    (net, fake, mock)
}

/// Waits for `net` to show `expected`; fails the test after 5 s.
async fn becomes(net: &Net, expected: NetStatus) {
    let mut status = net.status();
    let reached = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if *status.borrow_and_update() == expected {
                return;
            }
            status.changed().await.unwrap();
        }
    })
    .await;
    assert!(
        reached.is_ok(),
        "still {:?}, never {expected:?}",
        net.status_now()
    );
}

const READY: NetStatus = NetStatus::Ready {
    transport: TransportKind::None,
};

fn bootstrap(pct: u8, blocked: Option<BlockKind>) -> Progress {
    Progress::Bootstrap {
        frac: f32::from(pct) / 100.0,
        ready: false,
        blocked,
    }
}

// ---- Test 71: the limit without progress, by transport (R-23) ----

#[test]
fn the_blockage_threshold_depends_on_the_transport() {
    // From the spike's starts (S3): about twice the longest stretch
    // without progress.
    for (transport, limit) in [
        (TransportKind::None, 45),
        (TransportKind::Obfs4, 90),
        (TransportKind::Webtunnel, 90),
        (TransportKind::Snowflake, 120),
        (TransportKind::Meek, 120),
    ] {
        let limit = Duration::from_secs(limit);
        assert_eq!(transport.no_progress_limit(), limit, "{transport:?}");

        let start = Instant::now();
        let mut watch = Watch::new(transport, start);
        watch.on(0.4, false, None, start);
        let almost = start + limit - Duration::from_secs(1);
        assert_eq!(watch.status(almost), NetStatus::Starting { pct: 40 });
        assert_eq!(
            watch.status(start + limit),
            NetStatus::Blocked {
                kind: BlockKind::NoProgress,
                pct: 40
            },
            "{transport:?}"
        );

        // Progress starts the count again.
        watch.on(0.5, false, None, almost);
        assert_eq!(watch.status(start + limit), NetStatus::Starting { pct: 50 });
        assert_eq!(watch.next_change(almost), Some(almost + limit));
    }
}

#[test]
fn ready_wins_over_everything_and_has_no_limit() {
    let start = Instant::now();
    let mut watch = Watch::new(TransportKind::None, start);
    watch.on(1.0, true, Some(BlockKind::Filtering), start);

    let much_later = start + Duration::from_secs(3600);
    assert_eq!(watch.status(much_later), READY);
    assert_eq!(watch.next_change(much_later), None);
}

// ---- Test 12: the states a start goes through ----

#[tokio::test]
async fn status_goes_starting_ready_and_reports_each_blockage_kind() {
    let home = Scratch::new("states");
    let (net, fake, _mock) = fake_net(home.path());
    assert_eq!(net.status_now(), NetStatus::Off, "nothing before start");

    net.start();
    becomes(&net, NetStatus::Starting { pct: 0 }).await;
    fake.at(40);
    becomes(&net, NetStatus::Starting { pct: 40 }).await;

    for (kind, expected) in [
        (BlockKind::Offline, BlockKind::Offline),
        (BlockKind::Filtering, BlockKind::Filtering),
        (BlockKind::CantReachTor, BlockKind::CantReachTor),
        (BlockKind::ClockSkewed, BlockKind::ClockSkewed),
        (BlockKind::CantBootstrap, BlockKind::CantBootstrap),
    ] {
        fake.report(bootstrap(40, Some(kind)));
        becomes(
            &net,
            NetStatus::Blocked {
                kind: expected,
                pct: 40,
            },
        )
        .await;
    }
    // Arti no longer blocked: starting again.
    fake.report(bootstrap(60, None));
    becomes(&net, NetStatus::Starting { pct: 60 }).await;

    fake.ready();
    becomes(&net, READY).await;
    assert_eq!(fake.launches(), [TransportKind::None]);
    net.stop();
}

#[test]
fn arti_blockages_are_named_for_the_app() {
    use arti_client::status::BlockageKind as Arti;
    for (arti, ours) in [
        (Arti::Offline, Some(BlockKind::Offline)),
        (Arti::Filtering, Some(BlockKind::Filtering)),
        (Arti::CantReachTor, Some(BlockKind::CantReachTor)),
        (Arti::ClockSkewed, Some(BlockKind::ClockSkewed)),
        (Arti::CantBootstrap, Some(BlockKind::CantBootstrap)),
        (Arti::Disabled, None),
    ] {
        assert_eq!(tor::arti::block_kind(&arti), ours, "{arti:?}");
    }
}

#[test]
fn the_ui_gets_each_state_in_its_shape() {
    // What `net-changed` carries to the frontend (TOR-6).
    for (status, json) in [
        (NetStatus::Off, r#"{"state":"off"}"#),
        (
            NetStatus::Starting { pct: 40 },
            r#"{"state":"starting","pct":40}"#,
        ),
        (
            NetStatus::Ready {
                transport: TransportKind::Snowflake,
            },
            r#"{"state":"ready","transport":"snowflake"}"#,
        ),
        (
            NetStatus::Blocked {
                kind: BlockKind::CantReachTor,
                pct: 15,
            },
            r#"{"state":"blocked","kind":"cantReachTor","pct":15}"#,
        ),
        (NetStatus::PtMissing, r#"{"state":"ptMissing"}"#),
        (
            NetStatus::Obsolete { confirmed: false },
            r#"{"state":"obsolete","confirmed":false}"#,
        ),
        (NetStatus::Direct, r#"{"state":"direct"}"#),
    ] {
        assert_eq!(serde_json::to_string(&status).unwrap(), json);
    }
}

// ---- Test 14: blocked never means direct ----

#[tokio::test]
async fn a_blocked_start_offers_bridges_and_never_changes_mode() {
    let home = Scratch::new("blocked");
    let (net, fake, mock) = fake_net(home.path());
    net.start();
    fake.report(bootstrap(15, Some(BlockKind::Filtering)));
    becomes(
        &net,
        NetStatus::Blocked {
            kind: BlockKind::Filtering,
            pct: 15,
        },
    )
    .await;

    let iso = net.session().iso(IsoKind::RELAY, "wss://nos.lol");
    let refused = net.connect(&Target::new("nos.lol", 443), &iso).await;

    // The direct transport panics if touched; Tor was not asked either.
    assert_eq!(refused.err(), Some(NetError::TorNotReady));
    assert_eq!(net.mode(), Mode::Tor);
    assert!(mock.connections().is_empty());
    assert_eq!(
        net.ready(Duration::from_millis(50)).await,
        Err(NetError::TorNotReady)
    );
    net.stop();
}

// ---- Test 15: "Conectar sin Tor" lasts the process ----

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the permit is what is under test
async fn the_escape_lasts_the_process_and_is_never_saved() {
    let home = Scratch::new("escape");
    let (net, fake, _mock) = fake_net(home.path());
    net.start();
    fake.ready();
    becomes(&net, READY).await;

    net.allow_direct(DirectPermit::for_session()).unwrap();
    assert_eq!(net.status_now(), NetStatus::Direct);
    net.stop();

    // Nothing written says it: the folder holds no trace of it.
    for file in files_under(home.path()) {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        assert!(
            !text.to_lowercase().contains("direct"),
            "{} mentions it",
            file.display()
        );
    }
    // The next process: a new `Net` on the same folder goes through Tor.
    let (next, _, _) = fake_net(home.path());
    assert_eq!(next.mode(), Mode::Tor);
    assert_eq!(next.status_now(), NetStatus::Off);

    // And within this one, "Volver a usar Tor".
    net.back_to_tor();
    assert_eq!(net.mode(), Mode::Tor);
    assert_eq!(net.status_now(), NetStatus::Off);
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(files_under(&path));
        } else {
            found.push(path);
        }
    }
    found
}

// ---- Test 16: the folders ----

#[tokio::test]
async fn tor_dirs_live_under_the_tor_home_they_are_given() {
    let home = Scratch::new("dirs");
    let tor_home = home.path().join("tor");
    assert_eq!(
        TorDirs::fixed(&tor_home),
        TorDirs {
            state: tor_home.join("state"),
            cache: tor_home.join("cache"),
        }
    );
    let (net, _fake, _mock) = fake_net(&tor_home);
    assert_eq!(net.tor_home(), Some(tor_home.as_path()));

    net.start();

    assert!(tor_home.join("state").is_dir());
    assert!(tor_home.join("cache").is_dir());
    net.stop();
}

// ---- Test 19: settings.json ----

#[test]
fn tor_settings_hold_only_the_transport_kind_and_on_unlock_never_private() {
    let home = Scratch::new("settings");
    assert_eq!(
        TorSettings::load(home.path()),
        TorSettings {
            transport: TransportKind::None,
            start: StartWhen::Open,
        },
        "the defaults: no bridge, start when Trino opens"
    );

    let settings = TorSettings {
        transport: TransportKind::Obfs4,
        start: StartWhen::OnUnlock,
    };
    settings.save(home.path()).unwrap();

    let saved = std::fs::read_to_string(home.path().join("settings.json")).unwrap();
    assert_eq!(saved, r#"{"transport":"obfs4","start":"on_unlock"}"#);
    assert_eq!(TorSettings::load(home.path()), settings);
    assert!(!saved.contains("private"));
    // Nothing else can be in it: a field it does not know makes it the
    // defaults, never a bridge line.
    std::fs::write(
        home.path().join("settings.json"),
        r#"{"transport":"obfs4","start":"open","private":true}"#,
    )
    .unwrap();
    assert_eq!(TorSettings::load(home.path()), TorSettings::default());
}

#[tokio::test]
async fn the_transport_of_the_settings_is_the_one_started() {
    let home = Scratch::new("transport");
    TorSettings {
        transport: TransportKind::Snowflake,
        start: StartWhen::Open,
    }
    .save(home.path())
    .unwrap();
    let (net, fake, _mock) = fake_net(home.path());

    net.start();
    fake.ready();

    becomes(
        &net,
        NetStatus::Ready {
            transport: TransportKind::Snowflake,
        },
    )
    .await;
    assert_eq!(fake.launches(), [TransportKind::Snowflake]);
    net.stop();
}

// ---- Test 21: an obsolete Arti ----

#[tokio::test]
async fn deprecated_software_at_start_is_the_obsolete_state() {
    // Arti refusing to be created...
    let home = Scratch::new("obsolete-launch");
    let (net, fake, _mock) = fake_net(home.path());
    fake.fail_next(LaunchError::Obsolete);
    net.start();
    becomes(&net, NetStatus::Obsolete { confirmed: true }).await;

    // ...or its first bootstrap saying so (`SoftwareDeprecated`).
    let home = Scratch::new("obsolete-bootstrap");
    let (net, fake, _mock) = fake_net(home.path());
    net.start();
    fake.at(15);
    fake.report(Progress::Obsolete);
    becomes(&net, NetStatus::Obsolete { confirmed: true }).await;
    // It stays so: nothing later turns it into another state.
    fake.ready();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(net.status_now(), NetStatus::Obsolete { confirmed: true });
    assert_eq!(
        net.ready(Duration::from_secs(5)).await,
        Err(NetError::TorNotReady)
    );
    net.stop();
}

#[tokio::test]
async fn a_bridge_without_its_program_is_its_own_state() {
    let home = Scratch::new("pt-missing");
    let (net, fake, _mock) = fake_net(home.path());
    fake.fail_next(LaunchError::PtMissing);
    net.start();
    becomes(&net, NetStatus::PtMissing).await;
}

#[test]
fn arti_needs_the_bridge_program_for_a_bridge() {
    // TOR-7 brings lyrebird; until then a bridge transport cannot start,
    // and nothing of Arti is made (no network).
    let home = Scratch::new("arti-bridge");
    let (progress, _reports) = std::sync::mpsc::channel();
    let launched = tor::arti::Arti.launch(tor::Launch {
        dirs: TorDirs::fixed(home.path()),
        transport: TransportKind::Obfs4,
        pt: None,
        progress,
    });
    assert_eq!(launched.err(), Some(LaunchError::PtMissing));
    assert!(files_under(home.path()).is_empty());
}

// ---- Test 22: run.marker ----

/// A start that reaches ready and dies without stopping, as an `exit(1)`
/// of Arti would.
async fn die_after_ready(home: &Path) {
    let (net, fake, _mock) = fake_net(home);
    net.start();
    fake.ready();
    becomes(&net, READY).await;
    // Dropped without `stop`: the process ended.
    wait_for(|| marker_says(home, "ready")).await;
}

fn marker_says(home: &Path, phase: &str) -> bool {
    std::fs::read_to_string(home.join(MARKER_FILE))
        .is_ok_and(|text| text.contains(&format!("\"{phase}\"")))
}

async fn wait_for(what: impl Fn() -> bool) {
    for _ in 0..500 {
        if what() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never happened");
}

#[tokio::test]
async fn two_deaths_after_ready_stop_starting_tor_and_explain() {
    let home = Scratch::new("deaths");
    for _ in 0..STRIKES {
        die_after_ready(home.path()).await;
    }

    let (net, fake, _mock) = fake_net(home.path());
    net.start();

    // Not started, and "Puede que esta versión sea muy vieja".
    assert_eq!(net.status_now(), NetStatus::Obsolete { confirmed: false });
    assert_eq!(fake.launches().len(), 0);

    // "Intentar de nuevo" starts it.
    net.retry();
    assert_eq!(fake.launches().len(), 1);
    fake.ready();
    becomes(&net, READY).await;
    net.stop();
}

#[tokio::test]
async fn one_death_or_a_clean_stop_does_not_stop_tor() {
    let home = Scratch::new("one-death");
    die_after_ready(home.path()).await;

    let (net, fake, _mock) = fake_net(home.path());
    net.start();
    assert_eq!(fake.launches().len(), 1);
    fake.ready();
    becomes(&net, READY).await;
    wait_for(|| marker_says(home.path(), "ready")).await;

    net.stop();

    assert!(!home.path().join(MARKER_FILE).exists(), "a clean stop");
    // And so the next one starts with no death counted.
    die_after_ready(home.path()).await;
    let (net, fake, _mock) = fake_net(home.path());
    net.start();
    assert_eq!(fake.launches().len(), 1);
    net.stop();
}

#[tokio::test]
async fn a_death_before_ready_is_not_counted() {
    let home = Scratch::new("early-death");
    for _ in 0..STRIKES + 1 {
        let (net, fake, _mock) = fake_net(home.path());
        net.start();
        assert_eq!(fake.launches().len(), 1, "started");
        fake.at(30);
        becomes(&net, NetStatus::Starting { pct: 30 }).await;
        assert!(marker_says(home.path(), "starting"));
        // Dropped before ready.
    }
}

// ---- stop, sleep and waiting ----

#[tokio::test]
async fn stop_ends_tor_and_nothing_connects_after() {
    let home = Scratch::new("stop");
    let (net, fake, mock) = fake_net(home.path());
    let _listener = mock.listen("nos.lol", 443);
    net.start();
    fake.ready();
    becomes(&net, READY).await;
    let iso = net.session().iso(IsoKind::RELAY, "wss://nos.lol");
    net.connect(&Target::new("nos.lol", 443), &iso)
        .await
        .unwrap();

    net.stop();

    assert_eq!(net.status_now(), NetStatus::Off);
    assert_eq!(fake.log(), ["launch", "stop"]);
    let after = net.connect(&Target::new("nos.lol", 443), &iso).await;
    assert_eq!(after.err(), Some(NetError::TorNotReady));
    assert_eq!(mock.connections().len(), 1);
    // A stopped Tor's late report changes nothing.
    fake.ready();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(net.status_now(), NetStatus::Off);
    // Stopping twice is no error.
    net.stop();
}

#[tokio::test]
async fn start_twice_starts_one_tor() {
    let home = Scratch::new("twice");
    let (net, fake, _mock) = fake_net(home.path());
    net.start();
    net.start();
    assert_eq!(fake.launches().len(), 1);
    net.stop();
}

#[tokio::test]
async fn set_dormant_reaches_the_running_tor() {
    let home = Scratch::new("dormant");
    let (net, fake, _mock) = fake_net(home.path());
    net.set_dormant(true); // nothing runs: nothing to tell
    net.start();
    net.set_dormant(true);
    net.set_dormant(false);
    net.stop();
    assert_eq!(fake.log(), ["launch", "sleep", "wake", "stop"]);
}

#[tokio::test]
async fn ready_waits_for_a_starting_tor_and_not_for_one_never_started() {
    let home = Scratch::new("ready");
    let (net, fake, _mock) = fake_net(home.path());
    // Never started: no reason to wait.
    let started = Instant::now();
    assert_eq!(
        net.ready(Duration::from_secs(30)).await,
        Err(NetError::TorNotReady)
    );
    assert!(started.elapsed() < Duration::from_secs(1));

    net.start();
    let waiting = tokio::spawn({
        let net = Arc::clone(&net);
        async move { net.ready(Duration::from_secs(5)).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!waiting.is_finished(), "did not wait for the start");
    fake.ready();
    assert_eq!(waiting.await.unwrap(), Ok(()));

    // A starting Tor that does not make it in time.
    net.stop();
    net.start();
    assert_eq!(
        net.ready(Duration::from_millis(100)).await,
        Err(NetError::TorNotReady)
    );
    net.stop();
}

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the permit is what is under test
async fn until_ready_waits_through_off_and_lets_the_escape_through() {
    let home = Scratch::new("until-ready");
    let (net, fake, _mock) = fake_net(home.path());
    let waiting = tokio::spawn({
        let net = Arc::clone(&net);
        async move { net.until_ready().await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!waiting.is_finished(), "Off is waited through");
    net.start();
    fake.ready();
    tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap();
    net.stop();

    // Without Tor, by the session's permit: nothing to wait for.
    net.allow_direct(DirectPermit::for_session()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), net.until_ready())
        .await
        .unwrap();
}

#[tokio::test]
async fn a_net_with_no_tor_never_starts_one() {
    let net = Net::new();
    net.start();
    assert_eq!(net.status_now(), NetStatus::Off);
    assert_eq!(net.tor_home(), None);
    net.stop();
}

// ---- Test 6: onion first, then the domain through Tor ----

#[tokio::test]
async fn the_onion_comes_first_and_its_fallback_goes_through_tor_never_direct() {
    let onion = onion_map::onion_of("wss://relay.trinochat.org").expect("Trino's relay");
    assert!(onion.starts_with("ws://") && onion.ends_with(".onion"));
    assert_eq!(
        onion_map::onion_of("wss://relay.trinochat.org/"),
        Some(onion)
    );
    assert_eq!(onion_map::onion_of("wss://nos.lol"), None);
    assert_eq!(
        onion_map::relay_deadline("wss://relay.trinochat.org", Duration::from_secs(30)),
        Duration::from_secs(75)
    );
    assert_eq!(
        onion_map::relay_deadline("wss://nos.lol", Duration::from_secs(30)),
        Duration::from_secs(30)
    );

    // Nobody answers at the onion: the domain is tried, through Tor.
    let tor = Mock::new();
    let host = "relay.trinochat.org";
    let mut domain = tor.listen(host, 443);
    let net = Net::with_transports(
        Some(Arc::clone(&tor) as Arc<dyn Transport>),
        Arc::new(Forbidden),
    );
    let iso = net
        .session()
        .iso(IsoKind::RELAY, "wss://relay.trinochat.org");
    let connecting = tokio::spawn({
        let net = Arc::clone(&net);
        let iso = iso.clone();
        async move {
            onion_map::ws_connect_relay(
                &net,
                "wss://relay.trinochat.org",
                &iso,
                Duration::from_secs(5),
            )
            .await
        }
    });
    let server = tokio::time::timeout(Duration::from_secs(5), domain.accept())
        .await
        .unwrap()
        .unwrap();
    drop(server);
    let _ = connecting.await;

    let tried: Vec<(String, u16)> = tor
        .connections()
        .into_iter()
        .map(|(target, token)| {
            assert_eq!(token, iso, "the same token for both");
            (target.host, target.port)
        })
        .collect();
    let onion_host = onion.trim_start_matches("ws://").to_string();
    assert_eq!(tried, [(onion_host, 80), (host.to_string(), 443)]);
}

#[tokio::test]
async fn the_onion_answers_and_the_domain_is_not_tried() {
    let onion = onion_map::onion_of("wss://relay.trinochat.org").unwrap();
    let onion_host = onion.trim_start_matches("ws://");
    let tor = Mock::new();
    let mut at_onion = tor.listen(onion_host, 80);
    tokio::spawn(async move {
        while let Some(io) = at_onion.accept().await {
            tokio::spawn(tokio_tungstenite::accept_async(io));
        }
    });
    let net = Net::with_transports(
        Some(Arc::clone(&tor) as Arc<dyn Transport>),
        Arc::new(Forbidden),
    );
    let iso = net.session().iso(IsoKind::RELAY, "trino");

    let ws = onion_map::ws_connect_relay(
        &net,
        "wss://relay.trinochat.org",
        &iso,
        Duration::from_secs(5),
    )
    .await;

    assert!(ws.is_ok());
    assert_eq!(tor.connections().len(), 1);
}

// ---- Isolation in Arti ----

#[test]
fn equal_tokens_share_a_circuit_in_arti_and_others_never() {
    use arti_client::isolation::Isolation;
    let net = Net::new();
    let (one, two) = (net.session(), net.session());
    let relay: Box<dyn Isolation> = Box::new(one.iso(IsoKind::RELAY, "wss://nos.lol"));

    assert!(relay.compatible(&one.iso(IsoKind::RELAY, "wss://nos.lol")));
    assert!(!relay.compatible(&one.iso(IsoKind::RELAY, "wss://nostr.mom")));
    assert!(!relay.compatible(&one.iso(IsoKind::BLOSSOM, "wss://nos.lol")));
    assert!(!relay.compatible(&two.iso(IsoKind::RELAY, "wss://nos.lol")));
    // Arti's own tokens never match ours.
    assert!(!relay.compatible(&arti_client::IsolationToken::new()));
}

#[test]
fn the_ring_provider_is_installed_for_arti() {
    tor::arti::install_crypto_provider();
    tor::arti::install_crypto_provider();
    let installed = rustls::crypto::CryptoProvider::get_default().expect("a provider");
    let ring = rustls::crypto::ring::default_provider();
    let names = |p: &rustls::crypto::CryptoProvider| -> Vec<String> {
        p.cipher_suites
            .iter()
            .map(|s| format!("{:?}", s.suite()))
            .collect()
    };
    assert_eq!(names(installed), names(&ring));
}

#[test]
fn arti_gets_the_folders_and_nothing_else_of_trino() {
    let home = Scratch::new("arti-config");
    let dirs = TorDirs::fixed(home.path());
    let config = tor::arti::config(&dirs).expect("a configuration");
    let shown = format!("{config:?}");
    assert!(shown.contains("state"), "{shown}");
    assert!(shown.contains("cache"), "{shown}");
}

// ---- Design test 53: Arti really stops (network) ----

/// Needs the real Tor network: run by hand with `--ignored`. After `stop`,
/// every file Arti left can be opened for writing and destroyed, and stop
/// takes well under Arti's 5 s shutdown (spike S13: 11 ms).
#[test]
#[ignore = "needs the real Tor network"]
fn network_stop_drops_the_arti_runtime_and_every_tor_file_opens_exclusive() {
    let home = Scratch::new("arti-stop");
    let net = Net::with_arti(NetConfig {
        tor_home: home.path().to_path_buf(),
        pt: None,
    });
    let runtime = tokio::runtime::Runtime::new().unwrap();
    net.start();
    runtime
        .block_on(net.ready(Duration::from_secs(180)))
        .expect("Tor ready");

    let started = Instant::now();
    net.stop();
    assert!(started.elapsed() < Duration::from_secs(5));

    let files = files_under(home.path());
    assert!(!files.is_empty());
    for file in files {
        let opened = std::fs::OpenOptions::new().write(true).open(&file);
        assert!(opened.is_ok(), "{} is still held", file.display());
        drop(opened);
        std::fs::remove_file(&file).unwrap();
    }
}
