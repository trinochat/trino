use crate::crypto::sha256;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{schnorr::Signature, Keypair, Message as SecpMessage, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch, RwLock};
use tokio_tungstenite::tungstenite::Message;
use trino_net::{IsoKind, Mode, Net, Session};

pub const TRINO_KIND: u32 = 4848;

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

pub fn verify_event(event: &NostrEvent) -> bool {
    let serialized = serde_json::json!([
        0,
        event.pubkey,
        event.created_at,
        event.kind,
        event.tags,
        event.content
    ])
    .to_string();
    let id_bytes = sha256(serialized.as_bytes());
    if hex::encode(id_bytes) != event.id {
        return false;
    }
    let Ok(sig_bytes) = hex::decode(&event.sig) else {
        return false;
    };
    let Ok(pub_bytes) = hex::decode(&event.pubkey) else {
        return false;
    };
    if sig_bytes.len() != 64 || pub_bytes.len() != 32 {
        return false;
    }
    // BIP340 verification via libsecp256k1 (compatible with @noble/curves + relays).
    let secp = Secp256k1::verification_only();
    let Ok(xonly) = XOnlyPublicKey::from_slice(&pub_bytes) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let Ok(msg) = SecpMessage::from_digest_slice(&id_bytes) else {
        return false;
    };
    secp.verify_schnorr(&sig, &msg, &xonly).is_ok()
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
    filter: NostrFilter,
    catch_up: Option<CatchUp>,
}

fn req_payload(sub: &Subscription, now: i64, synced_at: Option<i64>) -> String {
    let mut filter = sub.filter.clone();
    if let Some(catch_up) = sub.catch_up {
        filter.since = Some(catch_up_since(now, synced_at, catch_up));
    }
    serde_json::json!(["REQ", sub.id, filter]).to_string()
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
        self.subs
            .iter()
            .map(|sub| req_payload(sub, now, self.synced_at))
            .collect()
    }

    /// A new subscription: remember it, and return its REQ.
    fn add(&mut self, sub: Subscription, now: i64) -> String {
        let req = req_payload(&sub, now, self.synced_at);
        if sub.catch_up.is_some() {
            self.awaiting_eose.insert(sub.id.clone());
            self.live = false;
        }
        self.subs.push(sub);
        req
    }

    /// Any frame from the relay; `text` is its content when it is a text frame.
    fn on_frame(&mut self, text: Option<&str>, now: i64) {
        if let Some(sub_id) = text.and_then(eose_subscription) {
            if self.awaiting_eose.remove(&sub_id) && self.awaiting_eose.is_empty() {
                self.live = true;
            }
        }
        if self.live {
            self.synced_at = Some(now);
        }
    }
}

