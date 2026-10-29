//! What the engine learns about a relay while it uses it: which kinds it
//! answers queries for, whether its `until` paging works, whether it is
//! throttling us, and how long it lets a quiet socket live.
//!
//! Public relays differ in ways NIP-11 does not always say (the relay spike
//! of 29 oct 2026, `research_notes/P1 metadatos/spike-relays.md`): one never
//! answers a REQ whose filter names an ephemeral kind, one requires an AUTH
//! it cannot complete, one returns short pages under `until` + `limit`, one
//! rate-limits a kind or bans after a burst, one drops a socket quiet for
//! 10 s. Nothing here is tied to a relay's name: each fact is learned from
//! what the relay does, kept for the session (one `RelayCaps` per relay,
//! shared by its connections), and read by whoever decides where to send
//! and what to ask.
//!
//! Only fixed, machine-readable facts are kept: a refusal's NIP-01 prefix
//! is mapped to a `Refusal`, and the relay's free text is never stored.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// A kind that went unanswered is asked again after this long.
pub const READ_RETRY: Duration = Duration::from_secs(3600);
/// The first wait after a `rate-limited:` refusal; it doubles with each
/// refusal in a row, up to `RATE_LIMIT_MAX`.
pub const RATE_LIMIT_FIRST: Duration = Duration::from_secs(15);
pub const RATE_LIMIT_MAX: Duration = Duration::from_secs(30 * 60);
/// The first wait after a `banned:` refusal, for every kind; it doubles
/// with each ban in a row, up to `BAN_MAX`.
pub const BAN_FIRST: Duration = Duration::from_secs(10 * 60);
pub const BAN_MAX: Duration = Duration::from_secs(6 * 3600);
/// The pace between sends grows by this factor at most.
pub const MAX_PACE_FACTOR: u32 = 16;
/// Acceptances in a row that halve the pace factor again.
pub const PACE_RELAX_AFTER: u32 = 20;

/// Why a relay refused a query or an event, from its NIP-01 prefix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `auth-required:`: it wants a NIP-42 AUTH first.
    AuthRequired,
    /// `restricted:` or `blocked:`: not for us, whatever we do.
    Restricted,
    /// Any other prefix, or none.
    Other,
}

impl Refusal {
    /// The refusal a relay's message starts with.
    pub fn of(message: &str) -> Self {
        match prefix(message) {
            "auth-required" => Refusal::AuthRequired,
            "restricted" | "blocked" => Refusal::Restricted,
            _ => Refusal::Other,
        }
    }
}

/// The NIP-01 machine-readable prefix of a relay message: what comes
/// before its first `:`, or nothing.
fn prefix(message: &str) -> &str {
    message.split_once(':').map_or("", |(p, _)| p.trim())
}

/// Whether a relay answers queries for a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reads {
    /// Not asked yet.
    Unknown,
    /// It sent EOSE.
    Answered,
    /// It sent neither EOSE nor CLOSED in time, at this moment.
    Unanswered(Instant),
    /// It CLOSED the query.
    Refused(Refusal),
}

/// What a refusal of an event means for later sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Throttled {
    /// Not a throttle: the event alone was refused.
    No,
    /// `rate-limited:` this kind, until then.
    RateLimited(Instant),
    /// `banned:` every kind, until then.
    Banned(Instant),
}

#[derive(Clone, Copy, Debug)]
struct Throttle {
    until: Instant,
    /// Refusals in a row.
    streak: u32,
}

#[derive(Default)]
struct State {
    reads: BTreeMap<u32, Reads>,
    paging_broken: bool,
    /// By kind; `None` is the whole relay (a ban, or a rate limit on an
    /// event whose kind is not known).
    throttles: BTreeMap<Option<u32>, Throttle>,
    pace_factor: u32,
    accepted_in_a_row: u32,
    keepalive: Option<Duration>,
}

/// One relay's learned facts, shared by its connections.
#[derive(Clone, Default)]
pub struct RelayCaps(Arc<Mutex<State>>);

