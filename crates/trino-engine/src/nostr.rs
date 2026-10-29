use crate::crypto::sha256;
use crate::relay_caps::RelayCaps;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{Keypair, Message as SecpMessage, Secp256k1};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;
use trino_core::p1::event as p1event;
use trino_net::{IsoKind, Mode, Net, Session};

pub const TRINO_KIND: u32 = 4848;

/// The kinds P1 listens to: messages (1059) and call signals (21059).
pub const P1_KINDS: [u32; 2] = [p1event::KIND_MESSAGE, p1event::KIND_CALL];

/// How far back of the moment it is sent a mailbox REQ's `since` stays at
/// least. Relays apply `since` to what arrives live too (the relay spike,
/// 29 oct 2026), and a message's `created_at` goes back up to 300 s, from a
/// clock that may be up to 3 h behind (P1 §3.5): a `since` any closer to
/// now drops such a message for good.
pub const P1_SINCE_LAG_SECS: i64 = 3 * 3600 + p1event::MAX_BACKDATE_SECS;

/// Whether `filter` asks for P1 mailboxes: a `#p` and only P1 kinds.
fn is_mailbox_filter(filter: &NostrFilter) -> bool {
    filter.p_tag.is_some()
        && filter
            .kinds
            .as_ref()
            .is_some_and(|kinds| !kinds.is_empty() && kinds.iter().all(|k| P1_KINDS.contains(k)))
}

/// A mailbox filter's `since`, moved back to `now − P1_SINCE_LAG_SECS` if
/// it is any later. Other filters, and no `since`, are left as they are.
fn hold_since_back(filter: &mut NostrFilter, now: i64) {
    if is_mailbox_filter(filter) {
        if let Some(since) = filter.since.as_mut() {
            *since = (*since).min(now - P1_SINCE_LAG_SECS);
        }
    }
}

/// Mailboxes in one filter. Past this a list is split in more filters of
/// the same REQ, which stays one pseudonym (P1 §3.6, R-31).
pub const MAILBOXES_PER_FILTER: usize = 650;

#[derive(Debug, Error)]
pub enum NostrError {
    #[error("connection failed: {0}")]
    Connect(String),
    #[error("signing failed: {0}")]
    Signing(String),
    #[error("send failed: {0}")]
    Send(String),
    #[error("hex decode: {0}")]
    Hex(#[from] hex::FromHexError),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NostrEvent {
    pub id: String,
    pub pubkey: String,
    pub created_at: i64,
    pub kind: u32,
    pub tags: Vec<Vec<String>>,
    pub content: String,
    pub sig: String,
}

impl NostrEvent {
    /// The pubkey this event is addressed to: the value of its first `p` tag.
    /// Trino puts exactly one there, the recipient of the pairwise ciphertext.
    pub fn recipient(&self) -> Option<&str> {
        self.tags
            .iter()
            .find(|tag| tag.first().map(String::as_str) == Some("p"))
            .and_then(|tag| tag.get(1))
            .map(String::as_str)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct NostrFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kinds: Option<Vec<u32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    #[serde(rename = "#p", skip_serializing_if = "Option::is_none")]
    pub p_tag: Option<Vec<String>>,
}

pub fn build_and_sign_event(
    priv_bytes: &[u8; 32],
    pub_bytes: &[u8; 32],
    kind: u32,
    content: &str,
    tags: Vec<Vec<String>>,
    created_at: Option<i64>,
) -> Result<NostrEvent, NostrError> {
    let created_at = created_at.unwrap_or_else(|| chrono::Utc::now().timestamp());
    let pubkey = hex::encode(pub_bytes);

    let serialized = serde_json::json!([0, pubkey, created_at, kind, tags, content]).to_string();
    let id_bytes = sha256(serialized.as_bytes());
    let id = hex::encode(id_bytes);

    let secp = Secp256k1::new();
    let kp = Keypair::from_seckey_slice(&secp, priv_bytes)
        .map_err(|e| NostrError::Signing(e.to_string()))?;
    let msg = SecpMessage::from_digest(id_bytes);
    let sig = secp.sign_schnorr_no_aux_rand(&msg, &kp);
    let sig_hex = hex::encode(sig.as_ref());

    Ok(NostrEvent {
        id,
        pubkey,
        created_at,
        kind,
        tags,
        content: content.to_string(),
        sig: sig_hex,
    })
}

/// Whether the event's id is its NIP-01 id and its BIP-340 signature is
/// valid: trino-core's check (P1 §6.2, step 1), the one every event that
/// arrives goes through.
pub fn verify_event(event: &NostrEvent) -> bool {
    p1event::verify_event(&event.clone().into())
}

impl From<p1event::Event> for NostrEvent {
    fn from(e: p1event::Event) -> Self {
        NostrEvent {
            id: e.id,
            pubkey: e.pubkey,
            created_at: e.created_at,
            kind: e.kind,
            tags: e.tags,
            content: e.content,
            sig: e.sig,
        }
    }
}

impl From<NostrEvent> for p1event::Event {
    fn from(e: NostrEvent) -> Self {
        p1event::Event {
            id: e.id,
            pubkey: e.pubkey,
            created_at: e.created_at,
            kind: e.kind,
            tags: e.tags,
            content: e.content,
            sig: e.sig,
        }
    }
}

/// `inner` sealed for `mailbox` in a P1 event of `kind` (1059 or 21059),
/// sent at `now`: a one-time author, one `p`, NIP-44 and an `expiration`
/// (6–8 days on 1059, 1–2 hours on 21059), and on 1059 a backdated
/// `created_at` (trino-core, P1 §2.1, `diseno-vinculacion.md` §23.8).
pub fn seal_p1(
    kind: u32,
    now: i64,
    mailbox: &[u8; 32],
    inner: &[u8],
) -> Result<NostrEvent, NostrError> {
    p1event::seal_event(kind, now, mailbox, inner)
        .map(NostrEvent::from)
        .map_err(|e| NostrError::Signing(e.to_string()))
}

/// The filters that listen to `mailboxes` for events of one P1 `kind` since
/// `since`: only that kind and the mailboxes, no identity anywhere, split
/// every `MAILBOXES_PER_FILTER` (P1 §3.6). No mailbox, no filter.
///
/// One kind per REQ: a relay may never answer a REQ that names an ephemeral
/// kind (the relay spike, 29 oct 2026), and that must not cost the
/// messages. Both REQs go on the same connection, which is one pseudonym
/// anyway.
pub fn p1_filters(kind: u32, mailboxes: &[[u8; 32]], since: i64) -> Vec<NostrFilter> {
    mailboxes
        .chunks(MAILBOXES_PER_FILTER)
        .map(|chunk| NostrFilter {
            kinds: Some(vec![kind]),
            p_tag: Some(chunk.iter().map(hex::encode).collect()),
            since: Some(since),
            ..Default::default()
        })
        .collect()
}

type EventHandler = Arc<dyn Fn(NostrEvent) + Send + Sync>;
type OkCallback = oneshot::Sender<(bool, Option<String>)>;

/// How a catch-up subscription picks its `since` each time it is (re)sent.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CatchUp {
    /// Never ask for events older than this many seconds.
    pub max_window_secs: i64,
    /// How far a re-subscription reaches back before the moment the previous
    /// connection was last known to be in sync, to absorb clock skew between
    /// the sender and us (relays filter on the sender's `created_at`).
    pub overlap_secs: i64,
}

/// `since` for a catch-up subscription sent at `now`: back to `synced_at`, the
/// last moment (local clock) an earlier connection to this relay was known to
/// have delivered everything, minus the overlap; the whole window when there is
/// no such moment, and never further back than the window either way.
pub fn catch_up_since(now: i64, synced_at: Option<i64>, catch_up: CatchUp) -> i64 {
    let floor = now - catch_up.max_window_secs;
    synced_at.map_or(floor, |synced| {
        (synced.min(now) - catch_up.overlap_secs).max(floor)
    })
}

struct Subscription {
    id: String,
    /// One REQ may carry several filters (P1 splits a long list of mailboxes
    /// in two, R-31): the relay sends what matches any of them.
    filters: Vec<NostrFilter>,
    catch_up: Option<CatchUp>,
}

fn req_payload(sub: &Subscription, now: i64, synced_at: Option<i64>) -> String {
    let mut frame = vec![Value::from("REQ"), Value::from(sub.id.as_str())];
    for filter in &sub.filters {
        let mut filter = filter.clone();
        if let Some(catch_up) = sub.catch_up {
            filter.since = Some(catch_up_since(now, synced_at, catch_up));
        }
        hold_since_back(&mut filter, now);
        frame.push(serde_json::to_value(filter).expect("a filter is plain JSON"));
    }
    Value::Array(frame).to_string()
}

/// `["CLOSE", <id>]` (NIP-01).
fn close_payload(id: &str) -> String {
    serde_json::json!(["CLOSE", id]).to_string()
}

/// A subscription id no relay can tie to another: 16 random hex digits,
/// never a counter (P1 R-23).
fn random_sub_id() -> String {
    hex::encode(rand::random::<[u8; 8]>())
}

/// The subscriptions of one relay connection. Owned by its connection task,
/// and free of I/O so the reconnect rules can be tested without a socket.
///
/// The point a re-subscription resumes from is taken from the relay protocol,
/// not from event timestamps: once every catch-up subscription on a socket has
/// reached EOSE, the relay has sent everything it stored and streams the rest
/// live, so each later frame proves we were in sync at that moment. Event
/// `created_at` values are chosen by their senders (anyone can address an
/// event to us, dated in the future) and relays send stored events newest
/// first, so neither can safely move this point.
#[derive(Default)]
struct SubscriptionBook {
    subs: Vec<Subscription>,
    /// Catch-up subscriptions on the current socket still waiting for EOSE.
    awaiting_eose: HashSet<String>,
    /// Every catch-up subscription on the current socket has reached EOSE.
    live: bool,
    /// Last moment (local clock) a socket was known to be live.
    synced_at: Option<i64>,
    /// `ClientOptions::answer_deadline`.
    answer_deadline: Option<Duration>,
    /// When each subscription sent on the current socket must have had its
    /// EOSE or CLOSED.
    due: HashMap<String, Instant>,
}

/// What a relay frame said about a subscription.
#[derive(Debug, PartialEq)]
enum SubAnswer {
    Nothing,
    /// EOSE, for a subscription of these kinds.
    Eose(Vec<u32>),
    /// CLOSED, for a subscription of these kinds, with the relay's message.
    Closed(Vec<u32>, String),
}

impl Subscription {
    /// The kinds its filters name, once each.
    fn kinds(&self) -> Vec<u32> {
        let mut kinds: Vec<u32> = self
            .filters
            .iter()
            .flat_map(|filter| filter.kinds.clone().unwrap_or_default())
            .collect();
        kinds.sort_unstable();
        kinds.dedup();
        kinds
    }
}

impl SubscriptionBook {
    /// A fresh socket is up: the REQs to (re)send on it.
    fn on_connected(&mut self, now: i64) -> Vec<String> {
        self.live = false;
        self.awaiting_eose = self
            .subs
            .iter()
            .filter(|sub| sub.catch_up.is_some())
            .map(|sub| sub.id.clone())
            .collect();
        self.due.clear();
        if let Some(deadline) = self.answer_deadline {
            let at = Instant::now() + deadline;
            self.due = self.subs.iter().map(|sub| (sub.id.clone(), at)).collect();
        }
        self.subs
            .iter()
            .map(|sub| req_payload(sub, now, self.synced_at))
            .collect()
    }

    /// A new subscription: remember it, and return its REQ. A mailbox
    /// subscription's `since` is held back once, here, and stays fixed: a
    /// later socket sends the same one.
    fn add(&mut self, mut sub: Subscription, now: i64) -> String {
        if sub.catch_up.is_none() {
            for filter in &mut sub.filters {
                hold_since_back(filter, now);
            }
        }
        let req = req_payload(&sub, now, self.synced_at);
        if sub.catch_up.is_some() {
            self.awaiting_eose.insert(sub.id.clone());
            self.live = false;
        }
        if let Some(deadline) = self.answer_deadline {
            self.due.insert(sub.id.clone(), Instant::now() + deadline);
        }
        self.subs.push(sub);
        req
    }

    /// Forget a subscription: its CLOSE, if it was there. A catch-up one no
    /// longer holds the socket back from being live.
    fn remove(&mut self, id: &str) -> Option<String> {
        self.drop_sub(id).map(|_| close_payload(id))
    }

    /// Takes subscription `id` out of the book, and out of what the socket
    /// waits for.
    fn drop_sub(&mut self, id: &str) -> Option<Subscription> {
        let at = self.subs.iter().position(|sub| sub.id == id)?;
        let sub = self.subs.remove(at);
        self.due.remove(id);
        if self.awaiting_eose.remove(id) && self.awaiting_eose.is_empty() {
            self.live = true;
        }
        Some(sub)
    }

    /// When the next subscription runs out of time to be answered.
    fn next_due(&self) -> Option<Instant> {
        self.due.values().min().copied()
    }

    /// The subscriptions unanswered at `at`, dropped: the CLOSE of each,
    /// and its kinds. They are not sent again on a later socket.
    fn expire(&mut self, at: Instant) -> Vec<(String, Vec<u32>)> {
        let late: Vec<String> = self
            .due
            .iter()
            .filter(|(_, due)| **due <= at)
            .map(|(id, _)| id.clone())
            .collect();
        late.into_iter()
            .filter_map(|id| {
                let sub = self.drop_sub(&id)?;
                Some((close_payload(&id), sub.kinds()))
            })
            .collect()
    }

