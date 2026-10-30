//! The network time (design P1 §3.5, D2, R-04).
//!
//! Epochs are 24 h of UTC for everyone, so everyone's mailboxes turn at
//! the same moment; a clock that is wrong by hours would listen to and send
//! to the wrong day. The network time is the local clock plus an offset:
//!
//! - the offset is the median of the `Date` headers of HTTPS answers that
//!   already go through Tor (news, the updater, Blossom, names, TURN),
//!   kept while they are fresh (a day) — one server alone cannot move it
//!   when others answered too;
//! - Arti's `ClockSkewed` diagnostic confirms a wrong clock when no answer
//!   is fresh.
//!
//! Past 10 minutes of offset Settings › Red shows it. Past an hour with no
//! fresh sample to correct it, nothing is sent: "La hora de tu equipo está
//! muy corrida; corrígela para enviar." The receiving side covers a clock
//! up to 3 h off that nobody noticed (§3.5), through `since`.

use std::collections::VecDeque;
use trino_core::p1::mailbox::epoch_of;

/// Past this offset Settings › Red shows the clock as off.
pub const SKEW_SHOWN_SECS: i64 = 10 * 60;
/// Past this offset, with no fresh sample to correct it, nothing is sent.
pub const SKEW_BLOCKS_SECS: i64 = 3600;
/// A sample corrects the clock for this long after it was taken.
pub const SAMPLE_FRESH_SECS: i64 = 86_400;
/// How many samples are kept: the newest ones.
pub const MAX_SAMPLES: usize = 9;

/// What the clock looks like to Settings and to sending.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skew {
    /// Within 10 minutes of the network, or nothing says otherwise.
    Fine,
    /// Off by `secs` (signed: positive is ahead) and corrected by fresh
    /// network time: shown, sending goes on.
    Corrected { secs: i64 },
    /// Known to be off by more than an hour and nothing fresh corrects it:
    /// nothing is sent. `secs` is the last known offset, if any.
    TooFar { secs: Option<i64> },
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    /// The local clock when the answer came, in unix seconds.
    at: i64,
    /// The local clock minus the server's `Date`.
    offset: i64,
}

/// The session's network time. Memory only: a new session asks again.
#[derive(Clone, Debug, Default)]
pub struct NetClock {
    samples: VecDeque<Sample>,
    tor_skewed: bool,
}

impl NetClock {
    /// An HTTPS answer that came at local time `local_now` with a `Date` of
    /// `server_date`.
    pub fn sample(&mut self, local_now: i64, server_date: i64) {
        if self.samples.len() == MAX_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back(Sample {
            at: local_now,
            offset: local_now.saturating_sub(server_date),
        });
    }

    /// Arti's diagnostic: whether it currently says the clock is skewed.
    pub fn set_tor_skewed(&mut self, skewed: bool) {
        self.tor_skewed = skewed;
    }

    /// How far the local clock is ahead of the network (positive) or
    /// behind it, from the fresh samples; `None` without one. The middle
    /// one (the higher of the two middle ones for an even count), so one
    /// server's `Date` alone moves nothing when others answered too.
    pub fn offset(&self, local_now: i64) -> Option<i64> {
        let mut fresh: Vec<i64> = self
            .samples
            .iter()
            .filter(|sample| local_now.abs_diff(sample.at) <= SAMPLE_FRESH_SECS as u64)
            .map(|sample| sample.offset)
            .collect();
        fresh.sort_unstable();
        fresh.get(fresh.len() / 2).copied()
    }

    /// The network time at local time `local_now`: the local clock when no
    /// fresh sample corrects it.
    pub fn now(&self, local_now: i64) -> i64 {
        local_now.saturating_sub(self.offset(local_now).unwrap_or(0))
    }

    /// The epoch of the network time at `local_now`.
    pub fn epoch(&self, local_now: i64) -> u32 {
        epoch_of(u64::try_from(self.now(local_now)).unwrap_or(0))
    }

    /// How the clock looks at `local_now`.
    pub fn skew(&self, local_now: i64) -> Skew {
        if let Some(secs) = self.offset(local_now) {
            return if secs.abs() > SKEW_SHOWN_SECS {
                Skew::Corrected { secs }
            } else {
                Skew::Fine
            };
        }
        let last = self.samples.back().map(|sample| sample.offset);
        if self.tor_skewed || last.is_some_and(|secs| secs.abs() > SKEW_BLOCKS_SECS) {
            Skew::TooFar { secs: last }
        } else {
            Skew::Fine
        }
    }

