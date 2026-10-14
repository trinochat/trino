//! The tests of `HttpClient` (Tor design §2.1, §11.1 tests 8 and 9, §11.8
//! test 67, and the redirects Blossom needs, spike S6). Tor is the
//! in-memory `Mock`, its servers those of mock_http.rs, and the direct
//! transport fails the test if anything touches it.

use crate::mock::{Forbidden, Mock};
use crate::mock_http::{self, header, header_count, Reply};
use crate::*;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A `Net` whose Tor is `tor` and whose direct transport panics if used.
fn tor_only(tor: Option<Arc<Mock>>) -> Arc<Net> {
    Net::with_transports(tor.map(|t| t as Arc<dyn Transport>), Arc::new(Forbidden))
}

/// A client on `tor` that trusts the test CA.
fn client(tor: &Arc<Mock>) -> HttpClient {
    HttpClient::with_tls(tor_only(Some(Arc::clone(tor))), mock_http::test_tls())
}

fn iso() -> Iso {
    Session::next().iso(IsoKind::BLOSSOM, "test")
}

const QUICK: Deadlines = Deadlines {
    connect: Duration::from_secs(2),
    total: Duration::from_millis(500),
    idle: None,
};

/// Fails the test instead of hanging when a request has no deadline.
async fn within<T>(work: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), work)
        .await
        .expect("still waiting after 5 s: no deadline")
}

// ---- Test 8: no redirects unless asked, and a capped answer ----

#[tokio::test]
async fn the_http_client_never_follows_redirects_and_caps_the_answer() {
    let tor = Mock::new();
    let seen = mock_http::serve(
        &tor,
        "https://a.trino.invalid",
        vec![
            mock_http::response(
                "302 Found",
                "Location: https://a.trino.invalid/other\r\n",
                b"",
            ),
            mock_http::response("200 OK", "", b"followed"),
        ],
    );
    let client = client(&tor);

    let response = within(client.send(
        Request::get("https://a.trino.invalid/start").unwrap(),
        &iso(),
        QUICK,
    ))
    .await
    .unwrap();

    assert_eq!(response.status(), 302);
    assert_eq!(seen.lock().unwrap().len(), 1, "the redirect was followed");

    // Over the cap, with a length or without one.
    let big = vec![b'x'; 4096];
    for reply in [
        mock_http::response("200 OK", "", &big),
        mock_http::until_close("200 OK", &big),
    ] {
        let tor = Mock::new();
        mock_http::serve(&tor, "https://a.trino.invalid", vec![reply]);
        let mut response = within(client_send(&tor, "https://a.trino.invalid/"))
            .await
            .unwrap();

        let read = within(response.read_capped(1024)).await;

        // Lengths only: a failure must not print every byte.
        assert_eq!(
            read.map(|body| body.len()),
            Err(HttpError::TooLarge { max: 1024 })
        );
    }
}

async fn client_send(tor: &Arc<Mock>, url: &str) -> Result<Response, HttpError> {
    client(tor)
        .send(Request::get(url).unwrap(), &iso(), QUICK)
        .await
}

#[tokio::test]
async fn an_answer_within_the_cap_is_read_whole() {
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://a.trino.invalid",
        vec![mock_http::until_close("200 OK", b"{\"url\":1}")],
    );
    let mut response = within(client_send(&tor, "https://a.trino.invalid/"))
        .await
        .unwrap();

    let read = within(response.read_capped(1024)).await;

    assert_eq!(read.unwrap(), b"{\"url\":1}");
}

#[tokio::test]
async fn a_request_goes_as_asked_with_its_body_headers_and_host() {
    let tor = Mock::new();
    let seen = mock_http::serve(
        &tor,
        "https://a.trino.invalid:8443",
        vec![mock_http::response("201 Created", "", b"")],
    );

    let response = within(
        client(&tor).send(
            Request::put("https://a.trino.invalid:8443/upload?x=1")
                .unwrap()
                .header("authorization", "Nostr abc")
                .unwrap()
                .header("content-type", "application/octet-stream")
                .unwrap()
                .body(b"ciphertext".to_vec()),
            &iso(),
            QUICK,
        ),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), 201);
    let seen = seen.lock().unwrap();
    let request = &seen[0];
    assert!(
        request.head.starts_with("PUT /upload?x=1 HTTP/1.1\r\n"),
        "{}",
        request.head
    );
    assert_eq!(
        header(&request.head, "host").as_deref(),
        Some("a.trino.invalid:8443")
    );
    assert_eq!(
        header(&request.head, "authorization").as_deref(),
        Some("Nostr abc")
    );
    assert_eq!(
        header(&request.head, "content-type").as_deref(),
        Some("application/octet-stream")
    );
    assert_eq!(request.body, b"ciphertext");
}

