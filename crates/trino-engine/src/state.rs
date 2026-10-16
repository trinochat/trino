//! The data folder and the records the session keeps: contacts, chats,
//! group invitations and accepted handshakes, and the files that held them
//! before the store (cifrado local).

use crate::call_log::CallEvent;
use crate::group::{FileRef, GroupRoster};
use crate::identity::PublicBundle;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::OnceLock;

/// Overridable data root. On mobile we set this to the app sandbox dir at
/// startup; on desktop it stays unset and we fall back to ~/.trino.
static HOME_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_trino_home(path: PathBuf) {
    let _ = HOME_OVERRIDE.set(path);
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
