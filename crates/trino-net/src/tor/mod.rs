//! Tor in a `Net` (Tor design §2.3–§2.6): what drives it, where it keeps
//! its files, and what it reports.
//!
//! `Net` talks to Tor through `TorBackend` and `RunningTor`: Arti in the
//! app (arti.rs), and a fake in tests (`mock::FakeTor`), so the states,
//! the lifecycle and the fail-closed rules are tested without the network.

pub mod arti;
pub(crate) mod marker;
pub mod settings;

use crate::{Progress, Transport, TransportKind};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

/// Where Arti keeps its files (§2.5): `state/` (guards, circuit timeouts,
/// keys) and `cache/` (the network's directory, public), both under the
/// Tor folder, `trino_home()/tor`.
///
/// With private bridges (TOR-7) they will be `run-<random>/state` and
/// `run-<random>/cache`, made at unlock and destroyed file by file at lock
/// and exit (R-01); that is the one place where this changes.
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

/// How the bridge program is run (§5.1). TOR-7 builds it: the spike found
/// that Arti shows lyrebird's console on Windows and that dropping Arti's
/// runtime leaves lyrebird running (S2, S13), so Trino launches it itself
/// and hands Arti its SOCKS port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PtLauncher {
    /// lyrebird at `path`, run only if its SHA-256 is `sha256` (R-24).
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
    /// The bridge program, if this build has one (TOR-7).
    pub pt: Option<PtLauncher>,
}

/// Everything a backend needs to start Tor.
pub struct Launch {
    pub dirs: TorDirs,
    pub transport: TransportKind,
    pub pt: Option<PtLauncher>,
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
