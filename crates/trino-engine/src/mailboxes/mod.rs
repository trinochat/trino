//! P1's mailboxes in the engine (P1-7, design P1 §3.5-§3.8): the network
//! time and its epochs, the routing table of the epoch, the padding of the
//! list a relay is asked for, when that list is renewed, the duplicate
//! markers, and what of all this is kept on disk.
//!
//! The derivations themselves (seeds, the session chain, the mailbox keys)
//! are trino-core's `p1::mailbox`; this module decides which of them a
//! session listens to and sends to, and when. Nothing in here opens a
//! connection: the relays are driven by whoever holds the session, with
//! the plans these functions give.

pub mod clock;
pub mod pad;
pub mod schedule;
pub mod table;

use crate::block::friend_blocked;
use crate::state::InnerState;
use pad::PadBook;
use rand::{CryptoRng, Rng};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use table::Dedup;

/// What the mailboxes keep on disk, in the sessions file (`RatchetsFile`
/// version 2, design P1 §9): the padding of the open epochs, the duplicate
/// markers, and the proactive handshakes owed. Everything else is derived
/// again from the contacts and the sessions.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MailboxState {
    #[serde(default)]
    pub pads: PadBook,
    #[serde(default)]
    pub dedup: Dedup,
    /// Contacts owed a proactive handshake, and when it goes out (unix
    /// seconds): kept, so a restart does not draw the moment again.
    #[serde(default)]
    pub handshakes_due: BTreeMap<String, i64>,
}

impl MailboxState {
    /// Drops the padding and the markers of epochs before `today − 1`.
    pub fn purge(&mut self, today: u32) {
        self.pads.purge(today);
        self.dedup.purge(today);
    }
}

/// Drops every session that does not run on P1: one of before P1 has no
/// mailbox secret and cannot be used any more (design P1 §9). The contact
/// stays. Gives the contacts whose session went, sorted.
pub fn drop_pre_p1_sessions(inner: &mut InnerState) -> Vec<String> {
    let mut dropped: Vec<String> = inner
        .ratchets
        .iter()
        .filter(|(_, state)| !state.is_p1())
        .map(|(handle, _)| handle.clone())
        .collect();
    dropped.sort();
    for handle in &dropped {
        // RatchetState wipes its secrets on drop.
        inner.ratchets.remove(handle);
        if let Some(mut ad) = inner.associated_data.remove(handle) {
            zeroize::Zeroize::zeroize(&mut ad);
        }
    }
    dropped
}

/// Owes a proactive handshake, 5–60 minutes after `now`, to every contact
/// not blocked that has no session running on P1 and is owed none yet;
/// forgets what is owed to a contact that has one again, is blocked or is
/// gone (design P1 §3.8, R-01).
pub fn plan_handshakes<R: Rng + CryptoRng>(inner: &mut InnerState, now: i64, rng: &mut R) {
    let owed: Vec<String> = inner
        .friends
        .values()
        .filter(|friend| !friend_blocked(inner, friend))
        .filter(|friend| {
            !inner
                .ratchets
                .get(&friend.handle)
                .is_some_and(|state| state.is_p1())
        })
        .map(|friend| friend.handle.clone())
        .collect();
    let due = &mut inner.mailboxes.handshakes_due;
    due.retain(|handle, _| owed.contains(handle));
    for handle in owed {
        due.entry(handle).or_insert_with(|| {
            let wait = schedule::handshake_delay(rng).as_secs();
            now.saturating_add(i64::try_from(wait).unwrap_or(i64::MAX))
        });
    }
}

