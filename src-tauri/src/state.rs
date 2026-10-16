use crate::group::GroupRoster;
use crate::identity::Identity;
use crate::nostr::NostrClient;
use crate::ratchet::RatchetState;
use crate::totp_enrollment::TotpEnrollment;
use crate::turn::TurnGate;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;

// The data folder and the session's records live in the engine (M4-0),
// under the same paths as before: `crate::state::trino_home`, `HistItem`…
pub use trino_engine::state::*;

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
    /// Ties the requests for TURN credentials to the unlocked session; it
    /// keeps none (see turn.rs).
    pub turn: TurnGate,
    /// Windows was locked during a call: Trino locks when the call ends
    /// (cifrado local CL-6a, design §7.2). Cleared by every lock.
    pub lock_after_call: Arc<AtomicBool>,
    /// Every connection of the app goes through it (Tor design §2): Tor,
    /// started and stopped with the app (net_cmds.rs), and the two permits
    /// to go without it. `AppState::default()` has none, so tests never
    /// start Arti; the app's own is `AppState::with_tor()`.
    pub net: Arc<trino_net::Net>,
    /// Trino's own updater (Tor design §6, updater.rs): the daily check,
    /// the verified installer held until the yes, and installing it.
    pub updater: Arc<crate::updater::Updater>,
}

impl AppState {
    /// The app's state, with Tor (Arti) keeping its files in `tor_home()`
    /// and lyrebird as its bridge program.
    /// It starts nothing: `net_cmds::on_open` does, as decided.
    pub fn with_tor() -> Self {
        AppState {
            net: trino_net::Net::with_arti(trino_net::NetConfig {
                tor_home: tor_home(),
                // lyrebird next to TrinoChat.exe, with its pinned SHA-256
                // (TOR-7); none in a build that does not ship it.
                pt: crate::commands::bridges_cmds::lyrebird(),
            }),
            ..AppState::default()
        }
    }
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
    /// Why the last lock happened, kept while locked so the window opened
    /// after it can say so (CL-6a). Not a secret: it never names anyone.
    pub lock_reason: Option<crate::commands::lock_cmds::LockReason>,
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
