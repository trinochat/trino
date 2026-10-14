//! Tor in a `Net` (Tor design §2.3–§2.6): what drives it, where it keeps
//! its files, and what it reports.
//!
//! `Net` talks to Tor through `TorBackend` and `RunningTor`: Arti in the
//! app (arti.rs), and a fake in tests (`mock::FakeTor`), so the states,
//! the lifecycle and the fail-closed rules are tested without the network.

pub mod arti;
pub mod bridges;
pub mod dirs;
pub(crate) mod marker;
pub mod pt;
pub mod settings;

use crate::{Progress, Transport, TransportKind};
use bridges::BridgeLine;
use pt::PtMethod;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

/// Where Arti keeps its files (§2.5): `state/` (guards, circuit timeouts,
/// keys) and `cache/` (the network's directory, public), both under the
/// Tor folder, `trino_home()/tor`.
///
/// With private bridges they are `run-<random>/state` and
/// `run-<random>/cache` instead, made at each start and destroyed file by
/// file when Tor stops (R-01, dirs.rs).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TorDirs {
    pub state: PathBuf,
    pub cache: PathBuf,
}

impl TorDirs {
    /// The fixed folders of `tor_home`.
    pub fn fixed(tor_home: &Path) -> Self {
        TorDirs {
            state: tor_home.join("state"),
            cache: tor_home.join("cache"),
        }
    }
}

/// The bridge program (§5.1). Either way Arti gets it as an unmanaged
/// transport: a SOCKS port per transport, which Arti does not run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtLauncher {
    /// lyrebird at `path`, which `Net` runs itself (pt.rs), with no
    /// window, and only if its SHA-256 is `sha256` (R-24): Arti would show
    /// its console on Windows and leave it running when stopped (spike
    /// S2, S13). The desktop's.
    Managed { path: PathBuf, sha256: [u8; 32] },
    /// A transport someone else runs, on this SOCKS address (iPhone's
    /// IPtProxy).
    Unmanaged { socks: std::net::SocketAddr },
}

/// What the app gives its `Net`.
#[derive(Clone, Debug)]
pub struct NetConfig {
    /// `trino_home()/tor`: settings.json, run.marker, state/ and cache/.
    pub tor_home: PathBuf,
    /// The bridge program, if this build has one: without it a start with
    /// bridges is "bridge program missing" (R-22).
    pub pt: Option<PtLauncher>,
}

/// Everything a backend needs to start Tor.
pub struct Launch {
    pub dirs: TorDirs,
    /// The transport the start counts its limit without progress by.
    pub transport: TransportKind,
    /// The bridges to reach Tor through; none goes straight to it.
    pub bridges: Vec<BridgeLine>,
    /// Where each transport of the bridges listens: the bridge program
    /// `Net` launched, or the host's (`PtLauncher::Unmanaged`).
    pub transports: Vec<PtMethod>,
    /// Where the running Tor reports its progress. When every copy is
    /// dropped (Tor stopped), `Net` stops listening.
    pub progress: mpsc::Sender<Progress>,
}

/// Why Tor did not start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchError {
    /// The transport needs the bridge program, and there is none fit to
    /// run (R-22, R-24).
    PtMissing,
    /// Arti is too old for the network (§6.5).
    Obsolete,
    /// Anything else: a folder that cannot be used, a bad configuration.
    Failed(&'static str),
}

/// Tor, as `Net` starts it.
pub trait TorBackend: Send + Sync {
    /// Start Tor. It returns at once; the start goes on underneath and
    /// reports to `launch.progress`.
    fn launch(&self, launch: Launch) -> Result<std::sync::Arc<dyn RunningTor>, LaunchError>;
}

/// A Tor that was started: it opens connections, sleeps and stops.
pub trait RunningTor: Transport {
    /// Sleep (`true`) or wake (`false`): background work stops while
    /// asleep, and a connection wakes it.
    fn set_dormant(&self, on: bool);

    /// Stop Tor for good: its tasks end and its files are closed (R-03).
    /// Blocks until they are. A second call does nothing.
    fn stop(&self);
}
