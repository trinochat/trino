use crate::call_log::CallEvent;
use crate::group::{FileRef, GroupRoster};
use crate::identity::{Identity, PublicBundle};
use crate::nostr::NostrClient;
use crate::ratchet::RatchetState;
use crate::totp_enrollment::TotpEnrollment;
use crate::turn::TurnCache;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
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
    /// Set by the frontend while a call holds the microphone or camera. Read
    /// when the window is closed or the app quits, without taking `inner`.
    pub call_active: Arc<AtomicBool>,
    /// Held for the whole of `forge`, `unseal`, `lock_vault` and `wipe`, so
    /// one of them at a time creates, opens, closes or deletes the identity.
    /// Kept apart from `inner` because they hold it across the slow key
    /// derivation, which must not stall everything else.
    pub session_gate: Mutex<()>,
    /// TURN credentials for protected calls, in memory only (see turn.rs).
    pub turn: TurnCache,
}

#[derive(Default)]
pub struct InnerState {
    pub identity: Option<Identity>,
    pub totp_secret: Option<Vec<u8>>,
    /// A TOTP secret being set up for a new identity (`totp_begin`,
    /// `totp_verify`), before any vault holds it. Memory only.
    pub totp_enrollment: TotpEnrollment,
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
    /// Group invitations waiting for the user, keyed by groupId. A roster for a
    /// group we are not in lands here, never directly in `groups`. Persisted to
    /// group_invites.json: the roster's event id is remembered as seen, so an
    /// invite kept only in memory would be lost for good on restart.
    pub group_invites: HashMap<String, GroupInvite>,
    /// Chat history keyed by conversation id (handle for DMs, "grp:<gid>" for groups).
    /// Persisted ENCRYPTED with the session's storage.
    pub history: HashMap<String, Vec<HistItem>>,
    /// Where the session keeps its data: the store, or the files of an
    /// account not moved yet (store/session.rs). Empty with no session.
    pub storage: crate::store::session::StorageCell,
    /// The relays this account connects to, as its account file keeps them.
    pub relay_urls: Vec<String>,
    /// When this account was created, in unix seconds.
    pub created_at: i64,
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
    /// Newest handshake accepted from each contact, keyed by their nostr
    /// pubkey, so an older (replayed) handshake can never replace the session
    /// a newer one started. Persisted in ratchets.bin. Only contacts'
    /// handshakes are recorded, so strangers cannot grow or evict it.
    pub handshake_marks: HashMap<String, HandshakeMark>,
    // -- W8 --
    /// When `contact-key-mismatch` last fired for each contact (unix secs),
    /// so it fires at most once every 10 minutes per contact. Memory only.
    pub key_mismatch_at: HashMap<String, i64>,
    /// The shared profiles (K12): this identity's "about" and revision, and
    /// what each contact shares and announced. Persisted ENCRYPTED to
    /// profiles.bin with a key of its own derived from the identity.
    pub profiles: crate::commands::profile::Profiles,
}

/// The newest handshake accepted from one contact.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeMark {
    /// `created_at` of the newest accepted handshake event.
    pub at: i64,
    /// Ephemeral keys of the handshakes accepted at exactly `at`, so a second
    /// genuine handshake within the same second is not taken for a replay.
    pub ek_pubs: Vec<String>,
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
    /// A call with this contact (K13); such an item has no text or file.
    /// Older versions read past it.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub call: Option<CallEvent>,
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
    /// The fingerprint the contact had before the user replaced its keys
    /// (K8), until the user says they saw the change.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub previous_fingerprint: Option<String>,
    /// When the keys were replaced, in unix seconds (K8).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub key_changed_at: Option<i64>,
    /// The group whose roster brought this contact (K9); `None` for one added
    /// with its code.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub via_group: Option<String>,
}

/// A signed roster for a group we are not in yet, held until the user accepts
/// or declines it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInvite {
    pub roster: GroupRoster,
    /// Handle of the contact who sent it (always the group admin).
    pub from_handle: String,
    pub received_at: i64,
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

pub fn group_invites_path() -> PathBuf {
    trino_home().join("group_invites.json")
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