// ---- Deadlines ----

#[tokio::test]
async fn a_server_that_never_answers_is_given_up_on_at_the_deadline() {
    let tor = Mock::new();
    mock_http::serve(&tor, "https://a.trino.invalid", vec![Reply::Never]);
    let started = Instant::now();

    let error = within(client_send(&tor, "https://a.trino.invalid/"))
        .await
        .err();

    assert_eq!(error, Some(HttpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn a_server_that_stops_sending_is_given_up_on_at_the_idle_deadline() {
    // A slow line needs a long total deadline; a server that stalls must
    // not hold the request for all of it.
    let patient = Deadlines {
        total: Duration::from_secs(60),
        idle: Some(Duration::from_millis(300)),
        ..QUICK
    };
    let tor = Mock::new();
    let mut listener = tor.listen("a.trino.invalid", 80);
    // A head that promises more than ever comes.
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut socket = listener.accept().await.unwrap();
        let mut buf = [0u8; 1024];
        let _ = socket.read(&mut buf).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nsome")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(socket);
    });
    let client = client(&tor);
    let started = Instant::now();

    let mut response = within(client.send(
        Request::get("http://a.trino.invalid/").unwrap(),
        &iso(),
        patient,
    ))
    .await
    .unwrap();
    let read = within(response.read_capped(1024)).await;

    assert_eq!(read.map(|b| b.len()), Err(HttpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(3));
    server.abort();

    // And one that never sends the head.
    mock_http::serve(&tor, "http://b.trino.invalid", vec![Reply::Never]);
    let started = Instant::now();
    let error = within(client.send(
        Request::get("http://b.trino.invalid/").unwrap(),
        &iso(),
        patient,
    ))
    .await
    .err();
    assert_eq!(error, Some(HttpError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(3));
}

// ---- Test 9: one connection per request, closed after it ----

#[tokio::test]
async fn connection_close_means_one_connection_per_request() {
    let tor = Mock::new();
    let seen = mock_http::serve(
        &tor,
        "https://a.trino.invalid",
        vec![
            mock_http::response("200 OK", "", b"one"),
            mock_http::response("200 OK", "", b"two"),
        ],
    );
    let client = client(&tor);
    let iso = iso();

    for expected in [b"one", b"two"] {
        let mut response = within(client.send(
            Request::get("https://a.trino.invalid/").unwrap(),
            &iso,
            QUICK,
        ))
        .await
        .unwrap();
        assert_eq!(within(response.read_capped(16)).await.unwrap(), expected);
    }

    assert_eq!(tor.connections().len(), 2, "a connection was reused");
    for request in seen.lock().unwrap().iter() {
        assert_eq!(
            header(&request.head, "connection").as_deref(),
            Some("close")
        );
    }
}

// ---- Test 67 (R-20): the User-Agent goes only to trinochat.org ----

#[tokio::test]
async fn the_user_agent_goes_only_to_trinochat_org() {
    let tor = Mock::new();
    let trino = mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![mock_http::response("200 OK", "", b"")],
    );
    let other = mock_http::serve(
        &tor,
        "https://blossom.trino.invalid",
        vec![
            mock_http::response("200 OK", "", b""),
            mock_http::response("200 OK", "", b""),
        ],
    );
    let lookalike = mock_http::serve(
        &tor,
        "https://www.trinochat.org",
        vec![mock_http::response("200 OK", "", b"")],
    );
    let client = client(&tor);

    // A caller cannot set its own: the client owns the header.
    for url in [
        "https://trinochat.org/api/v1/turn/credentials",
        "https://blossom.trino.invalid/x",
        "https://www.trinochat.org/",
    ] {
        let request = Request::get(url)
            .unwrap()
            .header("user-agent", "Mozilla/5.0 (leaks)")
            .unwrap();
        within(client.send(request, &iso(), QUICK)).await.unwrap();
    }
    within(client.send(
        Request::get("https://blossom.trino.invalid/y").unwrap(),
        &iso(),
        QUICK,
    ))
    .await
    .unwrap();

    let trino = trino.lock().unwrap();
    assert_eq!(header_count(&trino[0].head, "user-agent"), 1);
    assert_eq!(
        header(&trino[0].head, "user-agent").as_deref(),
        Some("Trino")
    );
    for request in other
        .lock()
        .unwrap()
        .iter()
        .chain(lookalike.lock().unwrap().iter())
    {
        assert_eq!(
            header(&request.head, "user-agent"),
            None,
            "{}",
            request.head
        );
    }
}

// ---- TLS, names and the transport ----

#[tokio::test]
async fn https_is_checked_against_the_web_roots() {
    // The production client does not trust the test CA.
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://a.trino.invalid",
        vec![mock_http::response("200 OK", "", b"")],
    );
    let client = HttpClient::new(tor_only(Some(Arc::clone(&tor))));

    let error = within(client.send(
        Request::get("https://a.trino.invalid/").unwrap(),
        &iso(),
        QUICK,
    ))
    .await
    .err();

    assert_eq!(error, Some(HttpError::Tls));
}

#[tokio::test]
async fn a_host_goes_to_tor_by_name_with_the_token_it_was_given() {
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://blossom.trino.invalid",
        vec![mock_http::response("200 OK", "", b"")],
    );
    let iso = Session::next().iso(IsoKind::BLOSSOM, "one download");

    within(client(&tor).send(
        Request::get("https://blossom.trino.invalid/abc").unwrap(),
        &iso,
        QUICK,
    ))
    .await
    .unwrap();

    let connections = tor.connections();
    assert_eq!(
        connections,
        [(Target::new("blossom.trino.invalid", 443), iso)],
        "by name, never resolved here, on its own token"
    );
}

