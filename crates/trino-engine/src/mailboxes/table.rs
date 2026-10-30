//! The routing table of an epoch and the duplicate markers (design P1
//! §3.6, §3.7, R-08, R-14).
//!
//! For every contact not blocked, in epoch `e`, the session listens to:
//! - the incoming introduction mailbox (handshakes only), which needs no
//!   state, so it exists for every contact, new or from before P1;
//! - the incoming session mailbox of the current session, and of the
//!   previous one while it is still listened to (§3.8; at most two, R-30).
//!
//! The table maps each of those mailboxes to its route, and replaces the
//! lookup by the event's author: a P1 event's author is a one-time key.
//! It is rebuilt every epoch and whenever contacts, blocks or sessions
//! change; it reaches the relays through the renewal (§3.6). Two routes
//! that give the same mailbox never share it: the later contact is
//! refused (R-14).
//!
//! Duplicates are remembered as `HMAC(k_dedup, id)` of the route's epoch,
//! never as event ids, and only for this epoch and the one before: older
//! mailboxes no longer route (R-08).

use crate::block::friend_blocked;
use crate::identity::{decode_array_32, KeyPair};
use crate::state::InnerState;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use trino_core::p1::mailbox::{
    dedup_key, direction, epoch_secret, intro_seed, mailbox, Direction, Mailbox, MailboxError,
    SessionChain,
};
use zeroize::Zeroizing;

/// The generation of every mailbox for now (R-17 keeps the field for a
/// later move).
pub const GENERATION: u8 = 0;

/// Markers kept per epoch: past this the oldest go first. A relay that
/// sends the same events again and again can only make one come back
/// twice, after this many others.
pub const DEDUP_PER_EPOCH: usize = 8192;

/// Which of a contact's sessions: at most the current one and the one
/// before it (R-30).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Slot {
    Current,
    Previous,
}

/// What a mailbox carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// The introduction mailbox: handshakes only (§3.2).
    Intro,
    /// A session's mailbox: everything else (§3.3).
    Session(Slot),
}

/// Where an event that came to one of the epoch's mailboxes goes.
pub struct Route {
    /// The contact's handle.
    pub contact: String,
    pub class: Class,
    /// The epoch of the mailbox.
    pub epoch: u32,
    /// The way it carries messages: from the contact to this device.
    pub direction: Direction,
    /// Its keys: `sk` opens the NIP-44 layer, `k_mac` the inner frame.
    pub mailbox: Mailbox,
    /// The key of its duplicate markers.
    pub k_dedup: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Route")
            .field("contact", &self.contact)
            .field("class", &self.class)
            .field("epoch", &self.epoch)
            .finish_non_exhaustive()
    }
}

/// A contact as the table needs it.
pub struct Peer<'a> {
    pub handle: &'a str,
    /// Their X25519 identity key: the device 0 key of `diseno-vinculacion.md`.
    pub dh: [u8; 32],
    pub sessions: Vec<(Slot, &'a SessionChain)>,
}

/// The routes of one epoch, by mailbox.
#[derive(Debug)]
pub struct Table {
    epoch: u32,
    routes: HashMap<[u8; 32], Route>,
    refused: Vec<String>,
}

