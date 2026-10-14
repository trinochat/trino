//! The one place that builds HTTP clients (plan-cambios §4 W7 and §8).
//!
//! Every client built here:
//! - uses rustls, the only TLS the app is built with;
//! - gives up connecting, and the whole exchange, at a deadline;
//! - never follows a redirect, so a server cannot send a request on to a
//!   host nobody chose;
//! - is read with a cap: turn.rs's own, which also wipes the credential it
//!   reads.
//!
//! The TURN credentials use it. Blossom moved to trino-net's HttpClient
//! (Tor design §3 B1, B2); this module leaves once turn.rs moves too.

use std::time::Duration;
use thiserror::Error;

/// How long a client waits: to connect, for the whole exchange and, if
/// given, between two reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Deadlines {
    pub(crate) connect: Duration,
    pub(crate) total: Duration,
    /// reqwest's read timeout: it starts with the request and runs, never
    /// reset, until the answer begins, and then between two reads of it.
    /// So it bounds sending a body too, and an upload must not have one.
    pub(crate) idle: Option<Duration>,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum NetError {
    #[error("could not build the HTTP client")]
    Build,
}

/// An HTTP client with the rules above.
pub(crate) fn client(deadlines: Deadlines) -> Result<reqwest::Client, NetError> {
    let builder = reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(deadlines.connect)
        .timeout(deadlines.total)
        .redirect(reqwest::redirect::Policy::none());
    match deadlines.idle {
        Some(idle) => builder.read_timeout(idle),
        None => builder,
    }
    .build()
    .map_err(|_| NetError::Build)
}

/// A local HTTP/1.1 server for the tests of the clients built here.
#[cfg(test)]
pub(crate) mod mock {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// What the server received on one connection. Only blossom.rs's tests
    /// read it, and they moved to trino-net's servers; this module leaves
    /// with reqwest, once turn.rs moves too (Tor design §3.2).
    #[allow(dead_code)]
    pub(crate) struct Request {
        pub(crate) head: String,
        pub(crate) body: Vec<u8>,
    }

    /// What the server does with one connection.
    pub(crate) enum Reply {
        /// Send these bytes and close.
        Bytes(Vec<u8>),
        /// Read the request and never answer.
        Never,
    }

    /// An answer with a `Content-Length`.
    pub(crate) fn response(status: &str, headers: &str, body: &[u8]) -> Reply {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        Reply::Bytes(bytes)
    }

    /// The value of the header `name` in `head`, if any.
    pub(crate) fn header(head: &str, name: &str) -> Option<String> {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    async fn read_request(socket: &mut TcpStream) -> Request {
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
                return Request {
                    head,
                    body: buf[end + 4..].to_vec(),
                };
            }
            let n = socket.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                return Request {
                    head: String::from_utf8_lossy(&buf).to_string(),
                    body: Vec::new(),
                };
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    }

    /// Serve the replies `replies(base_url)` gives, one per connection and
    /// in order. Returns the base URL (`http://127.0.0.1:<port>`) and the
    /// requests seen so far.
    pub(crate) async fn serve(
        replies: impl FnOnce(&str) -> Vec<Reply>,
    ) -> (String, Arc<Mutex<Vec<Request>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let replies = replies(&base);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            for reply in replies {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let request = read_request(&mut socket).await;
                log.lock().unwrap().push(request);
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
        });
        (base, seen)
    }
}

#[cfg(test)]
mod tests {
    use super::mock::{self, Reply};
    use super::*;
    use std::time::Instant;

    const QUICK: Deadlines = Deadlines {
        connect: Duration::from_secs(2),
        total: Duration::from_millis(500),
        idle: None,
    };

    /// Fails the test instead of hanging when a request has no deadline.
    async fn within<T>(limit: Duration, work: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(limit, work)
            .await
            .unwrap_or_else(|_| panic!("still waiting after {limit:?}: no deadline"))
    }

    #[tokio::test]
    async fn a_redirect_is_never_followed() {
        let (base, seen) = mock::serve(|base| {
            vec![
                mock::response("302 Found", &format!("Location: {base}/other\r\n"), b""),
                mock::response("200 OK", "", b"followed"),
            ]
        })
        .await;
        let client = client(QUICK).unwrap();

        let response = within(
            Duration::from_secs(5),
            client.get(format!("{base}/start")).send(),
        )
        .await
        .unwrap();

        assert_eq!(response.status().as_u16(), 302);
        assert_eq!(seen.lock().unwrap().len(), 1, "the redirect was followed");
    }

    #[tokio::test]
    async fn a_server_that_never_answers_is_given_up_on_at_the_deadline() {
        let (base, _) = mock::serve(|_| vec![Reply::Never]).await;
        let client = client(QUICK).unwrap();
        let started = Instant::now();

        let error = within(Duration::from_secs(5), client.get(&base).send())
            .await
            .unwrap_err();

        assert!(error.is_timeout(), "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn nothing_but_this_module_builds_an_http_client() {
        // §8: Tor swaps the transport in one place. Blossom's client is
        // trino-net's HttpClient, which this does not count.
        for (file, source) in [
            ("blossom.rs", include_str!("blossom.rs")),
            ("commands.rs", include_str!("commands.rs")),
            ("turn.rs", include_str!("turn.rs")),
        ] {
            for builder in ["reqwest::Client", "Client::builder", "reqwest::get"] {
                assert!(!source.contains(builder), "{file} uses {builder}");
            }
        }
    }
}