#[tokio::test]
async fn without_tor_ready_a_request_is_tor_not_ready_and_never_direct() {
    // Test 1 for HTTP: the direct transport panics if touched.
    let client = HttpClient::new(tor_only(None));

    let error = within(client.send(
        Request::get("https://trinochat.org/").unwrap(),
        &iso(),
        QUICK,
    ))
    .await
    .err();

    assert_eq!(error, Some(HttpError::TorNotReady));
}

#[test]
fn only_http_and_https_addresses_without_credentials_are_taken() {
    for bad in [
        "ftp://a.trino.invalid/",
        "ws://a.trino.invalid/",
        "https://user:secret@a.trino.invalid/",
        "https://user@a.trino.invalid/",
        "not a url",
        "https://",
    ] {
        assert_eq!(Request::get(bad).err(), Some(HttpError::BadUrl), "{bad}");
    }
    assert!(Request::get("http://a.onion/").is_ok());
}

// ---- Redirects, only where a policy allows them (spike S6, R-05) ----

const CDN: RedirectPolicy = RedirectPolicy::to(&[HostRule::Under("cdn.trino.invalid")]);

#[test]
fn a_host_rule_takes_the_name_and_what_is_under_it_and_nothing_else() {
    let under = HostRule::Under("primal.net");
    assert!(under.allows("primal.net"));
    assert!(under.allows("r2a.primal.net"));
    assert!(under.allows("a.b.primal.net"));
    assert!(!under.allows("evilprimal.net"));
    assert!(!under.allows("primal.net.evil.example"));
    assert!(!under.allows("net"));
    let exact = HostRule::Exact("github.com");
    assert!(exact.allows("github.com"));
    assert!(!exact.allows("api.github.com"));
    assert!(!exact.allows("github.com.evil.example"));
}

#[tokio::test]
async fn a_redirect_is_followed_on_https_to_an_allowed_host_with_the_same_token() {
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://blossom.trino.invalid",
        vec![mock_http::response(
            "302 Found",
            "Location: https://r2.cdn.trino.invalid/abc\r\n",
            b"",
        )],
    );
    let cdn = mock_http::serve(
        &tor,
        "https://r2.cdn.trino.invalid",
        vec![mock_http::response("200 OK", "", b"the blob")],
    );
    let iso = Session::next().iso(IsoKind::BLOSSOM, "one download");

    let mut response = within(
        client(&tor).send(
            Request::get("https://blossom.trino.invalid/abc")
                .unwrap()
                .follow(CDN),
            &iso,
            QUICK,
        ),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), 200);
    assert_eq!(within(response.read_capped(64)).await.unwrap(), b"the blob");
    assert!(cdn.lock().unwrap()[0]
        .head
        .starts_with("GET /abc HTTP/1.1\r\n"));
    let tokens: Vec<Iso> = tor.connections().into_iter().map(|(_, i)| i).collect();
    assert_eq!(tokens, [iso.clone(), iso], "every hop on the same token");
}