    /// Any frame from the relay; `text` is its content when it is a text
    /// frame. A subscription the relay CLOSED is dropped: it is not sent
    /// again on a later socket.
    fn on_frame(&mut self, text: Option<&str>, now: i64) -> SubAnswer {
        let answer = match text.and_then(subscription_answer) {
            Some((true, id, _)) => {
                self.due.remove(&id);
                if self.awaiting_eose.remove(&id) && self.awaiting_eose.is_empty() {
                    self.live = true;
                }
                match self.subs.iter().find(|sub| sub.id == id) {
                    Some(sub) => SubAnswer::Eose(sub.kinds()),
                    None => SubAnswer::Nothing,
                }
            }
            Some((false, id, message)) => match self.drop_sub(&id) {
                Some(sub) => SubAnswer::Closed(sub.kinds(), message),
                None => SubAnswer::Nothing,
            },
            None => SubAnswer::Nothing,
        };
        if self.live {
            self.synced_at = Some(now);
        }
        answer
    }
}

/// An `["EOSE", <id>]` (`true`) or `["CLOSED", <id>, <message>]` (`false`)
/// relay message: which, the subscription id and the message.
fn subscription_answer(text: &str) -> Option<(bool, String, String)> {
    if !text.contains("EOSE") && !text.contains("CLOSED") {
        return None; // skip parsing every event a second time
    }
    let msg: Vec<Value> = serde_json::from_str(text).ok()?;
    let eose = match msg.first()?.as_str()? {
        "EOSE" => true,
        "CLOSED" => false,
        _ => return None,
    };
    let id = msg.get(1)?.as_str()?.to_string();
    let message = msg.get(2).and_then(Value::as_str).unwrap_or_default();
    Some((eose, id, message.to_string()))
}

/// Resolves at `at`, or never.
async fn until_due(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
        None => futures_util::future::pending().await,
    }
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Most pages a one-shot catch-up asks for before it gives up.
pub const MAX_PAGES: usize = 64;

/// What a one-shot catch-up got.
#[derive(Debug, Default)]
pub struct Fetched {
    /// Every event that matched, checked and kept once, newest pages first.
    pub events: Vec<NostrEvent>,
    /// Whether it ended on a page with nothing new. `false` when it stopped
    /// at `MAX_PAGES`.
    pub complete: bool,
}

/// Asks `url` for what matches `filters` on a connection of its own, used
/// once (P1 §3.6, R-20): page after page of at most `page_limit` events,
/// each asking `until` the oldest `created_at` seen so far, until a page
/// brings nothing new. Each page is CLOSEd after its EOSE, and the socket
/// after the last one. Every event is checked (`verify_event`) and kept
/// once. The whole is given up at `deadline`.
///
/// A page with nothing new is confirmed by asking once more without
/// `limit`: a relay may return short pages under `until` + `limit` (the
/// relay spike, 29 oct 2026), and stopping there would lose messages. If
/// that ask brings anything new, `caps` learns the relay's paging is broken
/// and the rest, and every later catch-up from it, goes without `limit`.
/// The same ask covers more than `page_limit` events with one `created_at`.
/// A CLOSED, or no answer by `deadline`, is recorded in `caps` too.
pub async fn fetch_once(
    url: &str,
    connector: &Connector,
    filters: &[NostrFilter],
    page_limit: u32,
    deadline: Duration,
    caps: &RelayCaps,
) -> Result<Fetched, NostrError> {
    let kinds = Subscription {
        id: String::new(),
        filters: filters.to_vec(),
        catch_up: None,
    }
    .kinds();
    // A REQ is out and its answer not in yet.
    let asking = AtomicBool::new(false);
    let fetch = async {
        let ws = connector(url.to_string())
            .await
            .map_err(NostrError::Connect)?;
        let (mut write, mut read) = ws.split();
        let mut fetched = Fetched::default();
        let mut seen: HashSet<String> = HashSet::new();
        let mut until: Option<i64> = None;
        let mut limit = (!caps.paging_broken()).then_some(page_limit);
        // This page is the ask without `limit` that confirms an end.
        let mut confirming = false;
        for _ in 0..MAX_PAGES {
            let id = random_sub_id();
            let page: Vec<NostrFilter> = filters
                .iter()
                .map(|f| NostrFilter {
                    until: until.or(f.until),
                    limit,
                    ..f.clone()
                })
                .collect();
            let req = req_payload(
                &Subscription {
                    id: id.clone(),
                    filters: page,
                    catch_up: None,
                },
                unix_now(),
                None,
            );
            write
                .send(Message::Text(req))
                .await
                .map_err(|e| NostrError::Send(e.to_string()))?;
            asking.store(true, Ordering::SeqCst);
            let mut new = 0usize;
            loop {
                let frame = match read.next().await {
                    Some(Ok(Message::Text(text))) => text,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = write.send(Message::Pong(payload)).await;
                        continue;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        return Err(NostrError::Connect("the relay closed".to_string()));
                    }
                    Some(Ok(_)) => continue,
                };
                let Ok(msg) = serde_json::from_str::<Vec<Value>>(&frame) else {
                    continue;
                };
                let (kind, sub) = (
                    msg.first().and_then(Value::as_str),
                    msg.get(1).and_then(Value::as_str),
                );
                if sub != Some(id.as_str()) {
                    continue;
                }
                match kind {
                    Some("EVENT") => {
                        let Some(event) = msg
                            .get(2)
                            .and_then(|e| serde_json::from_value::<NostrEvent>(e.clone()).ok())
                        else {
                            continue;
                        };
                        if verify_event(&event) && seen.insert(event.id.clone()) {
                            until =
                                Some(until.map_or(event.created_at, |u| u.min(event.created_at)));
                            fetched.events.push(event);
                            new += 1;
                        }
                    }
                    Some("EOSE") => break,
                    Some("CLOSED") => {
                        asking.store(false, Ordering::SeqCst);
                        let message = msg.get(2).and_then(Value::as_str).unwrap_or_default();
                        caps.refused(&kinds, message);
                        return Err(NostrError::Connect(
                            "the relay closed the query".to_string(),
                        ));
                    }
                    _ => {}
                }
            }
            asking.store(false, Ordering::SeqCst);
            caps.answered(&kinds);
            let _ = write.send(Message::Text(close_payload(&id))).await;
            if new == 0 {
                if limit.is_some() {
                    limit = None;
                    confirming = true;
                    continue;
                }
                fetched.complete = true;
                break;
            }
            if confirming {
                caps.mark_paging_broken();
                confirming = false;
            }
        }
        let _ = write.close().await;
        Ok(fetched)
    };
    let result = tokio::time::timeout(deadline, fetch).await;
    if result.is_err() && asking.load(Ordering::SeqCst) {
        caps.unanswered(&kinds, Instant::now());
    }
    result.map_err(|_| NostrError::Connect("timeout".to_string()))?
}

/// A relay's WebSocket, over whatever trino-net carries it on: Tor, or the
/// direct transport with its permit (Tor design §3 R1).
pub type WsStream = trino_net::WsStream;

/// Opens the WebSocket of a relay. Production uses `relay_connector`; tests
/// inject one that fails.
pub type Connector =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<WsStream, String>> + Send + Sync>;

/// Told `true` when a client's socket comes up and `false` when it goes down.
pub type StateHandler = Arc<dyn Fn(bool) + Send + Sync>;

/// Resolves when a connection may be attempted: with Tor, once it is
/// ready (`ready_gate`).
pub type ReadyGate = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;

/// Waits for `net` to be ready, with no limit: Tor ready, or the session's
/// permit to go without it. Never a reason to go direct.
pub fn ready_gate(net: Arc<Net>) -> ReadyGate {
    Arc::new(move || {
        let net = Arc::clone(&net);
        Box::pin(async move { net.until_ready().await })
    })
}

/// The pauses between attempts to connect: `first`, then twice as long each
/// time, up to `max`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Backoff {
    pub first: Duration,
    pub max: Duration,
}

impl Backoff {
    /// The pause after one of `previous`.
    pub fn after(self, previous: Duration) -> Duration {
        (previous * 2).min(self.max)
    }
}

/// A messaging client's first connection (K3). A relay that is down at
/// unlock used to be given up for the whole session.
pub const FIRST_CONNECTION: Backoff = Backoff {
    first: Duration::from_secs(2),
    max: Duration::from_secs(60),
};

/// A connection that dropped, as before K3.
pub const RECONNECTION: Backoff = Backoff {
    first: Duration::from_secs(1),
    max: Duration::from_secs(30),
};

/// How long one attempt to connect may take, TLS and WebSocket handshakes
/// included. A captive portal, or a NAT mapping that died across sleep, can
/// take the TCP connection and never finish the handshake: past this, the
/// attempt counts as failed and the next one is tried.
///
/// Through Tor it also builds a circuit (design §3.1): the spike had a
/// relay's WebSocket up in 2.5-3.7 s (median) and 10 s at most, and a first
/// stream on a fresh circuit in up to 13 s (S3, S6), so 30 s leaves twice
/// that. It counts from when Tor is ready (§2.4): the relay's clients wait
/// for it first (`ClientOptions::ready`). A relay with an onion gets its
/// onion's 45 s on top (`relay_deadline`).
pub const CONNECT_DEADLINE: Duration = Duration::from_secs(30);

/// How long one attempt to reach the relay at `url` may take: its onion
/// first, if it has one, then its domain through Tor.
pub fn relay_deadline(url: &str) -> Duration {
    trino_net::onion_map::relay_deadline(url, CONNECT_DEADLINE)
}

/// How long a REQ may go unanswered. Through Tor the relays of the spike
/// sent EOSE within 5 s, and a REQ goes out only once the socket is up.
pub const ANSWER_DEADLINE: Duration = Duration::from_secs(60);

/// The most events a client keeps for a relay while it is down. Kept
/// events go out once it is back (K3); past this many, `publish` refuses
/// more until it is, so a relay down for a whole session does not hold
/// every handshake, call signal and roster sent meanwhile. The relays that
/// are up get them anyway.
pub const MAX_QUEUED_WHILE_DOWN: usize = 256;

/// How a client connects, and whom it tells.
#[derive(Clone)]
pub struct ClientOptions {
    pub connector: Connector,
    pub first_connection: Backoff,
    pub reconnection: Backoff,
    /// How long one attempt to connect may take.
    pub connect_deadline: Duration,
    /// Waited for before every attempt, outside its deadline: Tor being
    /// ready (§2.4). `None` attempts at once.
    pub ready: Option<ReadyGate>,
    /// The way out of the `Net` the connector uses (`Net::route`): a socket
    /// opened one way is opened again, at once, once it changes, so
    /// "Conectar sin Tor" and "Volver a usar Tor" move the sockets already
    /// open, not only the next ones (Tor design §2.8, test 15). `None`
    /// keeps a socket whatever the mode.
    pub route: Option<watch::Receiver<Mode>>,
    pub on_state: Option<StateHandler>,
    /// Writes no line of the diagnostic log: the warning to a trusted
    /// contact's, so the emergency path leaves the notes of a real unlock
    /// only (clave de emergencia RC-03).
    pub quiet: bool,
    /// What is learned about the relay; share one between the connections
    /// to the same relay.
    pub caps: RelayCaps,
    /// How long a REQ may go without EOSE or CLOSED: past it, the
    /// subscription is CLOSEd and dropped, and its kinds are marked
    /// unanswered in `caps`. `None` waits for ever.
    pub answer_deadline: Option<Duration>,
}

impl ClientOptions {
    /// `connector`, with the pauses and deadline above.
    pub fn new(connector: Connector, on_state: Option<StateHandler>) -> Self {
        ClientOptions {
            connector,
            first_connection: FIRST_CONNECTION,
            reconnection: RECONNECTION,
            connect_deadline: CONNECT_DEADLINE,
            ready: None,
            route: None,
            on_state,
            quiet: false,
            caps: RelayCaps::new(),
            answer_deadline: Some(ANSWER_DEADLINE),
        }
    }
}

/// Relay WebSockets through `net`: each relay URL gets its own isolation
/// token of `kind` within `session`, so two relays never share a Tor
/// circuit, nor this session with another (design §2.7). A relay with an
/// onion is tried there first, then by its domain through Tor (§3 R1).
/// With Tor not ready an attempt fails with `TorNotReady` and is tried
/// again later; nothing here ever goes direct on its own.
pub fn relay_connector(net: Arc<Net>, session: Session, kind: IsoKind) -> Connector {
    Arc::new(move |url: String| {
        let net = Arc::clone(&net);
        let iso = session.iso(kind, url.as_bytes());
        Box::pin(async move {
            let onion = trino_net::onion_map::ONION_DEADLINE;
            trino_net::onion_map::ws_connect_relay(&net, &url, &iso, onion)
                .await
                .map_err(|e| e.to_string())
        })
    })
}

/// The network inspector's WebSockets: a token of their own, apart from
/// the messaging connections to the same relays (design §2.7, R2).
pub fn inspector_connector(net: Arc<Net>, session: Session) -> Connector {
    relay_connector(net, session, IsoKind::INSPECTOR)
}

/// Events waiting for this relay's OK (NIP-01), by event id.
type PendingOks = Arc<StdMutex<HashMap<String, OkCallback>>>;

pub struct NostrClient {
    url: String,
    sender: mpsc::UnboundedSender<ClientCommand>,
    /// Whether the socket is up right now. Only the connection task sets it.
    connected: Arc<AtomicBool>,
    /// Set by `close`: it stops a client that is waiting to connect, which
    /// reads no commands until it has a socket.
    closed: watch::Sender<bool>,
    /// The events `publish_acked` waits on (K4); the connection task hands
    /// each relay OK to its event.
    pending_ok: PendingOks,
    /// Events published and not yet taken by the connection task.
    queued: Arc<AtomicUsize>,
    /// `ClientOptions::quiet`.
    quiet: bool,
    /// `ClientOptions::caps`.
    caps: RelayCaps,
}

/// What a relay answered to an event (NIP-01 `OK`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ack {
    /// The relay stored it (or had it already).
    Accepted,
    /// The relay refused it.
    Rejected,
    /// No answer in time, or no socket to ask on.
    NoAnswer,
}

/// Takes an event out of `pending` when its wait ends, however it ends: an
/// answer, the deadline, or a dropped wait.
struct PendingOk<'a> {
    pending: &'a PendingOks,
    id: &'a str,
}

impl Drop for PendingOk<'_> {
    fn drop(&mut self) {
        lock_pending(self.pending).remove(self.id);
    }
}

fn lock_pending(pending: &PendingOks) -> std::sync::MutexGuard<'_, HashMap<String, OkCallback>> {
    pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// NIP-01 answers an event the relay already has with `true` and a
/// `duplicate:` message; some relays say `false` instead. Either way the
/// relay has it.
fn is_duplicate(message: Option<&str>) -> bool {
    message.is_some_and(|message| message.starts_with("duplicate:"))
}

enum ClientCommand {
    Send(String),
    Subscribe(Subscription),
    /// CLOSE a subscription and forget it.
    Unsubscribe(String),
    Close,
}

impl NostrClient {
    /// A client whose first connection must succeed, so the caller learns
    /// the relay is up: the network inspector's. A drop later is retried.
    pub async fn connect(
        url: &str,
        on_event: EventHandler,
        connector: Connector,
    ) -> Result<Arc<Self>, NostrError> {
        Self::connect_with(url, on_event, ClientOptions::new(connector, None)).await
    }

    /// `connect`, with `options`: given up at its connect deadline.
    pub async fn connect_with(
        url: &str,
        on_event: EventHandler,
        options: ClientOptions,
    ) -> Result<Arc<Self>, NostrError> {
        let attempt = (options.connector)(url.to_string());
        let ws = tokio::time::timeout(options.connect_deadline, attempt)
            .await
            .map_err(|_| NostrError::Connect("timeout".to_string()))?
            .map_err(NostrError::Connect)?;
        Ok(Self::spawn(url, on_event, Some(ws), options))
    }

    /// A messaging client (K3). It never fails: it keeps trying to connect,
    /// the first time as well, until it is closed, and what is published or
    /// subscribed meanwhile goes out once it is up. `options.on_state` hears
    /// the socket come and go.
    pub fn start(url: &str, on_event: EventHandler, options: ClientOptions) -> Arc<Self> {
        Self::spawn(url, on_event, None, options)
    }