impl Table {
    /// The table of epoch `e` for this device (`me`, its X25519 identity
    /// key) and `peers`, in the order they were added: on a clash the later
    /// one is refused whole.
    pub fn build<'a>(me: &KeyPair, peers: impl IntoIterator<Item = Peer<'a>>, e: u32) -> Table {
        let mut table = Table {
            epoch: e,
            routes: HashMap::new(),
            refused: Vec::new(),
        };
        for peer in peers {
            match incoming_routes(me, &peer, e) {
                Ok(routes)
                    if routes
                        .iter()
                        .all(|route| !table.routes.contains_key(&route.mailbox.tag)) =>
                {
                    for route in routes {
                        table.routes.insert(route.mailbox.tag, route);
                    }
                }
                _ => table.refused.push(peer.handle.to_string()),
            }
        }
        table
    }

    /// The table of epoch `e` for the open session: its contacts that are
    /// not blocked, oldest first, with the sessions that run on P1.
    pub fn of(inner: &InnerState, e: u32) -> Table {
        let Some(identity) = inner.identity.as_ref() else {
            return Table {
                epoch: e,
                routes: HashMap::new(),
                refused: Vec::new(),
            };
        };
        let mut friends: Vec<_> = inner
            .friends
            .values()
            // Of someone blocked, only an administrator of a group you are
            // in is listened to, for its rosters (UR-2, R-04).
            .filter(|friend| {
                !friend_blocked(inner, friend)
                    || crate::block::administers_a_group(inner, &friend.bundle.ik_sign_pub)
            })
            .collect();
        friends.sort_by(|a, b| a.added_at.cmp(&b.added_at).then(a.handle.cmp(&b.handle)));
        let peers = friends.into_iter().filter_map(|friend| {
            let dh = crate::device::peer_device_dh(friend)?;
            let sessions = inner
                .ratchets
                .get(&friend.handle)
                .filter(|state| state.is_p1())
                .and_then(|state| state.session.as_ref())
                .map(|chain| vec![(Slot::Current, chain)])
                .unwrap_or_default();
            Some(Peer {
                handle: &friend.handle,
                dh,
                sessions,
            })
        });
        Table::build(&identity.ik_dh, peers, e)
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn route(&self, tag: &[u8; 32]) -> Option<&Route> {
        self.routes.get(tag)
    }

    /// Every mailbox of the epoch, sorted: what the relays are asked for
    /// (before the padding).
    pub fn mailboxes(&self) -> Vec<[u8; 32]> {
        let mut tags: Vec<_> = self.routes.keys().copied().collect();
        tags.sort_unstable();
        tags
    }

    /// The contacts left out because one of their mailboxes was already
    /// another's, or their key is this device's.
    pub fn refused(&self) -> &[String] {
        &self.refused
    }
}

/// The introduction mailbox this device sends a handshake to, for the
/// contact whose X25519 key is `theirs`, in epoch `e`.
pub fn outgoing_intro(me: &KeyPair, theirs: &[u8; 32], e: u32) -> Result<Mailbox, MailboxError> {
    let seed = intro_seed(&me.priv_bytes, &me.pub_bytes, theirs)?;
    let d = direction(&me.pub_bytes, theirs)?;
    Ok(mailbox(&epoch_secret(&seed, e), d, GENERATION))
}

/// The session mailbox this device sends to in epoch `e`; `None` if the
/// chain has no secret for `e`.
pub fn outgoing_session(
    me: &KeyPair,
    theirs: &[u8; 32],
    chain: &SessionChain,
    e: u32,
) -> Result<Option<Mailbox>, MailboxError> {
    let d = direction(&me.pub_bytes, theirs)?;
    Ok(chain.secret(e).map(|s| mailbox(s, d, GENERATION)))
}

/// The routes `peer` gets in epoch `e`: its incoming introduction mailbox,
/// and its sessions' that have a secret for `e`.
fn incoming_routes(me: &KeyPair, peer: &Peer, e: u32) -> Result<Vec<Route>, MailboxError> {
    let d = direction(&peer.dh, &me.pub_bytes)?;
    let route = |class, s: &[u8; 32]| Route {
        contact: peer.handle.to_string(),
        class,
        epoch: e,
        direction: d,
        mailbox: mailbox(s, d, GENERATION),
        k_dedup: dedup_key(s),
    };
    let seed = intro_seed(&me.priv_bytes, &me.pub_bytes, &peer.dh)?;
    let intro = epoch_secret(&seed, e);
    let mut routes = vec![route(Class::Intro, &intro)];
    for (slot, chain) in &peer.sessions {
        if let Some(s) = chain.secret(e) {
            routes.push(route(Class::Session(*slot), s));
        }
    }
    Ok(routes)
}

