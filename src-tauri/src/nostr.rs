use crate::crypto::sha256;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{schnorr::Signature, Keypair, Message as SecpMessage, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};

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

pub struct NostrClient {
    url: String,
    sender: mpsc::UnboundedSender<ClientCommand>,
    sub_counter: Arc<RwLock<u64>>,
}

enum ClientCommand {
    Send(String),
    Subscribe(Subscription),
    Close,
}

impl NostrClient {
    pub async fn connect(url: &str, on_event: EventHandler) -> Result<Arc<Self>, NostrError> {
        let (sender, receiver) = mpsc::unbounded_channel::<ClientCommand>();
        let pending_ok: Arc<RwLock<HashMap<String, OkCallback>>> =
            Arc::new(RwLock::new(HashMap::new()));

        // The first connection must succeed so the caller learns the relay is up.
        let (ws, _) = connect_async(url)
            .await
            .map_err(|e| NostrError::Connect(e.to_string()))?;

        let on_event_clone = on_event.clone();
        let pending_clone = pending_ok.clone();
        let url_log = url.to_string();
        // A single task owns the connection: it drives read + write + keepalive
        // via select!, and RECONNECTS with backoff when the socket drops (mobile
        // networks kill idle sockets when the screen turns off). Subscriptions
        // are re-sent on every (re)connection so we keep receiving, catch-up
        // ones with a `since` recomputed for that moment (see SubscriptionBook);
        // outgoing commands queue in the channel during a reconnect and flush
        // once we're back.
        tokio::spawn(async move {
            let mut receiver = receiver;
            let mut next_ws = Some(ws);
            let mut backoff = 1u64;
            let mut book = SubscriptionBook::default();
            'session: loop {
                let ws = match next_ws.take() {
                    Some(w) => w,
                    None => loop {
                        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                        match connect_async(&url_log).await {
                            Ok((w, _)) => {
                                dlog(&format!("WS reconnected: {}", url_log));
                                backoff = 1;
                                break w;
                            }
                            Err(e) => {
                                dlog(&format!(
                                    "WS reconnect failed {}: {} (retry {}s)",
                                    url_log, e, backoff
                                ));
                                backoff = (backoff * 2).min(30);
                            }
                        }
                    },
                };
                let (mut write, mut read) = ws.split();
                // Re-send the subscriptions so the fresh socket delivers events.
                for req in book.on_connected(unix_now()) {
                    let _ = write.send(Message::Text(req)).await;
                }
                let mut ping = tokio::time::interval(std::time::Duration::from_secs(25));
                ping.tick().await; // discard the immediate first tick
                loop {
                    tokio::select! {
                        incoming = read.next() => match incoming {
                            Some(Ok(Message::Text(text))) => {
                                book.on_frame(Some(&text), unix_now());
                                let _ = handle_relay_message(&text, &on_event_clone, &pending_clone).await;
                            }
                            Some(Ok(Message::Ping(payload))) => {
                                book.on_frame(None, unix_now());
                                let _ = write.send(Message::Pong(payload)).await;
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                dlog(&format!("WS dropped ({}) — reconnecting", url_log));
                                break;
                            }
                            // Pong / Binary / Frame: nothing to do, but the
                            // relay is evidently still there.
                            Some(Ok(_)) => book.on_frame(None, unix_now()),
                            Some(Err(e)) => {
                                dlog(&format!("WS read error {}: {} — reconnecting", url_log, e));
                                break;
                            }
                        },
                        cmd = receiver.recv() => match cmd {
                            Some(ClientCommand::Send(text)) => {
                                if write.send(Message::Text(text)).await.is_err() {
                                    break; // socket dead → reconnect
                                }
                            }
                            Some(ClientCommand::Subscribe(sub)) => {
                                // Kept in the book even if this send fails, so
                                // the reconnect re-sends it.
                                let req = book.add(sub, unix_now());
                                if write.send(Message::Text(req)).await.is_err() {
                                    break; // socket dead → reconnect
                                }
                            }
                            Some(ClientCommand::Close) | None => {
                                let _ = write.close().await;
                                break 'session; // shut down for good
                            }
                        },
                        _ = ping.tick() => {
                            if write.send(Message::Ping(Vec::new())).await.is_err() {
                                break; // socket dead → reconnect
                            }
                        }
                    }
                }
            }
        });

        Ok(Arc::new(NostrClient {
            url: url.to_string(),
            sender,
            sub_counter: Arc::new(RwLock::new(0)),
        }))
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
        dlog(&format!("SUBSCRIBE {} on {}", sub_id, self.url));
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

    pub fn close(&self) {
        let _ = self.sender.send(ClientCommand::Close);
    }
}

/// Append a diagnostic line to ~/.trino/trino-gui.log (mirrors commands::dbg_log).
fn dlog(msg: &str) {
    use std::io::Write;
    // Must use trino_home() (honours the mobile sandbox override), NOT
    // dirs::home_dir() — on Android the latter points outside the app sandbox
    // and every write fails silently, so relay logs never reach trino-gui.log.
    let path = crate::state::trino_home().join("trino-gui.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(
            format!(
                "[{}] {}\n",
                chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
                msg
            )
            .as_bytes(),
        );
    }
}

/// First `n` bytes of relay-supplied text, for log lines. Never panics on
/// short or non-ASCII input (same rule as `commands::short_prefix`).
fn log_prefix(s: &str, n: usize) -> &str {
    s.get(..n.min(s.len())).unwrap_or("?")
}

async fn handle_relay_message(
    text: &str,
    on_event: &EventHandler,
    _pending: &Arc<RwLock<HashMap<String, OkCallback>>>,
) -> Result<(), NostrError> {
    let Ok(msg) = serde_json::from_str::<Vec<Value>>(text) else {
        dlog(&format!(
            "WS recv: non-array message: {}",
            log_prefix(text, 60)
        ));
        return Ok(());
    };
    if msg.is_empty() {
        return Ok(());
    }
    let Some(msg_type) = msg[0].as_str() else {
        return Ok(());
    };

    if msg_type == "EVENT" && msg.len() >= 3 {
        match serde_json::from_value::<NostrEvent>(msg[2].clone()) {
            Ok(event) => {
                let ok = verify_event(&event);
                dlog(&format!(
                    "WS EVENT kind={} from={} verify={}",
                    event.kind,
                    log_prefix(&event.pubkey, 16),
                    ok
                ));
                if ok {
                    on_event(event);
                } else {
                    dlog("  -> verify_event FAILED (event dropped before handler)");
                }
            }
            Err(e) => dlog(&format!("WS EVENT deserialize failed: {}", e)),
        }
    } else {
        dlog(&format!("WS recv: {} (len {})", msg_type, msg.len()));
    }
    Ok(())
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
    fn log_prefix_never_splits_a_character() {
        // A relay controls this text; slicing it mid-character used to panic
        // and kill the connection task for good.
        let text = format!("{}ñ and more", "a".repeat(59));
        assert_eq!(log_prefix(&text, 60), "?");
        assert_eq!(log_prefix("short", 60), "short");
        assert_eq!(log_prefix(&"b".repeat(80), 60), "b".repeat(60));
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
}
