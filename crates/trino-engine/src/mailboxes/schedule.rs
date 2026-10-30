//! When the mailboxes reach the relays (design P1 §3.6, §3.8, §7.1; R-03,
//! R-04, R-09).
//!
//! - **Renewal:** a value that enters the table (a new session, a new
//!   contact) is not asked for at once. The whole REQ is replaced at
//!   random moments, exponential with a mean of 5 minutes (20 in
//!   "Protección reforzada", D17), unrelated to what is sent; what arrives
//!   meanwhile is stored by the relay and comes in through `since`.
//! - **Epochs:** the connection of epoch `e` opens at a random moment 0–30
//!   minutes after `e` starts, and the one of `e − 1` stays up to 3 hours
//!   after it. Both ask `since` the start of their epoch minus 3 hours and
//!   the 300 s a `created_at` may be backdated, so a sender whose clock is
//!   off by up to 3 hours, or who sent before the new connection opened,
//!   is still heard.
//! - **Unlocking:** the live connection of today opens on every relay but
//!   one, 0–60 s apart; on that one, chosen at random among those that
//!   store events, yesterday is fetched with a one-shot connection, and its
//!   live connection opens 5–45 minutes later, so the two are not tied by
//!   their timing.
//! - **Proactive handshakes:** a contact with no session that runs on P1
//!   gets a handshake 5–60 minutes after loading, never at once (§3.8).

use crate::nostr::P1_SINCE_LAG_SECS;
use rand::{CryptoRng, Rng};
use std::time::Duration;
use trino_core::p1::mailbox::EPOCH_SECS;

/// The mean wait between two renewals of the REQ.
pub const RENEW_MEAN: Duration = Duration::from_secs(5 * 60);
/// The same in "Protección reforzada" (D17).
pub const REINFORCED_RENEW_MEAN: Duration = Duration::from_secs(20 * 60);
/// A renewal wait is cut at this many means: the exponential has no upper
/// end, and a list must not wait hours for its new values.
pub const RENEW_MAX_MEANS: u32 = 8;
/// How long after its start an epoch's connection opens, at most.
pub const OPEN_NEXT_MAX: Duration = Duration::from_secs(30 * 60);
/// How long the previous epoch's connection stays after the change, and
/// how far off a clock may be and still be heard (§3.5).
pub const EPOCH_GRACE_SECS: i64 = 3 * 3600;
/// The live connections opened on unlocking are this far apart, at most.
pub const UNLOCK_SPREAD: Duration = Duration::from_secs(60);
/// The live connection of the relay that catches up opens this long after
/// unlocking: between the two bounds.
pub const CATCH_UP_LIVE_MIN: Duration = Duration::from_secs(5 * 60);
pub const CATCH_UP_LIVE_MAX: Duration = Duration::from_secs(45 * 60);
/// A proactive handshake goes out this long after loading: between the
/// two bounds.
pub const HANDSHAKE_MIN: Duration = Duration::from_secs(5 * 60);
pub const HANDSHAKE_MAX: Duration = Duration::from_secs(60 * 60);

/// How long until the next renewal of the REQ.
pub fn renewal_wait<R: Rng + CryptoRng>(rng: &mut R, reinforced: bool) -> Duration {
    let mean = if reinforced {
        REINFORCED_RENEW_MEAN
    } else {
        RENEW_MEAN
    };
    // 1 − U is in (0, 1], so its logarithm is finite.
    let u = 1.0 - rng.gen::<f64>();
    let wait = mean.mul_f64(-u.ln()).min(mean * RENEW_MAX_MEANS);
    wait.max(Duration::from_millis(1))
}

/// Whether the list the relays were last asked for is not the one wanted.
pub fn needs_renewal(asked: &[[u8; 32]], wanted: &[[u8; 32]]) -> bool {
    asked != wanted
}

/// The start of epoch `e`, in unix seconds of network time.
pub fn epoch_start(e: u32) -> i64 {
    i64::from(e) * EPOCH_SECS as i64
}