/// `HMAC-SHA256(k_dedup, id)`.
fn marker(k_dedup: &[u8; 32], id: &str) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(k_dedup).expect("HMAC takes a key of any length");
    mac.update(id.as_bytes());
    mac.finalize().into_bytes().into()
}

/// One epoch's markers, oldest first.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "Vec<String>", into = "Vec<String>")]
struct Marks {
    order: VecDeque<[u8; 32]>,
    set: HashSet<[u8; 32]>,
}

impl From<Vec<String>> for Marks {
    fn from(saved: Vec<String>) -> Self {
        let mut marks = Marks::default();
        for mark in saved.iter().filter_map(|hex| decode_array_32(hex).ok()) {
            marks.insert(mark);
        }
        marks
    }
}

impl From<Marks> for Vec<String> {
    fn from(marks: Marks) -> Self {
        marks.order.iter().map(hex::encode).collect()
    }
}

impl Marks {
    fn insert(&mut self, mark: [u8; 32]) -> bool {
        if !self.set.insert(mark) {
            return false;
        }
        self.order.push_back(mark);
        if self.order.len() > DEDUP_PER_EPOCH {
            if let Some(oldest) = self.order.pop_front() {
                self.set.remove(&oldest);
            }
        }
        true
    }
}

/// The duplicate markers of this epoch and the one before.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Dedup {
    epochs: BTreeMap<u32, Marks>,
}

impl Dedup {
    /// Whether event `id`, come to `route`'s mailbox, is new; it is
    /// remembered either way.
    pub fn first_sight(&mut self, route: &Route, id: &str) -> bool {
        self.epochs
            .entry(route.epoch)
            .or_default()
            .insert(marker(&route.k_dedup, id))
    }

    /// Drops the markers of epochs before `today − 1`.
    pub fn purge(&mut self, today: u32) {
        self.epochs = self.epochs.split_off(&today.saturating_sub(1));
    }

