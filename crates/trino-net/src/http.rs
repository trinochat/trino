//! HTTP over whatever `Net` gives (Tor design §2.1): the app's only HTTP
//! client, for Blossom, the TURN credentials and, later, names,
//! invitations, news and the updater. reqwest cannot take a connection
//! from Arti, so this is hyper's low-level HTTP/1.1 client over a
//! connection `Net` opens, with rustls for https:// as in wss://.
//!
//! Every request:
//! - goes through `Net::connect` with the caller's isolation token, the
//!   host by name: with Tor, the exit resolves it (design test 3);
//! - waits up to `READY_WAIT` for a starting Tor, and only then counts its
//!   `Deadlines`: it gives up connecting (TLS included), the whole exchange
//!   and, if asked, a silence between two reads, at them;
//! - opens its own connection and asks the server to close it after the
//!   answer (`Connection: close`): nothing is reused, so two requests never
//!   share a connection (invitations need this, design §8.1);
//! - follows no redirect, unless the caller gives a `RedirectPolicy`: then
//!   only a GET, only to https://, to the policy's hosts, at most
//!   `MAX_REDIRECTS` times, on the same token (spike S6 for Blossom, R-05
//!   for the updater);
//! - carries the User-Agent `Trino` to trinochat.org and no User-Agent to
//!   anyone else (R-20): the client owns that header, a caller cannot set it;
//! - is read with a cap.
//!
//! Errors never carry the address or anything the server said.

use crate::{BoxedIo, DirectPermit, Iso, Net, NetError, NetStatus, Target};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::header::{self, HeaderMap, HeaderName, HeaderValue};
use hyper::{Method, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::pki_types::ServerName;
use rustls::ClientConfig;
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use thiserror::Error;
use tokio::task::JoinHandle;
use tokio::time::{timeout_at, Instant};
use url::Url;

/// The most redirects a request follows, as the spike measured GitHub's
/// release downloads need (S7: three hops) and Blossom's one (S6).
pub const MAX_REDIRECTS: usize = 3;

/// The only host that gets a User-Agent, and the one it gets: fixed and
/// the same for every version, so it tells Cloudflare only what the path
/// already does (R-20, decision 15).
const TRINO_HOST: &str = "trinochat.org";
const TRINO_USER_AGENT: &str = "Trino";

/// Why a request failed. Short and fixed: never the address, nor what the
/// server said. The text is what the app shows as a server's reason.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum HttpError {
    /// Tor is not ready: never a reason to go direct (design §2.4).
    #[error("Tor is not ready yet")]
    TorNotReady,
    #[error("not allowed without Tor")]
    NotPermitted,
    /// Not an http:// or https:// address with a host, or one with a user
    /// or a password in it.
    #[error("not a web address")]
    BadUrl,
    #[error("connect")]
    Connect,
    #[error("timeout")]
    Timeout,
    /// The TLS handshake failed: most often a certificate that does not
    /// check out.
    #[error("tls")]
    Tls,
    /// The connection broke, or the answer was not HTTP.
    #[error("network")]
    Network,
    #[error("the answer is larger than {max} bytes")]
    TooLarge { max: usize },
    /// A redirect the request's policy does not allow, or one too many.
    #[error("redirect refused")]
    Redirect,
}

impl From<NetError> for HttpError {
    fn from(error: NetError) -> Self {
        match error {
            NetError::TorNotReady => HttpError::TorNotReady,
            NetError::NotPermitted => HttpError::NotPermitted,
            NetError::BadUrl => HttpError::BadUrl,
            NetError::Connect(_) => HttpError::Connect,
            NetError::Handshake(_) => HttpError::Network,
        }
    }
}

/// How long a request waits: to connect (TLS included), for the whole
/// exchange (every redirect and the reading of the body included) and, if
/// given, for each read: the head from when the request goes out, then
/// each piece of the body. So it bounds sending a body too, and an upload
/// must not have one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deadlines {
    pub connect: Duration,
    pub total: Duration,
    pub idle: Option<Duration>,
}

/// A host a redirect may go to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostRule {
    /// This name only.
    Exact(&'static str),
    /// This name and every name under it: `Under("primal.net")` takes
    /// `primal.net` and `r2a.primal.net`, never `evilprimal.net`.
    Under(&'static str),
}

impl HostRule {
    pub fn allows(self, host: &str) -> bool {
        match self {
            HostRule::Exact(name) => host == name,
            HostRule::Under(name) => {
                host == name
                    || host
                        .strip_suffix(name)
                        .is_some_and(|rest| rest.ends_with('.'))
            }
        }
    }
}

/// Where a GET may be redirected: https:// only, to these hosts, at most
/// `MAX_REDIRECTS` times.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RedirectPolicy {
    hosts: &'static [HostRule],
}

