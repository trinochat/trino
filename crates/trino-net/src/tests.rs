//! The tests of Tor design §11.1 that belong to this crate, plus the
//! permits of §2.8. None needs the network: Tor is the in-memory `Mock`,
//! and the only real socket is the direct one to a local listener.

use crate::mock::{Forbidden, Mock};
use crate::*;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// A `Net` whose Tor is `tor` and whose direct transport panics if used.
fn tor_only(tor: Option<Arc<Mock>>) -> Arc<Net> {
    Net::with_transports(tor.map(|t| t as Arc<dyn Transport>), Arc::new(Forbidden))
}

/// Fails the test instead of hanging.
async fn within<T>(work: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .expect("still waiting after 5 s")
}

// ---- Test 1: fail closed ----

#[tokio::test]
async fn tor_mode_never_reaches_the_direct_transport() {
    // No Tor yet: the answer is TorNotReady, and the direct transport,
    // which panics if touched, is never asked.
    let net = tor_only(None);
    let iso = net.session().iso(IsoKind::RELAY, "wss://relay.example");

    assert_eq!(net.mode(), Mode::Tor);
    let raw = within(net.connect(&Target::new("relay.example", 443), &iso)).await;
    assert_eq!(raw.err(), Some(NetError::TorNotReady));
    let ws = within(ws_connect(&net, "wss://relay.example", &iso)).await;
    assert_eq!(ws.err(), Some(NetError::TorNotReady));
}

#[tokio::test]
async fn with_tor_every_connection_goes_through_tor() {
    let tor = Mock::new();
    let _listener = tor.listen("relay.example", 443);
    let net = tor_only(Some(Arc::clone(&tor)));
    let iso = net.session().iso(IsoKind::RELAY, "wss://relay.example");

    within(net.connect(&Target::new("relay.example", 443), &iso))
        .await
        .unwrap();

    assert_eq!(tor.connections().len(), 1);
}

// ---- Test 3: names go to the transport unresolved ----

#[tokio::test]
async fn a_host_goes_by_name_and_is_never_resolved_locally() {
    // `.invalid` never resolves (RFC 6761): had anything looked it up
    // here, the connection would have failed before reaching Tor.
    let tor = Mock::new();
    let mut listener = tor.listen("relay.trino.invalid", 443);
    let net = tor_only(Some(Arc::clone(&tor)));
    let iso = net
        .session()
        .iso(IsoKind::RELAY, "wss://relay.trino.invalid");

    let connecting = tokio::spawn({
        let net = Arc::clone(&net);
        async move { ws_connect(&net, "wss://relay.trino.invalid", &iso).await }
    });
    let server = within(listener.accept()).await.expect("no connection");
    drop(server);
    let _ = within(connecting).await;

    let (target, _) = tor.connections().remove(0);
    assert_eq!(target, Target::new("relay.trino.invalid", 443));
}

// ---- Tests 4, 5 and 65: isolation tokens ----

#[test]
fn each_kind_of_traffic_gets_its_own_isolation_token() {
    let net = Net::new();
    let session = net.session();
    let url = "wss://nos.lol";

    let relay = session.iso(IsoKind::RELAY, url);
    assert_eq!(relay, session.iso(IsoKind::RELAY, url), "same kind and key");
    assert_ne!(relay, session.iso(IsoKind::INSPECTOR, url));
    assert_ne!(relay, session.iso(IsoKind::RELAY, "wss://nostr.mom"));
    for kind in [
        IsoKind::BLOSSOM,
        IsoKind::TURN,
        IsoKind::NAME,
        IsoKind::INVITE,
        IsoKind::UPDATE,
        IsoKind::NEWS,
    ] {
        assert_ne!(relay, session.iso(kind, url), "{kind:?}");
    }
}

#[test]
fn a_new_session_never_shares_circuits_with_the_last() {
    let net = Net::new();
    let (first, second) = (net.session(), net.session());

    assert_ne!(
        first.iso(IsoKind::RELAY, "wss://nos.lol"),
        second.iso(IsoKind::RELAY, "wss://nos.lol")
    );
}