/// The subscription id of an `["EOSE", <id>]` relay message.
fn eose_subscription(text: &str) -> Option<String> {
    if !text.contains("EOSE") {
        return None; // skip parsing every event a second time
    }
    let msg: Vec<Value> = serde_json::from_str(text).ok()?;
    if msg.first()?.as_str()? != "EOSE" {
        return None;
    }
    msg.get(1)?.as_str().map(str::to_string)
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
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
    sub_counter: Arc<RwLock<u64>>,
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
            sub_counter: Arc::new(RwLock::new(0)),
            connected,
            closed,
            pending_ok,
            queued,
        })
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
        let mut c = self.sub_counter.write().await;
        *c += 1;
        let sub_id = format!("trino-{}", c);
        dlog("SUBSCRIBE");
        // The connection task keeps it, so it is re-sent after every drop.
        self.sender
            .send(ClientCommand::Subscribe(Subscription {
                id: sub_id.clone(),
                filter: filter.clone(),
                catch_up,
            }))
            .map_err(|e| NostrError::Send(e.to_string()))?;
        Ok(sub_id)
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
        let mut book = SubscriptionBook::default();
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
                        dlog("WS opened the old way, opening it again");
                        drop(ws);
                        wait = false;
                        continue;
                    }
                    dlog("WS connected");
                    return Some((ws, opened));
                }
                Ok(Err(_)) => {
                    crate::diag::note_with("WS connection failed", &[("retry_s", &pause.as_secs())])
                }
                Err(_) => crate::diag::note_with(
                    "WS connection timed out",
                    &[("retry_s", &pause.as_secs())],
                ),
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
            tokio::select! {
                incoming = read.next() => match incoming {
                    Some(Ok(Message::Text(text))) => {
                        book.on_frame(Some(&text), unix_now());
                        handle_relay_message(&text, &self.on_event, &self.pending_ok);
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        book.on_frame(None, unix_now());
                        let _ = write.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        dlog("WS dropped, reconnecting");
                        return Served::Dropped;
                    }
                    // Pong / Binary / Frame: nothing to do, but the relay is
                    // evidently still there.
                    Some(Ok(_)) => book.on_frame(None, unix_now()),
                    Some(Err(_)) => {
                        dlog("WS read error, reconnecting");
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
                    Some(ClientCommand::Close) | None => {
                        let _ = write.close().await;
                        return Served::Closed; // shut down for good
                    }
                },
                () = route_moved(route, opened) => {
                    // The socket goes, and nothing more is sent the old way.
                    dlog("WS route changed, opening it again");
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

fn handle_relay_message(text: &str, on_event: &EventHandler, pending: &PendingOks) {
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
                crate::diag::note_with("WS EVENT", &[("kind", &event.kind), ("verified", &ok)]);
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

    pub struct TestRelay {
        pub url: String,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        kicks: Arc<Notify>,
    }

    impl TestRelay {
        pub async fn start(answer: Answer) -> Self {
            let host = format!(
                "relay-{}.trino.invalid",
                RELAYS.fetch_add(1, Ordering::SeqCst)
            );
            let mut listener = TOR.0.listen(&host, 80);
            let url = format!("ws://{host}");
            let events = Arc::new(StdMutex::new(Vec::new()));
            let kicks = Arc::new(Notify::new());
            let (log, kicked) = (Arc::clone(&events), Arc::clone(&kicks));
            tokio::spawn(async move {
                while let Some(io) = listener.accept().await {
                    let (log, kicked) = (Arc::clone(&log), Arc::clone(&kicked));
                    tokio::spawn(serve(io, answer.clone(), log, kicked));
                }
            });
            TestRelay { url, events, kicks }
        }

        /// The events it received, in order.
        pub fn events(&self) -> Vec<NostrEvent> {
            self.events.lock().unwrap().clone()
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

    async fn serve(
        io: impl AsyncRead + AsyncWrite + Unpin,
        answer: Answer,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        kicks: Arc<Notify>,
    ) {
        let Ok(ws) = tokio_tungstenite::accept_async(io).await else {
            return;
        };
        let (mut write, mut read) = ws.split();
        loop {
            let message = tokio::select! {
                message = read.next() => message,
                () = kicks.notified() => {
                    let _ = write.close().await;
                    return;
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
                Some("REQ") => frame.get(1).map(|id| serde_json::json!(["EOSE", id])),
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
            filter: NostrFilter {
                kinds: Some(vec![TRINO_KIND]),
                p_tag: Some(vec!["aa".repeat(32)]),
                ..Default::default()
            },
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
                filter,
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

        handle_relay_message(r#"["OK","other",true,""]"#, &handler, &pending);
        assert!(rx.try_recv().is_err(), "an OK for another event");
        handle_relay_message(r#"["OK","e1","yes",""]"#, &handler, &pending);
        assert!(rx.try_recv().is_err(), "a malformed OK");
        handle_relay_message(r#"["OK","e1",false,"blocked: spam"]"#, &handler, &pending);

        assert_eq!(
            rx.try_recv(),
            Ok((false, Some("blocked: spam".to_string())))
        );
        assert!(pending.lock().unwrap().is_empty());
    }
}
