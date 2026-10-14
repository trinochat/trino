//! HTTP servers for tests, on the in-memory `Mock` transport (feature
//! "test-util"). An https:// server speaks real TLS with a certificate of
//! the test CA in src/testdata, which only `test_tls` trusts. Nothing here
//! touches the network.

use crate::mock::Mock;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The test CA, and the certificate it signed for `*.trino.invalid`,
/// `*.cdn.trino.invalid`, `trinochat.org` and `*.trinochat.org`, with its key. Made for these tests
/// only (src/testdata/README.md); nothing outside a test trusts the CA.
const TEST_CA: &[u8] = include_bytes!("testdata/ca.der");
const TEST_CERT: &[u8] = include_bytes!("testdata/leaf.der");
const TEST_KEY: &[u8] = include_bytes!("testdata/leaf.key.der");

/// What a server received on one connection.
#[derive(Clone, Debug)]
pub struct Received {
    /// The request line and the headers, without the blank line.
    pub head: String,
    pub body: Vec<u8>,
}

/// What a server does with one connection.
pub enum Reply {
    /// Send these bytes and close.
    Bytes(Vec<u8>),
    /// Read the request and never answer.
    Never,
}

/// An answer with a `Content-Length`.
pub fn response(status: &str, headers: &str, body: &[u8]) -> Reply {
    let mut bytes = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
        body.len()
    )
    .into_bytes();
    bytes.extend_from_slice(body);
    Reply::Bytes(bytes)
}

/// An answer without a length: the body ends when the connection closes.
pub fn until_close(status: &str, body: &[u8]) -> Reply {
    let mut bytes = format!("HTTP/1.1 {status}\r\nConnection: close\r\n\r\n").into_bytes();
    bytes.extend_from_slice(body);
    Reply::Bytes(bytes)
}

/// The value of the header `name` in `head`, if any.
pub fn header(head: &str, name: &str) -> Option<String> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name)
            .then(|| value.trim().to_string())
    })
}

/// How many times the header `name` is in `head`.
pub fn header_count(head: &str, name: &str) -> usize {
    head.lines()
        .skip(1)
        .filter(|line| {
            line.split_once(':')
                .is_some_and(|(key, _)| key.eq_ignore_ascii_case(name))
        })
        .count()
}

/// A client TLS config that trusts the test CA and nothing else.
pub fn test_tls() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(TEST_CA))
        .expect("the test CA");
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
}

fn server_tls() -> Arc<ServerConfig> {
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(TEST_KEY));
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_no_client_auth()
            .with_single_cert(vec![CertificateDer::from(TEST_CERT)], key)
            .expect("the test certificate and its key");
    Arc::new(config)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn read_request<S: AsyncRead + Unpin>(socket: &mut S) -> Received {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        if let Some(end) = find(&buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..end]).to_string();
            let length = header(&head, "content-length")
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            while buf.len() < end + 4 + length {
                let n = socket.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            return Received {
                head,
                body: buf[end + 4..].to_vec(),
            };
        }
        let n = socket.read(&mut chunk).await.unwrap_or(0);
        if n == 0 {
            return Received {
                head: String::from_utf8_lossy(&buf).to_string(),
                body: Vec::new(),
            };
        }
        buf.extend_from_slice(&chunk[..n]);
    }
}

async fn answer<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut socket: S,
    reply: Reply,
    log: &Mutex<Vec<Received>>,
) {
    let request = read_request(&mut socket).await;
    log.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(request);
    match reply {
        Reply::Bytes(bytes) => {
            let _ = socket.write_all(&bytes).await;
            let _ = socket.shutdown().await;
        }
        Reply::Never => {
            // Hold the connection open, answering nothing.
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(60)).await;
                drop(socket);
            });
        }
    }
}

/// Serve `base` (`http://host[:port]` or `https://host[:port]`) on `tor`
/// with `replies`, one per connection and in order. Returns what each
/// connection asked for, as it arrives. Needs a tokio runtime.
pub fn serve(tor: &Mock, base: &str, replies: Vec<Reply>) -> Arc<Mutex<Vec<Received>>> {
    let url = url::Url::parse(base).expect("a base URL");
    let https = match url.scheme() {
        "https" => true,
        "http" => false,
        other => panic!("not an HTTP scheme: {other}"),
    };
    let host = url.host_str().expect("a host").to_string();
    let port = url.port_or_known_default().expect("a port");
    let mut listener = tor.listen(&host, port);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&seen);
    tokio::spawn(async move {
        let acceptor = tokio_rustls::TlsAcceptor::from(server_tls());
        for reply in replies {
            let Some(socket) = listener.accept().await else {
                return;
            };
            if https {
                // A client that refuses the certificate leaves here.
                let Ok(tls) = acceptor.accept(socket).await else {
                    continue;
                };
                answer(tls, reply, &log).await;
            } else {
                answer(socket, reply, &log).await;
            }
        }
    });
    seen
}