impl RedirectPolicy {
    pub const fn to(hosts: &'static [HostRule]) -> Self {
        RedirectPolicy { hosts }
    }

    /// Whether a redirect may go to `host` (over https).
    pub fn allows_host(&self, host: &str) -> bool {
        self.hosts.iter().any(|rule| rule.allows(host))
    }

    fn allows(&self, url: &Url) -> bool {
        url.scheme() == "https" && url.host_str().is_some_and(|host| self.allows_host(host))
    }
}

/// One request: a method, an http:// or https:// address, headers and a
/// body.
#[derive(Clone, Debug)]
pub struct Request {
    method: Method,
    url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Bytes,
    redirects: Option<RedirectPolicy>,
}

impl Request {
    pub fn get(url: &str) -> Result<Self, HttpError> {
        Request::new(Method::GET, url)
    }

    pub fn put(url: &str) -> Result<Self, HttpError> {
        Request::new(Method::PUT, url)
    }

    pub fn post(url: &str) -> Result<Self, HttpError> {
        Request::new(Method::POST, url)
    }

    fn new(method: Method, url: &str) -> Result<Self, HttpError> {
        let url = Url::parse(url).map_err(|_| HttpError::BadUrl)?;
        let has_host = url.host_str().is_some_and(|host| !host.is_empty());
        let credentials = !url.username().is_empty() || url.password().is_some();
        if !matches!(url.scheme(), "http" | "https") || !has_host || credentials {
            return Err(HttpError::BadUrl);
        }
        Ok(Request {
            method,
            url,
            headers: Vec::new(),
            body: Bytes::new(),
            redirects: None,
        })
    }

    /// Add the header `name` (lower case). `Host`, `Connection` and
    /// `User-Agent` belong to the client and are ignored here.
    pub fn header(mut self, name: &'static str, value: &str) -> Result<Self, HttpError> {
        let name = HeaderName::from_static(name);
        if [header::HOST, header::CONNECTION, header::USER_AGENT].contains(&name) {
            return Ok(self);
        }
        let value = HeaderValue::from_str(value).map_err(|_| HttpError::BadUrl)?;
        self.headers.push((name, value));
        Ok(self)
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = body.into();
        self
    }

    /// Follow redirects, a GET only, where `policy` allows.
    pub fn follow(mut self, policy: RedirectPolicy) -> Self {
        self.redirects = Some(policy);
        self
    }

    /// The same request at `next`, as a redirect asks: a GET with no body,
    /// and without its `Authorization` if `next` is another host.
    fn redirected(&self, next: Url) -> Request {
        let same_host = next.host_str() == self.url.host_str();
        Request {
            method: Method::GET,
            headers: self
                .headers
                .iter()
                .filter(|(name, _)| same_host || *name != header::AUTHORIZATION)
                .cloned()
                .collect(),
            body: Bytes::new(),
            redirects: self.redirects,
            url: next,
        }
    }

    /// The host as the transport and TLS take it: an IPv6 literal without
    /// its brackets.
    fn host(&self) -> &str {
        let host = self.url.host_str().unwrap_or_default();
        host.trim_start_matches('[').trim_end_matches(']')
    }

    /// The `Host` header: the name, and the port when it is not the
    /// scheme's.
    fn host_header(&self) -> String {
        let host = self.url.host_str().unwrap_or_default();
        match self.url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        }
    }

    /// The path and the query, as the request line carries them.
    fn path(&self) -> String {
        match self.url.query() {
            Some(query) => format!("{}?{query}", self.url.path()),
            None => self.url.path().to_string(),
        }
    }
}

/// The app's HTTP client, over a `Net`. Cheap to clone.
#[derive(Clone)]
pub struct HttpClient {
    net: Arc<Net>,
    tls: Arc<ClientConfig>,
    /// The updater's permit (§2.8, §6.5): every request goes direct, and
    /// only to the updater's hosts on 443 (`Net::connect_for_update`).
    updater: Option<Arc<DirectPermit>>,
}

impl HttpClient {
    /// https:// checked against the web's roots (webpki-roots), with ring.
    pub fn new(net: Arc<Net>) -> Self {
        HttpClient {
            net,
            tls: Arc::clone(&TLS),
            updater: None,
        }
    }