/// The `since` of epoch `e`'s connection: its start, minus the 3 h a clock
/// may be off and the 300 s a `created_at` may be backdated.
pub fn since_of(e: u32) -> i64 {
    epoch_start(e) - P1_SINCE_LAG_SECS
}

/// When epoch `e`'s connection opens and yesterday's closes, in network
/// time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Turn {
    pub epoch: u32,
    pub open_at: i64,
    pub close_previous_at: i64,
}

/// The turn into epoch `e`, drawn once for it.
pub fn turn<R: Rng + CryptoRng>(e: u32, rng: &mut R) -> Turn {
    let start = epoch_start(e);
    Turn {
        epoch: e,
        open_at: start + rng.gen_range(0..=OPEN_NEXT_MAX.as_secs() as i64),
        close_previous_at: start + EPOCH_GRACE_SECS,
    }
}

/// The epochs whose live connections are up at network time `now`, given
/// today's `turn`: yesterday's until 3 h after the change, today's from
/// its opening.
pub fn live_epochs(now: i64, turn: &Turn) -> Vec<u32> {
    let mut live = Vec::with_capacity(2);
    if now < turn.close_previous_at {
        live.push(turn.epoch.saturating_sub(1));
    }
    if now >= turn.open_at {
        live.push(turn.epoch);
    }
    live
}

/// What unlocking opens, relay by relay (the relays' order).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unlock {
    /// The relay that fetches yesterday once; `None` if none stores events.
    pub catch_up: Option<usize>,
    /// How long after unlocking each relay's live connection opens.
    pub live_after: Vec<Duration>,
}

/// The plan for unlocking with these relays; `stores[i]` says whether
/// relay `i` keeps events (all the default ones do).
pub fn unlock<R: Rng + CryptoRng>(stores: &[bool], rng: &mut R) -> Unlock {
    let storing: Vec<usize> = (0..stores.len()).filter(|&i| stores[i]).collect();
    let catch_up = (!storing.is_empty()).then(|| storing[rng.gen_range(0..storing.len())]);
    let live_after = (0..stores.len())
        .map(|i| {
            if Some(i) == catch_up {
                between(rng, CATCH_UP_LIVE_MIN, CATCH_UP_LIVE_MAX)
            } else {
                between(rng, Duration::ZERO, UNLOCK_SPREAD)
            }
        })
        .collect();
    Unlock {
        catch_up,
        live_after,
    }
}

/// How long after loading a proactive handshake goes out.
pub fn handshake_delay<R: Rng + CryptoRng>(rng: &mut R) -> Duration {
    between(rng, HANDSHAKE_MIN, HANDSHAKE_MAX)
}