#[test]
fn iso_is_an_open_token_of_kind_and_key() {
    // P1's rotating mailboxes need a kind this crate does not know, and a
    // key per mailbox, without touching this crate (design §2.2, R-14).
    const MAILBOX: IsoKind = IsoKind::new("mailbox");
    let session = Net::new().session();

    let monday = session.iso(MAILBOX, [1u8; 32]);
    assert_eq!(monday.kind(), MAILBOX);
    assert_eq!(monday, session.iso(MAILBOX, [1u8; 32]));
    assert_ne!(monday, session.iso(MAILBOX, [2u8; 32]));
    assert_ne!(monday, session.iso(IsoKind::RELAY, [1u8; 32]));
}

#[test]
fn an_iso_never_prints_its_key() {
    // Keys are relay URLs, mailbox ids or invitation ids.
    let iso = Net::new()
        .session()
        .iso(IsoKind::RELAY, "wss://secret.example");

    assert!(!format!("{iso:?}").contains("secret"), "{iso:?}");
}

// ---- Test 7: ws_connect ----

#[tokio::test]
async fn ws_connect_speaks_tls_for_wss_and_plain_ws_for_onion_over_any_stream() {
    let tor = Mock::new();
    let mut tls_side = tor.listen("relay.example", 443);
    let onion = "trinoxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion";
    let mut onion_side = tor.listen(onion, 80);
    let net = tor_only(Some(Arc::clone(&tor)));
    let session = net.session();

    // wss: the first bytes on the stream are a TLS handshake record.
    let iso = session.iso(IsoKind::RELAY, "wss");
    let tls = tokio::spawn({
        let net = Arc::clone(&net);
        async move { ws_connect(&net, "wss://relay.example", &iso).await }
    });
    let mut server = within(tls_side.accept()).await.unwrap();
    let mut record = [0u8; 3];
    within(server.read_exact(&mut record)).await.unwrap();
    assert_eq!(record[0], 0x16, "not a TLS handshake record");
    assert_eq!(record[1], 0x03, "not TLS");
    drop(server);
    assert!(within(tls).await.unwrap().is_err());

    // ws to an onion: a plain WebSocket, which completes.
    let iso = session.iso(IsoKind::RELAY, "onion");
    let plain = tokio::spawn({
        let net = Arc::clone(&net);
        let url = format!("ws://{onion}");
        async move { ws_connect(&net, &url, &iso).await }
    });
    let server = within(onion_side.accept()).await.unwrap();
    let accepted = tokio::spawn(tokio_tungstenite::accept_async(server));
    assert!(within(plain).await.unwrap().is_ok());
    assert!(within(accepted).await.unwrap().is_ok());
    let ports: Vec<u16> = tor.connections().iter().map(|(t, _)| t.port).collect();
    assert_eq!(ports, [443, 80], "the default ports of wss and ws");
}

#[tokio::test]
async fn ws_connect_takes_only_websocket_addresses() {
    let tor = Mock::new();
    let net = tor_only(Some(Arc::clone(&tor)));
    let iso = net.session().iso(IsoKind::RELAY, "x");

    for url in ["https://relay.example", "relay.example", "ws://", ""] {
        assert_eq!(
            within(ws_connect(&net, url, &iso)).await.err(),
            Some(NetError::BadUrl),
            "{url}"
        );
    }
    assert!(tor.connections().is_empty());
}

#[tokio::test]
async fn an_explicit_port_is_kept() {
    // Nobody listens: the connection is refused, after the mock saw where
    // it was going.
    let tor = Mock::new();
    let net = tor_only(Some(Arc::clone(&tor)));
    let iso = net.session().iso(IsoKind::RELAY, "x");

    let refused = within(ws_connect(&net, "ws://relay.example:7447/path", &iso)).await;

    assert_eq!(refused.err(), Some(NetError::Connect("refused")));

    assert_eq!(tor.connections()[0].0, Target::new("relay.example", 7447));
}

// ---- §2.8: the two permits ----