    /// How many markers are kept.
    pub fn len(&self) -> usize {
        self.epochs.values().map(|marks| marks.order.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::BlockedIdentity;
    use crate::identity::{create_identity, Identity};
    use crate::session::tests::{friend, state_with};

    const E: u32 = 20_370;

    fn chain_between(seed: u8, e0: u32, today: u32) -> SessionChain {
        SessionChain::start(&[seed; 32], e0, today).unwrap()
    }

    fn peer<'a>(
        handle: &'a str,
        id: &Identity,
        sessions: Vec<(Slot, &'a SessionChain)>,
    ) -> Peer<'a> {
        Peer {
            handle,
            dh: id.ik_dh.pub_bytes,
            sessions,
        }
    }

    #[test]
    fn what_one_side_sends_to_is_what_the_other_listens_to() {
        let (a, b) = (create_identity(), create_identity());
        let chain = chain_between(7, E - 2, E);
        let table_b = Table::build(
            &b.ik_dh,
            [peer("ana", &a, vec![(Slot::Current, &chain)])],
            E,
        );
        let table_a = Table::build(
            &a.ik_dh,
            [peer("beto", &b, vec![(Slot::Current, &chain)])],
            E,
        );

        let intro = outgoing_intro(&a.ik_dh, &b.ik_dh.pub_bytes, E).unwrap();
        let route = table_b
            .route(&intro.tag)
            .expect("B listens to A's introductions");
        assert_eq!(
            (route.contact.as_str(), route.class, route.epoch),
            ("ana", Class::Intro, E)
        );
        assert_eq!(*route.mailbox.sk, *intro.sk);
        assert_eq!(*route.mailbox.k_mac, *intro.k_mac);

        let session = outgoing_session(&a.ik_dh, &b.ik_dh.pub_bytes, &chain, E)
            .unwrap()
            .unwrap();
        let route = table_b
            .route(&session.tag)
            .expect("B listens to the session");
        assert_eq!(route.class, Class::Session(Slot::Current));
        assert_eq!(
            route.direction,
            direction(&a.ik_dh.pub_bytes, &b.ik_dh.pub_bytes).unwrap()
        );

        // And the other way round; never one's own outgoing mailbox.
        let back = outgoing_session(&b.ik_dh, &a.ik_dh.pub_bytes, &chain, E)
            .unwrap()
            .unwrap();
        assert!(table_a.route(&back.tag).is_some());
        assert!(table_a.route(&session.tag).is_none());
        assert!(table_b.route(&back.tag).is_none());
        assert_eq!(table_b.mailboxes().len(), 2);
    }

    #[test]
    fn yesterdays_session_mailbox_is_still_known_and_older_ones_are_not() {
        let (a, b) = (create_identity(), create_identity());
        let chain = chain_between(9, E - 5, E);
        assert!(
            outgoing_session(&a.ik_dh, &b.ik_dh.pub_bytes, &chain, E - 1)
                .unwrap()
                .is_some()
        );
        assert!(
            outgoing_session(&a.ik_dh, &b.ik_dh.pub_bytes, &chain, E - 2)
                .unwrap()
                .is_none()
        );
        // A chain behind the epoch gives no session route, the
        // introduction stays.
        let behind = chain_between(9, E - 5, E - 3);
        let table = Table::build(
            &b.ik_dh,
            [peer("ana", &a, vec![(Slot::Current, &behind)])],
            E,
        );
        assert_eq!(table.mailboxes().len(), 1);
        let only = table.route(&table.mailboxes()[0]).unwrap();
        assert_eq!(only.class, Class::Intro);
    }

    #[test]
    fn two_epochs_share_no_mailbox() {
        let (a, b, c) = (create_identity(), create_identity(), create_identity());
        let chain = chain_between(3, E, E + 1);
        let peers = || {
            [
                peer("ana", &a, vec![(Slot::Current, &chain)]),
                peer("caro", &c, vec![]),
            ]
        };
        let today: HashSet<_> = Table::build(&b.ik_dh, peers(), E)
            .mailboxes()
            .into_iter()
            .collect();
        let tomorrow: HashSet<_> = Table::build(&b.ik_dh, peers(), E + 1)
            .mailboxes()
            .into_iter()
            .collect();
        assert_eq!((today.len(), tomorrow.len()), (3, 3));
        assert!(today.is_disjoint(&tomorrow));
    }

    #[test]
    fn the_previous_session_is_listened_to_beside_the_current_one() {
        let (a, b) = (create_identity(), create_identity());
        let (old, new) = (chain_between(1, E - 9, E), chain_between(2, E, E));
        let table = Table::build(
            &b.ik_dh,
            [peer(
                "ana",
                &a,
                vec![(Slot::Current, &new), (Slot::Previous, &old)],
            )],
            E,
        );
        let classes: HashSet<_> = table
            .mailboxes()
            .iter()
            .map(|tag| format!("{:?}", table.route(tag).unwrap().class))
            .collect();
        assert_eq!(classes.len(), 3, "{classes:?}");
    }

    #[test]
    fn a_contact_whose_mailbox_is_taken_or_whose_key_is_mine_is_refused() {
        let (a, b) = (create_identity(), create_identity());
        let table = Table::build(
            &b.ik_dh,
            [
                peer("ana", &a, vec![]),
                peer("copia", &a, vec![]),
                peer("yo", &b, vec![]),
            ],
            E,
        );
        assert_eq!(table.refused(), ["copia", "yo"]);
        assert_eq!(table.mailboxes().len(), 1);
        assert_eq!(table.route(&table.mailboxes()[0]).unwrap().contact, "ana");
    }

    #[test]
    fn the_sessions_table_leaves_out_the_blocked_and_holds_no_identity_value() {
        let (me, ana, beto) = (create_identity(), create_identity(), create_identity());
        let mut inner = state_with(&[friend(&ana, "ana"), friend(&beto, "beto")]);
        inner.identity = Some(me.clone());
        let blocked = BlockedIdentity::before_ur2(
            hex::encode(beto.nostr.pub_bytes),
            inner.friends.get("beto"),
            0,
        );
        inner.blocked.insert(blocked);

        let table = Table::of(&inner, E);
        let contacts: Vec<_> = table
            .mailboxes()
            .iter()
            .map(|tag| table.route(tag).unwrap().contact.clone())
            .collect();
        assert_eq!(contacts, ["ana"]);

        let identity_values: Vec<[u8; 32]> = [&me, &ana, &beto]
            .iter()
            .flat_map(|id| [id.ik_sign.pub_bytes, id.ik_dh.pub_bytes, id.nostr.pub_bytes])
            .collect();
        for tag in table.mailboxes() {
            assert!(!identity_values.contains(&tag));
        }
    }

    #[test]
    fn only_sessions_that_run_on_p1_have_a_session_route() {
        let (me, ana) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&ana, "ana")]);
        inner.identity = Some(me.clone());
        let state = crate::session::tests::plain_ratchet();
        // A session of before P1: introductions only.
        inner.ratchets.insert("ana".into(), state.clone());
        assert_eq!(Table::of(&inner, E).mailboxes().len(), 1);

        let mut p1 = state;
        p1.attach_session(trino_core::pqxdh::SUITE, &[4; 32], E, E)
            .unwrap();
        inner.ratchets.insert("ana".into(), p1);
        let table = Table::of(&inner, E);
        assert_eq!(table.mailboxes().len(), 2);
        assert!(table
            .mailboxes()
            .iter()
            .any(|tag| table.route(tag).unwrap().class == Class::Session(Slot::Current)));
    }

    #[test]
    fn a_duplicate_is_seen_once_per_mailbox_epoch_and_never_kept_as_its_id() {
        let (a, b) = (create_identity(), create_identity());
        let today = Table::build(&b.ik_dh, [peer("ana", &a, vec![])], E);
        let yesterday = Table::build(&b.ik_dh, [peer("ana", &a, vec![])], E - 1);
        let route = today.route(&today.mailboxes()[0]).unwrap();
        let old = yesterday.route(&yesterday.mailboxes()[0]).unwrap();
        let id = "ab".repeat(32);

        let mut dedup = Dedup::default();
        assert!(dedup.first_sight(route, &id));
        assert!(!dedup.first_sight(route, &id));
        assert!(dedup.first_sight(old, &id), "another epoch, another key");
        let saved = serde_json::to_string(&dedup).unwrap();
        assert!(!saved.contains(&id), "{saved}");
        let back: Dedup = serde_json::from_str(&saved).unwrap();
        assert_eq!(back, dedup);

        dedup.purge(E);
        assert_eq!(dedup.len(), 2, "today and yesterday stay");
        dedup.purge(E + 1);
        assert_eq!(dedup.len(), 1);
        dedup.purge(E + 2);
        assert!(dedup.is_empty());
    }

    #[test]
    fn markers_are_capped_per_epoch_oldest_first() {
        let (a, b) = (create_identity(), create_identity());
        let table = Table::build(&b.ik_dh, [peer("ana", &a, vec![])], E);
        let route = table.route(&table.mailboxes()[0]).unwrap();
        let mut dedup = Dedup::default();
        for n in 0..=DEDUP_PER_EPOCH {
            assert!(dedup.first_sight(route, &n.to_string()));
        }
        assert_eq!(dedup.len(), DEDUP_PER_EPOCH);
        assert!(dedup.first_sight(route, "0"), "the oldest went first");
        assert!(!dedup.first_sight(route, &DEDUP_PER_EPOCH.to_string()));
    }
}