/// What loading the sessions does under P1: drops those of before P1 and
/// plans the handshakes that replace them. Gives the contacts whose
/// session went.
pub fn on_load<R: Rng + CryptoRng>(inner: &mut InnerState, now: i64, rng: &mut R) -> Vec<String> {
    let dropped = drop_pre_p1_sessions(inner);
    plan_handshakes(inner, now, rng);
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::block::BlockedIdentity;
    use crate::identity::{create_identity, Identity};
    use crate::ratchet::RatchetState;
    use crate::session::tests::{add_session_read_by, friend, state_with};
    use crate::session::{load_ratchets, RatchetsFile, RATCHETS_VERSION};
    use crate::store::session::Found;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use schedule::{HANDSHAKE_MAX, HANDSHAKE_MIN};
    use zeroize::Zeroizing;

    const NOW: i64 = 1_760_000_000;
    const E: u32 = 20_370;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(3)
    }

    /// A session of `me`'s, of before P1 or (with `p1`) on P1.
    fn session(me: &Identity, p1: bool) -> RatchetState {
        let other = create_identity();
        let (mut state, _) = add_session_read_by(&mut InnerState::default(), me, &other, "x");
        if p1 {
            state
                .attach_session(trino_core::pqxdh::SUITE, &[5; 32], E, E)
                .unwrap();
        }
        state
    }

    fn found(file: &RatchetsFile) -> Found {
        Found::Ready(Zeroizing::new(serde_json::to_vec(file).unwrap()))
    }

    #[test]
    fn the_sessions_file_is_written_as_version_2_with_the_mailboxes() {
        let mut inner = state_with(&[]);
        inner.mailboxes.pads.of(E, &mut rng()).fill(&[[1; 32]]);
        inner
            .mailboxes
            .handshakes_due
            .insert("ana".into(), NOW + 600);

        let file = RatchetsFile::from_state(&inner);
        assert_eq!(file.version, RATCHETS_VERSION);
        assert_eq!(RATCHETS_VERSION, 2);
        let mut restarted = InnerState::default();
        load_ratchets(&mut restarted, found(&file));
        assert_eq!(restarted.mailboxes, inner.mailboxes);
    }

    #[test]
    fn a_sessions_file_of_a_newer_version_is_not_read() {
        let me = create_identity();
        let mut file = RatchetsFile::default();
        file.ratchets.insert("ana".into(), session(&me, true));
        file.version = RATCHETS_VERSION + 1;
        let mut inner = InnerState::default();
        load_ratchets(&mut inner, found(&file));
        assert!(inner.ratchets.is_empty());
    }

    #[test]
    fn a_version_1_file_loses_its_sessions_keeps_its_contacts_and_owes_handshakes() {
        let (me, ana, beto, caro) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        // Written before P1: no version, no mailboxes.
        let mut before = RatchetsFile::default();
        before.ratchets.insert("ana".into(), session(&me, false));
        before.ratchets.insert("beto".into(), session(&me, true));
        before.associated_data.insert("ana".into(), vec![1, 2]);
        let mut json = serde_json::to_value(&before).unwrap();
        let map = json.as_object_mut().unwrap();
        map.remove("version");
        map.remove("mailboxes");

        let mut inner = state_with(&[
            friend(&ana, "ana"),
            friend(&beto, "beto"),
            friend(&caro, "caro"),
        ]);
        inner.identity = Some(me);
        let bytes = Zeroizing::new(serde_json::to_vec(&json).unwrap());
        load_ratchets(&mut inner, Found::Ready(bytes));
        assert_eq!(inner.ratchets.len(), 2);

        let dropped = on_load(&mut inner, NOW, &mut rng());
        assert_eq!(dropped, ["ana"]);
        assert!(!inner.ratchets.contains_key("ana"));
        assert!(!inner.associated_data.contains_key("ana"));
        assert!(inner.ratchets.contains_key("beto"), "a P1 session stays");
        assert_eq!(inner.friends.len(), 3, "every contact stays");

        let due = &inner.mailboxes.handshakes_due;
        assert_eq!(due.keys().collect::<Vec<_>>(), ["ana", "caro"]);
        for at in due.values() {
            let wait = std::time::Duration::from_secs((at - NOW) as u64);
            assert!((HANDSHAKE_MIN..=HANDSHAKE_MAX).contains(&wait), "{wait:?}");
        }
        assert_eq!(RatchetsFile::from_state(&inner).version, RATCHETS_VERSION);
    }

    #[test]
    fn a_handshake_owed_keeps_its_moment_and_goes_once_it_is_not_owed() {
        let (me, ana, beto) = (create_identity(), create_identity(), create_identity());
        let mut inner = state_with(&[friend(&ana, "ana"), friend(&beto, "beto")]);
        inner.identity = Some(me.clone());
        inner.mailboxes.handshakes_due.insert("gone".into(), NOW);
        plan_handshakes(&mut inner, NOW, &mut rng());
        let first = inner.mailboxes.handshakes_due.clone();
        assert_eq!(first.keys().collect::<Vec<_>>(), ["ana", "beto"]);

        // Loaded again later: the same moments, not drawn again.
        plan_handshakes(&mut inner, NOW + 60, &mut StdRng::seed_from_u64(77));
        assert_eq!(inner.mailboxes.handshakes_due, first);

        // Ana has a P1 session now; Beto is blocked.
        inner.ratchets.insert("ana".into(), session(&me, true));
        let blocked = BlockedIdentity::before_ur2(
            hex::encode(beto.nostr.pub_bytes),
            inner.friends.get("beto"),
            0,
        );
        inner.blocked.insert(blocked);
        plan_handshakes(&mut inner, NOW + 120, &mut rng());
        assert!(inner.mailboxes.handshakes_due.is_empty());
    }

    #[test]
    fn purging_drops_padding_older_than_yesterday() {
        let mut state = MailboxState::default();
        for e in [E - 3, E - 1, E] {
            state.pads.of(e, &mut rng());
        }
        state.purge(E);
        assert_eq!(state.pads.epochs(), [E - 1, E]);
    }

    #[test]
    fn locking_forgets_the_mailboxes() {
        let mut inner = state_with(&[]);
        inner.mailboxes.pads.of(E, &mut rng());
        inner.mailboxes.handshakes_due.insert("ana".into(), NOW);
        crate::session::clear_sensitive_state(&mut inner);
        assert_eq!(inner.mailboxes, MailboxState::default());
    }
}
