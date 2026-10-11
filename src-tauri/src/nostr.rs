use crate::crypto::sha256;
use futures_util::future::BoxFuture;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{schnorr::Signature, Keypair, Message as SecpMessage, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

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

/// A relay's WebSocket.
pub type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Opens the WebSocket of a relay. Production uses `websocket_connector`;
/// tests inject one that fails.
pub type Connector =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<WsStream, String>> + Send + Sync>;

/// Told `true` when a client's socket comes up and `false` when it goes down.
pub type StateHandler = Arc<dyn Fn(bool) + Send + Sync>;

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

/// How a client connects, and whom it tells.
#[derive(Clone)]
pub struct ClientOptions {
    pub connector: Connector,
    pub first_connection: Backoff,
    pub reconnection: Backoff,
    pub on_state: Option<StateHandler>,
}

impl ClientOptions {
    /// The real WebSocket and the pauses above.
    pub fn new(on_state: Option<StateHandler>) -> Self {
        ClientOptions {
            connector: websocket_connector(),
            first_connection: FIRST_CONNECTION,
            reconnection: RECONNECTION,
            on_state,
        }
    }
}

/// `connect_async`, as a `Connector`.
pub fn websocket_connector() -> Connector {
    Arc::new(|url: String| {
        Box::pin(async move {
            connect_async(url.as_str())
                .await
                .map(|(ws, _)| ws)
                .map_err(|e| e.to_string())
        })
    })
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
}

enum ClientCommand {
    Send(String),
    Subscribe(Subscription),
    Close,
}

impl NostrClient {
    /// A client whose first connection must succeed, so the caller learns
    /// the relay is up: the network inspector's. A drop later is retried.
    pub async fn connect(url: &str, on_event: EventHandler) -> Result<Arc<Self>, NostrError> {
        let (ws, _) = connect_async(url)
            .await
            .map_err(|e| NostrError::Connect(e.to_string()))?;
        Ok(Self::spawn(
            url,
            on_event,
            Some(ws),
            ClientOptions::new(None),
        ))
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
        let connection = Connection {
            url: url.to_string(),
            on_event,
            pending_ok,
            connected: Arc::clone(&connected),
            options,
        };
        tokio::spawn(connection.run(first, receiver, closed_rx));
        Arc::new(NostrClient {
            url: url.to_string(),
            sender,
            sub_counter: Arc::new(RwLock::new(0)),
            connected,
            closed,
        })
    }

    /// Whether the socket is up right now (K3).
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn publish(&self, event: &NostrEvent) -> Result<(), NostrError> {
        let payload = serde_json::json!(["EVENT", event]).to_string();
        self.sender
            .send(ClientCommand::Send(payload))
            .map_err(|e| NostrError::Send(e.to_string()))?;
        Ok(())
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
        let mut next = first;
        // The first connection is tried at once; after a drop, a pause first.
        let (mut backoff, mut at_once) = (self.options.first_connection, true);
        loop {
            let ws = match next.take() {
                Some(ws) => ws,
                None => match self
                    .connect_with_retries(backoff, at_once, &mut closed)
                    .await
                {
                    Some(ws) => ws,
                    None => break, // closed while waiting
                },
            };
            (backoff, at_once) = (self.options.reconnection, false);
            self.set_connected(true);
            let closing = self.serve(ws, &mut book, &mut receiver).await;
            self.set_connected(false);
            if closing {
                break;
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
    /// `None` once the client is closed.
    async fn connect_with_retries(
        &self,
        backoff: Backoff,
        at_once: bool,
        closed: &mut watch::Receiver<bool>,
    ) -> Option<WsStream> {
        let mut pause = backoff.first;
        let mut wait = !at_once;
        loop {
            if wait {
                tokio::select! {
                    () = tokio::time::sleep(pause) => {}
                    () = until_closed(closed) => return None,
                }
                pause = backoff.after(pause);
            }
            wait = true;
            let attempt = tokio::select! {
                attempt = (self.options.connector)(self.url.clone()) => attempt,
                () = until_closed(closed) => return None,
            };
            match attempt {
                Ok(ws) => {
                    dlog("WS connected");
                    return Some(ws);
                }
                Err(_) => {
                    crate::diag::note_with("WS connection failed", &[("retry_s", &pause.as_secs())])
                }
            }
        }
    }

    /// Serve one socket until it drops (`false`) or the client is closed
    /// (`true`).
    async fn serve(
        &self,
        ws: WsStream,
        book: &mut SubscriptionBook,
        receiver: &mut mpsc::UnboundedReceiver<ClientCommand>,
    ) -> bool {
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
                        return false;
                    }
                    // Pong / Binary / Frame: nothing to do, but the relay is
                    // evidently still there.
                    Some(Ok(_)) => book.on_frame(None, unix_now()),
                    Some(Err(_)) => {
                        dlog("WS read error, reconnecting");
                        return false;
                    }
                },
                cmd = receiver.recv() => match cmd {
                    Some(ClientCommand::Send(text)) => {
                        if write.send(Message::Text(text)).await.is_err() {
                            return false; // socket dead → reconnect
                        }
                    }
                    Some(ClientCommand::Subscribe(sub)) => {
                        // Kept in the book even if this send fails, so the
                        // reconnect re-sends it.
                        let req = book.add(sub, unix_now());
                        if write.send(Message::Text(req)).await.is_err() {
                            return false; // socket dead → reconnect
                        }
                    }
                    Some(ClientCommand::Close) | None => {
                        let _ = write.close().await;
                        return true; // shut down for good
                    }
                },
                _ = ping.tick() => {
                    if write.send(Message::Ping(Vec::new())).await.is_err() {
                        return false; // socket dead → reconnect
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

fn handle_relay_message(text: &str, on_event: &EventHandler, _pending: &PendingOks) {
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

    if msg_type == "EVENT" && msg.len() >= 3 {
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

/// A relay for tests: NIP-01 over a real WebSocket on 127.0.0.1, enough for
/// the clients here and the sends in commands.rs.
#[cfg(test)]
pub(crate) mod test_relay {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Notify;

    /// How the relay answers an EVENT.
    #[derive(Clone, Debug)]
    pub(crate) enum Answer {
        /// `["OK", id, true, ""]`.
        Accept,
    }

    pub(crate) struct TestRelay {
        pub(crate) url: String,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        kicks: Arc<Notify>,
    }

    impl TestRelay {
        pub(crate) async fn start(answer: Answer) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let events = Arc::new(StdMutex::new(Vec::new()));
            let kicks = Arc::new(Notify::new());
            let (log, kicked) = (Arc::clone(&events), Arc::clone(&kicks));
            tokio::spawn(async move {
                while let Ok((tcp, _)) = listener.accept().await {
                    let (log, kicked) = (Arc::clone(&log), Arc::clone(&kicked));
                    tokio::spawn(serve(tcp, answer.clone(), log, kicked));
                }
            });
            TestRelay { url, events, kicks }
        }

        /// The events it received, in order.
        pub(crate) fn events(&self) -> Vec<NostrEvent> {
            self.events.lock().unwrap().clone()
        }

        /// Close every connection it has, as a relay restarting would.
        pub(crate) fn kick(&self) {
            self.kicks.notify_waiters();
        }

        /// A messaging client of this relay, once its socket is up.
        pub(crate) async fn client(&self) -> Arc<NostrClient> {
            let client = NostrClient::start(&self.url, Arc::new(|_| {}), quick_options(None));
            wait_until("the client to connect", || client.is_connected()).await;
            client
        }
    }

    async fn serve(
        tcp: TcpStream,
        answer: Answer,
        events: Arc<StdMutex<Vec<NostrEvent>>>,
        kicks: Arc<Notify>,
    ) {
        let Ok(ws) = tokio_tungstenite::accept_async(tcp).await else {
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
                    let accepted = match &answer {
                        Answer::Accept => Some(true),
                    };
                    accepted.map(|ok| {
                        let message = if ok { "" } else { "blocked: test" };
                        serde_json::json!(["OK", event.id, ok, message])
                    })
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
    pub(crate) const QUICK: Backoff = Backoff {
        first: Duration::from_millis(10),
        max: Duration::from_millis(40),
    };

    pub(crate) fn quick_options(on_state: Option<StateHandler>) -> ClientOptions {
        ClientOptions {
            connector: websocket_connector(),
            first_connection: QUICK,
            reconnection: QUICK,
            on_state,
        }
    }

    /// A connector that never connects, counting its attempts.
    pub(crate) fn refusing_connector(attempts: Arc<AtomicUsize>) -> Connector {
        Arc::new(move |_url| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Err("refused".to_string()) })
        })
    }

    /// A client that keeps failing to connect, with its attempts counted.
    pub(crate) fn unreachable_client(attempts: Arc<AtomicUsize>) -> Arc<NostrClient> {
        let options = ClientOptions {
            connector: refusing_connector(attempts),
            ..quick_options(None)
        };
        NostrClient::start("ws://127.0.0.1:9", Arc::new(|_| {}), options)
    }

    /// Wait until `done`, or fail the test after 5 s.
    pub(crate) async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
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

    use super::test_relay::{quick_options, unreachable_client, wait_until, Answer, TestRelay};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

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
        let real = websocket_connector();
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
        let real = websocket_connector();
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
}
