//! The one place that builds HTTP clients (plan-cambios §4 W7 and §8).
//!
//! Every client built here:
//! - uses rustls, the only TLS the app is built with;
//! - gives up connecting, and the whole exchange, at a deadline;
//! - never follows a redirect, so a server cannot send a request on to a
//!   host nobody chose;
//! - is read with a cap: `read_capped`, which refuses an answer past a
//!   size, or turn.rs's own, which also wipes the credential it reads.
//!
//! Blossom (K2) and the TURN credentials use it. Tor will change the
//! transport here, for every client at once.

use std::time::Duration;
use thiserror::Error;

/// How long a client waits: to connect, and for the whole exchange.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Deadlines {
    pub(crate) connect: Duration,
    pub(crate) total: Duration,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub(crate) enum NetError {
    #[error("could not build the HTTP client")]
    Build,
    #[error("the answer is larger than {max} bytes")]
    TooLarge { max: usize },
    #[error("{0}")]
    Transfer(&'static str),
}

/// A short reason for a failed request: never the URL, which reqwest puts
/// in its own message.
pub(crate) fn reason(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else {
        "network"
    }
}

/// An HTTP client with the rules above.
pub(crate) fn client(deadlines: Deadlines) -> Result<reqwest::Client, NetError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .connect_timeout(deadlines.connect)
        .timeout(deadlines.total)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| NetError::Build)
}

/// The body of `response`, refused as soon as it passes `max` bytes:
/// before reading anything when the server says it is larger, and
/// otherwise once the bytes read go past it.
pub(crate) async fn read_capped(
    response: &mut reqwest::Response,
    max: usize,
) -> Result<Vec<u8>, NetError> {
    let too_large = NetError::TooLarge { max };
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(too_large);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| NetError::Transfer(reason(&e)))?
    {
        if body.len() + chunk.len() > max {
            return Err(too_large);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A local HTTP/1.1 server for the tests of the clients built here.
#[cfg(test)]
pub(crate) mod mock {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// What the server received on one connection.
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

    /// An answer without a length: the body ends when the connection closes.
    pub(crate) fn until_close(status: &str, body: &[u8]) -> Reply {
        let mut bytes = format!("HTTP/1.1 {status}\r\nConnection: close\r\n\r\n").into_bytes();
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

        assert_eq!(reason(&error), "timeout", "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn an_answer_over_the_cap_is_refused_with_or_without_a_length() {
        let big = vec![b'x'; 4096];
        for reply in [
            mock::response("200 OK", "", &big),
            mock::until_close("200 OK", &big),
        ] {
            let (base, _) = mock::serve(|_| vec![reply]).await;
            let mut response = client(QUICK).unwrap().get(&base).send().await.unwrap();

            let read = within(Duration::from_secs(5), read_capped(&mut response, 1024)).await;

            // Lengths only: a failure must not print every byte.
            assert_eq!(
                read.map(|body| body.len()),
                Err(NetError::TooLarge { max: 1024 })
            );
        }
    }

    #[tokio::test]
    async fn an_answer_within_the_cap_is_read_whole() {
        let (base, _) = mock::serve(|_| vec![mock::until_close("200 OK", b"{\"url\":1}")]).await;
        let mut response = client(QUICK).unwrap().get(&base).send().await.unwrap();

        let read = within(Duration::from_secs(5), read_capped(&mut response, 1024)).await;

        assert_eq!(read.unwrap(), b"{\"url\":1}");
    }

    #[test]
    fn nothing_but_this_module_builds_an_http_client() {
        // §8: Tor swaps the transport in one place.
        for (file, source) in [
            ("blossom.rs", include_str!("blossom.rs")),
            ("commands.rs", include_str!("commands.rs")),
            ("turn.rs", include_str!("turn.rs")),
        ] {
            for builder in ["Client::new", "Client::builder", "reqwest::get"] {
                assert!(!source.contains(builder), "{file} uses {builder}");
            }
        }
    }
}
