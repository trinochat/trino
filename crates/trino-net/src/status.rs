//! What the app sees of Tor (Tor design §2.4): one `NetStatus` at a time,
//! and how a start that stops moving becomes `Blocked`.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// How Tor is reached: straight to the network, or through a bridge of
/// one kind (§2.5, `tor/settings.json`). The kind only: private bridge
/// lines live in the app's encrypted store, never here (R-25).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportKind {
    /// No bridge.
    #[default]
    None,
    Snowflake,
    Obfs4,
    Webtunnel,
    Meek,
}

impl TransportKind {
    /// How long a start may go without progress before it counts as
    /// blocked (R-23). From the spike's starts (S3, three per case), with
    /// about twice the longest stretch it saw without progress: straight
    /// to Tor 45 s (15 s seen), obfs4 90 s (53 s), Snowflake 120 s
    /// (54 s). WebTunnel goes with obfs4, and meek with Snowflake, as the
    /// design had them; the spike could measure neither.
    pub fn no_progress_limit(self) -> Duration {
        Duration::from_secs(match self {
            TransportKind::None => 45,
            TransportKind::Obfs4 | TransportKind::Webtunnel => 90,
            TransportKind::Snowflake | TransportKind::Meek => 120,
        })
    }
}

/// Why Tor seems not to connect. Arti's diagnosis is rough, so the app
/// words it as "it seems" (§2.4, §10.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    /// No network at all.
    Offline,
    /// The network seems to block Tor.
    Filtering,
    /// Tor cannot be reached, for some other reason.
    CantReachTor,
    /// The clock of this computer is off.
    ClockSkewed,
    /// The directory of the network does not come.
    CantBootstrap,
    /// Arti said nothing, but the start has not moved for the transport's
    /// `no_progress_limit`.
    NoProgress,
}

/// The state of the network, as the app's UI gets it (`net-changed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum NetStatus {
    /// Tor has not been started: before the first run's "Conexión" step,
    /// while locked when it starts at unlock, after `stop`. Nothing goes
    /// out.
    Off,
    /// Tor is starting: `pct` of the way.
    Starting { pct: u8 },
    /// Tor is ready, through `transport`.
    Ready { transport: TransportKind },
    /// Tor does not connect, and keeps trying underneath. Never a reason
    /// to go direct (decision 1).
    Blocked { kind: BlockKind, pct: u8 },
    /// The bridge program is missing, or is not the one Trino ships
    /// (R-22, R-24; TOR-7).
    PtMissing,
    /// This version of Arti is too old for the Tor network (§6.5):
    /// `confirmed` when Arti said so, and not when two deaths right after
    /// Tor was ready make it likely (`run.marker`).
    Obsolete { confirmed: bool },
    /// Everything goes without Tor, by "Conectar sin Tor (solo esta vez)",
    /// until Trino closes or "Volver a usar Tor".
    Direct,
}

impl NetStatus {
    /// Whether a connection may go out now.
    pub fn is_ready(self) -> bool {
        matches!(self, NetStatus::Ready { .. } | NetStatus::Direct)
    }

    /// Whether Tor may still become ready by itself: it is starting or
    /// blocked, and keeps trying.
    pub fn may_become_ready(self) -> bool {
        matches!(self, NetStatus::Starting { .. } | NetStatus::Blocked { .. })
    }
}

/// What a running Tor reports (the Arti backend, or a test's).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Progress {
    /// Arti's bootstrap status: how far (0 to 1), whether it is ready for
    /// traffic, and what it believes blocks it.
    Bootstrap {
        frac: f32,
        ready: bool,
        blocked: Option<BlockKind>,
    },
    /// Arti refused to run: its version is too old for the network
    /// (`ErrorKind::SoftwareDeprecated` at start, §6.5).
    Obsolete,
}

/// A percentage from Arti's fraction.
fn pct(frac: f32) -> u8 {
    (frac.clamp(0.0, 1.0) * 100.0).round() as u8
}

/// Turns what a starting Tor reports into a `NetStatus`, with the
/// transport's limit without progress (R-23).
#[derive(Debug)]
pub(crate) struct Watch {
    transport: TransportKind,
    pct: u8,
    ready: bool,
    blocked: Option<BlockKind>,
    /// When the start last moved forward (or began).
    moved_at: Instant,
}

impl Watch {
    pub(crate) fn new(transport: TransportKind, now: Instant) -> Self {
        Watch {
            transport,
            pct: 0,
            ready: false,
            blocked: None,
            moved_at: now,
        }
    }

    pub(crate) fn on(&mut self, frac: f32, ready: bool, blocked: Option<BlockKind>, now: Instant) {
        let pct = pct(frac);
        // Only a step forward is progress: going back (a directory that
        // grew stale) is no reason to wait longer.
        if pct > self.pct || (ready && !self.ready) {
            self.moved_at = now;
        }
        if pct < self.pct && !ready {
            // Starting over: the limit counts from here.
            self.moved_at = now;
        }
        self.pct = pct;
        self.ready = ready;
        self.blocked = blocked;
    }

    /// The status at `now`: ready above all; then what Arti says blocks
    /// it; then no progress for the transport's limit.
    pub(crate) fn status(&self, now: Instant) -> NetStatus {
        if self.ready {
            return NetStatus::Ready {
                transport: self.transport,
            };
        }
        if let Some(kind) = self.blocked {
            return NetStatus::Blocked {
                kind,
                pct: self.pct,
            };
        }
        if now.saturating_duration_since(self.moved_at) >= self.transport.no_progress_limit() {
            return NetStatus::Blocked {
                kind: BlockKind::NoProgress,
                pct: self.pct,
            };
        }
        NetStatus::Starting { pct: self.pct }
    }

    /// When the status may change by itself: when the limit without
    /// progress runs out. `None` once ready, or already past it.
    pub(crate) fn next_change(&self, now: Instant) -> Option<Instant> {
        let at = self.moved_at + self.transport.no_progress_limit();
        (!self.ready && at > now).then_some(at)
    }
}