    /// https:// checked against `tls` instead: the test CA of mock_http.rs.
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_tls(net: Arc<Net>, tls: Arc<ClientConfig>) -> Self {
        HttpClient {
            net,
            tls,
            updater: None,
        }
    }

    /// The updater's client without Tor (§2.8, §6.5, R-15): "Buscar la
    /// versión nueva sin Tor…" on the "old version" screen, after its
    /// confirmation. It takes only the updater's permit, and only while
    /// Arti is obsolete (`NetStatus::Obsolete`, confirmed or not); then
    /// every request goes direct, to trinochat.org and GitHub's release
    /// hosts on 443 only, and anything else is `NotPermitted` before a
    /// connection is made. It never waits for Tor, and it changes the mode
    /// of nothing else: relays, WebSockets and every other client stay on
    /// Tor, or nowhere.
    pub fn for_update(net: Arc<Net>, permit: DirectPermit) -> Result<Self, HttpError> {
        HttpClient::for_update_inner(net, permit, Arc::clone(&TLS))
    }

    /// `for_update`, with https:// checked against `tls`.
    #[cfg(any(test, feature = "test-util"))]
    pub fn for_update_with_tls(
        net: Arc<Net>,
        permit: DirectPermit,
        tls: Arc<ClientConfig>,
    ) -> Result<Self, HttpError> {
        HttpClient::for_update_inner(net, permit, tls)
    }

    fn for_update_inner(
        net: Arc<Net>,
        permit: DirectPermit,
        tls: Arc<ClientConfig>,
    ) -> Result<Self, HttpError> {
        let obsolete = matches!(net.status_now(), NetStatus::Obsolete { .. });
        if !permit.is_for_updater() || !obsolete {
            return Err(HttpError::NotPermitted);
        }
        Ok(HttpClient {
            net,
            tls,
            updater: Some(Arc::new(permit)),
        })
    }

    /// Whether this is the updater's client without Tor (`for_update`).
    pub fn is_for_update(&self) -> bool {
        self.updater.is_some()
    }

    /// The `Net` it goes through: its mode decides whether a check that
    /// can wait for Tor runs at all (news.rs).
    pub fn net(&self) -> &Net {
        &self.net
    }

    /// Send `request` through `Net`, isolated by `iso`, within `deadlines`;
    /// with its policy, follow its redirects on the same token. The answer
    /// is the head; read the body with `Response::read_capped`.
    pub async fn send(
        &self,
        request: Request,
        iso: &Iso,
        deadlines: Deadlines,
    ) -> Result<Response, HttpError> {
        // A starting Tor is waited for, and the deadlines count from when
        // it is ready (design §2.4, §3.1); with none, `TorNotReady` at once.
        // The updater's permit has no Tor to wait for: Arti is obsolete.
        if self.updater.is_none() {
            self.net.ready(crate::READY_WAIT).await?;
        }
        let deadline = Instant::now() + deadlines.total;
        let mut request = request;
        let mut redirects = 0;
        loop {
            let response = self.exchange(&request, iso, &deadlines, deadline).await?;
            let Some(policy) = request.redirects else {
                return Ok(response);
            };
            if request.method != Method::GET || !is_redirect(response.status) {
                return Ok(response);
            }
            let next = response
                .header("location")
                .and_then(|location| request.url.join(location).ok())
                .ok_or(HttpError::Redirect)?;
            if redirects == MAX_REDIRECTS || !policy.allows(&next) {
                return Err(HttpError::Redirect);
            }
            redirects += 1;
            request = request.redirected(next);
        }
    }

