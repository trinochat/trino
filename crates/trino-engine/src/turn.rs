//! TURN credentials for protected calls (relay only, Cloudflare).
//!
//! Trino's credential Worker hands out short-lived Cloudflare TURN servers to
//! a NIP-98 request with NIP-13 proof of work. Why, the contract and the
//! limits: docs/llamadas-turn.md.
//!
//! With Tor (design §3 T1, decision 18): each call signs its request with a
//! key made for it alone, never the account's, sends it through Tor on a
//! token of its own, and gets credentials of its own. Nothing is kept from
//! one call for the next, so Cloudflare can tie neither two calls nor a
//! call and the account by the key or by the exit. The UI names the call
//! (its `callId`), so a renewal within it signs with that call's key and
//! goes on its token, while the credentials are asked afresh.

use crate::command_error::{CommandError, ErrorCode};
use crate::crypto::sha256;
use crate::nostr::build_and_sign_event;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::watch;
use trino_net::{Deadlines, HttpClient, HttpError, Iso, IsoKind, Net, Request, Response};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// The only endpoint production talks to; tests point a `TurnClient` elsewhere.
pub const TURN_ENDPOINT: &str = "https://trinochat.org/api/v1/turn/credentials";
/// The body the Worker expects, byte for byte: its sha256 is signed.
const REQUEST_BODY: &str = r#"{"v":1}"#;
const NIP98_KIND: u32 = 27235;
/// NIP-13 difficulty; equal to the Worker's `POW_BITS` (trino-infra/turn).
const POW_BITS: u32 = 20;
/// About 67 million hashes: at 20 bits, running out is a 1 in e^64 event.
const MAX_POW_ATTEMPTS: u64 = 1 << 26;
/// How many hashes the miner tries between looks at its stop flag.
const STOP_CHECK_INTERVAL: u64 = 1 << 12;
/// To reach the Worker and have its answer (Tor design §3.1). Through Tor
/// the spike measured a GET to trinochat.org on a fresh circuit at 1.6-5.3 s
/// and a first stream up to 13 s (S3, S6): 30 s leaves twice that. The proof
/// of work is mined before, so the event is at most ~31 s old when it
/// arrives, within the 60 s the Worker accepts.
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
/// The Worker accepts `created_at` within 60 s; past this, a 401 is our clock.
const CLOCK_TOLERANCE_SECS: i64 = 30;
const TURN_HOST: &str = "turn.cloudflare.com";
const MAX_SERVERS: usize = 4;
const MAX_URLS: usize = 8;
const MAX_URL_LEN: usize = 256;
const MAX_FIELD_LEN: usize = 512;
const MAX_TTL_SECS: i64 = 86_400;
/// Stands for the NIP-13 counter while mining; never sent.
const NONCE_PLACEHOLDER: &str = "__trino_nonce__";

/// The Nostr keys that sign a request: made for one call alone
/// (`one_time`), never the account's (decision 18).
pub struct SigningKeys {
    pub priv_bytes: Zeroizing<[u8; 32]>,
    pub pub_bytes: [u8; 32],
}

impl SigningKeys {
    /// A key of its own, for one call. The Worker takes any key with the
    /// proof of work (trino-infra turn/README.md), so this needs no change
    /// there; its per-key limits stop being per person, and the proof of
    /// work and the global cap remain.
    pub fn one_time() -> Self {
        let secp = secp256k1::Secp256k1::new();
        let pair = secp256k1::Keypair::new(&secp, &mut rand::thread_rng());
        SigningKeys {
            priv_bytes: Zeroizing::new(pair.secret_bytes()),
            pub_bytes: pair.x_only_public_key().0.serialize(),
        }
    }
}

/// One TURN server, as `RTCPeerConnection` takes it. Wiped when dropped.
#[derive(Clone, PartialEq, Eq, Serialize, Zeroize, ZeroizeOnDrop)]
pub struct TurnServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

impl std::fmt::Debug for TurnServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TurnServer")
            .field("urls", &self.urls)
            .field("username", &self.username)
            .field("credential", &"<redacted>")
            .finish()
    }
}