    /// Whether a message may go out at `local_now`.
    pub fn may_send(&self, local_now: i64) -> bool {
        !matches!(self.skew(local_now), Skew::TooFar { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use trino_core::p1::mailbox::EPOCH_SECS;

    const NOW: i64 = 1_760_000_000;

    #[test]
    fn with_no_sample_the_network_time_is_the_local_clock() {
        let clock = NetClock::default();
        assert_eq!(clock.offset(NOW), None);
        assert_eq!(clock.now(NOW), NOW);
        assert_eq!(clock.epoch(NOW), (NOW as u64 / EPOCH_SECS) as u32);
        assert_eq!(clock.skew(NOW), Skew::Fine);
        assert!(clock.may_send(NOW));
    }

    #[test]
    fn the_median_of_fresh_samples_corrects_the_local_clock() {
        let mut clock = NetClock::default();
        // The local clock runs 2 h ahead; one server lies by a day.
        clock.sample(NOW, NOW - 7_200);
        clock.sample(NOW + 10, NOW + 10 - 7_210);
        clock.sample(NOW + 20, NOW + 20 + 86_400);
        assert_eq!(clock.offset(NOW + 30), Some(7_200));
        assert_eq!(clock.now(NOW + 30), NOW + 30 - 7_200);
        assert_eq!(clock.skew(NOW + 30), Skew::Corrected { secs: 7_200 });
        assert!(clock.may_send(NOW + 30), "fresh network time corrects it");
    }

    #[test]
    fn an_epoch_turns_at_midnight_utc_of_the_network_time() {
        let mut clock = NetClock::default();
        let midnight = (NOW / EPOCH_SECS as i64 + 1) * EPOCH_SECS as i64;
        // Local clock 10 s behind: at its 23:59:55 the network is past
        // midnight.
        clock.sample(midnight - 5, midnight + 5);
        let e = (midnight as u64 / EPOCH_SECS) as u32;
        assert_eq!(clock.epoch(midnight - 5), e);
        assert_eq!(clock.epoch(midnight - 11), e - 1);
    }

    #[test]
    fn a_small_offset_is_fine_and_ten_minutes_is_shown() {
        let mut clock = NetClock::default();
        clock.sample(NOW, NOW - 30);
        assert_eq!(clock.skew(NOW), Skew::Fine);
        let mut clock = NetClock::default();
        clock.sample(NOW, NOW + SKEW_SHOWN_SECS + 1);
        assert_eq!(
            clock.skew(NOW),
            Skew::Corrected {
                secs: -(SKEW_SHOWN_SECS + 1)
            }
        );
    }

    #[test]
    fn a_sample_stops_correcting_after_a_day() {
        let mut clock = NetClock::default();
        clock.sample(NOW, NOW - 600);
        assert_eq!(clock.offset(NOW + SAMPLE_FRESH_SECS), Some(600));
        assert_eq!(clock.offset(NOW + SAMPLE_FRESH_SECS + 1), None);
        assert_eq!(
            clock.now(NOW + SAMPLE_FRESH_SECS + 1),
            NOW + SAMPLE_FRESH_SECS + 1
        );
    }

    #[test]
    fn more_than_an_hour_off_with_nothing_fresh_stops_sending() {
        // A stale sample said 2 h off.
        let mut clock = NetClock::default();
        clock.sample(NOW, NOW - 7_200);
        let later = NOW + SAMPLE_FRESH_SECS + 60;
        assert_eq!(clock.skew(later), Skew::TooFar { secs: Some(7_200) });
        assert!(!clock.may_send(later));
        // A fresh sample lets it send again, corrected.
        clock.sample(later, later - 7_200);
        assert!(clock.may_send(later));

        // Under an hour stale is only shown, as nothing proves it worse.
        let mut clock = NetClock::default();
        clock.sample(NOW, NOW - 1_800);
        let later = NOW + SAMPLE_FRESH_SECS + 60;
        assert_eq!(clock.skew(later), Skew::Fine);
        assert!(clock.may_send(later));
    }

    #[test]
    fn tor_saying_the_clock_is_skewed_stops_sending_until_a_sample_corrects_it() {
        let mut clock = NetClock::default();
        clock.set_tor_skewed(true);
        assert_eq!(clock.skew(NOW), Skew::TooFar { secs: None });
        assert!(!clock.may_send(NOW));
        clock.sample(NOW, NOW - 5_000);
        assert_eq!(clock.skew(NOW), Skew::Corrected { secs: 5_000 });
        assert!(clock.may_send(NOW));
        clock.set_tor_skewed(false);
        let later = NOW + SAMPLE_FRESH_SECS + 60;
        assert_eq!(clock.skew(later), Skew::TooFar { secs: Some(5_000) });
    }

    #[test]
    fn only_the_newest_samples_are_kept() {
        let mut clock = NetClock::default();
        for i in 0..(MAX_SAMPLES as i64) {
            clock.sample(NOW + i, NOW + i - 9_000);
        }
        for i in 0..(MAX_SAMPLES as i64) {
            clock.sample(NOW + 100 + i, NOW + 100 + i - 60);
        }
        assert_eq!(clock.offset(NOW + 200), Some(60));
    }
}