    /// One request on one connection of its own.
    async fn exchange(
        &self,
        request: &Request,
        iso: &Iso,
        deadlines: &Deadlines,
        deadline: Instant,
    ) -> Result<Response, HttpError> {
        let connect_by = deadline.min(Instant::now() + deadlines.connect);
        let io = timeout_at(connect_by, self.connect(request, iso))
            .await
            .map_err(|_| HttpError::Timeout)??;

        let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
            .await
            .map_err(|_| HttpError::Network)?;
        // Drives the connection until the answer is read; aborted with the
        // `Response`, so nothing is left open behind it.
        let driver = AbortOnDrop(tokio::spawn(async move {
            let _ = connection.await;
        }));

        let mut outgoing = hyper::Request::builder()
            .method(request.method.clone())
            .uri(request.path())
            .header(header::HOST, request.host_header())
            .header(header::CONNECTION, "close");
        if request.host() == TRINO_HOST {
            outgoing = outgoing.header(header::USER_AGENT, TRINO_USER_AGENT);
        }
        for (name, value) in &request.headers {
            outgoing = outgoing.header(name, value);
        }
        let outgoing = outgoing
            .body(Full::new(request.body.clone()))
            .map_err(|_| HttpError::BadUrl)?;

        let head_by = read_by(deadline, deadlines.idle);
        let answer = timeout_at(head_by, sender.send_request(outgoing))
            .await
            .map_err(|_| HttpError::Timeout)?
            .map_err(|_| HttpError::Network)?;
        let (head, body) = answer.into_parts();
        // The app's network time (P1 §3.5): only the value, and only that.
        if let Some(date) = head
            .headers
            .get(header::DATE)
            .and_then(|value| value.to_str().ok())
        {
            self.net.saw_date(date);
        }
        Ok(Response {
            status: head.status,
            headers: head.headers,
            body,
            deadline,
            idle: deadlines.idle,
            _driver: driver,
        })
    }

    /// A connection to the request's host, with TLS for https://.
    async fn connect(&self, request: &Request, iso: &Iso) -> Result<BoxedIo, HttpError> {
        let port = request
            .url
            .port_or_known_default()
            .ok_or(HttpError::BadUrl)?;
        let target = Target::new(request.host(), port);
        let io = match &self.updater {
            Some(permit) => self.net.connect_for_update(permit, &target).await?,
            None => self.net.connect(&target, iso).await?,
        };
        if request.url.scheme() != "https" {
            return Ok(io);
        }
        let name =
            ServerName::try_from(request.host().to_string()).map_err(|_| HttpError::BadUrl)?;
        let tls = tokio_rustls::TlsConnector::from(Arc::clone(&self.tls))
            .connect(name, io)
            .await
            .map_err(|_| HttpError::Tls)?;
        Ok(Box::new(tls))
    }
}

/// A status a redirect policy follows (not 304, which is no redirect).
fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

/// When the next read must have come: the idle deadline from now, if any,
/// and never past the whole exchange's.
fn read_by(deadline: Instant, idle: Option<Duration>) -> Instant {
    match idle {
        Some(idle) => deadline.min(Instant::now() + idle),
        None => deadline,
    }
}

/// The head of an answer, and its body to read.
pub struct Response {
    status: StatusCode,
    headers: HeaderMap,
    body: Incoming,
    deadline: Instant,
    idle: Option<Duration>,
    _driver: AbortOnDrop,
}

impl Response {
    pub fn status(&self) -> u16 {
        self.status.as_u16()
    }

    /// The header `name`, if it is there and is visible ASCII.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name)?.to_str().ok()
    }

    /// The body, refused as soon as it passes `max` bytes: before reading
    /// anything when the server says it is larger, and otherwise once the
    /// bytes read go past it.
    pub async fn read_capped(&mut self, max: usize) -> Result<Vec<u8>, HttpError> {
        let mut body = Vec::new();
        self.read_capped_into(max, &mut body).await?;
        Ok(body)
    }

    /// `read_capped`, into `out`: a caller that must wipe the body hands in
    /// a buffer it wipes, allocated to `max` so growing it leaves no copy.
    pub async fn read_capped_into(
        &mut self,
        max: usize,
        out: &mut Vec<u8>,
    ) -> Result<(), HttpError> {
        let too_large = HttpError::TooLarge { max };
        let length = self
            .header("content-length")
            .and_then(|length| length.parse::<u64>().ok());
        if length.is_some_and(|length| length > max as u64) {
            return Err(too_large);
        }
        loop {
            let next = timeout_at(read_by(self.deadline, self.idle), self.body.frame())
                .await
                .map_err(|_| HttpError::Timeout)?;
            let Some(frame) = next else {
                return Ok(());
            };
            let frame = frame.map_err(|_| HttpError::Network)?;
            if let Ok(data) = frame.into_data() {
                if out.len() + data.len() > max {
                    return Err(too_large);
                }
                out.extend_from_slice(&data);
            }
        }
    }
}

/// Aborts its task when dropped.
struct AbortOnDrop(JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// The TLS of https://: the web's roots, TLS 1.2 and 1.3, ring, HTTP/1.1.
static TLS: LazyLock<Arc<ClientConfig>> = LazyLock::new(|| {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Arc::new(config)
});