/// What `get_turn_servers` returns: the servers and when they expire (unix s).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TurnServers {
    pub ice_servers: Vec<TurnServer>,
    pub expires_at: i64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TurnError {
    #[error("the vault is locked")]
    Locked,
    #[error("could not sign the request: {0}")]
    Signing(String),
    #[error("no proof of work found within the attempt cap")]
    ProofOfWork,
    #[error("network error: {0}")]
    Network(String),
    #[error("the credential service refused the request: {status} {code}")]
    Refused { status: u16, code: String },
    #[error("rate limited (retry after {retry_after:?} s)")]
    RateLimited { retry_after: Option<u64> },
    #[error("the credential service is disabled")]
    Disabled,
    #[error("the credential service could not reach Cloudflare")]
    Upstream,
    #[error("invalid response: {0}")]
    InvalidResponse(&'static str),
    #[error("the local clock is {offset} s off the credential service's")]
    ClockSkew { offset: i64 },
    /// Tor is still connecting. Never a reason to offer a direct call (R-11).
    #[error("Tor is not ready yet")]
    TorNotReady,
}

/// The UI only needs to know that protection failed; the message is for the log.
impl From<TurnError> for CommandError {
    fn from(error: TurnError) -> Self {
        let code = match &error {
            TurnError::Locked => ErrorCode::NoVault,
            TurnError::Network(_)
            | TurnError::Refused { .. }
            | TurnError::RateLimited { .. }
            | TurnError::Disabled
            | TurnError::Upstream
            | TurnError::ClockSkew { .. } => ErrorCode::Io,
            TurnError::Signing(_) | TurnError::ProofOfWork | TurnError::InvalidResponse(_) => {
                ErrorCode::Internal
            }
            TurnError::TorNotReady => ErrorCode::TorNotReady,
        };
        CommandError::new(code, format!("turn: {error}"))
    }
}

/// Leading zero bits of an event id (NIP-13 difficulty).
fn leading_zero_bits(id: &[u8; 32]) -> u32 {
    let mut bits = 0;
    for byte in id {
        if *byte != 0 {
            return bits + byte.leading_zeros();
        }
        bits += 8;
    }
    bits
}

/// Whether an event id has the `bits` of NIP-13 difficulty it commits to.
fn meets_difficulty(id: &[u8; 32], bits: u32) -> bool {
    leading_zero_bits(id) >= bits
}

fn nonce_tag(counter: &str, bits: u32) -> Vec<String> {
    vec!["nonce".to_string(), counter.to_string(), bits.to_string()]
}

/// Find a NIP-13 counter that gives the event id `bits` leading zero bits.
/// Only the NIP-01 serialization is hashed; nothing is signed until it is found.
/// Once `stop` is set, gives up within `STOP_CHECK_INTERVAL` hashes.
fn mine_nonce(
    pubkey: &str,
    created_at: i64,
    base_tags: &[Vec<String>],
    bits: u32,
    max_attempts: u64,
    stop: &AtomicBool,
) -> Result<u64, TurnError> {
    let mut tags = base_tags.to_vec();
    tags.push(nonce_tag(NONCE_PLACEHOLDER, bits));
    // The same serialization `build_and_sign_event` hashes.
    let template = serde_json::json!([0, pubkey, created_at, NIP98_KIND, tags, ""]).to_string();
    let (prefix, suffix) = template
        .split_once(NONCE_PLACEHOLDER)
        .ok_or_else(|| TurnError::Signing("nonce placeholder missing".to_string()))?;
    let mut midstate = Sha256::new();
    midstate.update(prefix.as_bytes());
    for counter in 0..max_attempts {
        if counter % STOP_CHECK_INTERVAL == 0 && stop.load(Ordering::Relaxed) {
            // Only a dropped request sets it, and nobody reads this result.
            return Err(TurnError::Locked);
        }
        let mut hasher = midstate.clone();
        hasher.update(counter.to_string().as_bytes());
        hasher.update(suffix.as_bytes());
        let id: [u8; 32] = hasher.finalize().into();
        if meets_difficulty(&id, bits) {
            return Ok(counter);
        }
    }
    Err(TurnError::ProofOfWork)
}

/// The `Authorization` header for one credentials request: a NIP-98 event
/// (kind 27235) for `TURN_ENDPOINT`, with proof of work, in base64.
fn authorization(
    keys: &SigningKeys,
    created_at: i64,
    bits: u32,
    max_attempts: u64,
    stop: &AtomicBool,
) -> Result<String, TurnError> {
    let pubkey = hex::encode(keys.pub_bytes);
    let mut tags = vec![
        vec!["u".to_string(), TURN_ENDPOINT.to_string()],
        vec!["method".to_string(), "POST".to_string()],
        vec![
            "payload".to_string(),
            hex::encode(sha256(REQUEST_BODY.as_bytes())),
        ],
    ];
    let counter = mine_nonce(&pubkey, created_at, &tags, bits, max_attempts, stop)?;
    tags.push(nonce_tag(&counter.to_string(), bits));
    let event = build_and_sign_event(
        &keys.priv_bytes,
        &keys.pub_bytes,
        NIP98_KIND,
        "",
        tags,
        Some(created_at),
    )
    .map_err(|e| TurnError::Signing(e.to_string()))?;
    let id: [u8; 32] = hex::decode(&event.id)
        .ok()
        .and_then(|id| id.try_into().ok())
        .ok_or_else(|| TurnError::Signing("malformed event id".to_string()))?;
    if !meets_difficulty(&id, bits) {
        return Err(TurnError::Signing("proof of work mismatch".to_string()));
    }
    let json = serde_json::to_string(&event).map_err(|e| TurnError::Signing(e.to_string()))?;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD.encode(json)
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCredentials {
    ice_servers: Vec<WireServer>,
    ttl: i64,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireServer {
    urls: Vec<String>,
    username: String,
    credential: String,
}

/// Port of a TURN URL: decimal, no leading zero, never 53 (browsers refuse it).
fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|b| b.is_ascii_digit())
        && matches!(port.parse::<u16>(), Ok(n) if n != 53)
}

/// `turn:` or `turns:` on exactly `turn.cloudflare.com`, an optional port and
/// an optional `?transport=udp|tcp`. Anything else (STUN, another host,
/// userinfo, IP literals, paths) is refused.
fn is_cloudflare_turn_url(url: &str) -> bool {
    if url.len() > MAX_URL_LEN {
        return false;
    }
    let Some(rest) = url
        .strip_prefix("turn:")
        .or_else(|| url.strip_prefix("turns:"))
    else {
        return false;
    };
    let (authority, query) = match rest.split_once('?') {
        Some((authority, query)) => (authority, Some(query)),
        None => (rest, None),
    };
    if !matches!(query, None | Some("transport=udp" | "transport=tcp")) {
        return false;
    }
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    host == TURN_HOST && port.is_none_or(valid_port)
}

fn valid_field(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_FIELD_LEN && !value.chars().any(char::is_control)
}

/// Validate the Worker's 200 response. Any server that is not Cloudflare
/// TURN with credentials rejects the whole answer: the call then asks before
/// going direct, rather than trusting a broken or tampered Worker.
///
/// `expiresAt` is judged against `server_now`, the Worker's `Date`, and the
/// result is given in local time (`now`), so a skewed local clock neither
/// rejects good credentials nor keeps them too long. Without a `Date`, the
/// ttl alone counts.
fn parse_credentials(
    body: &[u8],
    now: i64,
    server_now: Option<i64>,
) -> Result<TurnServers, TurnError> {
    let wire: WireCredentials = serde_json::from_slice(body)
        .map_err(|_| TurnError::InvalidResponse("not the expected JSON"))?;
    if wire.ice_servers.is_empty() || wire.ice_servers.len() > MAX_SERVERS {
        return Err(TurnError::InvalidResponse("wrong number of servers"));
    }
    if !(1..=MAX_TTL_SECS).contains(&wire.ttl) {
        return Err(TurnError::InvalidResponse("ttl out of range"));
    }
    let lifetime = match server_now {
        Some(server_now) => wire.expires_at.saturating_sub(server_now).min(wire.ttl),
        None => wire.ttl,
    };
    if lifetime <= 0 {
        return Err(TurnError::InvalidResponse("the credentials have expired"));
    }
    let mut ice_servers = Vec::with_capacity(wire.ice_servers.len());
    for server in wire.ice_servers {
        if server.urls.is_empty() || server.urls.len() > MAX_URLS {
            return Err(TurnError::InvalidResponse("wrong number of URLs"));
        }
        if !server.urls.iter().all(|url| is_cloudflare_turn_url(url)) {
            return Err(TurnError::InvalidResponse("a URL is not Cloudflare TURN"));
        }
        if !valid_field(&server.username) || !valid_field(&server.credential) {
            return Err(TurnError::InvalidResponse("bad username or credential"));
        }
        ice_servers.push(TurnServer {
            urls: server.urls,
            username: server.username,
            credential: server.credential,
        });
    }
    Ok(TurnServers {
        ice_servers,
        expires_at: now + lifetime,
    })
}

/// An HTTP `Date` header (IMF-fixdate is RFC 2822 with `GMT`) in unix seconds.
fn http_date(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|date| date.timestamp())
}

/// The Worker's `{"error":"<code>"}`, kept only if it is a plain snake_case code.
fn error_code(body: &[u8]) -> String {
    #[derive(Deserialize)]
    struct WireError {
        error: String,
    }
    serde_json::from_slice::<WireError>(body)
        .map(|wire| wire.error)
        .ok()
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 32
                && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
        .unwrap_or_default()
}

fn network(error: HttpError) -> TurnError {
    match error {
        HttpError::TorNotReady => TurnError::TorNotReady,
        other => TurnError::Network(other.to_string()),
    }
}

/// The body, wiped when dropped: a 200 carries the credential.
async fn read_capped(response: &mut Response) -> Result<Zeroizing<Vec<u8>>, TurnError> {
    // Allocated once, so growing it leaves no unwiped copy behind. hyper's
    // own buffers are not ours to wipe, as reqwest's were not.
    let mut body = Zeroizing::new(Vec::with_capacity(MAX_RESPONSE_BYTES));
    match response
        .read_capped_into(MAX_RESPONSE_BYTES, &mut body)
        .await
    {
        Ok(()) => Ok(body),
        Err(HttpError::TooLarge { .. }) => {
            Err(TurnError::InvalidResponse("the response is too large"))
        }
        Err(other) => Err(network(other)),
    }
}