/// A uniform duration in `[min, max]`, to the millisecond.
fn between<R: Rng + CryptoRng>(rng: &mut R, min: Duration, max: Duration) -> Duration {
    let millis = |d: Duration| u64::try_from(d.as_millis()).unwrap_or(u64::MAX);
    Duration::from_millis(rng.gen_range(millis(min)..=millis(max)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use trino_core::p1::mailbox::epoch_of;

    const E: u32 = 20_370;

    fn rng() -> StdRng {
        StdRng::seed_from_u64(11)
    }

    #[test]
    fn renewals_wait_five_minutes_on_average_and_twenty_when_reinforced() {
        let mut rng = rng();
        for (reinforced, mean) in [(false, RENEW_MEAN), (true, REINFORCED_RENEW_MEAN)] {
            let n = 20_000;
            let waits: Vec<_> = (0..n).map(|_| renewal_wait(&mut rng, reinforced)).collect();
            assert!(waits
                .iter()
                .all(|w| !w.is_zero() && *w <= mean * RENEW_MAX_MEANS));
            let average = waits.iter().sum::<Duration>() / n;
            let off = average.as_secs_f64() / mean.as_secs_f64();
            assert!((0.95..1.05).contains(&off), "{average:?} for {mean:?}");
            // Exponential, not fixed: a third or so wait under 40 % of the mean.
            let short = waits.iter().filter(|w| **w < mean * 2 / 5).count();
            assert!((0.28..0.38).contains(&(short as f64 / n as f64)), "{short}");
        }
    }

    #[test]
    fn a_renewal_happens_only_when_the_list_changed() {
        assert!(!needs_renewal(&[[1; 32]], &[[1; 32]]));
        assert!(needs_renewal(&[[1; 32]], &[[1; 32], [2; 32]]));
    }

    #[test]
    fn an_epoch_asks_since_its_start_less_three_hours_and_the_backdating() {
        assert_eq!(since_of(E), epoch_start(E) - EPOCH_GRACE_SECS - 300);
        assert_eq!(since_of(E), epoch_start(E) - P1_SINCE_LAG_SECS);
        assert_eq!(epoch_of(epoch_start(E) as u64), E);
    }

    #[test]
    fn a_new_epoch_opens_within_thirty_minutes_and_the_old_one_stays_three_hours() {
        let mut rng = rng();
        let opens: Vec<_> = (0..500).map(|_| turn(E, &mut rng)).collect();
        for t in &opens {
            assert_eq!(t.epoch, E);
            assert!(
                (epoch_start(E)..=epoch_start(E) + OPEN_NEXT_MAX.as_secs() as i64)
                    .contains(&t.open_at)
            );
            assert_eq!(t.close_previous_at, epoch_start(E) + EPOCH_GRACE_SECS);
        }
        let distinct: std::collections::HashSet<_> = opens.iter().map(|t| t.open_at).collect();
        assert!(distinct.len() > 400, "drawn, not fixed");
    }

    #[test]
    fn yesterdays_connection_overlaps_todays_and_then_closes() {
        let start = epoch_start(E);
        let t = Turn {
            epoch: E,
            open_at: start + 600,
            close_previous_at: start + EPOCH_GRACE_SECS,
        };
        assert_eq!(live_epochs(start - 10, &t), [E - 1]);
        assert_eq!(live_epochs(start + 300, &t), [E - 1]);
        assert_eq!(live_epochs(start + 600, &t), [E - 1, E]);
        assert_eq!(live_epochs(start + EPOCH_GRACE_SECS - 1, &t), [E - 1, E]);
        assert_eq!(live_epochs(start + EPOCH_GRACE_SECS, &t), [E]);
        assert_eq!(live_epochs(start + 20 * 3600, &t), [E]);
    }

    #[test]
    fn unlocking_catches_up_on_one_storing_relay_whose_live_connection_waits() {
        let mut rng = rng();
        let stores = [true, false, true];
        let mut chosen = [0usize; 3];
        for _ in 0..300 {
            let plan = unlock(&stores, &mut rng);
            let c = plan.catch_up.expect("two relays store events");
            assert!(stores[c]);
            chosen[c] += 1;
            for (i, after) in plan.live_after.iter().enumerate() {
                if i == c {
                    assert!((CATCH_UP_LIVE_MIN..=CATCH_UP_LIVE_MAX).contains(after));
                } else {
                    assert!(*after <= UNLOCK_SPREAD);
                }
            }
        }
        assert!(chosen[0] > 100 && chosen[2] > 100, "{chosen:?}");

        let plan = unlock(&[false, false], &mut rng);
        assert_eq!(plan.catch_up, None);
        assert!(plan.live_after.iter().all(|after| *after <= UNLOCK_SPREAD));
        assert!(unlock(&[], &mut rng).live_after.is_empty());
    }

    #[test]
    fn a_proactive_handshake_waits_five_to_sixty_minutes() {
        let mut rng = rng();
        let delays: Vec<_> = (0..500).map(|_| handshake_delay(&mut rng)).collect();
        assert!(delays
            .iter()
            .all(|d| (HANDSHAKE_MIN..=HANDSHAKE_MAX).contains(d)));
        let distinct: std::collections::HashSet<_> = delays.iter().collect();
        assert!(distinct.len() > 400);
    }
}
