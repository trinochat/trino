//! The session's state (`InnerState`), the data folder, and the records
//! the session keeps: contacts, chats, group invitations and accepted
//! handshakes, and the files that held them before the store (cifrado
//! local).

use crate::call_log::CallEvent;
use crate::group::{FileRef, GroupRoster};
use crate::identity::{Identity, PublicBundle};
use crate::nostr::NostrClient;
use crate::ratchet::RatchetState;
use crate::totp_enrollment::TotpEnrollment;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

/// Overridable data root. On mobile we set this to the app sandbox dir at
/// startup; on desktop it stays unset and we fall back to ~/.trino.
static HOME_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_trino_home(path: PathBuf) {
    let _ = HOME_OVERRIDE.set(path);
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
    /// The session's version 3 vault, to seal its shared block again
    /// (vault_file.rs). Empty with no session.
    pub vault: crate::vault_file::VaultCell,
    /// The relays this account connects to, as its account file keeps them.
    pub relay_urls: Vec<String>,
    /// When this account was created, in unix seconds.
    pub created_at: i64,
    /// Whom you blocked, by identity (uso responsable UR-2, `block.rs`).
    /// Persisted ENCRYPTED with the account.
    pub blocked: crate::block::BlockList,
    /// Requests of people who are not contacts, and the identities whose
    /// request you deleted (uso responsable UR-4, `requests.rs`). Persisted
    /// ENCRYPTED to the store's requests.bin.
    pub requests: crate::requests::RequestBook,
    /// The reports you made (uso responsable UR-5, `report.rs`): sealed
    /// while they wait, then only their code and day, for 30 days.
    /// Persisted ENCRYPTED with the account.
    pub reports: crate::report::ReportBook,
    /// Told when a report is made, so `report::watch` sends it now.
    pub report_watch: Arc<tokio::sync::Notify>,
    /// Which `report::watch` is the session's: one started later replaces it.
    pub report_watcher: u64,
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
    pub profiles: crate::profile::Profiles,
    /// Why the last lock happened, kept while locked so the window opened
    /// after it can say so (CL-6a). Not a secret: it never names anyone.
    pub lock_reason: Option<crate::lock::LockReason>,
    // -- Clave de emergencia (CE-6) --
    /// The warning to a trusted contact, both sides: the one this account
    /// would send, and the questions and registrations of its contacts.
    /// Persisted ENCRYPTED in the store's account file.
    pub alerts: crate::alert::AlertBook,
    /// The connections that listen to the warnings' mailboxes, apart from
    /// `relays` (RC-07). Empty with no registration accepted.
    pub alert_relays: Vec<Arc<NostrClient>>,
    /// Told when the registrations listened to change, so their
    /// connections follow (`alert::watch`).
    pub alert_watch: Arc<tokio::sync::Notify>,
    /// Which `alert::watch` is the session's: one started later replaces it.
    pub alert_watcher: u64,
    /// Until when (unix seconds) Settings' "Qué pasa en la red" stays open
    /// after the passphrase opened it; 0 for closed. Memory only.
    pub alert_settings_until: i64,
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

#[derive(Clone, Serialize, Deserialize)]
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
    /// When you accepted this contact, in unix seconds (uso responsable
    /// UR-3, `group_contacts.rs`). `None` only for one a group's roster
    /// made, until you accept it: "Agregar a contactos", its request or its
    /// code. Always written, `null` included: a record of before UR-3 has
    /// none, and reads as accepted (U6, `ACCEPTED_BEFORE_UR3`).
    #[serde(default = "accepted_before_ur3")]
    pub accepted_at: Option<i64>,
}

/// What `accepted_at` says of a contact kept before UR-3: accepted, at a
/// moment nobody wrote down (U6: the contacts of a group of before stay as
/// they were, so no conversation is cut).
pub const ACCEPTED_BEFORE_UR3: i64 = 0;

fn accepted_before_ur3() -> Option<i64> {
    Some(ACCEPTED_BEFORE_UR3)
}

/// Debug without the message's text or its file (TRN-CORE-05): the file's
/// key and thumbnail are the attachment's secrets, and the text is the
/// message. What shows is that they are there.
impl std::fmt::Debug for HistItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let hidden = |there: bool| there.then_some("<redacted>");
        f.debug_struct("HistItem")
            .field("side", &self.side)
            .field("from", &self.from)
            .field("text", &hidden(self.text.is_some()))
            .field("file", &hidden(self.file.is_some()))
            .field("call", &self.call)
            .field("ts", &self.ts)
            .finish()
    }
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