/// Where credentials are requested from, through which `Net`, and how long
/// to wait.
pub struct TurnClient {
    net: Arc<Net>,
    http: HttpClient,
    url: String,
    timeout: Duration,
}

impl TurnClient {
    pub fn production(net: Arc<Net>) -> Self {
        TurnClient {
            http: HttpClient::new(Arc::clone(&net)),
            net,
            url: TURN_ENDPOINT.to_string(),
            timeout: HTTP_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn local(net: Arc<Net>, http: HttpClient, url: String, timeout: Duration) -> Self {
        TurnClient {
            net,
            http,
            url,
            timeout,
        }
    }

    /// The token of one call: a session of its own, so it shares a Tor
    /// circuit with nothing else (design §2.7).
    fn call_iso(&self) -> Iso {
        self.net.session().iso(IsoKind::TURN, "credentials")
    }

    /// POST the request through `Net` on `iso`, the call's token;
    /// redirects are not followed and the answer is capped. `now` is the
    /// local clock when the request was signed.
    async fn request(
        &self,
        authorization: &str,
        now: i64,
        iso: &Iso,
    ) -> Result<TurnServers, TurnError> {
        let request = Request::post(&self.url)
            .and_then(|request| request.header("authorization", authorization))
            .and_then(|request| request.header("content-type", "application/json"))
            .map_err(network)?
            .body(REQUEST_BODY);
        let deadlines = Deadlines {
            connect: self.timeout,
            total: self.timeout,
            idle: None,
        };
        let mut response = self
            .http
            .send(request, iso, deadlines)
            .await
            .map_err(network)?;
        let status = response.status();
        let retry_after = response
            .header("retry-after")
            .and_then(|value| value.trim().parse::<u64>().ok());
        let server_now = response.header("date").and_then(http_date);
        let body = read_capped(&mut response).await;
        match status {
            200 => parse_credentials(&body?, now, server_now),
            401 => match server_now.map(|server_now| server_now - now) {
                Some(offset) if offset.abs() > CLOCK_TOLERANCE_SECS => {
                    Err(TurnError::ClockSkew { offset })
                }
                _ => Err(TurnError::Refused {
                    status,
                    code: body.map(|body| error_code(&body)).unwrap_or_default(),
                }),
            },
            429 => Err(TurnError::RateLimited { retry_after }),
            502 => Err(TurnError::Upstream),
            503 => Err(TurnError::Disabled),
            _ => Err(TurnError::Refused {
                status,
                code: body.map(|body| error_code(&body)).unwrap_or_default(),
            }),
        }
    }
}

/// Which unlocked session a request belongs to: taken while the identity
/// is known to be unlocked, and void once `TurnGate::clear` runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Session(u64);

/// Ties the requests for TURN credentials to the unlocked session. It keeps
/// no credentials: each call asks for its own, and each renewal asks again
/// (design §3 T1). It keeps the signer of the current call, so a renewal
/// within that call signs with its key and goes on its token. Locking or
/// wiping cancels any request in flight and forgets the signer
/// (docs/llamadas-turn.md).
pub struct TurnGate {
    /// Bumped by `clear`; wakes and voids every request of an older session.
    epoch: watch::Sender<u64>,
    /// The current call's key and token; another call replaces it.
    call: std::sync::Mutex<Option<CallSigner>>,
}

/// What signs the requests of one call: a key made for it and its token.
struct CallSigner {
    session: Session,
    call_id: String,
    keys: Arc<SigningKeys>,
    iso: Iso,
}

impl Default for TurnGate {
    fn default() -> Self {
        TurnGate {
            epoch: watch::Sender::new(0),
            call: std::sync::Mutex::new(None),
        }
    }
}

impl TurnGate {
    /// The current session. Read it while the identity is read, under the
    /// same lock that `lock_vault` and `wipe` take, so no lock slips between.
    pub fn session(&self) -> Session {
        Session(*self.epoch.borrow())
    }

    /// Void every request of the current session: one in flight returns
    /// `Locked` at once, and the call's key is dropped (and wiped).
    pub fn clear(&self) {
        self.epoch.send_modify(|epoch| *epoch += 1);
        *self.call.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// The key and token of `call_id` in `session`: the ones it had, or
    /// new ones that replace the last call's.
    fn signer(
        &self,
        session: Session,
        call_id: &str,
        client: &TurnClient,
    ) -> (Arc<SigningKeys>, Iso) {
        let mut call = self.call.lock().unwrap_or_else(PoisonError::into_inner);
        match call.as_ref() {
            Some(signer) if signer.session == session && signer.call_id == call_id => {
                (Arc::clone(&signer.keys), signer.iso.clone())
            }
            _ => {
                let signer = CallSigner {
                    session,
                    call_id: call_id.to_string(),
                    keys: Arc::new(SigningKeys::one_time()),
                    iso: client.call_iso(),
                };
                let found = (Arc::clone(&signer.keys), signer.iso.clone());
                *call = Some(signer);
                found
            }
        }
    }

    fn is_current(&self, session: Session) -> bool {
        *self.epoch.borrow() == session.0
    }

    /// Credentials from `fetch`, for `session`. A session voided by
    /// `clear`, before or during the fetch, gets `Locked`, and whatever the
    /// fetch got is dropped (and wiped).
    pub async fn request<F, Fut>(
        &self,
        session: Session,
        fetch: F,
    ) -> Result<TurnServers, TurnError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<TurnServers, TurnError>>,
    {
        if !self.is_current(session) {
            return Err(TurnError::Locked);
        }
        let mut epoch = self.epoch.subscribe();
        let servers = tokio::select! {
            servers = fetch() => servers?,
            () = voided(&mut epoch, session) => return Err(TurnError::Locked),
        };
        if !self.is_current(session) {
            return Err(TurnError::Locked);
        }
        Ok(servers)
    }
}

/// Resolves once `clear` has voided `session`.
async fn voided(epoch: &mut watch::Receiver<u64>, session: Session) {
    // The sender lives in the gate, which outlives every request.
    let _ = epoch.wait_for(|epoch| *epoch != session.0).await;
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Sets its flag when dropped: the future that owns it is gone.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// `authorization`, mined on tokio's blocking pool. Dropping the future (a
/// lock does) stops the miner, which then drops and wipes its copy of the key.
async fn mined_authorization(
    keys: &SigningKeys,
    created_at: i64,
    bits: u32,
    max_attempts: u64,
) -> Result<String, TurnError> {
    let signing = SigningKeys {
        priv_bytes: keys.priv_bytes.clone(),
        pub_bytes: keys.pub_bytes,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let _stop_on_drop = StopOnDrop(Arc::clone(&stop));
    // Mining takes about 1 s of CPU in release: keep it off the async workers.
    tokio::task::spawn_blocking(move || {
        authorization(&signing, created_at, bits, max_attempts, &stop)
    })
    .await
    .map_err(|e| TurnError::Signing(e.to_string()))?
}

/// Sign (with proof of work) and send one request, dated `created_at`, on
/// the call's token.
async fn signed_request(
    client: &TurnClient,
    keys: &SigningKeys,
    created_at: i64,
    iso: &Iso,
) -> Result<TurnServers, TurnError> {
    let header = mined_authorization(keys, created_at, POW_BITS, MAX_POW_ATTEMPTS).await?;
    client.request(&header, unix_now(), iso).await
}

/// Whether `call_id` is a call's id as call.ts makes and checks them: 16 to
/// 64 letters, digits, `_` or `-`.
pub fn valid_call_id(call_id: &str) -> bool {
    (16..=64).contains(&call_id.len())
        && call_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// TURN servers for the call `call_id`: signed with a key made for that
/// call, mined, and fetched on its token; a renewal within the call uses
/// the same key and token, and asks afresh. The key is dropped (and
/// wiped) when another call or a lock replaces it.
pub async fn turn_servers(
    gate: &TurnGate,
    client: &TurnClient,
    session: Session,
    call_id: &str,
) -> Result<TurnServers, TurnError> {
    let (keys, iso) = gate.signer(session, call_id, client);
    gate.request(session, move || async move {
        match signed_request(client, &keys, unix_now(), &iso).await {
            // A skewed clock: sign once more, dated by the Worker's clock,
            // still as the same call.
            Err(TurnError::ClockSkew { offset }) => {
                signed_request(client, &keys, unix_now() + offset, &iso).await
            }
            result => result,
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::crypto::sha256;
    use crate::nostr::{verify_event, NostrEvent};
    use base64::Engine;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Instant;
    use trino_net::mock::{Forbidden, Mock};
    use trino_net::mock_http::{self, Received, Reply};
    use trino_net::Transport;

    /// Two calls, as call.ts names them (32 hex digits).
    const CALL_A: &str = "0123456789abcdef0123456789abcdef";
    const CALL_B: &str = "fedcba9876543210fedcba9876543210";

    // A fixed throwaway key, never a real identity.
    const TEST_PRIV: [u8; 32] = [7u8; 32];

    fn test_keys() -> SigningKeys {
        let secp = secp256k1::Secp256k1::new();
        let pair = secp256k1::Keypair::from_seckey_slice(&secp, &TEST_PRIV).unwrap();
        SigningKeys {
            priv_bytes: Zeroizing::new(TEST_PRIV),
            pub_bytes: pair.x_only_public_key().0.serialize(),
        }
    }

    fn now() -> i64 {
        chrono::Utc::now().timestamp()
    }

    fn decode_auth(header: &str) -> NostrEvent {
        let b64 = header
            .strip_prefix("Nostr ")
            .expect("the Nostr auth scheme");
        let json = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("standard base64");
        serde_json::from_slice(&json).expect("an event")
    }

    fn tag<'a>(event: &'a NostrEvent, name: &str) -> &'a [String] {
        event
            .tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))
            .map(|t| &t[1..])
            .unwrap_or_else(|| panic!("missing tag {name}"))
    }

    fn cloudflare_servers() -> serde_json::Value {
        json!([{
            "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:443?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turn:turn.cloudflare.com:80?transport=tcp",
                "turns:turn.cloudflare.com:5349?transport=tcp",
                "turns:turn.cloudflare.com:443?transport=tcp"
            ],
            "username": "u-test",
            "credential": "c-test"
        }])
    }

    fn worker_body(servers: serde_json::Value, ttl: i64, expires_at: i64) -> String {
        json!({ "iceServers": servers, "ttl": ttl, "expiresAt": expires_at }).to_string()
    }

    fn parse_value(body: serde_json::Value) -> Result<TurnServers, TurnError> {
        parse_credentials(body.to_string().as_bytes(), now(), Some(now()))
    }

    fn sample(expires_at: i64) -> TurnServers {
        TurnServers {
            ice_servers: vec![TurnServer {
                urls: vec!["turn:turn.cloudflare.com:3478?transport=udp".to_string()],
                username: "user".to_string(),
                credential: "secret-credential".to_string(),
            }],
            expires_at,
        }
    }

    // ── NIP-98 + NIP-13 ─────────────────────────────────────────────────────

    #[test]
    fn counts_the_leading_zero_bits_of_an_event_id() {
        let mut id = [0u8; 32];
        assert_eq!(leading_zero_bits(&id), 256);
        id[0] = 0x80;
        assert_eq!(leading_zero_bits(&id), 0);
        id[0] = 0x00;
        id[1] = 0x01;
        assert_eq!(leading_zero_bits(&id), 15);
        id[1] = 0x00;
        id[2] = 0x7f;
        assert_eq!(leading_zero_bits(&id), 17);
    }

    #[test]
    fn the_request_is_a_signed_nip98_event_with_proof_of_work() {
        let created_at = now();
        let never = AtomicBool::new(false);
        let header =
            authorization(&test_keys(), created_at, POW_BITS, MAX_POW_ATTEMPTS, &never).unwrap();
        let event = decode_auth(&header);
        assert!(
            verify_event(&event),
            "the id and BIP-340 signature must verify"
        );
        assert_eq!(event.kind, 27235);
        assert_eq!(event.pubkey, hex::encode(test_keys().pub_bytes));
        assert_eq!(event.created_at, created_at);
        assert_eq!(event.content, "");
        assert_eq!(event.tags.len(), 4);
        assert_eq!(tag(&event, "u"), [TURN_ENDPOINT]);
        assert_eq!(tag(&event, "method"), ["POST"]);
        assert_eq!(tag(&event, "payload"), [hex::encode(sha256(br#"{"v":1}"#))]);
        let nonce = tag(&event, "nonce");
        assert_eq!(nonce.len(), 2);
        assert!(nonce[0].parse::<u64>().is_ok(), "the counter is decimal");
        // The Worker's POW_BITS (trino-infra/turn) must be 20 as well.
        assert_eq!(nonce[1], "20", "it commits to 20 bits");
        let id: [u8; 32] = hex::decode(&event.id).unwrap().try_into().unwrap();
        assert!(
            leading_zero_bits(&id) >= 20,
            "the id has {} leading zero bits",
            leading_zero_bits(&id)
        );
    }

    #[test]
    fn an_id_with_19_zero_bits_is_not_enough() {
        let mut id = [0xffu8; 32];
        id[0] = 0x00;
        id[1] = 0x00;
        id[2] = 0x10;
        assert_eq!(leading_zero_bits(&id), 19);
        assert!(!meets_difficulty(&id, POW_BITS));
        id[2] = 0x08;
        assert_eq!(leading_zero_bits(&id), 20);
        assert!(meets_difficulty(&id, POW_BITS));
    }

    #[test]
    fn the_attempt_cap_almost_never_runs_out() {
        // Each attempt succeeds with probability 2^-bits.
        let expected_attempts = f64::from(POW_BITS).exp2();
        let chance_of_running_out = (-(MAX_POW_ATTEMPTS as f64) / expected_attempts).exp();
        assert!(
            chance_of_running_out < 1e-24,
            "{chance_of_running_out:e} of mining in vain"
        );
    }

    #[test]
    fn dropping_a_request_stops_its_mining_thread() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            // 256 bits are never found: it mines until something stops it.
            let keys = test_keys();
            let mining = mined_authorization(&keys, now(), 256, u64::MAX);
            let dropped = tokio::time::timeout(Duration::from_millis(100), mining).await;
            assert!(dropped.is_err(), "still mining when dropped");
        });
        // Waits for the blocking pool, so for the miner, up to 5 s.
        let started = Instant::now();
        runtime.shutdown_timeout(Duration::from_secs(5));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the miner kept running (and kept a copy of the key) after the drop"
        );
    }

    /// What a user waits for before a protected call: mining and signing at
    /// `POW_BITS`, 20 times. Only release numbers mean anything:
    /// `cargo test --release -p trino-engine --lib turn::tests::mining_time -- --ignored --nocapture`
    #[test]
    #[ignore = "a measurement, not a check"]
    fn mining_time() {
        const RUNS: i64 = 20;
        let keys = test_keys();
        let never = AtomicBool::new(false);
        let first = now();
        let mut times = Vec::new();
        let mut hashes = 0u64;
        for run in 0..RUNS {
            // A different event each run, so a different search.
            let started = Instant::now();
            let header =
                authorization(&keys, first + run, POW_BITS, MAX_POW_ATTEMPTS, &never).unwrap();
            times.push(started.elapsed().as_secs_f64());
            let counter: u64 = tag(&decode_auth(&header), "nonce")[0].parse().unwrap();
            hashes += counter + 1;
        }
        let total: f64 = times.iter().sum();
        let rate = hashes as f64 / total;
        times.sort_by(f64::total_cmp);
        let mid = times.len() / 2; // RUNS is even
        println!(
            "{RUNS} runs at {POW_BITS} bits: mean {:.3} s, median {:.3} s, min {:.3} s, max {:.3} s; \
             {:.2} M hashes/s, so {:.3} s expected for 2^{POW_BITS} hashes",
            total / RUNS as f64,
            (times[mid - 1] + times[mid]) / 2.0,
            times[0],
            times[times.len() - 1],
            rate / 1e6,
            f64::from(POW_BITS).exp2() / rate,
        );
    }

    #[test]
    fn mining_gives_up_after_its_attempt_cap() {
        assert_eq!(
            authorization(&test_keys(), now(), 256, 1_000, &AtomicBool::new(false)),
            Err(TurnError::ProofOfWork)
        );
    }

    // ── response validation ─────────────────────────────────────────────────

    #[test]
    fn accepts_the_workers_turn_servers() {
        let n = now();
        let body = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let parsed = parse_credentials(body.as_bytes(), n, Some(n)).unwrap();
        assert_eq!(parsed.ice_servers.len(), 1);
        assert_eq!(parsed.ice_servers[0].urls.len(), 6);
        assert_eq!(parsed.ice_servers[0].username, "u-test");
        assert_eq!(parsed.ice_servers[0].credential, "c-test");
        assert_eq!(parsed.expires_at, n + 14_400);
    }

    #[test]
    fn accepts_turn_urls_without_a_port_or_a_transport() {
        let n = now();
        let servers = json!([{
            "urls": ["turn:turn.cloudflare.com", "turns:turn.cloudflare.com:443"],
            "username": "u",
            "credential": "c"
        }]);
        let body = worker_body(servers, 600, n + 600);
        assert!(parse_credentials(body.as_bytes(), n, Some(n)).is_ok());
    }

    #[test]
    fn rejects_any_url_that_is_not_turn_on_cloudflare() {
        let n = now();
        for url in [
            "stun:stun.cloudflare.com:3478",
            "stuns:turn.cloudflare.com:5349",
            "turn:turn.cloudflare.com:53?transport=udp",
            "turns:turn.cloudflare.com:53?transport=tcp",
            "turn:turn.cloudflare.com:053",
            "turn:turn.example.net:3478?transport=udp",
            "turn:turn.cloudflare.com.evil.net:3478",
            "turn:evil.net@turn.cloudflare.com:3478",
            "turn:TURN.cloudflare.com:3478",
            "TURN:turn.cloudflare.com:3478",
            "turn:turn.cloudflare.com:3478?transport=sctp",
            "turn:turn.cloudflare.com:3478?transport=udp&x=1",
            "turn:turn.cloudflare.com:0",
            "turn:turn.cloudflare.com:99999",
            "turn:turn.cloudflare.com:",
            "turn:[2606:4700::1]:3478",
            "turn:turn.cloudflare.com/path",
            "https://turn.cloudflare.com",
            "",
        ] {
            let good = "turns:turn.cloudflare.com:443?transport=tcp";
            let servers = json!([{ "urls": [good, url], "username": "u", "credential": "c" }]);
            let body = worker_body(servers, 14_400, n + 14_400);
            assert!(
                parse_credentials(body.as_bytes(), n, Some(n)).is_err(),
                "{url:?} must be rejected"
            );
        }
    }

    #[test]
    fn rejects_missing_or_empty_credentials_and_malformed_bodies() {
        let n = now();
        let url = "turn:turn.cloudflare.com:3478?transport=udp";
        let one = |server: serde_json::Value| json!({ "iceServers": [server], "ttl": 3600, "expiresAt": n + 3600 });
        let cases = [
            one(json!({ "urls": [url], "username": "", "credential": "c" })),
            one(json!({ "urls": [url], "username": "u", "credential": "" })),
            one(json!({ "urls": [url], "credential": "c" })),
            one(json!({ "urls": [url], "username": "u" })),
            one(json!({ "urls": [url], "username": 1, "credential": "c" })),
            one(json!({ "urls": url, "username": "u", "credential": "c" })),
            one(json!({ "urls": [], "username": "u", "credential": "c" })),
            one(json!({ "urls": vec![url; 9], "username": "u", "credential": "c" })),
            one(json!({ "urls": [url], "username": "u", "credential": "c", "extra": 1 })),
            one(json!({ "urls": [url], "username": "u\n", "credential": "c" })),
            one(json!({ "urls": [url], "username": "u".repeat(513), "credential": "c" })),
            json!({ "iceServers": [], "ttl": 3600, "expiresAt": n + 3600 }),
            json!({ "iceServers": vec![json!({ "urls": [url], "username": "u", "credential": "c" }); 5], "ttl": 3600, "expiresAt": n + 3600 }),
            json!({ "ttl": 3600, "expiresAt": n + 3600 }),
            json!({ "iceServers": cloudflare_servers(), "ttl": 0, "expiresAt": n + 3600 }),
            json!({ "iceServers": cloudflare_servers(), "ttl": -5, "expiresAt": n + 3600 }),
            json!({ "iceServers": cloudflare_servers(), "ttl": 86_401, "expiresAt": n + 3600 }),
            json!({ "iceServers": cloudflare_servers(), "ttl": 3600, "expiresAt": n }),
            json!({ "iceServers": cloudflare_servers(), "ttl": 3600 }),
            json!(["not", "an", "object"]),
        ];
        for case in cases {
            assert!(
                parse_value(case.clone()).is_err(),
                "{case} must be rejected"
            );
        }
        assert!(parse_credentials(b"not json", n, None).is_err());
    }

    #[test]
    fn never_keeps_credentials_past_the_ttl_it_was_given() {
        let n = now();
        let body = worker_body(cloudflare_servers(), 3_600, n + 86_400);
        assert_eq!(
            parse_credentials(body.as_bytes(), n, Some(n))
                .unwrap()
                .expires_at,
            n + 3_600
        );
    }

    #[test]
    fn a_skewed_local_clock_does_not_reject_valid_credentials() {
        let server = now();
        let body = worker_body(cloudflare_servers(), 14_400, server + 14_400);
        // Five hours ahead and one hour behind the Worker.
        for local in [server + 5 * 3_600, server - 3_600] {
            let parsed = parse_credentials(body.as_bytes(), local, Some(server)).unwrap();
            assert_eq!(parsed.expires_at, local + 14_400, "in local time");
        }
    }

    #[test]
    fn the_expiry_is_checked_against_the_workers_clock() {
        let server = now();
        let local = server - 3_600;
        let expired = worker_body(cloudflare_servers(), 14_400, server);
        assert!(parse_credentials(expired.as_bytes(), local, Some(server)).is_err());
        // Less left than the ttl: the shorter of the two, in local time.
        let short = worker_body(cloudflare_servers(), 14_400, server + 600);
        assert_eq!(
            parse_credentials(short.as_bytes(), local, Some(server))
                .unwrap()
                .expires_at,
            local + 600
        );
    }

    #[test]
    fn without_the_workers_clock_the_ttl_alone_sets_the_expiry() {
        let local = now();
        let body = worker_body(cloudflare_servers(), 14_400, local - 100);
        assert_eq!(
            parse_credentials(body.as_bytes(), local, None)
                .unwrap()
                .expires_at,
            local + 14_400
        );
    }

    // ── HTTP, through Tor ───────────────────────────────────────────────────

    /// The Worker, on an in-memory Tor whose trinochat.org speaks TLS with
    /// the test CA: each connection gets the next reply. Its client, what
    /// it saw, and every connection made with its token.
    struct Worker {
        client: TurnClient,
        seen: Arc<StdMutex<Vec<Received>>>,
        tor: Arc<Mock>,
    }

    fn worker(replies: Vec<Reply>, timeout: Duration) -> Worker {
        let tor = Mock::new();
        let net = Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn Transport>),
            Arc::new(Forbidden),
        );
        let seen = mock_http::serve(&tor, "https://trinochat.org", replies);
        let http = HttpClient::with_tls(Arc::clone(&net), mock_http::test_tls());
        let client = TurnClient::local(net, http, TURN_ENDPOINT.to_string(), timeout);
        Worker { client, seen, tor }
    }

    fn response(status: &str, headers: &str, body: &str) -> Reply {
        mock_http::response(
            status,
            &format!("Content-Type: application/json\r\n{headers}"),
            body.as_bytes(),
        )
    }

    fn header_value(head: &str, name: &str) -> Option<String> {
        mock_http::header(head, name)
    }

    /// A token of its own, as each call has.
    fn call_iso() -> Iso {
        Net::with_transports(None, Arc::new(Forbidden))
            .session()
            .iso(IsoKind::TURN, "")
    }

    #[test]
    fn production_uses_the_fixed_endpoint_and_a_thirty_second_timeout() {
        // Tor design §3.1 with the spike's times: a GET to trinochat.org on
        // a fresh circuit took 1.6-5.3 s, a first stream up to 13 s (S3,
        // S6). The proof of work is mined before, so the event is at most
        // ~31 s old when it arrives, within the Worker's 60 s.
        let client = TurnClient::production(Net::new());
        assert_eq!(client.url, "https://trinochat.org/api/v1/turn/credentials");
        assert_eq!(client.timeout, Duration::from_secs(30));
    }

    #[tokio::test]
    async fn posts_the_exact_body_with_nip98_auth_and_returns_the_servers() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(
            vec![response("200 OK", "Cache-Control: no-store\r\n", &ok)],
            Duration::from_secs(5),
        );
        let servers = w.client.request("Nostr abc", n, &call_iso()).await.unwrap();
        assert_eq!(servers.ice_servers[0].username, "u-test");
        let seen = w.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let request = &seen[0];
        assert!(request
            .head
            .starts_with("POST /api/v1/turn/credentials HTTP/1.1\r\n"));
        assert_eq!(
            header_value(&request.head, "authorization").as_deref(),
            Some("Nostr abc")
        );
        assert_eq!(
            header_value(&request.head, "content-type").as_deref(),
            Some("application/json")
        );
        // R-20: trinochat.org gets the fixed User-Agent, and only it.
        assert_eq!(
            header_value(&request.head, "user-agent").as_deref(),
            Some("Trino")
        );
        assert_eq!(request.body, br#"{"v":1}"#);
    }

    #[tokio::test]
    async fn the_request_goes_through_tor_to_trinochat_org_on_the_calls_token() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(vec![response("200 OK", "", &ok)], Duration::from_secs(5));
        let iso = call_iso();

        w.client.request("Nostr abc", n, &iso).await.unwrap();

        assert_eq!(
            w.tor.connections(),
            [(trino_net::Target::new("trinochat.org", 443), iso)]
        );
    }

    #[tokio::test]
    async fn with_tor_not_ready_the_request_is_tor_not_ready_and_never_direct() {
        // R-11: the call keeps ringing and never offers to go direct for
        // this; the direct transport fails the test if touched.
        let net = Net::with_transports(None, Arc::new(Forbidden));
        let client = TurnClient::production(net);

        let error = client
            .request("Nostr x", now(), &call_iso())
            .await
            .unwrap_err();

        assert_eq!(error, TurnError::TorNotReady);
        assert_eq!(CommandError::from(error).code, ErrorCode::TorNotReady);
    }

    #[tokio::test]
    async fn maps_the_workers_errors() {
        let refused = |status, code: &str| TurnError::Refused {
            status,
            code: code.to_string(),
        };
        let cases = [
            (
                response(
                    "429 Too Many Requests",
                    "Retry-After: 120\r\n",
                    r#"{"error":"rate_limited"}"#,
                ),
                TurnError::RateLimited {
                    retry_after: Some(120),
                },
            ),
            (
                response("503 Service Unavailable", "", r#"{"error":"disabled"}"#),
                TurnError::Disabled,
            ),
            (
                response("502 Bad Gateway", "", r#"{"error":"upstream"}"#),
                TurnError::Upstream,
            ),
            (
                response("401 Unauthorized", "", r#"{"error":"bad_auth"}"#),
                refused(401, "bad_auth"),
            ),
            (
                response("403 Forbidden", "", r#"{"error":"low_pow"}"#),
                refused(403, "low_pow"),
            ),
            (
                response("409 Conflict", "", r#"{"error":"replay"}"#),
                refused(409, "replay"),
            ),
            (
                response("400 Bad Request", "", r#"{"error":"Bad <script>"}"#),
                refused(400, ""),
            ),
            (
                response("500 Internal Server Error", "", "oops"),
                refused(500, ""),
            ),
        ];
        for (canned, expected) in cases {
            let w = worker(vec![canned], Duration::from_secs(5));
            let error = w
                .client
                .request("Nostr x", now(), &call_iso())
                .await
                .unwrap_err();
            assert_eq!(error, expected);
        }
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(
            vec![
                response("302 Found", &format!("Location: {TURN_ENDPOINT}\r\n"), ""),
                response("200 OK", "", &ok),
            ],
            Duration::from_secs(5),
        );
        let error = w
            .client
            .request("Nostr x", n, &call_iso())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            TurnError::Refused {
                status: 302,
                code: String::new()
            }
        );
        assert_eq!(w.seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn refuses_a_response_larger_than_16_kib() {
        let big = "x".repeat(MAX_RESPONSE_BYTES + 1);
        let with_length = response("200 OK", "", &big);
        let until_close = mock_http::until_close("200 OK", big.as_bytes());
        for canned in [with_length, until_close] {
            let w = worker(vec![canned], Duration::from_secs(5));
            let error = w
                .client
                .request("Nostr x", now(), &call_iso())
                .await
                .unwrap_err();
            assert!(matches!(error, TurnError::InvalidResponse(_)), "{error:?}");
        }
    }

    #[tokio::test]
    async fn gives_up_when_the_service_does_not_answer_in_time() {
        let w = worker(vec![Reply::Never], Duration::from_millis(300));
        let start = Instant::now();
        let error = w
            .client
            .request("Nostr x", now(), &call_iso())
            .await
            .unwrap_err();
        assert_eq!(error, TurnError::Network("timeout".to_string()));
        assert!(start.elapsed() < Duration::from_secs(5));
    }

    fn http_date(unix: i64) -> String {
        chrono::DateTime::from_timestamp(unix, 0)
            .unwrap()
            .format("%a, %d %b %Y %H:%M:%S GMT")
            .to_string()
    }

    fn bad_auth_at(server: i64) -> Reply {
        response(
            "401 Unauthorized",
            &format!("Date: {}\r\n", http_date(server)),
            r#"{"error":"bad_auth"}"#,
        )
    }

    #[tokio::test]
    async fn a_401_from_a_distant_clock_reports_the_offset() {
        let n = now();
        let w = worker(vec![bad_auth_at(n + 3_600)], Duration::from_secs(5));
        let error = w
            .client
            .request("Nostr x", n, &call_iso())
            .await
            .unwrap_err();
        match error {
            TurnError::ClockSkew { offset } => assert!((offset - 3_600).abs() <= 5, "{offset}"),
            other => panic!("expected ClockSkew, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_401_from_a_close_clock_is_a_plain_refusal() {
        let n = now();
        let w = worker(vec![bad_auth_at(n + 10)], Duration::from_secs(5));
        let error = w
            .client
            .request("Nostr x", n, &call_iso())
            .await
            .unwrap_err();
        assert_eq!(
            error,
            TurnError::Refused {
                status: 401,
                code: "bad_auth".to_string()
            }
        );
    }

    #[tokio::test]
    async fn the_workers_date_validates_the_expiry_of_a_200() {
        let server = now();
        let local = server + 5 * 3_600;
        let ok = worker_body(cloudflare_servers(), 14_400, server + 14_400);
        let date = format!("Date: {}\r\n", http_date(server));
        let w = worker(vec![response("200 OK", &date, &ok)], Duration::from_secs(5));
        let servers = w
            .client
            .request("Nostr x", local, &call_iso())
            .await
            .unwrap();
        assert!((servers.expires_at - (local + 14_400)).abs() <= 5);
    }

    #[tokio::test]
    async fn signs_again_on_the_workers_clock_after_a_skewed_401() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 3_600 + 14_400);
        let w = worker(
            vec![bad_auth_at(n + 3_600), response("200 OK", "", &ok)],
            Duration::from_secs(5),
        );
        let gate = TurnGate::default();
        let servers = turn_servers(&gate, &w.client, gate.session(), CALL_A)
            .await
            .unwrap();
        assert_eq!(servers.ice_servers[0].username, "u-test");
        let seen = w.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        let first = decode_auth(&header_value(&seen[0].head, "authorization").unwrap());
        let second = decode_auth(&header_value(&seen[1].head, "authorization").unwrap());
        assert!((first.created_at - n).abs() <= 5);
        assert!((second.created_at - (n + 3_600)).abs() <= 5);
        assert!(verify_event(&second));
        assert_ne!(first.id, second.id, "a new event, so no replay");
        // Still the same call: its key and its circuit.
        assert_eq!(first.pubkey, second.pubkey);
        let tokens: Vec<Iso> = w.tor.connections().into_iter().map(|(_, i)| i).collect();
        assert_eq!(tokens[0], tokens[1]);
    }

    #[tokio::test]
    async fn signs_again_only_once() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(
            vec![
                bad_auth_at(n + 3_600),
                bad_auth_at(n + 3_600),
                response("200 OK", "", &ok),
            ],
            Duration::from_secs(5),
        );
        let gate = TurnGate::default();
        let error = turn_servers(&gate, &w.client, gate.session(), CALL_A)
            .await
            .unwrap_err();
        assert!(matches!(error, TurnError::ClockSkew { .. }), "{error:?}");
        assert_eq!(w.seen.lock().unwrap().len(), 2);
    }

    // ── one key, one token and fresh credentials per call (R-02, R-04) ──────

    #[tokio::test]
    async fn turn_credentials_are_asked_per_call_with_a_fresh_key_and_their_own_token() {
        // Design test 29 and decision 18: Cloudflare must not tie two calls,
        // nor a call to the account, by the key that signs the request or
        // by the exit it comes from. So every call signs with a key made
        // for it alone, goes on a token of its own, and gets credentials of
        // its own: none are kept from one call for the next, though the
        // first ones would have lasted four hours.
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(
            vec![response("200 OK", "", &ok), response("200 OK", "", &ok)],
            Duration::from_secs(5),
        );
        let gate = TurnGate::default();

        let first = turn_servers(&gate, &w.client, gate.session(), CALL_A)
            .await
            .unwrap();
        let second = turn_servers(&gate, &w.client, gate.session(), CALL_B)
            .await
            .unwrap();

        assert_eq!(first.ice_servers[0].username, "u-test");
        assert_eq!(second.ice_servers[0].username, "u-test");
        let seen = w.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "the second call reused the first's");
        let keys: Vec<String> = seen
            .iter()
            .map(|request| {
                let event = decode_auth(&header_value(&request.head, "authorization").unwrap());
                assert!(verify_event(&event));
                assert_eq!(tag(&event, "u"), [TURN_ENDPOINT]);
                event.pubkey
            })
            .collect();
        assert_ne!(keys[0], keys[1], "two calls signed with one key");
        let tokens: Vec<Iso> = w.tor.connections().into_iter().map(|(_, i)| i).collect();
        assert_eq!(tokens.len(), 2);
        assert!(tokens.iter().all(|iso| iso.kind() == IsoKind::TURN));
        assert_ne!(tokens[0], tokens[1], "two calls on one token");
    }

    /// TOR-4's first deviation, closed by TOR-6: the UI names the call
    /// (its callId), so a renewal of the credentials within one call signs
    /// with that call's key and goes on its token, while the credentials
    /// are asked afresh each time.
    #[tokio::test]
    async fn a_renewal_within_one_call_reuses_its_key_and_token_and_asks_anew() {
        let n = now();
        let ok = worker_body(cloudflare_servers(), 14_400, n + 14_400);
        let w = worker(
            vec![response("200 OK", "", &ok), response("200 OK", "", &ok)],
            Duration::from_secs(5),
        );
        let gate = TurnGate::default();

        for _ in 0..2 {
            turn_servers(&gate, &w.client, gate.session(), CALL_A)
                .await
                .unwrap();
        }

        let seen = w.seen.lock().unwrap();
        assert_eq!(seen.len(), 2, "every renewal asks the Worker anew");
        let keys: Vec<String> = seen
            .iter()
            .map(|request| {
                decode_auth(&header_value(&request.head, "authorization").unwrap()).pubkey
            })
            .collect();
        let tokens: Vec<Iso> = w.tor.connections().into_iter().map(|(_, i)| i).collect();
        assert_eq!(keys[0], keys[1], "a renewal signs with its call's key");
        assert_eq!(tokens[0], tokens[1], "a renewal goes on its call's token");
    }

    /// Only the same call in the same session gets the same signer: another
    /// call, a lock, or a session from before gets a new key and token.
    #[test]
    fn another_call_or_a_lock_gets_a_new_key_and_token() {
        let client = TurnClient::production(Net::with_transports(None, Arc::new(Forbidden)));
        let gate = TurnGate::default();
        let session = gate.session();
        let (a1, iso_a1) = gate.signer(session, CALL_A, &client);
        let (a2, iso_a2) = gate.signer(session, CALL_A, &client);
        assert!(Arc::ptr_eq(&a1, &a2));
        assert_eq!(iso_a1, iso_a2);

        let (b, iso_b) = gate.signer(session, CALL_B, &client);
        assert_ne!(a1.pub_bytes, b.pub_bytes, "another call, another key");
        assert_ne!(iso_a1, iso_b, "another call, another token");
        let (a3, iso_a3) = gate.signer(session, CALL_A, &client);
        assert_ne!(
            a1.pub_bytes, a3.pub_bytes,
            "a call that was replaced is not taken back"
        );
        assert_ne!(iso_a1, iso_a3);

        gate.clear();
        let (after, iso_after) = gate.signer(gate.session(), CALL_A, &client);
        assert_ne!(a3.pub_bytes, after.pub_bytes, "after a lock, a new key");
        assert_ne!(iso_a3, iso_after, "after a lock, a new token");
        let (stale, _) = gate.signer(session, CALL_A, &client);
        assert_ne!(
            after.pub_bytes, stale.pub_bytes,
            "a session from before shares nothing"
        );
    }

    #[test]
    fn a_call_id_is_what_the_ui_makes() {
        assert!(valid_call_id(CALL_A));
        assert!(valid_call_id(&"a".repeat(64)));
        for bad in [
            "",
            "short",
            "has space in it!!",
            "ñññññññññññññññññ",
            &"a".repeat(65),
        ] {
            assert!(!valid_call_id(bad), "{bad}");
        }
    }

    #[test]
    fn a_one_time_key_is_new_every_time_and_signs_what_it_says() {
        let a = SigningKeys::one_time();
        let b = SigningKeys::one_time();
        assert_ne!(*a.priv_bytes, *b.priv_bytes);
        assert_ne!(a.pub_bytes, b.pub_bytes);
        let secp = secp256k1::Secp256k1::new();
        let pair = secp256k1::Keypair::from_seckey_slice(&secp, &*a.priv_bytes).unwrap();
        assert_eq!(pair.x_only_public_key().0.serialize(), a.pub_bytes);
    }

    // ── the session gate ────────────────────────────────────────────────────

    #[tokio::test]
    async fn a_lock_cancels_a_request_in_flight() {
        let gate = TurnGate::default();
        let finished = AtomicBool::new(false);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let slow = || async {
            let _ = started_tx.send(());
            tokio::time::sleep(Duration::from_secs(2)).await;
            finished.store(true, Ordering::SeqCst);
            Ok(sample(20_000))
        };
        let (result, ()) = tokio::join!(gate.request(gate.session(), slow), async {
            started_rx.await.unwrap();
            gate.clear(); // returns at once, while the request is in flight
        });
        assert_eq!(result, Err(TurnError::Locked));
        assert!(
            !finished.load(Ordering::SeqCst),
            "the request in flight is dropped"
        );
    }

    #[tokio::test]
    async fn a_session_from_before_a_lock_gets_nothing() {
        let gate = TurnGate::default();
        let counter = AtomicUsize::new(0);
        let fetch = || {
            counter.fetch_add(1, Ordering::SeqCst);
            std::future::ready(Ok(sample(20_000)))
        };
        let stale = gate.session();
        gate.request(stale, fetch).await.unwrap();
        gate.clear();
        gate.request(gate.session(), fetch).await.unwrap();

        assert_eq!(gate.request(stale, fetch).await, Err(TurnError::Locked));
        assert_eq!(
            counter.load(Ordering::SeqCst),
            2,
            "a voided session asks nothing"
        );
    }

    #[tokio::test]
    async fn every_request_is_asked_anew_and_a_failure_is_only_returned() {
        let gate = TurnGate::default();
        let session = gate.session();
        assert_eq!(
            gate.request(session, || async { Err(TurnError::Disabled) })
                .await,
            Err(TurnError::Disabled)
        );
        let counter = AtomicUsize::new(0);
        for _ in 0..3 {
            gate.request(session, || {
                counter.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(sample(20_000)))
            })
            .await
            .unwrap();
        }
        assert_eq!(counter.load(Ordering::SeqCst), 3, "nothing is kept");
    }

    // ── what the UI sees ────────────────────────────────────────────────────

    #[test]
    fn errors_map_to_the_codes_the_ui_knows() {
        assert_eq!(
            CommandError::from(TurnError::Locked).code,
            ErrorCode::NoVault
        );
        for error in [
            TurnError::Network("down".to_string()),
            TurnError::Refused {
                status: 401,
                code: "bad_auth".to_string(),
            },
            TurnError::RateLimited { retry_after: None },
            TurnError::Disabled,
            TurnError::Upstream,
            TurnError::ClockSkew { offset: 3_600 },
        ] {
            assert_eq!(CommandError::from(error).code, ErrorCode::Io);
        }
        for error in [
            TurnError::Signing("bad key".to_string()),
            TurnError::ProofOfWork,
            TurnError::InvalidResponse("bad"),
        ] {
            assert_eq!(CommandError::from(error).code, ErrorCode::Internal);
        }
        assert!(CommandError::from(TurnError::Disabled)
            .message
            .starts_with("turn: "));
    }

    #[test]
    fn the_ui_receives_the_servers_and_their_expiry() {
        assert_eq!(
            serde_json::to_value(sample(10_000)).unwrap(),
            json!({
                "ice_servers": [{
                    "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
                    "username": "user",
                    "credential": "secret-credential"
                }],
                "expires_at": 10_000
            })
        );
    }

    #[test]
    fn credentials_are_wiped_from_memory_when_dropped() {
        fn wiped_on_drop<T: zeroize::ZeroizeOnDrop>() {}
        wiped_on_drop::<TurnServer>();
    }

    #[test]
    fn debug_output_never_shows_the_credential() {
        let printed = format!("{:?}", sample(10_000));
        assert!(!printed.contains("secret-credential"), "{printed}");
    }
}