/// A `Net` whose Tor and direct transports are both mocks.
fn both(tor: &Arc<Mock>, direct: &Arc<Mock>) -> Arc<Net> {
    Net::with_transports(
        Some(Arc::clone(tor) as Arc<dyn Transport>),
        Arc::clone(direct) as Arc<dyn Transport>,
    )
}

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the permits are what is under test
async fn the_session_permit_sends_everything_direct_until_back_to_tor() {
    let (tor, direct) = (Mock::new(), Mock::new());
    let (_on_tor, _on_direct) = (
        tor.listen("a.example", 443),
        direct.listen("a.example", 443),
    );
    let net = both(&tor, &direct);
    let iso = net.session().iso(IsoKind::RELAY, "a");
    let target = Target::new("a.example", 443);

    net.allow_direct(DirectPermit::for_session()).unwrap();
    assert_eq!(net.mode(), Mode::Direct);
    within(net.connect(&target, &iso)).await.unwrap();
    assert_eq!(
        (tor.connections().len(), direct.connections().len()),
        (0, 1)
    );

    net.back_to_tor();
    assert_eq!(net.mode(), Mode::Tor);
    within(net.connect(&target, &iso)).await.unwrap();
    assert_eq!(
        (tor.connections().len(), direct.connections().len()),
        (1, 1)
    );
}

/// "Volver a conectarse de forma privada" must move the sockets already
/// open (design §2.8, test 15): whoever holds one hears every change of
/// mode, and only changes.
#[tokio::test]
#[allow(clippy::disallowed_methods)] // the permits are what is under test
async fn the_route_tells_every_change_of_mode_and_only_changes() {
    let (tor, direct) = (Mock::new(), Mock::new());
    let net = both(&tor, &direct);
    let mut route = net.route();
    assert_eq!(*route.borrow_and_update(), Mode::Tor);

    net.allow_direct(DirectPermit::for_session()).unwrap();
    within(route.changed()).await.unwrap();
    assert_eq!(*route.borrow_and_update(), Mode::Direct);

    // Asked again, nothing changes, and nobody is told.
    net.allow_direct(DirectPermit::for_session()).unwrap();
    assert!(!route.has_changed().unwrap());

    net.back_to_tor();
    within(route.changed()).await.unwrap();
    assert_eq!(*route.borrow_and_update(), Mode::Tor);

    // The updater's permit never changes the mode, so nothing moves.
    let _ = net.allow_direct(DirectPermit::for_updater());
    net.back_to_tor();
    assert!(!route.has_changed().unwrap());
}

#[tokio::test]
#[allow(clippy::disallowed_methods)]
async fn the_updater_permit_never_changes_the_mode() {
    let (tor, direct) = (Mock::new(), Mock::new());
    let net = both(&tor, &direct);

    assert_eq!(
        net.allow_direct(DirectPermit::for_updater()),
        Err(NetError::NotPermitted)
    );
    assert_eq!(net.mode(), Mode::Tor);
}

#[tokio::test]
#[allow(clippy::disallowed_methods)]
async fn the_updater_permit_reaches_only_its_hosts_on_https() {
    let (tor, direct) = (Mock::new(), Mock::new());
    let allowed = [
        "trinochat.org",
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    ];
    let _listeners: Vec<_> = allowed.iter().map(|h| direct.listen(h, 443)).collect();
    let net = both(&tor, &direct);
    let permit = DirectPermit::for_updater();

    for host in allowed {
        within(net.connect_for_update(&permit, &Target::new(host, 443)))
            .await
            .unwrap_or_else(|e| panic!("{host}: {e}"));
    }
    for (host, port) in [
        ("evil.example", 443),
        ("github.com.evil.example", 443),
        ("relay.trinochat.org", 443),
        ("github.com", 80),
    ] {
        assert_eq!(
            within(net.connect_for_update(&permit, &Target::new(host, port)))
                .await
                .err(),
            Some(NetError::NotPermitted),
            "{host}:{port}"
        );
    }
    // The session's permit is not the updater's.
    let session = DirectPermit::for_session();
    assert_eq!(
        within(net.connect_for_update(&session, &Target::new("github.com", 443)))
            .await
            .err(),
        Some(NetError::NotPermitted)
    );
    assert_eq!(direct.connections().len(), allowed.len());
    assert!(tor.connections().is_empty());
    assert_eq!(
        net.mode(),
        Mode::Tor,
        "the updater's permit changed the mode"
    );
}

