use crate::crypto::sha256;
use futures_util::{SinkExt, StreamExt};
use secp256k1::{schnorr::Signature, Keypair, Message as SecpMessage, Secp256k1, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
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

pub struct NostrClient {
    url: String,
    sender: mpsc::UnboundedSender<ClientCommand>,
    sub_counter: Arc<RwLock<u64>>,
    // Active subscription REQ payloads, replayed on every reconnect so we keep
    // receiving after a mobile network drop / relay hiccup.
    subs: Arc<RwLock<Vec<String>>>,
}

enum ClientCommand {
    Send(String),
    Close,
}

impl NostrClient {
    pub async fn connect(url: &str, on_event: EventHandler) -> Result<Arc<Self>, NostrError> {
        let (sender, receiver) = mpsc::unbounded_channel::<ClientCommand>();
        let pending_ok: Arc<RwLock<HashMap<String, OkCallback>>> =
            Arc::new(RwLock::new(HashMap::new()));
        let subs: Arc<RwLock<Vec<String>>> = Arc::new(RwLock::new(Vec::new()));

        // The first connection must succeed so the caller learns the relay is up.
        let (ws, _) = connect_async(url)
            .await
            .map_err(|e| NostrError::Connect(e.to_string()))?;

        let on_event_clone = on_event.clone();
        let pending_clone = pending_ok.clone();
        let subs_task = subs.clone();
        let url_log = url.to_string();
        // A single task owns the connection: it drives read + write + keepalive
        // via select!, and RECONNECTS with backoff when the socket drops (mobile
        // networks kill idle sockets when the screen turns off). Stored
        // subscriptions are replayed on every (re)connection so we keep
        // receiving; outgoing commands queue in the channel during a reconnect
        // and flush once we're back.
        tokio::spawn(async move {
            let mut receiver = receiver;
            let mut next_ws = Some(ws);
            let mut backoff = 1u64;
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
                // Replay active subscriptions so the fresh socket delivers events.
                for req in subs_task.read().await.iter() {
                    let _ = write.send(Message::Text(req.clone())).await;
                }
                let mut ping = tokio::time::interval(std::time::Duration::from_secs(25));
                ping.tick().await; // discard the immediate first tick
                loop {
                    tokio::select! {
                        incoming = read.next() => match incoming {
                            Some(Ok(Message::Text(text))) => {
                                let _ = handle_relay_message(&text, &on_event_clone, &pending_clone).await;
                            }
                            Some(Ok(Message::Ping(payload))) => {
                                let _ = write.send(Message::Pong(payload)).await;
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                dlog(&format!("WS dropped ({}) — reconnecting", url_log));
                                break;
                            }
                            Some(Ok(_)) => {} // Pong / Binary / Frame — ignore
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
            subs,
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

    pub async fn subscribe(&self, filter: &NostrFilter) -> Result<String, NostrError> {
        let mut c = self.sub_counter.write().await;
        *c += 1;
        let sub_id = format!("trino-{}", c);
        let payload = serde_json::json!(["REQ", sub_id, filter]).to_string();
        dlog(&format!(
            "SUBSCRIBE {} on {} ({}b)",
            sub_id,
            self.url,
            payload.len()
        ));
        // Remember it so the reconnect loop can replay it after a drop.
        self.subs.write().await.push(payload.clone());
        self.sender
            .send(ClientCommand::Send(payload))
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

async fn handle_relay_message(
    text: &str,
    on_event: &EventHandler,
    _pending: &Arc<RwLock<HashMap<String, OkCallback>>>,
) -> Result<(), NostrError> {
    let Ok(msg) = serde_json::from_str::<Vec<Value>>(text) else {
        dlog(&format!(
            "WS recv: non-array message: {}",
            &text[..60.min(text.len())]
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
                    &event.pubkey[..16.min(event.pubkey.len())],
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