/// Whether `TRINO_HOME` chose the data folder: then other folders may share
/// the WebView's localStorage with this one (design §5.6).
pub fn custom_data_dir() -> bool {
    std::env::var_os("TRINO_HOME").is_some()
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

/// Tor's folder (Tor design §2.5): in clear, outside the encrypted store,
/// in the data folder, so each `TRINO_HOME` has its own Tor.
pub const TOR_DIR: &str = "tor";

pub fn tor_home() -> PathBuf {
    trino_home().join(TOR_DIR)
}

/// The relays of a new account (Tor design decision 13, as updated on 14
/// Oct 2026): none behind Cloudflare, which also fronts TURN and would see
/// a call's IP next to the account's traffic (R-02); all three answered
/// through Tor exits 9 or 10 times in 10 (spike S6). relay.damus.io only if
/// the person adds it; nostr.oxtr.dev only by its onion once checked;
/// offchain.pub not at all (0 in 15 through Tor).
pub fn default_relays() -> Vec<String> {
    vec![
        "wss://nos.lol".to_string(),
        "wss://relay.snort.social".to_string(),
        "wss://nostr.mom".to_string(),
    ]
}

/// What `default_relays` was before decision 13. No screen ever let anyone
/// choose relays, so an account holding exactly these has the old
/// defaults, not a choice.
const EARLIER_DEFAULT_RELAYS: [&str; 3] = [
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.snort.social",
];

/// The relays a session connects to: the account's own, except none or
/// the old defaults, which become today's (decision 13 is for everyone,
/// design §17.2). Old and new share nos.lol and relay.snort.social, so
/// contacts on an earlier version are still reached.
pub fn relays_to_use(account: &[String]) -> Vec<String> {
    let earlier = account.len() == EARLIER_DEFAULT_RELAYS.len()
        && EARLIER_DEFAULT_RELAYS
            .iter()
            .all(|relay| account.iter().any(|own| own == relay));
    if account.is_empty() || earlier {
        default_relays()
    } else {
        account.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TRN-CORE-05: a derived Debug printed a message's text and its file's
    /// key, so one log line or panic would have written them to disk.
    #[test]
    fn trn_core_05_a_history_item_does_not_print_its_text_or_file_key() {
        let key = "ab".repeat(32);
        let item = HistItem {
            side: "them".into(),
            from: Some("ana".into()),
            text: Some("la clave es girasol".into()),
            file: Some(FileRef {
                url: "https://blossom.example/abc".into(),
                key: key.clone(),
                sha256: "0".repeat(64),
                mime: "image/png".into(),
                name: "foto.png".into(),
                size: 1,
                thumb: Some("data:image/png;base64,iVBORw0KGgo=".into()),
            }),
            call: None,
            ts: 1_760_000_000,
        };
        let shown = format!("{item:?} {item:#?}");
        assert!(!shown.contains("girasol"), "{shown}");
        assert!(!shown.contains(&key), "{shown}");
        assert!(!shown.contains("iVBORw0KGgo"), "{shown}");
        assert!(
            shown.contains("1760000000"),
            "the rest still shows: {shown}"
        );
    }

    /// Tor design decision 13, as updated on 14 Oct 2026 (spike S6).
    #[test]
    fn the_default_relays_are_none_behind_cloudflare() {
        assert_eq!(
            default_relays(),
            [
                "wss://nos.lol",
                "wss://relay.snort.social",
                "wss://nostr.mom"
            ]
        );
        for relay in default_relays() {
            assert!(!relay.contains("damus"), "damus only if added by hand");
            assert!(!relay.contains("offchain"));
            assert!(
                !relay.contains("oxtr"),
                "oxtr only by its onion, once checked"
            );
        }
    }

    #[test]
    fn an_account_with_the_earlier_defaults_gets_todays() {
        let earlier = [
            "wss://relay.damus.io",
            "wss://nos.lol",
            "wss://relay.snort.social",
        ]
        .map(String::from);
        assert_eq!(relays_to_use(&earlier), default_relays());
        // In another order, the same three.
        let mut shuffled = earlier.to_vec();
        shuffled.reverse();
        assert_eq!(relays_to_use(&shuffled), default_relays());
        assert_eq!(relays_to_use(&[]), default_relays());
        // Anything else is the account's own, damus included.
        let own = ["wss://relay.damus.io".to_string()];
        assert_eq!(relays_to_use(&own), own);
        let more = [earlier.to_vec(), vec!["wss://nostr.mom".to_string()]].concat();
        assert_eq!(relays_to_use(&more), more);
    }
}