#[tokio::test]
#[allow(clippy::disallowed_methods)]
async fn the_real_direct_transport_connects_only_with_the_session_permit() {
    // The one real socket of these tests: to a listener on this machine.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        socket.write_all(b"hi").await.unwrap();
    });
    let net = Net::new();
    let iso = net.session().iso(IsoKind::RELAY, "local");
    let target = Target::new("127.0.0.1", port);

    assert_eq!(
        within(net.connect(&target, &iso)).await.err(),
        Some(NetError::TorNotReady),
        "without a permit, a Net with no Tor connects nowhere"
    );
    net.allow_direct(DirectPermit::for_session()).unwrap();
    let mut io = within(net.connect(&target, &iso)).await.unwrap();
    let mut hello = [0u8; 2];
    within(io.read_exact(&mut hello)).await.unwrap();

    assert_eq!(&hello, b"hi");
    server.await.unwrap();
}

// ---- The rule that keeps the permits and the sockets in their place ----

/// The workspace's clippy.toml, which every crate of it reads.
const CLIPPY_TOML: &str = include_str!("../../../clippy.toml");

#[test]
fn clippy_disallows_building_a_permit_and_every_direct_socket() {
    // R-07 and R-21: with `-D warnings` (CI and the checks of every step)
    // naming one of these outside an `#[allow]` fails the build. Which
    // files may hold that `#[allow]` for the permits is the app's own test
    // (`only_two_files_name_direct_permit`).
    for path in [
        "trino_net::DirectPermit::for_session",
        "trino_net::DirectPermit::for_updater",
        "tokio::net::TcpStream::connect",
        "std::net::TcpStream::connect",
        "std::net::TcpStream::connect_timeout",
        "std::net::ToSocketAddrs::to_socket_addrs",
        "tokio::net::lookup_host",
        "tokio::net::UdpSocket::bind",
        "std::net::UdpSocket::bind",
        "tokio_tungstenite::connect_async",
        "tokio_tungstenite::connect_async_with_config",
        "tokio_tungstenite::connect_async_tls_with_config",
        "hyper_util::client::legacy::connect::HttpConnector",
        "hyper_util::client::legacy::connect::dns::GaiResolver",
    ] {
        assert!(
            CLIPPY_TOML.contains(&format!("path = \"{path}\"")),
            "clippy.toml does not disallow {path}"
        );
    }
}

#[test]
fn no_file_outside_direct_names_a_socket_or_a_resolver() {
    // Design test 10, for this crate. This file is left out: it names them
    // to list what clippy disallows, and binds a local listener.
    let banned = [
        concat!("Tcp", "Stream"),
        concat!("Udp", "Socket"),
        concat!("lookup", "_host"),
        concat!("ToSocket", "Addrs"),
    ];
    for (file, source) in [
        ("lib.rs", include_str!("lib.rs")),
        ("transport.rs", include_str!("transport.rs")),
        ("ws.rs", include_str!("ws.rs")),
        ("http.rs", include_str!("http.rs")),
        ("mock.rs", include_str!("mock.rs")),
        ("mock_http.rs", include_str!("mock_http.rs")),
        ("http_tests.rs", include_str!("http_tests.rs")),
        ("status.rs", include_str!("status.rs")),
        ("onion_map.rs", include_str!("onion_map.rs")),
        ("tor/mod.rs", include_str!("tor/mod.rs")),
        ("tor/arti.rs", include_str!("tor/arti.rs")),
        ("tor/settings.rs", include_str!("tor/settings.rs")),
        ("tor/marker.rs", include_str!("tor/marker.rs")),
        ("tor/bridges.rs", include_str!("tor/bridges.rs")),
        ("tor/dirs.rs", include_str!("tor/dirs.rs")),
        ("tor/pt.rs", include_str!("tor/pt.rs")),
        ("pt_tests.rs", include_str!("pt_tests.rs")),
        ("bridge_tests.rs", include_str!("bridge_tests.rs")),
        ("tor_tests.rs", include_str!("tor_tests.rs")),
    ] {
        for name in banned {
            assert!(!source.contains(name), "{file} names {name}");
        }
    }
}