    fn spawn(
        url: &str,
        on_event: EventHandler,
        first: Option<WsStream>,
        options: ClientOptions,
    ) -> Arc<Self> {
        let (sender, receiver) = mpsc::unbounded_channel::<ClientCommand>();
        let (closed, closed_rx) = watch::channel(false);
        let connected = Arc::new(AtomicBool::new(false));
        let pending_ok = PendingOks::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let quiet = options.quiet;
        let caps = options.caps.clone();
        let connection = Connection {
            url: url.to_string(),
            on_event,
            pending_ok: Arc::clone(&pending_ok),
            connected: Arc::clone(&connected),
            queued: Arc::clone(&queued),
            options,
        };
        tokio::spawn(connection.run(first, receiver, closed_rx));
        Arc::new(NostrClient {
            url: url.to_string(),
            sender,
            connected,
            closed,
            pending_ok,
            queued,
            quiet,
            caps,
        })
    }

    /// What has been learned about this relay.
    pub fn caps(&self) -> &RelayCaps {
        &self.caps
    }

    /// Whether the socket is up right now (K3).
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// How many published events still wait for this relay's OK.
    #[cfg(any(test, feature = "test-util"))]
    pub fn awaiting_ok(&self) -> usize {
        lock_pending(&self.pending_ok).len()
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Send `event`, or keep it until the relay is up again: at most
    /// `MAX_QUEUED_WHILE_DOWN` of them while it is down.
    pub async fn publish(&self, event: &NostrEvent) -> Result<(), NostrError> {
        if !self.is_connected() && self.queued.load(Ordering::SeqCst) >= MAX_QUEUED_WHILE_DOWN {
            return Err(NostrError::Send(
                "the relay is down and keeps no more events".to_string(),
            ));
        }
        let payload = serde_json::json!(["EVENT", event]).to_string();
        self.queued.fetch_add(1, Ordering::SeqCst);
        self.sender
            .send(ClientCommand::Send(payload))
            .map_err(|e| {
                self.queued.fetch_sub(1, Ordering::SeqCst);
                NostrError::Send(e.to_string())
            })?;
        Ok(())
    }

    /// Publish `event` and wait up to `wait` for this relay's OK (K4).
    pub async fn publish_acked(&self, event: &NostrEvent, wait: Duration) -> Ack {
        let (answer, answered) = oneshot::channel();
        lock_pending(&self.pending_ok).insert(event.id.clone(), answer);
        let _waiting = PendingOk {
            pending: &self.pending_ok,
            id: &event.id,
        };
        if self.publish(event).await.is_err() {
            return Ack::NoAnswer;
        }
        match tokio::time::timeout(wait, answered).await {
            Ok(Ok((true, _))) => Ack::Accepted,
            Ok(Ok((false, message))) if is_duplicate(message.as_deref()) => Ack::Accepted,
            Ok(Ok((false, _))) => Ack::Rejected,
            // The deadline, or a connection task that ended.
            Ok(Err(_)) | Err(_) => Ack::NoAnswer,
        }
    }

    /// Subscribe with `filter` exactly as given, re-sent unchanged after every
    /// reconnect.
    pub async fn subscribe(&self, filter: &NostrFilter) -> Result<String, NostrError> {
        self.subscribe_with(filter, None).await
    }

    /// Subscribe to events we may have missed while offline, and keep
    /// receiving. `filter.since` is ignored: each (re)send asks only for what
    /// this relay may not have delivered yet, never more than
    /// `catch_up.max_window_secs` back.
    pub async fn subscribe_catching_up(
        &self,
        filter: &NostrFilter,
        catch_up: CatchUp,
    ) -> Result<String, NostrError> {
        self.subscribe_with(filter, Some(catch_up)).await
    }

    async fn subscribe_with(
        &self,
        filter: &NostrFilter,
        catch_up: Option<CatchUp>,
    ) -> Result<String, NostrError> {
        self.subscribe_filters(vec![filter.clone()], catch_up).await
    }

    /// Subscribe with several filters in one REQ, under a random id; with
    /// `catch_up`, each filter's `since` is set as `subscribe_catching_up`
    /// does.
    pub async fn subscribe_filters(
        &self,
        filters: Vec<NostrFilter>,
        catch_up: Option<CatchUp>,
    ) -> Result<String, NostrError> {
        let sub_id = random_sub_id();
        if !self.quiet {
            dlog("SUBSCRIBE");
        }
        // The connection task keeps it, so it is re-sent after every drop.
        self.sender
            .send(ClientCommand::Subscribe(Subscription {
                id: sub_id.clone(),
                filters,
                catch_up,
            }))
            .map_err(|e| NostrError::Send(e.to_string()))?;
        Ok(sub_id)
    }

    /// Listen to `mailboxes` since `since`: a REQ per P1 kind the relay
    /// is known to answer (`p1_filters`, `RelayCaps::readable`). Gives each
    /// kind with its subscription id; none without mailboxes.
    pub async fn subscribe_p1(
        &self,
        mailboxes: &[[u8; 32]],
        since: i64,
    ) -> Result<Vec<(u32, String)>, NostrError> {
        let mut subscribed = Vec::new();
        let now = Instant::now();
        for kind in P1_KINDS {
            let filters = p1_filters(kind, mailboxes, since);
            if filters.is_empty() || !self.caps.readable(kind, now) {
                continue;
            }
            subscribed.push((kind, self.subscribe_filters(filters, None).await?));
        }
        Ok(subscribed)
    }

    /// Replace subscription `old` with these filters: CLOSE it, then a REQ
    /// under a new random id, so the two cannot be tied by their id (P1
    /// §3.6, R-09). Gives the new id.
    pub async fn replace_subscription(
        &self,
        old: &str,
        filters: Vec<NostrFilter>,
        catch_up: Option<CatchUp>,
    ) -> Result<String, NostrError> {
        self.unsubscribe(old)?;
        self.subscribe_filters(filters, catch_up).await
    }

    /// CLOSE subscription `id` and forget it: it is not sent again after a
    /// reconnect.
    pub fn unsubscribe(&self, id: &str) -> Result<(), NostrError> {
        self.sender
            .send(ClientCommand::Unsubscribe(id.to_string()))
            .map_err(|e| NostrError::Send(e.to_string()))
    }

    /// Shut the client down for good. A client waiting to connect stops at
    /// once (it reads no commands until it has a socket); a connected one
    /// first sends what is queued before the close.
    pub fn close(&self) {
        let _ = self.closed.send(true);
        let _ = self.sender.send(ClientCommand::Close);
    }
}

/// What a client's connection task works with.
struct Connection {
    url: String,
    on_event: EventHandler,
    pending_ok: PendingOks,
    connected: Arc<AtomicBool>,
    /// `NostrClient::queued`: one less for each event taken from the queue.
    queued: Arc<AtomicUsize>,
    options: ClientOptions,
}

impl Connection {
    /// A line of the log, unless the client is quiet.
    fn note(&self, text: &'static str) {
        self.note_with(text, &[]);
    }

    fn note_with(&self, text: &'static str, fields: &[(&'static str, &dyn crate::diag::Plain)]) {
        if !self.options.quiet {
            crate::diag::note_with(text, fields);
        }
    }

    /// A single task owns the connection: it drives read + write + keepalive
    /// via select!, and RECONNECTS with backoff when the socket drops (mobile
    /// networks kill idle sockets when the screen turns off). A messaging
    /// client retries its first connection as well (K3). Subscriptions are
    /// re-sent on every (re)connection so we keep receiving, catch-up ones
    /// with a `since` recomputed for that moment (see SubscriptionBook);
    /// outgoing commands queue in the channel while there is no socket and
    /// flush once we're back.
    async fn run(
        self,
        first: Option<WsStream>,
        mut receiver: mpsc::UnboundedReceiver<ClientCommand>,
        mut closed: watch::Receiver<bool>,
    ) {
        let mut book = SubscriptionBook {
            answer_deadline: self.options.answer_deadline,
            ..Default::default()
        };
        let mut route = self.options.route.clone();
        // A socket handed in was opened the way the route says now.
        let mut next = first.map(|ws| (ws, route.as_mut().map(|r| *r.borrow_and_update())));
        // The first connection is tried at once; after a drop, a pause first.
        let (mut backoff, mut at_once) = (self.options.first_connection, true);
        loop {
            let (ws, opened) = match next.take() {
                Some(opened) => opened,
                None => match self
                    .connect_with_retries(backoff, at_once, &mut closed, &mut route)
                    .await
                {
                    Some(opened) => opened,
                    None => break, // closed while waiting
                },
            };
            backoff = self.options.reconnection;
            self.set_connected(true);
            let end = self
                .serve(ws, &mut book, &mut receiver, &mut route, opened)
                .await;
            self.set_connected(false);
            match end {
                Served::Closed => break,
                Served::Dropped => at_once = false,
                // The other way, at once: nothing to wait out.
                Served::Moved => at_once = true,
            }
        }
    }

    /// Keep `connected` and tell `on_state`, on changes only.
    fn set_connected(&self, up: bool) {
        if self.connected.swap(up, Ordering::SeqCst) != up {
            if let Some(on_state) = &self.options.on_state {
                on_state(up);
            }
        }
    }

    /// Connect, pausing between attempts as `backoff` says, until it works;
    /// `None` once the client is closed. An attempt still going at the
    /// connect deadline counts as failed. A change of the route ends a
    /// pause, and a socket that opened after the route changed is closed
    /// and opened again the new way. Gives the socket and the mode it was
    /// opened in.
    async fn connect_with_retries(
        &self,
        backoff: Backoff,
        at_once: bool,
        closed: &mut watch::Receiver<bool>,
        route: &mut Option<watch::Receiver<Mode>>,
    ) -> Option<(WsStream, Option<Mode>)> {
        let mut pause = backoff.first;
        let mut wait = !at_once;
        loop {
            if wait {
                tokio::select! {
                    () = tokio::time::sleep(pause) => {}
                    () = route_changed(route) => {}
                    () = until_closed(closed) => return None,
                }
                pause = backoff.after(pause);
            }
            wait = true;
            let opened = route.as_mut().map(|r| *r.borrow_and_update());
            // With Tor, the deadline counts from when it is ready (§2.4).
            if let Some(ready) = &self.options.ready {
                tokio::select! {
                    () = ready() => {}
                    () = until_closed(closed) => return None,
                }
            }
            let deadline = self.options.connect_deadline;
            let attempt = tokio::select! {
                attempt = tokio::time::timeout(deadline, (self.options.connector)(self.url.clone())) => attempt,
                () = until_closed(closed) => return None,
            };
            match attempt {
                Ok(Ok(ws)) => {
                    let now = route.as_mut().map(|r| *r.borrow_and_update());
                    if now != opened {
                        // Opened the old way: dropped, and opened again now.
                        self.note("WS opened the old way, opening it again");
                        drop(ws);
                        wait = false;
                        continue;
                    }
                    self.note("WS connected");
                    return Some((ws, opened));
                }
                Ok(Err(_)) => {
                    self.note_with("WS connection failed", &[("retry_s", &pause.as_secs())])
                }
                Err(_) => {
                    self.note_with("WS connection timed out", &[("retry_s", &pause.as_secs())])
                }
            }
        }
    }

    /// Serve one socket, opened in mode `opened`, until it drops, the
    /// client is closed, or the route goes another way.
    async fn serve(
        &self,
        ws: WsStream,
        book: &mut SubscriptionBook,
        receiver: &mut mpsc::UnboundedReceiver<ClientCommand>,
        route: &mut Option<watch::Receiver<Mode>>,
        opened: Option<Mode>,
    ) -> Served {
        let (mut write, mut read) = ws.split();
        // Re-send the subscriptions so the fresh socket delivers events.
        for req in book.on_connected(unix_now()) {
            let _ = write.send(Message::Text(req)).await;
        }
        let mut ping = tokio::time::interval(Duration::from_secs(25));
        ping.tick().await; // discard the immediate first tick
        loop {
            let due = book.next_due();
            tokio::select! {
                incoming = read.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        match book.on_frame(Some(&text), unix_now()) {
                            SubAnswer::Eose(kinds) => self.options.caps.answered(&kinds),
                            SubAnswer::Closed(kinds, message) => {
                                self.note("REQ closed by the relay, dropped");
                                self.options.caps.refused(&kinds, &message);
                            }
                            SubAnswer::Nothing => {}
                        }
                        handle_relay_message(&text, &self.on_event, &self.pending_ok, self.options.quiet);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        book.on_frame(None, unix_now());
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        self.note("WS dropped, reconnecting");
                        return Served::Dropped;
                    }
                    // Pong / Binary / Frame: nothing to do, but the relay is
                    // evidently still there.
                    Some(Ok(_)) => {
                        book.on_frame(None, unix_now());
                    }
                    Some(Err(_)) => {
                        self.note("WS read error, reconnecting");
                        return Served::Dropped;
                    }
                },
                cmd = receiver.recv() => match cmd {
                    Some(ClientCommand::Send(text)) => {
                        self.queued.fetch_sub(1, Ordering::SeqCst);
                        if write.send(Message::Text(text)).await.is_err() {
                            return Served::Dropped; // socket dead → reconnect
                        }
                    }
                    Some(ClientCommand::Subscribe(sub)) => {
                        // Kept in the book even if this send fails, so the
                        // reconnect re-sends it.
                        let req = book.add(sub, unix_now());
                        if write.send(Message::Text(req)).await.is_err() {
                            return Served::Dropped; // socket dead → reconnect
                        }
                    }
                    Some(ClientCommand::Unsubscribe(id)) => {
                        if let Some(close) = book.remove(&id) {
                            if write.send(Message::Text(close)).await.is_err() {
                                return Served::Dropped; // socket dead → reconnect
                            }
                        }
                    }
                    Some(ClientCommand::Close) | None => {
                        let _ = write.close().await;
                        return Served::Closed; // shut down for good
                    }
                },
                () = until_due(due) => {
                    for (close, kinds) in book.expire(Instant::now()) {
                        self.note("REQ unanswered in time, closed");
                        self.options.caps.unanswered(&kinds, Instant::now());
                        if write.send(Message::Text(close)).await.is_err() {
                            return Served::Dropped; // socket dead → reconnect
                        }
                    }
                }
                () = route_moved(route, opened) => {
                    // The socket goes, and nothing more is sent the old way.
                    self.note("WS route changed, opening it again");
                    return Served::Moved;
                }
                _ = ping.tick() => {
                    if write.send(Message::Ping(Vec::new())).await.is_err() {
                        return Served::Dropped; // socket dead → reconnect
                    }
                }
            }
        }
    }
}

/// Resolves once the client is closed, or dropped.
async fn until_closed(closed: &mut watch::Receiver<bool>) {
    let _ = closed.wait_for(|closed| *closed).await;
}

/// How serving a socket ended.
enum Served {
    /// The client was closed.
    Closed,
    /// The socket dropped: open it again after a pause.
    Dropped,
    /// The route goes another way: open it again at once.
    Moved,
}