impl RelayCaps {
    pub fn new() -> Self {
        Self::default()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ---- reads ----

    /// What is known of the relay's answers for `kind`.
    pub fn reads(&self, kind: u32) -> Reads {
        self.state()
            .reads
            .get(&kind)
            .copied()
            .unwrap_or(Reads::Unknown)
    }

    /// Whether a query for `kind` is worth sending at `now`: not refused,
    /// and not unanswered within `READ_RETRY`.
    pub fn readable(&self, kind: u32, now: Instant) -> bool {
        match self.reads(kind) {
            Reads::Unknown | Reads::Answered => true,
            Reads::Unanswered(at) => now.duration_since(at) >= READ_RETRY,
            Reads::Refused(_) => false,
        }
    }

    /// The relay sent EOSE to a query for `kinds`.
    pub fn answered(&self, kinds: &[u32]) {
        let mut state = self.state();
        for kind in kinds {
            state.reads.insert(*kind, Reads::Answered);
        }
    }

    /// A query for `kinds` got neither EOSE nor CLOSED in time.
    pub fn unanswered(&self, kinds: &[u32], now: Instant) {
        let mut state = self.state();
        for kind in kinds {
            state.reads.insert(*kind, Reads::Unanswered(now));
        }
    }

    /// The relay CLOSED a query for `kinds` with `message`.
    pub fn refused(&self, kinds: &[u32], message: &str) {
        let refusal = Refusal::of(message);
        let mut state = self.state();
        for kind in kinds {
            state.reads.insert(*kind, Reads::Refused(refusal));
        }
    }

    // ---- paging ----

    /// Whether its pages under `until` + `limit` came back short.
    pub fn paging_broken(&self) -> bool {
        self.state().paging_broken
    }

    pub fn mark_paging_broken(&self) {
        self.state().paging_broken = true;
    }

    // ---- writes ----

    /// Until when an event of `kind` must not be sent, if it must wait.
    pub fn write_blocked(&self, kind: u32, now: Instant) -> Option<Instant> {
        let state = self.state();
        [Some(kind), None]
            .iter()
            .filter_map(|key| state.throttles.get(key))
            .map(|t| t.until)
            .filter(|until| *until > now)
            .max()
    }

    /// The relay refused an event of `kind` (`None`: not known) with
    /// `message`: a throttle if it says `rate-limited:` or `banned:`.
    pub fn event_refused(&self, kind: Option<u32>, message: &str, now: Instant) -> Throttled {
        let (key, first, max, ban) = match prefix(message) {
            "rate-limited" => (kind, RATE_LIMIT_FIRST, RATE_LIMIT_MAX, false),
            "banned" => (None, BAN_FIRST, BAN_MAX, true),
            _ => return Throttled::No,
        };
        let mut state = self.state();
        let streak = state.throttles.get(&key).map_or(0, |t| t.streak + 1);
        let wait = first
            .checked_mul(1u32 << streak.min(16))
            .unwrap_or(max)
            .min(max);
        let until = now + wait;
        state.throttles.insert(key, Throttle { until, streak });
        state.pace_factor = (state.pace_factor.max(1) * 2).min(MAX_PACE_FACTOR);
        state.accepted_in_a_row = 0;
        if ban {
            Throttled::Banned(until)
        } else {
            Throttled::RateLimited(until)
        }
    }

    /// The relay took an event of `kind`: its rate-limit streak ends, and
    /// enough acceptances in a row bring the pace back down.
    pub fn event_accepted(&self, kind: Option<u32>) {
        let mut state = self.state();
        if let Some(kind) = kind {
            state.throttles.remove(&Some(kind));
        }
        state.accepted_in_a_row += 1;
        if state.accepted_in_a_row >= PACE_RELAX_AFTER {
            state.accepted_in_a_row = 0;
            state.pace_factor = (state.pace_factor / 2).max(1);
        }
    }

    /// The gap between sends to it: `base`, stretched after throttles.
    pub fn pace_gap(&self, base: Duration) -> Duration {
        base * self.state().pace_factor.max(1)
    }

    // ---- quiet sockets ----

    /// How often to ping a socket that has nothing else to send.
    pub fn keepalive(&self, default: Duration) -> Duration {
        self.state().keepalive.unwrap_or(default).min(default)
    }

    /// A socket dropped after `quiet` without a frame from us: if that is
    /// shorter than the ping interval it had, ping at half of it from now
    /// on, never more often than every `floor`.
    pub fn dropped_while_quiet(&self, quiet: Duration, default: Duration, floor: Duration) {
        let mut state = self.state();
        let current = state.keepalive.unwrap_or(default).min(default);
        if quiet < current {
            state.keepalive = Some((quiet / 2).max(floor).min(current));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: Duration = Duration::from_secs(1);

    #[test]
    fn a_refusal_is_read_from_its_prefix_only() {
        assert_eq!(
            Refusal::of("auth-required: requested filter requires authentication"),
            Refusal::AuthRequired
        );
        assert_eq!(Refusal::of("restricted: not for you"), Refusal::Restricted);
        assert_eq!(Refusal::of("blocked: test"), Refusal::Restricted);
        assert_eq!(Refusal::of("error: relay needs serviceUrl"), Refusal::Other);
        assert_eq!(Refusal::of("no prefix at all"), Refusal::Other);
    }

    #[test]
    fn a_kind_is_readable_until_it_goes_unanswered_or_is_refused() {
        let caps = RelayCaps::new();
        let now = Instant::now();
        assert_eq!(caps.reads(1059), Reads::Unknown);
        assert!(caps.readable(1059, now));
        caps.answered(&[1059]);
        assert_eq!(caps.reads(1059), Reads::Answered);
        caps.unanswered(&[21059], now);
        assert!(!caps.readable(21059, now + S));
        assert!(caps.readable(21059, now + READ_RETRY), "asked again later");
        assert!(caps.readable(1059, now), "one kind does not taint another");
        caps.refused(&[1059], "auth-required: we want AUTH");
        assert_eq!(caps.reads(1059), Reads::Refused(Refusal::AuthRequired));
        assert!(!caps.readable(1059, now + READ_RETRY));
    }

    #[test]
    fn a_rate_limit_holds_that_kind_back_longer_each_time_in_a_row() {
        let caps = RelayCaps::new();
        let now = Instant::now();
        assert_eq!(caps.write_blocked(21059, now), None);
        assert_eq!(
            caps.event_refused(Some(21059), "rate-limited: slow down matey", now),
            Throttled::RateLimited(now + RATE_LIMIT_FIRST)
        );
        assert_eq!(caps.write_blocked(21059, now), Some(now + RATE_LIMIT_FIRST));
        assert_eq!(caps.write_blocked(1059, now), None, "only that kind");
        assert_eq!(
            caps.event_refused(Some(21059), "rate-limited: again", now),
            Throttled::RateLimited(now + 2 * RATE_LIMIT_FIRST)
        );
        for _ in 0..20 {
            caps.event_refused(Some(21059), "rate-limited:", now);
        }
        assert_eq!(caps.write_blocked(21059, now), Some(now + RATE_LIMIT_MAX));
        assert_eq!(caps.write_blocked(21059, now + RATE_LIMIT_MAX), None);
        caps.event_accepted(Some(21059));
        assert_eq!(
            caps.event_refused(Some(21059), "rate-limited:", now),
            Throttled::RateLimited(now + RATE_LIMIT_FIRST),
            "an acceptance ends the streak"
        );
    }

    #[test]
    fn a_ban_holds_every_kind_back() {
        let caps = RelayCaps::new();
        let now = Instant::now();
        assert_eq!(
            caps.event_refused(Some(1059), "banned: too many rate-limit violations", now),
            Throttled::Banned(now + BAN_FIRST)
        );
        assert_eq!(caps.write_blocked(1059, now), Some(now + BAN_FIRST));
        assert_eq!(caps.write_blocked(21059, now), Some(now + BAN_FIRST));
        caps.event_refused(None, "banned: again", now);
        assert_eq!(caps.write_blocked(1, now), Some(now + 2 * BAN_FIRST));
    }

    #[test]
    fn other_refusals_are_not_throttles() {
        let caps = RelayCaps::new();
        let now = Instant::now();
        for message in ["blocked: no", "invalid: event expired", "", "error: x"] {
            assert_eq!(caps.event_refused(Some(1059), message, now), Throttled::No);
        }
        assert_eq!(caps.write_blocked(1059, now), None);
        assert_eq!(caps.pace_gap(S), S);
    }

    #[test]
    fn throttles_stretch_the_pace_and_acceptances_bring_it_back() {
        let caps = RelayCaps::new();
        let now = Instant::now();
        assert_eq!(caps.pace_gap(S), S);
        caps.event_refused(Some(1059), "rate-limited: x", now);
        assert_eq!(caps.pace_gap(S), 2 * S);
        for _ in 0..10 {
            caps.event_refused(Some(1059), "rate-limited: x", now);
        }
        assert_eq!(caps.pace_gap(S), MAX_PACE_FACTOR * S);
        for _ in 0..PACE_RELAX_AFTER {
            caps.event_accepted(Some(1059));
        }
        assert_eq!(caps.pace_gap(S), MAX_PACE_FACTOR / 2 * S);
    }

    #[test]
    fn a_socket_dropped_while_quiet_is_pinged_more_often() {
        let caps = RelayCaps::new();
        let default = 25 * S;
        assert_eq!(caps.keepalive(default), default);
        caps.dropped_while_quiet(10 * S, default, 2 * S);
        assert_eq!(caps.keepalive(default), 5 * S);
        caps.dropped_while_quiet(30 * S, default, 2 * S);
        assert_eq!(
            caps.keepalive(default),
            5 * S,
            "a longer quiet changes nothing"
        );
        caps.dropped_while_quiet(S, default, 2 * S);
        assert_eq!(caps.keepalive(default), 2 * S, "never under the floor");
    }

    #[test]
    fn paging_is_trusted_until_it_comes_back_short() {
        let caps = RelayCaps::new();
        assert!(!caps.paging_broken());
        caps.mark_paging_broken();
        assert!(caps.paging_broken());
        assert!(caps.clone().paging_broken(), "shared by its connections");
    }
}