#[tokio::test]
async fn a_redirect_to_another_host_plain_http_or_past_three_hops_is_refused() {
    let hop = |to: &str| mock_http::response("302 Found", &format!("Location: {to}\r\n"), b"");
    for (chain, why) in [
        (
            vec![hop("https://elsewhere.trino.invalid/abc")],
            "another host",
        ),
        (
            vec![hop("https://cdn.trino.invalid.evil.invalid/abc")],
            "a lookalike",
        ),
        (vec![hop("http://cdn.trino.invalid/abc")], "plain http"),
        (
            vec![hop("//elsewhere.trino.invalid/abc")],
            "a scheme-relative one",
        ),
        (
            vec![
                hop("https://cdn.trino.invalid/1"),
                hop("https://cdn.trino.invalid/2"),
                hop("https://cdn.trino.invalid/3"),
                hop("https://cdn.trino.invalid/4"),
            ],
            "a fourth hop",
        ),
    ] {
        let tor = Mock::new();
        let hops = chain.len();
        let mut chain = chain.into_iter();
        mock_http::serve(
            &tor,
            "https://blossom.trino.invalid",
            vec![chain.next().unwrap()],
        );
        mock_http::serve(&tor, "https://cdn.trino.invalid", chain.collect());

        let error = within(
            client(&tor).send(
                Request::get("https://blossom.trino.invalid/abc")
                    .unwrap()
                    .follow(CDN),
                &iso(),
                QUICK,
            ),
        )
        .await
        .err();

        assert_eq!(error, Some(HttpError::Redirect), "{why}");
        let reached: Vec<String> = tor.connections().into_iter().map(|(t, _)| t.host).collect();
        assert_eq!(reached.len(), hops, "{why}: {reached:?}");
        assert!(
            reached.iter().all(|host| host != "elsewhere.trino.invalid"
                && host != "cdn.trino.invalid.evil.invalid"),
            "{why}: {reached:?}"
        );
    }
}

#[tokio::test]
async fn a_relative_redirect_stays_on_the_same_host() {
    let tor = Mock::new();
    let seen = mock_http::serve(
        &tor,
        "https://cdn.trino.invalid",
        vec![
            mock_http::response("307 Temporary Redirect", "Location: /moved\r\n", b""),
            mock_http::response("200 OK", "", b"here"),
        ],
    );

    let mut response = within(
        client(&tor).send(
            Request::get("https://cdn.trino.invalid/abc")
                .unwrap()
                .follow(CDN),
            &iso(),
            QUICK,
        ),
    )
    .await
    .unwrap();

    assert_eq!(within(response.read_capped(64)).await.unwrap(), b"here");
    assert!(seen.lock().unwrap()[1]
        .head
        .starts_with("GET /moved HTTP/1.1\r\n"));
}

#[tokio::test]
async fn a_redirect_carries_no_authorization_to_another_host() {
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://blossom.trino.invalid",
        vec![mock_http::response(
            "302 Found",
            "Location: https://cdn.trino.invalid/abc\r\n",
            b"",
        )],
    );
    let cdn = mock_http::serve(
        &tor,
        "https://cdn.trino.invalid",
        vec![mock_http::response("200 OK", "", b"")],
    );

    within(
        client(&tor).send(
            Request::get("https://blossom.trino.invalid/abc")
                .unwrap()
                .header("authorization", "Nostr secret")
                .unwrap()
                .follow(CDN),
            &iso(),
            QUICK,
        ),
    )
    .await
    .unwrap();

    assert_eq!(header(&cdn.lock().unwrap()[0].head, "authorization"), None);
}

#[tokio::test]
async fn only_a_get_follows_a_redirect() {
    // An upload is never sent on to a host it was not addressed to.
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://blossom.trino.invalid",
        vec![mock_http::response(
            "307 Temporary Redirect",
            "Location: https://cdn.trino.invalid/upload\r\n",
            b"",
        )],
    );

    let response = within(
        client(&tor).send(
            Request::put("https://blossom.trino.invalid/upload")
                .unwrap()
                .body(b"blob".to_vec())
                .follow(CDN),
            &iso(),
            QUICK,
        ),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), 307);
    assert_eq!(tor.connections().len(), 1);
}

#[test]
fn errors_never_print_an_address() {
    for error in [
        HttpError::TorNotReady,
        HttpError::NotPermitted,
        HttpError::BadUrl,
        HttpError::Connect,
        HttpError::Timeout,
        HttpError::Tls,
        HttpError::Network,
        HttpError::TooLarge { max: 1 },
        HttpError::Redirect,
    ] {
        let text = error.to_string();
        assert!(
            !text.contains("://") && !text.contains(".invalid"),
            "{text}"
        );
    }
    assert_eq!(HttpError::Timeout.to_string(), "timeout");
    assert_eq!(HttpError::Connect.to_string(), "connect");
    assert_eq!(
        HttpError::TooLarge { max: 1024 }.to_string(),
        "the answer is larger than 1024 bytes"
    );
}