/// Resolves at the next change of `route`; never without one, or once its
/// `Net` is gone.
async fn route_changed(route: &mut Option<watch::Receiver<Mode>>) {
    let changed = match route {
        Some(route) => route.changed().await.is_ok(),
        None => false,
    };
    if !changed {
        futures_util::future::pending::<()>().await;
    }
}

/// Resolves once `route` goes a way other than `opened`.
async fn route_moved(route: &mut Option<watch::Receiver<Mode>>, opened: Option<Mode>) {
    loop {
        route_changed(route).await;
        let now = route.as_mut().map(|r| *r.borrow_and_update());
        if now != opened {
            return;
        }
    }
}

/// A line for the diagnostic log: fixed text only, and only debug builds
/// keep the log (diag.rs, T3). Nothing a relay sends ever goes in.
fn dlog(text: &'static str) {
    crate::diag::note(text);
}

/// The log line for a relay message of type `msg_type`, which the relay
/// chose: only the types NIP-01 defines are named.
fn relay_message_note(msg_type: &str) -> &'static str {
    match msg_type {
        "OK" => "WS recv: OK",
        "EOSE" => "WS recv: EOSE",
        "NOTICE" => "WS recv: NOTICE",
        "CLOSED" => "WS recv: CLOSED",
        "AUTH" => "WS recv: AUTH",
        _ => "WS recv: a message of another type",
    }
}

fn handle_relay_message(text: &str, on_event: &EventHandler, pending: &PendingOks, quiet: bool) {
    let dlog = |text: &'static str| {
        if !quiet {
            dlog(text);
        }
    };
    let Ok(msg) = serde_json::from_str::<Vec<Value>>(text) else {
        dlog("WS recv: a message that is not an array");
        return;
    };
    if msg.is_empty() {
        return;
    }
    let Some(msg_type) = msg[0].as_str() else {
        return;
    };

    if msg_type == "OK" {
        // ["OK", <event id>, <true|false>, <message>] (NIP-01), for an event
        // `publish_acked` waits on. Anything else is ignored.
        if let (Some(id), Some(accepted)) = (
            msg.get(1).and_then(Value::as_str),
            msg.get(2).and_then(Value::as_bool),
        ) {
            let message = msg.get(3).and_then(Value::as_str).map(str::to_string);
            if let Some(answer) = lock_pending(pending).remove(id) {
                let _ = answer.send((accepted, message));
            }
        }
        dlog(relay_message_note(msg_type));
    } else if msg_type == "EVENT" && msg.len() >= 3 {
        match serde_json::from_value::<NostrEvent>(msg[2].clone()) {
            Ok(event) => {
                let ok = verify_event(&event);
                if !quiet {
                    crate::diag::note_with("WS EVENT", &[("kind", &event.kind), ("verified", &ok)]);
                }
                if ok {
                    on_event(event);
                } else {
                    dlog("  -> verify_event FAILED (event dropped before handler)");
                }
            }
            Err(_) => dlog("WS EVENT deserialize failed"),
        }
    } else {
        dlog(relay_message_note(msg_type));
    }
}

/// A relay for tests: NIP-01 over a real WebSocket, enough for the clients
/// here and the sends in the app's commands.rs (through `test-util`). It is reached the way a relay is in
/// the app, through trino-net's `Net` in Tor mode, where Tor is an
/// in-memory pipe and the direct transport fails the test if anything
/// uses it.
#[cfg(any(test, feature = "test-util"))]
pub mod test_relay {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{LazyLock, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncWrite};
    use tokio::sync::Notify;
    use trino_net::mock::{Forbidden, Mock};

