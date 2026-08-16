use crate::group::{FileRef, GroupRoster};
use crate::identity::{Identity, PublicBundle};
use crate::nostr::NostrClient;
use crate::ratchet::RatchetState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// Overridable data root. On mobile we set this to the app sandbox dir at
/// startup; on desktop it stays unset and we fall back to ~/.trino.
static HOME_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

#[cfg_attr(not(mobile), allow(dead_code))]
pub fn set_trino_home(path: PathBuf) {
    let _ = HOME_OVERRIDE.set(path);
}

#[derive(Default)]
pub struct AppState {
    pub inner: Arc<Mutex<InnerState>>,
}

#[derive(Default)]
pub struct InnerState {
    pub identity: Option<Identity>,
    pub totp_secret: Option<Vec<u8>>,
    pub handle: Option<String>,
    pub avatar: Option<String>,
    pub friends: HashMap<String, FriendRecord>,
    pub ratchets: HashMap<String, RatchetState>,
    pub associated_data: HashMap<String, Vec<u8>>,
    pub relays: Vec<Arc<NostrClient>>,
    /// Read-only connections opened by the network-activity inspector. Kept
    /// apart from `relays` so observing traffic never touches the messaging
    /// subscriptions or the decryption pipeline. Empty unless the panel is open.
    pub inspector_relays: Vec<Arc<NostrClient>>,
    pub current_peer: Option<String>,
    /// Event ids already processed, to dedup deliveries across multiple relays.
    pub seen_events: HashSet<String>,
    pub seen_event_order: VecDeque<String>,
    /// Known groups, keyed by groupId. Persisted to groups.json.
    pub groups: HashMap<String, GroupRoster>,
    /// Chat history keyed by conversation id (handle for DMs, "grp:<gid>" for groups).
    /// Persisted ENCRYPTED to history.bin with a key derived from the identity.
    pub history: HashMap<String, Vec<HistItem>>,
    pub history_key: Option<[u8; 32]>,
    /// Blocked senders, by nostr pubkey. Their events are dropped on arrival.
    pub blocked: HashSet<String>,
    /// Last time (unix secs) we auto-healed a desynced session per handle, to
    /// rate-limit re-handshakes and avoid storms. In-memory only.
    pub resync_at: HashMap<String, i64>,
    /// Recent outgoing text envelopes per handle: (message_id, envelope_bytes,
    /// ts). Replayed on the new session after an auto-heal so a message the peer
    /// couldn't decrypt (desync) isn't lost. In-memory, capped.
    pub outbox: HashMap<String, Vec<(String, Vec<u8>, i64)>>,
    /// Message ids already delivered to the UI, to drop duplicates from resends.
    pub seen_msg_ids: HashSet<String>,
    pub seen_msg_id_order: VecDeque<String>,
}

const SEEN_EVENT_CAP: usize = 4096;
const SEEN_MESSAGE_CAP: usize = 2048;

impl InnerState {
    pub fn remember_event(&mut self, id: String) -> bool {
        remember_recent_id(
            &mut self.seen_events,
            &mut self.seen_event_order,
            id,
            SEEN_EVENT_CAP,
        )
    }

    pub fn remember_message_id(&mut self, id: String) -> bool {
        remember_recent_id(
            &mut self.seen_msg_ids,
            &mut self.seen_msg_id_order,
            id,
            SEEN_MESSAGE_CAP,
        )
    }

    pub fn clear_seen_ids(&mut self) {
        self.seen_events.clear();
        self.seen_event_order.clear();
        self.seen_msg_ids.clear();
        self.seen_msg_id_order.clear();
    }
}

fn remember_recent_id(
    ids: &mut HashSet<String>,
    order: &mut VecDeque<String>,
    id: String,
    cap: usize,
) -> bool {
    if !ids.insert(id.clone()) {
        return false;
    }
    order.push_back(id);
    while order.len() > cap {
        if let Some(expired) = order.pop_front() {
            ids.remove(&expired);
        }
    }
    true
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistItem {
    pub side: String, // "me" | "them"
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<String>, // sender handle (group messages)
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub file: Option<FileRef>,
    pub ts: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendRecord {
    pub handle: String,
    pub bundle: PublicBundle,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar: Option<String>, // small profile thumbnail (data: URL) from their bundle
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub handle: String,
    pub nostr_pub: String,
    pub relays: Vec<String>,
    pub created_at: i64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub avatar: Option<String>, // your profile photo thumbnail (data: URL)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsFile {
    pub handle: String,
    pub friends: Vec<FriendRecord>,
    #[serde(default)]
    pub blocked: Vec<String>,
}

pub fn trino_home() -> PathBuf {
    if let Ok(home) = std::env::var("TRINO_HOME") {
        return PathBuf::from(home);
    }
    if let Some(o) = HOME_OVERRIDE.get() {
        return o.clone();
    }
    if let Some(d) = dirs::home_dir() {
        return d.join(".trino");
    }
    PathBuf::from(".trino")
}

pub fn vault_path() -> PathBuf {
    trino_home().join("vault.bin")
}

pub fn friends_path() -> PathBuf {
    trino_home().join("friends.json")
}

pub fn config_path() -> PathBuf {
    trino_home().join("config.json")
}

pub fn groups_path() -> PathBuf {
    trino_home().join("groups.json")
}

pub fn history_path() -> PathBuf {
    trino_home().join("history.bin")
}

pub fn ratchets_path() -> PathBuf {
    trino_home().join("ratchets.bin")
}

pub fn default_relays() -> Vec<String> {
    vec![
        "wss://relay.damus.io".to_string(),
        "wss://nos.lol".to_string(),
        "wss://relay.snort.social".to_string(),
    ]
}