    /// The Tor of every test relay, and the `Net` on it.
    static TOR: LazyLock<(Arc<Mock>, Arc<Net>)> = LazyLock::new(|| {
        let tor = Mock::new();
        let net = Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn trino_net::Transport>),
            Arc::new(Forbidden),
        );
        (tor, net)
    });

    /// Names the test relays apart.
    static RELAYS: AtomicUsize = AtomicUsize::new(0);

    /// Relay WebSockets the way the app opens them, through the tests'
    /// `Net`.
    pub fn connector() -> Connector {
        relay_connector(Arc::clone(&TOR.1), TOR.1.session(), IsoKind::RELAY)
    }

    /// The tests' `Net`, in Tor mode and ready.
    pub fn net() -> Arc<Net> {
        Arc::clone(&TOR.1)
    }

    /// The tests' Tor: every connection asked of it, with its token.
    pub fn tor() -> Arc<Mock> {
        Arc::clone(&TOR.0)
    }

    /// How the relay answers an EVENT.
    #[derive(Clone, Debug)]
    pub enum Answer {
        /// `["OK", id, true, ""]`.
        Accept,
        /// `["OK", id, false, "blocked: …"]`.
        Reject,
        /// `["OK", id, false, "duplicate: …"]`: it had the event already.
        Duplicate,
        /// Nothing at all.
        Silent,
        /// Refuses the events addressed (`p`) to this pubkey, takes the rest.
        RejectTo(String),
        /// Never answers the events addressed to this pubkey, takes the rest.
        SilentTo(String),
        /// Takes each event once it is told to, one `notify_one` each.
        AcceptWhenReleased(Arc<Notify>),
    }

    /// How a test relay departs from NIP-01, as relays in the spike did.
    #[derive(Clone, Debug, Default)]
    pub struct Quirks {
        /// A REQ naming one of these kinds gets nothing back: no event, no
        /// EOSE, no CLOSED.
        pub silent_kinds: Vec<u32>,
        /// A REQ naming one of these kinds is CLOSED with this message.
        pub closed_kinds: Vec<(u32, String)>,
        /// A filter with both `until` and `limit` gets only the events whose
        /// `created_at` is exactly `until`: short pages.
        pub broken_paging: bool,
    }

    pub struct TestRelay {
        pub url: String,
        /// Its host, as the tests' Tor records the connections to it.
        pub host: String,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        reqs: Arc<StdMutex<Vec<(usize, Value)>>>,
        frames: Arc<StdMutex<Vec<Frame>>>,
        kicks: Arc<Notify>,
    }

    /// A REQ or CLOSE a relay received, with the number of its connection.
    #[derive(Clone, Debug, PartialEq)]
    pub enum Frame {
        /// `["REQ", id, filters…]`.
        Req(usize, String, Vec<Value>),
        /// `["CLOSE", id]`.
        Close(usize, String),
    }

    /// What every connection of one relay shares.
    #[derive(Clone)]
    struct Shared {
        answer: Answer,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        reqs: Arc<StdMutex<Vec<(usize, Value)>>>,
        frames: Arc<StdMutex<Vec<Frame>>>,
        kicks: Arc<Notify>,
        /// Whether it hands its events to the subscriptions that match.
        serving: bool,
        quirks: Quirks,
        live: tokio::sync::broadcast::Sender<NostrEvent>,
    }

    impl TestRelay {
        /// A relay that keeps what it gets and answers, and gives nothing to
        /// any subscription but its EOSE.
        pub async fn start(answer: Answer) -> Self {
            Self::start_on(&TOR.0, answer, false)
        }

        /// A relay that also hands each subscription the events it keeps,
        /// and the ones that come later, that match its kinds and `#p`.
        pub async fn serving(answer: Answer) -> Self {
            Self::start_on(&TOR.0, answer, true)
        }

        /// A relay reached through `tor`.
        pub fn start_on(tor: &Mock, answer: Answer, serving: bool) -> Self {
            Self::start_named(tor, &Self::new_host(), answer, serving)
        }

        /// A host no test relay has had: one to start a relay on later.
        pub fn new_host() -> String {
            format!(
                "relay-{}.trino.invalid",
                RELAYS.fetch_add(1, Ordering::SeqCst)
            )
        }

        /// A relay at `host`, reached through `tor`: one that comes up late.
        pub fn start_named(tor: &Mock, host: &str, answer: Answer, serving: bool) -> Self {
            Self::start_full(tor, host, answer, serving, Quirks::default())
        }

        /// A serving relay with these quirks.
        pub fn quirky(answer: Answer, quirks: Quirks) -> Self {
            Self::start_full(&TOR.0, &Self::new_host(), answer, true, quirks)
        }

        fn start_full(
            tor: &Mock,
            host: &str,
            answer: Answer,
            serving: bool,
            quirks: Quirks,
        ) -> Self {
            let host = host.to_string();
            let mut listener = tor.listen(&host, 80);
            let url = format!("ws://{host}");
            let shared = Shared {
                answer,
                events: Arc::default(),
                reqs: Arc::default(),
                frames: Arc::default(),
                kicks: Arc::new(Notify::new()),
                serving,
                quirks,
                live: tokio::sync::broadcast::channel(64).0,
            };
            let relay = TestRelay {
                url,
                host,
                events: Arc::clone(&shared.events),
                reqs: Arc::clone(&shared.reqs),
                frames: Arc::clone(&shared.frames),
                kicks: Arc::clone(&shared.kicks),
            };
            tokio::spawn(async move {
                let mut connections = 0;
                while let Some(io) = listener.accept().await {
                    connections += 1;
                    tokio::spawn(serve(io, shared.clone(), connections));
                }
            });
            relay
        }

        /// The events it received, in order.
        pub fn events(&self) -> Vec<NostrEvent> {
            self.events.lock().unwrap().clone()
        }

        /// Every REQ it received, in order: the number of its connection,
        /// counted from 1, and its filter.
        pub fn reqs(&self) -> Vec<(usize, Value)> {
            self.reqs.lock().unwrap().clone()
        }

        /// Every REQ and CLOSE it received, in order, with all their filters.
        pub fn frames(&self) -> Vec<Frame> {
            self.frames.lock().unwrap().clone()
        }

        /// Keep `event` as if it had been published to it, without telling
        /// the subscriptions open now.
        pub fn store(&self, event: NostrEvent) {
            self.events.lock().unwrap().push(event);
        }

        /// Close every connection it has, as a relay restarting would.
        pub fn kick(&self) {
            self.kicks.notify_waiters();
        }

        /// A messaging client of this relay, once its socket is up.
        pub async fn client(&self) -> Arc<NostrClient> {
            let client = NostrClient::start(&self.url, Arc::new(|_| {}), quick_options(None));
            wait_until("the client to connect", || client.is_connected()).await;
            client
        }
    }

    /// Whether `event` matches `filter`, by its kinds, `#p`, `since` and
    /// `until` (a REQ applies `limit`).
    fn matches(filter: &Value, event: &NostrEvent) -> bool {
        let listed = |field: &str, wanted: Value| {
            filter
                .get(field)
                .and_then(Value::as_array)
                .is_none_or(|values| values.contains(&wanted))
        };
        let since = filter.get("since").and_then(Value::as_i64);
        let until = filter.get("until").and_then(Value::as_i64);
        listed("kinds", Value::from(event.kind))
            && listed("#p", Value::from(event.recipient().unwrap_or_default()))
            && since.is_none_or(|since| event.created_at >= since)
            && until.is_none_or(|until| event.created_at <= until)
    }

    /// Whether `event` matches any of `filters`.
    fn matches_any(filters: &[Value], event: &NostrEvent) -> bool {
        filters.iter().any(|filter| matches(filter, event))
    }

    /// The kept events a REQ with `filters` gets: each filter's matches,
    /// newest first and at most its `limit`, as relays send them.
    fn stored_for(filters: &[Value], kept: &[NostrEvent], quirks: &Quirks) -> Vec<NostrEvent> {
        let mut out: Vec<NostrEvent> = Vec::new();
        for filter in filters {
            let until = filter.get("until").and_then(Value::as_i64);
            let short = quirks.broken_paging && filter.get("limit").is_some();
            let mut found: Vec<&NostrEvent> = kept
                .iter()
                .filter(|e| matches(filter, e))
                .filter(|e| !short || until.is_none_or(|until| e.created_at == until))
                .collect();
            found.sort_by_key(|e| std::cmp::Reverse(e.created_at));
            let limit = filter
                .get("limit")
                .and_then(Value::as_u64)
                .map_or(usize::MAX, |l| l as usize);
            for event in found.into_iter().take(limit) {
                if !out.iter().any(|seen| seen.id == event.id) {
                    out.push(event.clone());
                }
            }
        }
        out
    }

    async fn serve(io: impl AsyncRead + AsyncWrite + Unpin, shared: Shared, connection: usize) {
        let Ok(ws) = tokio_tungstenite::accept_async(io).await else {
            return;
        };
        let Shared {
            answer,
            events,
            reqs,
            frames,
            kicks,
            serving,
            quirks,
            live,
        } = shared;
        let mut later = live.subscribe();
        let mut subs: Vec<(Value, Vec<Value>)> = Vec::new();
        let (mut write, mut read) = ws.split();
        loop {
            let message = tokio::select! {
                message = read.next() => message,
                () = kicks.notified() => {
                    let _ = write.close().await;
                    return;
                }
                Ok(event) = later.recv(), if serving => {
                    for (id, filters) in &subs {
                        if matches_any(filters, &event) {
                            let frame = serde_json::json!(["EVENT", id, event]).to_string();
                            if write.send(Message::Text(frame)).await.is_err() {
                                return;
                            }
                        }
                    }
                    continue;
                }
            };
            let Some(Ok(message)) = message else {
                return;
            };
            let Message::Text(text) = message else {
                continue;
            };
            let Ok(frame) = serde_json::from_str::<Vec<Value>>(&text) else {
                continue;
            };
            let reply = match frame.first().and_then(Value::as_str) {
                Some("EVENT") => {
                    let Some(event) = frame
                        .get(1)
                        .and_then(|e| serde_json::from_value::<NostrEvent>(e.clone()).ok())
                    else {
                        continue;
                    };
                    events.lock().unwrap().push(event.clone());
                    if serving {
                        let _ = live.send(event.clone());
                    }
                    let (ok, message) = match &answer {
                        Answer::Accept => (true, ""),
                        Answer::Reject => (false, "blocked: test"),
                        Answer::Duplicate => (false, "duplicate: already have this event"),
                        Answer::Silent => continue,
                        Answer::RejectTo(pubkey) if event.recipient() == Some(pubkey) => {
                            (false, "blocked: test")
                        }
                        Answer::RejectTo(_) => (true, ""),
                        Answer::SilentTo(pubkey) if event.recipient() == Some(pubkey) => continue,
                        Answer::SilentTo(_) => (true, ""),
                        Answer::AcceptWhenReleased(release) => {
                            release.notified().await;
                            (true, "")
                        }
                    };
                    Some(serde_json::json!(["OK", event.id, ok, message]))
                }
                Some("REQ") => {
                    let id = frame.get(1).cloned().unwrap_or_default();
                    let filters: Vec<Value> = frame.iter().skip(2).cloned().collect();
                    let first = filters.first().cloned().unwrap_or_default();
                    reqs.lock().unwrap().push((connection, first));
                    frames.lock().unwrap().push(Frame::Req(
                        connection,
                        id.as_str().unwrap_or_default().to_string(),
                        filters.clone(),
                    ));
                    let names = |kind: &u32| {
                        filters.iter().any(|f| {
                            f.get("kinds")
                                .and_then(Value::as_array)
                                .is_some_and(|kinds| kinds.contains(&Value::from(*kind)))
                        })
                    };
                    if quirks.silent_kinds.iter().any(names) {
                        continue;
                    }
                    if let Some((_, message)) = quirks.closed_kinds.iter().find(|(k, _)| names(k)) {
                        let closed = serde_json::json!(["CLOSED", id, message]).to_string();
                        if write.send(Message::Text(closed)).await.is_err() {
                            return;
                        }
                        continue;
                    }
                    if serving {
                        let kept = events.lock().unwrap().clone();
                        for event in stored_for(&filters, &kept, &quirks) {
                            let frame = serde_json::json!(["EVENT", id, event]).to_string();
                            if write.send(Message::Text(frame)).await.is_err() {
                                return;
                            }
                        }
                        // A REQ under an id already open replaces it (NIP-01).
                        subs.retain(|(open, _)| *open != id);
                        subs.push((id.clone(), filters));
                    }
                    Some(serde_json::json!(["EOSE", id]))
                }
                Some("CLOSE") => {
                    let id = frame.get(1).cloned().unwrap_or_default();
                    frames.lock().unwrap().push(Frame::Close(
                        connection,
                        id.as_str().unwrap_or_default().to_string(),
                    ));
                    subs.retain(|(open, _)| *open != id);
                    None
                }
                _ => None,
            };
            if let Some(reply) = reply {
                if write.send(Message::Text(reply.to_string())).await.is_err() {
                    return;
                }
            }
        }
    }

    /// Pauses short enough for retries to happen within a test.
    pub const QUICK: Backoff = Backoff {
        first: Duration::from_millis(10),
        max: Duration::from_millis(40),
    };

    pub fn quick_options(on_state: Option<StateHandler>) -> ClientOptions {
        ClientOptions {
            connector: connector(),
            first_connection: QUICK,
            reconnection: QUICK,
            // Short, yet long enough for a loaded machine to finish a
            // handshake over the in-memory pipe.
            connect_deadline: Duration::from_secs(1),
            ready: None,
            route: None,
            on_state,
            quiet: false,
            caps: RelayCaps::new(),
            answer_deadline: Some(Duration::from_secs(5)),
        }
    }

    /// A connector that never connects, counting its attempts.
    pub fn refusing_connector(attempts: Arc<AtomicUsize>) -> Connector {
        Arc::new(move |_url| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("refused".to_string()) })
        })
    }

    /// A client that keeps failing to connect, with its attempts counted.
    pub fn unreachable_client(attempts: Arc<AtomicUsize>) -> Arc<NostrClient> {
        let options = ClientOptions {
            connector: refusing_connector(attempts),
            ..quick_options(None)
        };
        NostrClient::start("ws://127.0.0.1:9", Arc::new(|_| {}), options)
    }

    /// Wait until `done`, or fail the test after 5 s.
    pub async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {what}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::generate_nostr_keypair;

    #[test]
    fn build_and_verify_event_roundtrip() {
        let kp = generate_nostr_keypair();
        let event = build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            TRINO_KIND,
            "hello nostr",
            vec![vec!["t".to_string(), "test".to_string()]],
            Some(1700000000),
        )
        .unwrap();
        assert_eq!(event.kind, TRINO_KIND);
        assert_eq!(event.content, "hello nostr");
        assert_eq!(event.pubkey.len(), 64);
        assert_eq!(event.sig.len(), 128);
        assert!(verify_event(&event));
    }

    #[test]
    fn tampered_content_fails_verification() {
        let kp = generate_nostr_keypair();
        let mut event = build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            TRINO_KIND,
            "original",
            vec![],
            Some(1700000000),
        )
        .unwrap();
        event.content = "tampered".to_string();
        assert!(!verify_event(&event));
    }

    #[test]
    fn event_id_serialization_and_verify_roundtrip() {
        // Synthetic vector (freshly generated keys, no real user data): checks
        // the NIP-01 id serialization AND BIP340 sign/verify agree. Both Rust and
        // the TS client follow the same standards, so this covers interop without
        // embedding anyone's real pubkey in the repo.
        let kp = generate_nostr_keypair();
        let event = build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            TRINO_KIND,
            r#"{"header":{"dhPub":"00","pn":0,"n":1},"nonce":"00","ciphertext":"00"}"#,
            vec![vec!["p".to_string(), "00".repeat(32)]],
            Some(1_782_857_351),
        )
        .unwrap();
        let serialized = serde_json::json!([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ])
        .to_string();
        let recomputed = hex::encode(sha256(serialized.as_bytes()));
        assert_eq!(recomputed, event.id, "id serialization mismatch");
        assert!(
            verify_event(&event),
            "must verify a BIP340-signed Nostr event"
        );
    }

    fn tagged(tags: Vec<Vec<String>>) -> NostrEvent {
        let kp = generate_nostr_keypair();
        build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            TRINO_KIND,
            "x",
            tags,
            Some(1),
        )
        .unwrap()
    }

    #[test]
    fn recipient_is_the_first_p_tag() {
        let tag = |k: &str, v: &str| vec![k.to_string(), v.to_string()];
        assert_eq!(
            tagged(vec![tag("t", "x"), tag("p", "aa"), tag("p", "bb")]).recipient(),
            Some("aa")
        );
        assert_eq!(tagged(vec![tag("t", "x")]).recipient(), None);
        assert_eq!(tagged(vec![vec!["p".to_string()]]).recipient(), None);
    }

    #[test]
    fn what_a_relay_sends_never_reaches_the_log() {
        // A relay controls this text. It used to be sliced into log lines,
        // where a cut mid-character panicked and killed the connection task
        // for good; now only fixed names go in (T3).
        assert_eq!(relay_message_note("EOSE"), "WS recv: EOSE");
        for chosen in [
            format!("{}ñ and more", "a".repeat(59)),
            "NOTICE: ana@example.org said hi".to_string(),
            String::new(),
        ] {
            assert_eq!(
                relay_message_note(&chosen),
                "WS recv: a message of another type"
            );
        }
    }

    // ---- Catch-up subscriptions ----

    const T: i64 = 1_760_000_000;
    const DAY: i64 = 86_400;
    const CATCH_UP: CatchUp = CatchUp {
        max_window_secs: DAY,
        overlap_secs: 600,
    };

    fn catch_up_sub(id: &str) -> Subscription {
        Subscription {
            id: id.to_string(),
            filters: vec![NostrFilter {
                kinds: Some(vec![TRINO_KIND]),
                p_tag: Some(vec!["aa".repeat(32)]),
                ..Default::default()
            }],
            catch_up: Some(CATCH_UP),
        }
    }

    fn since_of(req: &str) -> Option<i64> {
        let v: Value = serde_json::from_str(req).unwrap();
        v[2]["since"].as_i64()
    }

    fn eose(id: &str) -> String {
        serde_json::json!(["EOSE", id]).to_string()
    }

    #[test]
    fn catch_up_since_starts_at_the_last_sync_and_stays_in_the_window() {
        assert_eq!(catch_up_since(T, None, CATCH_UP), T - DAY);
        assert_eq!(catch_up_since(T, Some(T - 3600), CATCH_UP), T - 3600 - 600);
        assert_eq!(catch_up_since(T, Some(T - 5 * DAY), CATCH_UP), T - DAY);
        // A sync point ahead of the clock never pushes `since` past now.
        assert_eq!(catch_up_since(T, Some(T + DAY), CATCH_UP), T - 600);
    }

    #[test]
    fn the_first_request_asks_for_the_whole_window() {
        let mut book = SubscriptionBook::default();
        assert_eq!(since_of(&book.add(catch_up_sub("s1"), T)), Some(T - DAY));
    }

    #[test]
    fn a_reconnect_asks_only_for_what_may_have_been_missed() {
        let mut book = SubscriptionBook::default();
        book.add(catch_up_sub("s1"), T);
        book.on_frame(Some(&eose("s1")), T + 1);
        book.on_frame(None, T + 3600); // a pong an hour later: still live

        let reqs = book.on_connected(T + 3 * 3600); // dropped, back 2h later
        assert_eq!(reqs.len(), 1);
        assert_eq!(since_of(&reqs[0]), Some(T + 3600 - 600));
    }

    #[test]
    fn the_window_does_not_grow_with_uptime() {
        let mut book = SubscriptionBook::default();
        book.add(catch_up_sub("s1"), T);
        book.on_frame(Some(&eose("s1")), T + 1);
        for day in 1..=5 {
            book.on_frame(None, T + day * DAY);
        }
        let reqs = book.on_connected(T + 5 * DAY + 60);
        assert_eq!(since_of(&reqs[0]), Some(T + 5 * DAY - 600));
    }

    #[test]
    fn a_connection_that_never_caught_up_moves_nothing_forward() {
        // Relays send stored events newest first. A socket that drops before
        // EOSE may have skipped older ones, so the next one must ask again
        // from the same point, whatever the events it did deliver said.
        let mut book = SubscriptionBook::default();
        book.add(catch_up_sub("s1"), T);
        book.on_frame(Some(&eose("s1")), T + 100);

        let reqs = book.on_connected(T + 200);
        assert_eq!(since_of(&reqs[0]), Some(T + 100 - 600));
        book.on_frame(Some(r#"["EVENT","s1",{}]"#), T + 300); // no EOSE yet
        book.on_frame(Some(&eose("other")), T + 350); // not ours

        let reqs = book.on_connected(T + 400);
        assert_eq!(since_of(&reqs[0]), Some(T + 100 - 600));
    }

    #[test]
    fn plain_subscriptions_are_resent_unchanged() {
        let mut book = SubscriptionBook::default();
        let filter = NostrFilter {
            kinds: Some(vec![TRINO_KIND]),
            limit: Some(40),
            ..Default::default()
        };
        let first = book.add(
            Subscription {
                id: "i1".to_string(),
                filters: vec![filter],
                catch_up: None,
            },
            T,
        );
        assert_eq!(since_of(&first), None);
        assert_eq!(book.on_connected(T + DAY), vec![first]);
    }

    #[test]
    fn tampered_signature_fails_verification() {
        let kp = generate_nostr_keypair();
        let mut event = build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            TRINO_KIND,
            "real",
            vec![],
            Some(1700000000),
        )
        .unwrap();
        event.sig = "0".repeat(128);
        assert!(!verify_event(&event));
    }

    // ---- K3: the first connection is retried, and the state is known ----

    use super::test_relay::{
        self, quick_options, unreachable_client, wait_until, Answer, TestRelay,
    };
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use trino_net::mock::Mock;
    use trino_net::Mode;

    fn ignore_events() -> EventHandler {
        Arc::new(|_| {})
    }

    /// The lines a client of a test relay logs while it connects,
    /// subscribes, publishes and closes, on a runtime of this thread (the
    /// capture is the thread's).
    fn lines_of_a_client(quiet: bool) -> Vec<String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let ((), lines) = crate::diag::capture::lines(|| {
            runtime.block_on(async {
                let relay = TestRelay::start(Answer::Accept).await;
                let options = ClientOptions {
                    quiet,
                    ..quick_options(None)
                };
                let client = NostrClient::start(&relay.url, ignore_events(), options);
                wait_until("the client to connect", || client.is_connected()).await;
                client.subscribe(&NostrFilter::default()).await.unwrap();
                let me = crate::identity::create_identity();
                let event = build_and_sign_event(
                    &me.nostr.priv_bytes,
                    &me.nostr.pub_bytes,
                    TRINO_KIND,
                    "x",
                    vec![],
                    None,
                )
                .unwrap();
                assert_eq!(
                    client.publish_acked(&event, Duration::from_secs(5)).await,
                    Ack::Accepted
                );
                client.close();
                tokio::time::sleep(Duration::from_millis(50)).await;
            })
        });
        lines
    }

    /// Clave de emergencia RC-03: the warning's connection writes no line
    /// of the log, so the emergency path leaves a real unlock's notes only.
    #[test]
    fn a_quiet_client_writes_no_line_of_the_log() {
        assert!(!lines_of_a_client(false).is_empty(), "the capture works");
        let lines = lines_of_a_client(true);
        assert!(lines.is_empty(), "{lines:?}");
    }

    /// A state handler, and what it heard.
    fn recorder() -> (StateHandler, Arc<StdMutex<Vec<bool>>>) {
        let heard = Arc::new(StdMutex::new(Vec::new()));
        let log = Arc::clone(&heard);
        let handler: StateHandler = Arc::new(move |up| log.lock().unwrap().push(up));
        (handler, heard)
    }

    #[tokio::test]
    async fn a_first_connection_that_fails_is_tried_again() {
        let relay = TestRelay::start(Answer::Accept).await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let real = test_relay::connector();
        // Refused once, like a relay that is down at unlock and back later.
        let connector: Connector = Arc::new(move |url| {
            if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                Box::pin(async { Err("refused".to_string()) })
            } else {
                real(url)
            }
        });
        let (handler, heard) = recorder();
        let options = ClientOptions {
            connector,
            ..quick_options(Some(handler))
        };

        let client = NostrClient::start(&relay.url, ignore_events(), options);

        wait_until("the second attempt to connect", || client.is_connected()).await;
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(*heard.lock().unwrap(), [true]);
        assert_eq!(client.url(), relay.url);
        client.close();
    }

    #[test]
    fn the_pause_between_first_attempts_doubles_from_2_s_to_60_s() {
        let mut pause = FIRST_CONNECTION.first;
        let mut pauses = vec![pause.as_secs()];
        for _ in 0..6 {
            pause = FIRST_CONNECTION.after(pause);
            pauses.push(pause.as_secs());
        }
        assert_eq!(pauses, [2, 4, 8, 16, 32, 60, 60]);
        // A dropped connection keeps the pace it always had.
        assert_eq!(
            RECONNECTION,
            Backoff {
                first: Duration::from_secs(1),
                max: Duration::from_secs(30)
            }
        );
    }

    #[tokio::test]
    async fn closing_a_client_stops_its_attempts() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let client = unreachable_client(Arc::clone(&attempts));
        wait_until("a few attempts", || attempts.load(Ordering::SeqCst) >= 3).await;

        client.close();
        tokio::time::sleep(Duration::from_millis(50)).await;
        let after_close = attempts.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(250)).await;

        assert_eq!(
            attempts.load(Ordering::SeqCst),
            after_close,
            "it kept trying after close"
        );
        assert!(!client.is_connected());
    }

    #[tokio::test]
    async fn the_state_handler_hears_the_socket_come_back_after_a_drop() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (handler, heard) = recorder();
        let client = NostrClient::start(&relay.url, ignore_events(), quick_options(Some(handler)));
        wait_until("the first connection", || client.is_connected()).await;

        relay.kick();

        wait_until("the drop and the reconnection", || {
            heard.lock().unwrap().len() >= 3
        })
        .await;
        assert_eq!(heard.lock().unwrap()[..3], [true, false, true]);
        assert!(client.is_connected());

        client.close();
        wait_until("the close", || !client.is_connected()).await;
        wait_until("the handler to hear it", || {
            heard.lock().unwrap().len() == 4
        })
        .await;
        assert_eq!(*heard.lock().unwrap(), [true, false, true, false]);
    }

    #[tokio::test]
    async fn what_is_sent_before_the_first_connection_goes_out_once_it_is_up() {
        let relay = TestRelay::start(Answer::Accept).await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let real = test_relay::connector();
        let connector: Connector = Arc::new(move |url| {
            if counted.fetch_add(1, Ordering::SeqCst) < 2 {
                Box::pin(async { Err("refused".to_string()) })
            } else {
                real(url)
            }
        });
        let options = ClientOptions {
            connector,
            ..quick_options(None)
        };
        let client = NostrClient::start(&relay.url, ignore_events(), options);

        // Asked for while it cannot connect yet: kept, and sent later.
        client
            .subscribe(&NostrFilter {
                kinds: Some(vec![TRINO_KIND]),
                ..Default::default()
            })
            .await
            .unwrap();
        let event = {
            let kp = generate_nostr_keypair();
            build_and_sign_event(&kp.priv_bytes, &kp.pub_bytes, TRINO_KIND, "x", vec![], None)
                .unwrap()
        };
        client.publish(&event).await.unwrap();

        wait_until("the queued event to arrive", || relay.events().len() == 1).await;
        assert_eq!(relay.events()[0].id, event.id);
        client.close();
    }

    // ---- Tor design §3 R1/R2: relays go through trino-net ----

    /// Design test 13 (§2.4): a relay's first attempt waits for Tor to be
    /// ready, and only then does its deadline count. Without the wait it
    /// would fail with TorNotReady at once and be tried again only after
    /// its pause (here 10 s).
    ///
    /// On tokio's paused clock: time moves only while nothing in the test
    /// has work to do, so the in-memory handshake after Tor is ready never
    /// runs into the 300 ms deadline, however loaded the machine is. On the
    /// real clock it did, about once in six runs under load (TOR-12).
    #[tokio::test(start_paused = true)]
    async fn a_relay_deadline_starts_when_tor_is_ready() {
        use crate::fsutil::scratch::ScratchDir;
        use crate::testing::fake_tor;

        let scratch = ScratchDir::new("relay-ready");
        let (net, fake, tor) = fake_tor(&scratch.path().join("tor"));
        let mut server = tor.listen("relay.trino.invalid", 80);
        tokio::spawn(async move {
            while let Some(io) = server.accept().await {
                // The socket stays open until the client closes it: one
                // the relay dropped at once would be connected only for
                // an instant, which the test could miss.
                tokio::spawn(async move {
                    if let Ok(mut ws) = tokio_tungstenite::accept_async(io).await {
                        while let Some(Ok(_)) = ws.next().await {}
                    }
                });
            }
        });
        net.start();
        let attempts = Arc::new(AtomicUsize::new(0));
        let real = relay_connector(Arc::clone(&net), net.session(), IsoKind::RELAY);
        let counted = Arc::clone(&attempts);
        let connector: Connector = Arc::new(move |url| {
            counted.fetch_add(1, Ordering::SeqCst);
            real(url)
        });
        let slow = Backoff {
            first: Duration::from_secs(10),
            max: Duration::from_secs(10),
        };
        let options = ClientOptions {
            connector,
            first_connection: slow,
            reconnection: slow,
            connect_deadline: Duration::from_millis(300),
            ready: Some(ready_gate(Arc::clone(&net))),
            route: None,
            on_state: None,
            quiet: false,
            caps: RelayCaps::new(),
            answer_deadline: None,
        };

        let client = NostrClient::start("ws://relay.trino.invalid", ignore_events(), options);
        // Tor takes longer to start than the relay's deadline.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            0,
            "tried before Tor was ready"
        );
        fake.ready();
        // Tor's state comes from a thread of its own, which the paused
        // clock does not wait for: waited for without a timer, so the
        // clock stays where it is meanwhile.
        within_real_time(
            Duration::from_secs(10),
            "Tor to be ready",
            net.until_ready(),
        )
        .await;

        wait_until("the relay once Tor is ready", || client.is_connected()).await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        client.close();
        net.stop();
    }

    /// `future`, failing the test once it has taken `limit` of real time:
    /// for what another thread does, which a paused clock does not wait
    /// for and no tokio timer can bound.
    async fn within_real_time<T>(
        limit: Duration,
        what: &str,
        future: impl std::future::Future<Output = T>,
    ) -> T {
        let (expired, expiry) = tokio::sync::oneshot::channel::<()>();
        std::thread::spawn(move || {
            std::thread::sleep(limit);
            let _ = expired.send(());
        });
        tokio::select! {
            out = future => out,
            _ = expiry => panic!("timed out waiting for {what}"),
        }
    }

    /// Tor design §3 R1: a relay with an onion is reached there first,
    /// through Tor (trino-net's onion_map).
    #[tokio::test]
    async fn the_relay_connector_tries_a_relays_onion_first() {
        let (tor, direct) = (Mock::new(), Mock::new());
        let net = net_on(Some(&tor), &direct);
        let connector = relay_connector(Arc::clone(&net), net.session(), IsoKind::RELAY);

        assert!(connector("wss://relay.trinochat.org".to_string())
            .await
            .is_err());

        let hosts: Vec<String> = tor
            .connections()
            .into_iter()
            .map(|(target, _)| target.host)
            .collect();
        assert_eq!(hosts.len(), 2);
        assert!(hosts[0].ends_with(".onion"), "{hosts:?}");
        assert_eq!(hosts[1], "relay.trinochat.org");
        assert!(direct.connections().is_empty());
        assert_eq!(
            relay_deadline("wss://relay.trinochat.org"),
            trino_net::onion_map::ONION_DEADLINE + CONNECT_DEADLINE
        );
        assert_eq!(relay_deadline("wss://nos.lol"), CONNECT_DEADLINE);
    }

    /// A `Net` whose Tor is `tor` and whose direct transport is `direct`.
    fn net_on(tor: Option<&Arc<Mock>>, direct: &Arc<Mock>) -> Arc<Net> {
        Net::with_transports(
            tor.map(|t| Arc::clone(t) as Arc<dyn trino_net::Transport>),
            Arc::clone(direct) as Arc<dyn trino_net::Transport>,
        )
    }

    #[tokio::test]
    async fn a_relay_is_reached_through_tor_by_name_with_its_own_token() {
        let (tor, direct) = (Mock::new(), Mock::new());
        let mut server = tor.listen("relay.trino.invalid", 80);
        tokio::spawn(async move {
            while let Some(io) = server.accept().await {
                tokio::spawn(tokio_tungstenite::accept_async(io));
            }
        });
        let net = net_on(Some(&tor), &direct);
        let session = net.session();
        let url = "ws://relay.trino.invalid";
        let options = ClientOptions {
            connector: relay_connector(Arc::clone(&net), session.clone(), IsoKind::RELAY),
            ..quick_options(None)
        };

        let client = NostrClient::start(url, ignore_events(), options);

        wait_until("the relay over Tor", || client.is_connected()).await;
        let seen = tor.connections();
        assert_eq!(seen[0].0, trino_net::Target::new("relay.trino.invalid", 80));
        assert_eq!(seen[0].1, session.iso(IsoKind::RELAY, url));
        assert!(direct.connections().is_empty(), "a relay went direct");
        client.close();
    }

    #[tokio::test]
    async fn with_tor_not_ready_a_relay_keeps_waiting_and_never_goes_direct() {
        let direct = Mock::new();
        let _never = direct.listen("relay.trino.invalid", 80);
        let net = net_on(None, &direct);
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let through_net = relay_connector(net, Net::new().session(), IsoKind::RELAY);
        let connector: Connector = Arc::new(move |url| {
            counted.fetch_add(1, Ordering::SeqCst);
            through_net(url)
        });
        let options = ClientOptions {
            connector,
            ..quick_options(None)
        };

        let client = NostrClient::start("ws://relay.trino.invalid", ignore_events(), options);

        wait_until("a few attempts", || attempts.load(Ordering::SeqCst) >= 3).await;
        assert!(!client.is_connected());
        assert!(direct.connections().is_empty(), "a relay went direct");
        client.close();
    }

    #[tokio::test]
    async fn the_inspector_never_shares_a_token_with_the_relays() {
        // Design §2.7: the inspector's connection to a relay is its own.
        let (tor, direct) = (Mock::new(), Mock::new());
        let net = net_on(Some(&tor), &direct);
        let session = net.session();
        let url = "wss://relay.trino.invalid".to_string();

        let _ = inspector_connector(Arc::clone(&net), session.clone())(url.clone()).await;
        let _ = relay_connector(net, session, IsoKind::RELAY)(url).await;

        let seen = tor.connections();
        assert_eq!(seen[0].1.kind(), IsoKind::INSPECTOR);
        assert_ne!(seen[0].1, seen[1].1);
    }

    // ---- Tor design §2.8 and test 15: a socket follows the route ----

    /// A connector that reaches `on_tor` while `route` says Tor and
    /// `direct` while it says Direct, noting the mode of each attempt. The
    /// app's is `relay_connector` over the `Net` whose `route` this is.
    fn routed_connector(
        route: watch::Receiver<Mode>,
        on_tor: &TestRelay,
        direct: &TestRelay,
        attempts: Arc<StdMutex<Vec<Mode>>>,
    ) -> Connector {
        let real = test_relay::connector();
        let (on_tor, direct) = (on_tor.url.clone(), direct.url.clone());
        Arc::new(move |_url| {
            let mode = *route.borrow();
            attempts.lock().unwrap().push(mode);
            real(match mode {
                Mode::Tor => on_tor.clone(),
                Mode::Direct => direct.clone(),
            })
        })
    }

    #[tokio::test]
    async fn an_open_relay_socket_is_opened_again_when_the_mode_changes() {
        let (on_tor, direct) = (
            TestRelay::start(Answer::Accept).await,
            TestRelay::start(Answer::Accept).await,
        );
        let (mode, route) = watch::channel(Mode::Tor);
        let attempts = Arc::new(StdMutex::new(Vec::new()));
        let options = ClientOptions {
            connector: routed_connector(route.clone(), &on_tor, &direct, Arc::clone(&attempts)),
            route: Some(route),
            // A drop pauses a long time first: a move must not wait for it.
            reconnection: Backoff {
                first: Duration::from_secs(30),
                max: Duration::from_secs(30),
            },
            ..quick_options(None)
        };
        let client = NostrClient::start("ws://relay.trino.invalid", ignore_events(), options);
        wait_until("the socket through Tor", || client.is_connected()).await;
        client.publish(&some_event()).await.unwrap();
        wait_until("the event through Tor", || on_tor.events().len() == 1).await;

        // "Conectar sin protección": the socket opened through Tor goes, and
        // a new one opens the other way, at once.
        mode.send(Mode::Direct).unwrap();
        wait_until("an attempt without Tor", || {
            attempts.lock().unwrap().last() == Some(&Mode::Direct)
        })
        .await;
        wait_until("the socket without Tor", || client.is_connected()).await;
        client.publish(&some_event()).await.unwrap();
        wait_until("the event without Tor", || direct.events().len() == 1).await;

        // "Volver a conectarse de forma privada": back through Tor, and
        // nothing more goes the direct way.
        mode.send(Mode::Tor).unwrap();
        wait_until("an attempt through Tor again", || {
            attempts.lock().unwrap().last() == Some(&Mode::Tor)
        })
        .await;
        wait_until("the socket through Tor again", || client.is_connected()).await;
        client.publish(&some_event()).await.unwrap();
        wait_until("the event through Tor again", || on_tor.events().len() == 2).await;
        assert_eq!(direct.events().len(), 1, "an event went the old way");
        assert_eq!(
            *attempts.lock().unwrap(),
            [Mode::Tor, Mode::Direct, Mode::Tor]
        );
        client.close();
    }

    #[tokio::test]
    async fn a_socket_that_opens_after_the_mode_changed_is_opened_again() {
        // An attempt begun through Tor that ends after "Conectar sin
        // protección" (or the other way) must not stay up the old way.
        let (on_tor, direct) = (
            TestRelay::start(Answer::Accept).await,
            TestRelay::start(Answer::Accept).await,
        );
        let (mode, route) = watch::channel(Mode::Tor);
        let attempts = Arc::new(StdMutex::new(Vec::new()));
        let release = Arc::new(tokio::sync::Notify::new());
        let routed = routed_connector(route.clone(), &on_tor, &direct, Arc::clone(&attempts));
        let gate = Arc::clone(&release);
        let connector: Connector = Arc::new(move |url| {
            let (attempt, gate) = (routed(url), Arc::clone(&gate));
            Box::pin(async move {
                let ws = attempt.await;
                gate.notified().await;
                ws
            })
        });
        let options = ClientOptions {
            connector,
            route: Some(route),
            connect_deadline: Duration::from_secs(5),
            ..quick_options(None)
        };
        let client = NostrClient::start("ws://relay.trino.invalid", ignore_events(), options);
        wait_until("the first attempt", || attempts.lock().unwrap().len() == 1).await;

        mode.send(Mode::Direct).unwrap();
        release.notify_one();
        wait_until("an attempt without Tor", || {
            attempts.lock().unwrap().len() == 2
        })
        .await;
        assert!(
            !client.is_connected(),
            "the socket opened through Tor stayed"
        );
        release.notify_one();
        wait_until("the socket without Tor", || client.is_connected()).await;
        client.publish(&some_event()).await.unwrap();
        wait_until("the event without Tor", || direct.events().len() == 1).await;
        assert!(on_tor.events().is_empty());
        client.close();
    }

    // ---- B2: a handshake that never ends, and a relay that stays down ----

    /// A connector whose attempts never end, counting them: a captive
    /// portal, or a NAT mapping that died across sleep, takes the TCP
    /// connection and never finishes the handshake.
    fn stalled_connector(attempts: Arc<AtomicUsize>) -> Connector {
        Arc::new(move |_url| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Box::pin(futures_util::future::pending())
        })
    }

    #[tokio::test]
    async fn a_connection_that_never_completes_is_given_up_and_tried_again() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let options = ClientOptions {
            connector: stalled_connector(Arc::clone(&attempts)),
            ..quick_options(None)
        };

        let client = NostrClient::start("ws://127.0.0.1:9", ignore_events(), options);

        wait_until("a second attempt", || attempts.load(Ordering::SeqCst) >= 2).await;
        assert!(!client.is_connected());
        client.close();
    }

    #[tokio::test]
    async fn the_inspectors_connection_gives_up_at_its_deadline() {
        let options = ClientOptions {
            connector: stalled_connector(Arc::default()),
            ..quick_options(None)
        };

        let connecting = NostrClient::connect_with("ws://127.0.0.1:9", ignore_events(), options);

        let connected = tokio::time::timeout(Duration::from_secs(5), connecting)
            .await
            .expect("still connecting after 5 s: no deadline");
        assert!(matches!(connected, Err(NostrError::Connect(_))));
    }

    #[test]
    fn a_real_connection_is_given_thirty_seconds() {
        // Tor design §3.1 with the spike's times (S6): through Tor a relay's
        // WebSocket was up in 2.5-3.7 s (median) and 10 s at most, and a
        // first stream on a fresh circuit took up to 13 s (S3).
        assert_eq!(
            ClientOptions::new(test_relay::connector(), None).connect_deadline,
            Duration::from_secs(30)
        );
    }

    #[tokio::test]
    async fn a_relay_that_stays_down_keeps_only_so_many_events() {
        let client = unreachable_client(Arc::default());
        for _ in 0..MAX_QUEUED_WHILE_DOWN {
            client.publish(&some_event()).await.unwrap();
        }

        let past_the_bound = client.publish(&some_event()).await;

        assert!(past_the_bound.is_err(), "kept past the bound");
        client.close();
    }

    #[tokio::test]
    async fn the_events_kept_for_a_relay_free_their_places_once_they_go_out() {
        let relay = TestRelay::start(Answer::Accept).await;
        let allowed = Arc::new(AtomicBool::new(false));
        let (gate, real) = (Arc::clone(&allowed), test_relay::connector());
        let connector: Connector = Arc::new(move |url| {
            if gate.load(Ordering::SeqCst) {
                real(url)
            } else {
                Box::pin(async { Err("refused".to_string()) })
            }
        });
        let options = ClientOptions {
            connector,
            ..quick_options(None)
        };
        let client = NostrClient::start(&relay.url, ignore_events(), options);
        for _ in 0..MAX_QUEUED_WHILE_DOWN {
            client.publish(&some_event()).await.unwrap();
        }
        allowed.store(true, Ordering::SeqCst);
        wait_until("the kept events", || {
            relay.events().len() == MAX_QUEUED_WHILE_DOWN
        })
        .await;

        // Down again: there is room for as many as before, and no more.
        allowed.store(false, Ordering::SeqCst);
        relay.kick();
        wait_until("the drop", || !client.is_connected()).await;
        for _ in 0..MAX_QUEUED_WHILE_DOWN {
            client.publish(&some_event()).await.unwrap();
        }
        assert!(client.publish(&some_event()).await.is_err());
        client.close();
    }

    // ---- K4: a relay's OK ----

    fn some_event() -> NostrEvent {
        let kp = generate_nostr_keypair();
        build_and_sign_event(&kp.priv_bytes, &kp.pub_bytes, TRINO_KIND, "x", vec![], None).unwrap()
    }

    #[tokio::test]
    async fn a_published_event_waits_for_the_relays_ok() {
        for (answer, expected) in [
            (Answer::Accept, Ack::Accepted),
            (Answer::Reject, Ack::Rejected),
            // NIP-01 answers a duplicate with `true`; some relays say `false`.
            // Either way the relay has the event.
            (Answer::Duplicate, Ack::Accepted),
            (Answer::Silent, Ack::NoAnswer),
        ] {
            let relay = TestRelay::start(answer.clone()).await;
            let client = relay.client().await;

            let ack = client
                .publish_acked(&some_event(), Duration::from_millis(300))
                .await;

            assert_eq!(ack, expected, "{answer:?}");
            assert_eq!(relay.events().len(), 1);
            client.close();
        }
    }

    #[tokio::test]
    async fn a_wait_that_ends_leaves_nothing_behind() {
        let relay = TestRelay::start(Answer::Silent).await;
        let client = relay.client().await;

        let ack = client
            .publish_acked(&some_event(), Duration::from_millis(100))
            .await;
        // A wait that is dropped halfway, like a send that already has its OK
        // from another relay.
        let dropped = tokio::time::timeout(
            Duration::from_millis(50),
            client.publish_acked(&some_event(), Duration::from_secs(10)),
        )
        .await;

        assert_eq!(ack, Ack::NoAnswer);
        assert!(dropped.is_err());
        assert!(client.pending_ok.lock().unwrap().is_empty());
        client.close();
    }

    #[test]
    fn an_ok_reaches_the_event_it_answers_and_only_that() {
        let pending = PendingOks::default();
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert("e1".to_string(), tx);
        let handler: EventHandler = Arc::new(|_| panic!("an OK is not an event"));

        handle_relay_message(r#"["OK","other",true,""]"#, &handler, &pending, false);
        assert!(rx.try_recv().is_err(), "an OK for another event");
        handle_relay_message(r#"["OK","e1","yes",""]"#, &handler, &pending, false);
        assert!(rx.try_recv().is_err(), "a malformed OK");
        handle_relay_message(
            r#"["OK","e1",false,"blocked: spam"]"#,
            &handler,
            &pending,
            false,
        );

        assert_eq!(
            rx.try_recv(),
            Ok((false, Some("blocked: spam".to_string())))
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    // ---- P1-6: random ids, several filters in one REQ, replace and CLOSE ----

    /// A handler that keeps every event it gets.
    fn collector() -> (EventHandler, Arc<StdMutex<Vec<NostrEvent>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let keep = Arc::clone(&seen);
        let handler: EventHandler = Arc::new(move |event| keep.lock().unwrap().push(event));
        (handler, seen)
    }

    /// An event addressed (`p`) to `to`, signed by a fresh key.
    fn addressed(to: &str, created_at: i64) -> NostrEvent {
        let kp = generate_nostr_keypair();
        let tags = vec![vec!["p".to_string(), to.to_string()]];
        build_and_sign_event(
            &kp.priv_bytes,
            &kp.pub_bytes,
            1059,
            "x",
            tags,
            Some(created_at),
        )
        .unwrap()
    }

    fn to_mailbox(p: &str) -> NostrFilter {
        NostrFilter {
            kinds: Some(vec![1059]),
            p_tag: Some(vec![p.to_string()]),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn subscription_ids_are_random_not_a_counter() {
        let relay = TestRelay::start(Answer::Accept).await;
        let client = relay.client().await;
        let a = client.subscribe(&NostrFilter::default()).await.unwrap();
        let b = client.subscribe(&NostrFilter::default()).await.unwrap();
        assert_ne!(a, b);
        for id in [&a, &b] {
            assert_eq!(id.len(), 16, "{id}");
            assert!(id.bytes().all(|c| c.is_ascii_hexdigit()), "{id}");
            assert!(!id.starts_with("trino"));
        }
        wait_until("both REQs", || relay.frames().len() == 2).await;
        client.close();
    }

    #[tokio::test]
    async fn one_req_carries_several_filters() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let (on_event, seen) = collector();
        let client = NostrClient::start(&relay.url, on_event, quick_options(None));
        wait_until("the client to connect", || client.is_connected()).await;
        let (a, b, c) = ("aa".repeat(32), "bb".repeat(32), "cc".repeat(32));
        let id = client
            .subscribe_filters(vec![to_mailbox(&a), to_mailbox(&b)], None)
            .await
            .unwrap();
        wait_until("the REQ", || relay.frames().len() == 1).await;
        match &relay.frames()[0] {
            test_relay::Frame::Req(_, got, filters) => {
                assert_eq!(got, &id);
                assert_eq!(filters.len(), 2);
            }
            other => panic!("{other:?}"),
        }
        let sender = relay.client().await;
        for to in [&a, &b, &c] {
            sender.publish(&addressed(to, 1_800_000_000)).await.unwrap();
        }
        wait_until("two events", || seen.lock().unwrap().len() == 2).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let got: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.recipient().unwrap().to_string())
            .collect();
        assert_eq!(got, vec![a, b]);
        client.close();
        sender.close();
    }

    #[tokio::test]
    async fn replacing_a_subscription_closes_the_old_one_under_a_new_id() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let (on_event, seen) = collector();
        let client = NostrClient::start(&relay.url, on_event, quick_options(None));
        wait_until("the client to connect", || client.is_connected()).await;
        let (a, b) = ("aa".repeat(32), "bb".repeat(32));
        let old = client
            .subscribe_filters(vec![to_mailbox(&a)], None)
            .await
            .unwrap();
        let new = client
            .replace_subscription(&old, vec![to_mailbox(&b)], None)
            .await
            .unwrap();
        assert_ne!(old, new);
        wait_until("REQ, CLOSE and REQ", || relay.frames().len() == 3).await;
        let frames = relay.frames();
        assert!(matches!(&frames[0], test_relay::Frame::Req(1, id, _) if *id == old));
        assert_eq!(frames[1], test_relay::Frame::Close(1, old.clone()));
        assert!(matches!(&frames[2], test_relay::Frame::Req(1, id, _) if *id == new));

        let sender = relay.client().await;
        sender.publish(&addressed(&a, 1_800_000_000)).await.unwrap();
        sender.publish(&addressed(&b, 1_800_000_000)).await.unwrap();
        wait_until("the new mailbox's event", || {
            seen.lock().unwrap().len() == 1
        })
        .await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0].recipient(), Some(b.as_str()));

        // After a reconnect only the new one is asked for again.
        relay.kick();
        wait_until("the REQ again", || relay.frames().len() == 4).await;
        // On a new connection (the sender's is another one).
        assert!(
            matches!(&relay.frames()[3], test_relay::Frame::Req(n, id, _) if *n > 1 && *id == new)
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(relay.frames().len(), 4);
        client.close();
        sender.close();
    }

    #[test]
    fn a_closed_catch_up_no_longer_holds_the_socket_back() {
        let mut book = SubscriptionBook::default();
        book.add(catch_up_sub("a"), T);
        book.add(catch_up_sub("b"), T);
        book.on_frame(Some(r#"["EOSE","a"]"#), T + 1);
        assert!(!book.live);
        assert_eq!(book.remove("b"), Some(r#"["CLOSE","b"]"#.to_string()));
        assert!(book.live);
        assert_eq!(book.remove("b"), None);
        assert_eq!(book.on_connected(T + 2).len(), 1);
    }

    // ---- P1-6: P1 events and the filters of mailboxes ----

    fn mailboxes(n: usize) -> Vec<[u8; 32]> {
        (0..n).map(|_| generate_nostr_keypair().pub_bytes).collect()
    }

    /// P1 design test 11: only mailboxes, one P1 kind and `since`.
    #[test]
    fn p1_filters_hold_only_mailboxes_and_one_p1_kind() {
        let boxes = mailboxes(3);
        for kind in P1_KINDS {
            let filters = p1_filters(kind, &boxes, 1_800_000_000);
            assert_eq!(filters.len(), 1);
            let json = serde_json::to_value(&filters[0]).unwrap();
            let mut keys: Vec<&String> = json.as_object().unwrap().keys().collect();
            keys.sort();
            assert_eq!(keys, ["#p", "kinds", "since"]);
            assert_eq!(json["kinds"], serde_json::json!([kind]));
            assert_eq!(json["since"], 1_800_000_000);
            let want: Vec<String> = boxes.iter().map(hex::encode).collect();
            assert_eq!(json["#p"], serde_json::json!(want));
            assert!(p1_filters(kind, &[], 0).is_empty());
        }
    }

    /// R-31: past 650 mailboxes the list goes in more filters of one REQ.
    #[test]
    fn a_long_list_of_mailboxes_is_split_in_filters() {
        let boxes = mailboxes(1301);
        let filters = p1_filters(p1event::KIND_MESSAGE, &boxes, 0);
        let sizes: Vec<usize> = filters
            .iter()
            .map(|f| f.p_tag.as_ref().unwrap().len())
            .collect();
        assert_eq!(sizes, [650, 650, 1]);
        let all: Vec<String> = filters
            .iter()
            .flat_map(|f| f.p_tag.clone().unwrap())
            .collect();
        assert_eq!(all, boxes.iter().map(hex::encode).collect::<Vec<_>>());
        assert_eq!(p1_filters(p1event::KIND_CALL, &mailboxes(1300), 0).len(), 2);
    }

    #[tokio::test]
    async fn a_sealed_p1_event_reaches_its_mailbox_and_opens() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let (on_event, seen) = collector();
        let client = NostrClient::start(&relay.url, on_event, quick_options(None));
        wait_until("the client to connect", || client.is_connected()).await;
        let mailbox = generate_nostr_keypair();
        let other = generate_nostr_keypair();
        let now = chrono::Utc::now().timestamp();
        let subs = client
            .subscribe_p1(&[mailbox.pub_bytes], now - 3 * 3600)
            .await
            .unwrap();
        assert_eq!(subs.len(), 2, "a REQ per kind");
        wait_until("the REQs", || relay.frames().len() == 2).await;

        let sender = relay.client().await;
        let inner = vec![7u8; 1024];
        let event = seal_p1(p1event::KIND_MESSAGE, now, &mailbox.pub_bytes, &inner).unwrap();
        let elsewhere = seal_p1(p1event::KIND_CALL, now, &other.pub_bytes, &inner).unwrap();
        assert_eq!(
            sender
                .publish_acked(&elsewhere, Duration::from_secs(5))
                .await,
            Ack::Accepted
        );
        assert_eq!(
            sender.publish_acked(&event, Duration::from_secs(5)).await,
            Ack::Accepted
        );
        wait_until("the event", || seen.lock().unwrap().len() == 1).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let got = seen.lock().unwrap()[0].clone();
        assert_eq!(got.id, event.id);
        assert!(verify_event(&got));
        let core: p1event::Event = got.into();
        assert_eq!(p1event::mailbox_of(&core), Some(mailbox.pub_bytes));
        assert_eq!(
            &p1event::open_event(&mailbox.priv_bytes, &core).unwrap()[..],
            &inner[..]
        );
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "the other mailbox's event stays out"
        );
        client.close();
        sender.close();
    }

    #[test]
    fn a_p1_event_has_a_one_time_author_and_expires() {
        let me = crate::identity::create_identity();
        let mailbox = generate_nostr_keypair().pub_bytes;
        let now = 1_800_000_000;
        let a = seal_p1(p1event::KIND_MESSAGE, now, &mailbox, b"x").unwrap();
        let b = seal_p1(p1event::KIND_MESSAGE, now, &mailbox, b"x").unwrap();
        assert_ne!(a.pubkey, b.pubkey);
        assert_ne!(a.pubkey, hex::encode(me.nostr.pub_bytes));
        assert_eq!(a.tags[0], vec!["p".to_string(), hex::encode(mailbox)]);
        let expiration: i64 = a.tags[1][1].parse().unwrap();
        assert!(expiration >= a.created_at + 6 * 86_400);
        assert!(verify_event(&a));
        assert!(seal_p1(TRINO_KIND, now, &mailbox, b"x").is_err());
    }

    /// diseno-vinculacion.md §23.8: a call signal expires too, 1 to 2 hours
    /// out, and is still read as a mailbox's event.
    #[test]
    fn a_p1_call_signal_expires_within_two_hours_and_names_its_mailbox() {
        let mailbox = generate_nostr_keypair().pub_bytes;
        let now = 1_800_000_000;
        let call = seal_p1(p1event::KIND_CALL, now, &mailbox, b"x").unwrap();
        assert_eq!(call.created_at, now);
        assert_eq!(call.tags.len(), 2);
        assert_eq!(call.tags[1][0], "expiration");
        let expiration: i64 = call.tags[1][1].parse().unwrap();
        assert!((now + 3_600..=now + 7_200).contains(&expiration));
        assert!(verify_event(&call));
        assert_eq!(p1event::mailbox_of(&call.into()), Some(mailbox));
    }

    // ---- Relays that do not answer, or CLOSE (the relay spike) ----

    fn reqs_on(relay: &TestRelay, connection: usize) -> Vec<(String, Vec<Value>)> {
        relay
            .frames()
            .into_iter()
            .filter_map(|frame| match frame {
                test_relay::Frame::Req(c, id, filters) if c == connection => Some((id, filters)),
                _ => None,
            })
            .collect()
    }

    fn closes_on(relay: &TestRelay, connection: usize) -> Vec<String> {
        relay
            .frames()
            .into_iter()
            .filter_map(|frame| match frame {
                test_relay::Frame::Close(c, id) if c == connection => Some(id),
                _ => None,
            })
            .collect()
    }

    fn deadline_options(deadline: Duration) -> ClientOptions {
        ClientOptions {
            answer_deadline: Some(deadline),
            ..quick_options(None)
        }
    }

    #[tokio::test]
    async fn a_relay_silent_to_a_kind_is_cut_at_the_deadline_and_the_rest_still_flows() {
        use crate::relay_caps::Reads;
        let relay = TestRelay::quirky(
            Answer::Accept,
            test_relay::Quirks {
                silent_kinds: vec![p1event::KIND_CALL],
                ..Default::default()
            },
        );
        let (on_event, seen) = collector();
        let options = deadline_options(Duration::from_millis(300));
        let client = NostrClient::start(&relay.url, on_event, options);
        wait_until("the client to connect", || client.is_connected()).await;
        let mailbox = generate_nostr_keypair().pub_bytes;
        let now = chrono::Utc::now().timestamp();
        let subs = client
            .subscribe_p1(&[mailbox], now - 4 * 3600)
            .await
            .unwrap();
        let call_sub = subs
            .iter()
            .find(|(k, _)| *k == p1event::KIND_CALL)
            .unwrap()
            .1
            .clone();

        wait_until("the silent REQ to be closed", || {
            closes_on(&relay, 1) == [call_sub.clone()]
        })
        .await;
        assert!(matches!(
            client.caps().reads(p1event::KIND_CALL),
            Reads::Unanswered(_)
        ));
        assert_eq!(client.caps().reads(p1event::KIND_MESSAGE), Reads::Answered);

        let sender = relay.client().await;
        let event = seal_p1(p1event::KIND_MESSAGE, now, &mailbox, b"hi").unwrap();
        assert_eq!(
            sender.publish_acked(&event, Duration::from_secs(5)).await,
            Ack::Accepted
        );
        wait_until("the message", || seen.lock().unwrap().len() == 1).await;

        // A later reconnect asks only for what the relay answers. The
        // sender was connection 2; the client comes back as the third.
        sender.close();
        relay.kick();
        wait_until("the client again", || !reqs_on(&relay, 3).is_empty()).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let again = reqs_on(&relay, 3);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].1[0]["kinds"], serde_json::json!([1059]));
        // And a new subscription skips that kind for now.
        let subs = client
            .subscribe_p1(&[mailbox], now - 4 * 3600)
            .await
            .unwrap();
        let kinds: Vec<u32> = subs.iter().map(|(k, _)| *k).collect();
        assert_eq!(kinds, [p1event::KIND_MESSAGE]);
        client.close();
    }

    #[tokio::test]
    async fn a_query_closed_for_auth_is_marked_and_never_sent_again() {
        use crate::relay_caps::{Reads, Refusal};
        let relay = TestRelay::quirky(
            Answer::Accept,
            test_relay::Quirks {
                closed_kinds: vec![(
                    p1event::KIND_MESSAGE,
                    "auth-required: requested filter requires authentication".to_string(),
                )],
                ..Default::default()
            },
        );
        let client = NostrClient::start(&relay.url, ignore_events(), quick_options(None));
        wait_until("the client to connect", || client.is_connected()).await;
        let mailbox = generate_nostr_keypair().pub_bytes;
        client
            .subscribe_p1(&[mailbox], 1_800_000_000)
            .await
            .unwrap();
        wait_until("the refusal", || {
            client.caps().reads(p1event::KIND_MESSAGE) == Reads::Refused(Refusal::AuthRequired)
        })
        .await;
        wait_until("the calls answered", || {
            client.caps().reads(p1event::KIND_CALL) == Reads::Answered
        })
        .await;
        assert!(closes_on(&relay, 1).is_empty(), "a CLOSED needs no CLOSE");
        relay.kick();
        wait_until("the second connection", || !reqs_on(&relay, 2).is_empty()).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        let again = reqs_on(&relay, 2);
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].1[0]["kinds"], serde_json::json!([21059]));
        client.close();
    }

    #[test]
    fn a_catch_up_query_the_relay_closed_or_never_answered_does_not_hold_the_sync_back() {
        let mut book = SubscriptionBook {
            answer_deadline: Some(Duration::from_secs(1)),
            ..Default::default()
        };
        book.add(catch_up_sub("s1"), T);
        book.add(catch_up_sub("s2"), T);
        book.add(catch_up_sub("s3"), T);
        book.on_frame(Some(&eose("s1")), T + 1);
        book.on_frame(Some(r#"["CLOSED","s2","auth-required: no"]"#), T + 2);
        assert!(!book.live, "s3 still owes an answer");
        let expired = book.expire(Instant::now() + Duration::from_secs(2));
        assert_eq!(expired.len(), 1);
        assert!(expired[0].0.contains("s3"), "its CLOSE");
        assert!(book.live);
        book.on_frame(None, T + 10);
        let reqs = book.on_connected(T + 20);
        assert_eq!(reqs.len(), 1, "only the answered one is sent again");
        assert_eq!(since_of(&reqs[0]), Some(T + 10 - 600));
    }

    // ---- A mailbox REQ never asks `since` a recent moment ----

    fn p1_sub(id: &str, since: i64, catch_up: Option<CatchUp>) -> Subscription {
        Subscription {
            id: id.to_string(),
            filters: p1_filters(p1event::KIND_MESSAGE, &[[2u8; 32]], since),
            catch_up,
        }
    }

    #[test]
    fn a_mailbox_req_never_asks_since_a_recent_moment() {
        let mut book = SubscriptionBook::default();
        // Asked for since now: the relay would drop, even live, a message
        // backdated up to 300 s or sent with a clock 3 h behind.
        let req = book.add(p1_sub("m1", T, None), T);
        assert_eq!(since_of(&req), Some(T - P1_SINCE_LAG_SECS));
        // An older `since` stays as it is.
        let req = book.add(p1_sub("m2", T - DAY, None), T);
        assert_eq!(since_of(&req), Some(T - DAY));
        // A catch-up one, back after a sync a few seconds ago, too.
        book.add(p1_sub("m3", 0, Some(CATCH_UP)), T);
        book.on_frame(Some(&eose("m3")), T + 1);
        book.on_frame(None, T + 50);
        let reqs = book.on_connected(T + 60);
        assert_eq!(since_of(&reqs[0]), Some(T - P1_SINCE_LAG_SECS), "fixed");
        assert_eq!(since_of(&reqs[2]), Some(T + 60 - P1_SINCE_LAG_SECS));
        // Anything else is left alone.
        assert_eq!(since_of(&book.add(catch_up_sub("c1"), T)), Some(T - 600));
    }

    #[tokio::test]
    async fn a_backdated_message_arrives_live_even_if_asked_since_now() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let (on_event, seen) = collector();
        let client = NostrClient::start(&relay.url, on_event, quick_options(None));
        wait_until("the client to connect", || client.is_connected()).await;
        let mailbox = generate_nostr_keypair().pub_bytes;
        let now = chrono::Utc::now().timestamp();
        client.subscribe_p1(&[mailbox], now).await.unwrap();
        wait_until("the REQs", || relay.frames().len() == 2).await;
        // A sender whose clock is 200 s behind ours, backdating up to 300 s more.
        let sender = relay.client().await;
        let event = seal_p1(p1event::KIND_MESSAGE, now - 200, &mailbox, b"late").unwrap();
        assert!(event.created_at < now);
        assert_eq!(
            sender.publish_acked(&event, Duration::from_secs(5)).await,
            Ack::Accepted
        );
        wait_until("the backdated message", || seen.lock().unwrap().len() == 1).await;
        client.close();
        sender.close();
    }

    // ---- P1-6: the one-shot catch-up, paged with `until` (R-20) ----

    #[tokio::test]
    async fn a_one_shot_catch_up_pages_back_to_an_empty_page() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let mailbox = "aa".repeat(32);
        let mut want = HashSet::new();
        for i in 0..25 {
            let event = addressed(&mailbox, 1_800_000_000 + i * 7);
            want.insert(event.id.clone());
            relay.store(event);
        }
        // Someone else's: never asked for.
        relay.store(addressed(&"bb".repeat(32), 1_800_000_100));
        let fetched = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &[to_mailbox(&mailbox)],
            10,
            Duration::from_secs(5),
            &RelayCaps::new(),
        )
        .await
        .unwrap();
        assert!(fetched.complete);
        let got: HashSet<String> = fetched.events.iter().map(|e| e.id.clone()).collect();
        assert_eq!(got, want);
        assert_eq!(fetched.events.len(), 25, "each one once");

        // One connection; a REQ per page, each CLOSEd, `until` going back.
        let frames = relay.frames();
        let mut untils = Vec::new();
        let mut limits = Vec::new();
        let mut open: Option<String> = None;
        for frame in &frames {
            match frame {
                test_relay::Frame::Req(1, id, filters) => {
                    assert!(open.is_none(), "one page at a time");
                    limits.push(filters[0]["limit"].as_u64());
                    untils.push(filters[0]["until"].as_i64());
                    open = Some(id.clone());
                }
                test_relay::Frame::Close(1, id) => {
                    assert_eq!(open.take().as_ref(), Some(id));
                }
                other => panic!("another connection: {other:?}"),
            }
        }
        wait_until("the last CLOSE", || {
            matches!(relay.frames().last(), Some(test_relay::Frame::Close(..)))
        })
        .await;
        assert_eq!(untils[0], None);
        assert!(untils.len() >= 4 && untils.len() <= 6, "{untils:?}");
        // Pages of 10, and a last ask without `limit` that confirms the end.
        let (last, pages) = limits.split_last().unwrap();
        assert!(pages.iter().all(|l| *l == Some(10)), "{limits:?}");
        assert_eq!(*last, None);
        let backwards: Vec<i64> = untils.iter().flatten().copied().collect();
        assert!(backwards.windows(2).all(|w| w[1] <= w[0]), "{backwards:?}");
    }

    #[tokio::test]
    async fn a_one_shot_catch_up_of_nothing_asks_once() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let fetched = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &[to_mailbox(&"aa".repeat(32))],
            10,
            Duration::from_secs(5),
            &RelayCaps::new(),
        )
        .await
        .unwrap();
        assert!(fetched.complete);
        assert!(fetched.events.is_empty());
        wait_until("two REQs and their CLOSEs", || relay.frames().len() == 4).await;
    }

    #[tokio::test]
    async fn a_one_shot_catch_up_drops_what_does_not_verify() {
        let relay = TestRelay::serving(Answer::Accept).await;
        let mailbox = "aa".repeat(32);
        let good = addressed(&mailbox, 1_800_000_000);
        let mut forged = addressed(&mailbox, 1_800_000_001);
        forged.content = "changed".to_string();
        relay.store(good.clone());
        relay.store(forged);
        let fetched = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &[to_mailbox(&mailbox)],
            10,
            Duration::from_secs(5),
            &RelayCaps::new(),
        )
        .await
        .unwrap();
        let ids: Vec<&str> = fetched.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, [good.id.as_str()]);
    }

    #[tokio::test]
    async fn a_relay_whose_pages_come_back_short_is_read_without_limit() {
        let relay = TestRelay::quirky(
            Answer::Accept,
            test_relay::Quirks {
                broken_paging: true,
                ..Default::default()
            },
        );
        let mailbox = "aa".repeat(32);
        let mut want = HashSet::new();
        for i in 0..25 {
            let event = addressed(&mailbox, 1_800_000_000 + i * 7);
            want.insert(event.id.clone());
            relay.store(event);
        }
        let caps = RelayCaps::new();
        let fetched = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &[to_mailbox(&mailbox)],
            10,
            Duration::from_secs(5),
            &caps,
        )
        .await
        .unwrap();
        assert!(fetched.complete);
        let got: HashSet<String> = fetched.events.iter().map(|e| e.id.clone()).collect();
        assert_eq!(got, want, "nothing lost to the short pages");
        assert!(caps.paging_broken());

        // Known now: the next catch-up asks without `limit` from the start.
        let fetched = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &[to_mailbox(&mailbox)],
            10,
            Duration::from_secs(5),
            &caps,
        )
        .await
        .unwrap();
        assert_eq!(fetched.events.len(), 25);
        let first_of_second = relay
            .frames()
            .into_iter()
            .find_map(|frame| match frame {
                test_relay::Frame::Req(2, _, filters) => Some(filters),
                _ => None,
            })
            .unwrap();
        assert!(first_of_second[0].get("limit").is_none());
    }

    #[tokio::test]
    async fn a_one_shot_catch_up_marks_a_kind_the_relay_never_answers() {
        use crate::relay_caps::Reads;
        let relay = TestRelay::quirky(
            Answer::Accept,
            test_relay::Quirks {
                silent_kinds: vec![p1event::KIND_CALL],
                ..Default::default()
            },
        );
        let caps = RelayCaps::new();
        let calls = p1_filters(p1event::KIND_CALL, &[[2u8; 32]], 0);
        let result = fetch_once(
            &relay.url,
            &test_relay::connector(),
            &calls,
            10,
            Duration::from_millis(300),
            &caps,
        )
        .await;
        assert!(result.is_err());
        assert!(matches!(
            caps.reads(p1event::KIND_CALL),
            Reads::Unanswered(_)
        ));
        let messages = p1_filters(p1event::KIND_MESSAGE, &[[2u8; 32]], 0);
        fetch_once(
            &relay.url,
            &test_relay::connector(),
            &messages,
            10,
            Duration::from_secs(5),
            &caps,
        )
        .await
        .unwrap();
        assert_eq!(caps.reads(p1event::KIND_MESSAGE), Reads::Answered);
    }

    #[tokio::test]
    async fn a_one_shot_catch_up_gives_up_at_its_deadline() {
        let never: Connector = Arc::new(|_url| Box::pin(futures_util::future::pending()));
        let started = std::time::Instant::now();
        let result = fetch_once(
            "ws://relay.trino.invalid",
            &never,
            &[to_mailbox(&"aa".repeat(32))],
            10,
            Duration::from_millis(100),
            &RelayCaps::new(),
        )
        .await;
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
