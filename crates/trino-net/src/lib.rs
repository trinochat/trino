//! Trino's network (Tor design §2): every connection the app opens goes
//! through a `Net`, and a `Net` goes through Tor unless a `DirectPermit`
//! says otherwise.
//!
//! - Fail closed by type (§2.8): a `Net` starts in `Mode::Tor`, the only
//!   mode that can be made at start. With no Tor ready, a connection is
//!   refused with `NetError::TorNotReady`; no error, retry or deadline
//!   ever sends it direct.
//! - The direct transport (direct.rs) is reached in two ways only, each
//!   with its permit: the whole `Net` in `Mode::Direct` after "Conectar
//!   sin Tor", or the updater's HTTPS to its hosts when Arti is obsolete.
//! - HTTP goes through `HttpClient` (http.rs), over the same `Net`: no
//!   redirects unless a policy allows them, a capped answer, deadlines, and
//!   the User-Agent `Trino` to trinochat.org only.
//! - No Tauri and nothing of the app (§2.1): the host hands everything in,
//!   so the engine M4 extracts takes this crate as it is.
//!
//! - Tor itself (`tor/`, TOR-5): Arti on a runtime of its own, started and
//!   stopped by the app, with its states (`NetStatus`) on a watch channel
//!   and a limit without progress for each transport.
//! - Bridges (`tor/bridges.rs`, TOR-7): Tor Browser's built-in ones, and
//!   the lines a person pastes, checked strictly.

mod direct;
mod http;
#[cfg(any(test, feature = "test-util"))]
pub mod mock;
#[cfg(any(test, feature = "test-util"))]
pub mod mock_http;
pub mod news;
pub mod onion_map;
mod status;
pub mod tor;
mod transport;
pub mod update;
mod ws;

#[cfg(test)]
mod bridge_tests;
#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod news_tests;
#[cfg(test)]
mod pt_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tor_tests;
#[cfg(test)]
mod update_tests;

pub use http::{Deadlines, HostRule, HttpClient, HttpError, RedirectPolicy, Request, Response};
pub use status::{BlockKind, NetStatus, Progress, TransportKind};
pub use tor::bridges::{BridgeError, BridgeLine, Bridges};
pub use tor::pt::{PtError, PtMethod};
pub use tor::settings::{StartWhen, TorSettings};
pub use tor::{LaunchError, NetConfig, PtLauncher, RunningTor, TorBackend, TorDirs};
pub use transport::{BoxedIo, DirectPermit, Io, Iso, IsoKind, Session, Target, Transport};
pub use ws::{ws_connect, WsStream};

use status::Watch;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::watch;
use tor::marker::{self, RunMarker};
use tor::pt::PtProcess;
use tor::Launch;
use transport::Scope;

/// How long an HTTP request waits for a starting Tor before it gives up
/// with `TorNotReady` (§2.4). Its own deadlines count from when Tor is
/// ready (§3.1).
pub const READY_WAIT: Duration = Duration::from_secs(30);

/// Why a connection was not made. Never the URL or the host: these end up
/// in the app's messages.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum NetError {
    /// Tor is not ready. The app tells this apart from "the server did not
    /// answer", and it never leads to offering a direct connection (§2.4).
    #[error("Tor is not ready yet")]
    TorNotReady,
    /// A permit was used for something it does not allow.
    #[error("not allowed without Tor")]
    NotPermitted,
    #[error("not a ws:// or wss:// address")]
    BadUrl,
    #[error("could not connect ({0})")]
    Connect(&'static str),
    #[error("the WebSocket handshake failed ({0})")]
    Handshake(&'static str),
}

/// A short reason for a connection that failed.
pub(crate) fn io_reason(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::ConnectionRefused => "refused",
        ErrorKind::TimedOut => "timeout",
        ErrorKind::NetworkUnreachable | ErrorKind::HostUnreachable => "unreachable",
        _ => "network",
    }
}

/// How the connections of a `Net` go out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Through Tor, or nowhere while it is not ready.
    Tor,
    /// Everything direct, by `DirectPermit::for_session`, until
    /// `back_to_tor` or the end of the process.
    Direct,
}

/// The only hosts the updater's permit reaches, on 443 only (§2.8, §6.4):
/// trinochat.org and GitHub's release hosts. Exact names: a subdomain is
/// not one of them.
const UPDATER_HOSTS: [&str; 4] = [
    "trinochat.org",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a `Net` and the thread that watches its Tor share.
struct Shared {
    /// Set only by `allow_direct` with the session's permit. Memory only:
    /// nothing here can save it.
    without_tor: AtomicBool,
    /// Tor's own state. Its lock also guards `generation` and the marker
    /// writes, so a stopped Tor's watcher never writes after `stop`.
    tor: Mutex<NetStatus>,
    /// Which start of Tor is current: `stop` and every start move it on,
    /// and a watcher of an older one changes nothing.
    generation: AtomicU64,
    /// What the app sees: `Direct` without Tor, Tor's state otherwise.
    seen: watch::Sender<NetStatus>,
    /// The mode, for whoever holds a socket open: a change means its
    /// socket went the other way and must be opened again (§2.8).
    route: watch::Sender<Mode>,
}

impl Shared {
    fn new(tor: NetStatus) -> Self {
        Shared {
            without_tor: AtomicBool::new(false),
            tor: Mutex::new(tor),
            generation: AtomicU64::new(0),
            seen: watch::Sender::new(tor),
            route: watch::Sender::new(Mode::Tor),
        }
    }

    /// Go without Tor, or back to it: the app sees it, and so does every
    /// socket open on the old way.
    fn set_without_tor(&self, on: bool) {
        self.without_tor.store(on, Ordering::SeqCst);
        self.republish();
        let mode = if on { Mode::Direct } else { Mode::Tor };
        self.route.send_if_modified(|current| {
            let changed = *current != mode;
            *current = mode;
            changed
        });
    }

    fn publish(&self, tor: NetStatus) {
        let seen = if self.without_tor.load(Ordering::SeqCst) {
            NetStatus::Direct
        } else {
            tor
        };
        self.seen.send_if_modified(|current| {
            let changed = *current != seen;
            *current = seen;
            changed
        });
    }

    fn republish(&self) {
        let tor = *lock(&self.tor);
        self.publish(tor);
    }

    /// A new start of Tor, in `status`: the watchers of earlier ones stop
    /// counting.
    fn next_generation(&self, status: NetStatus) -> u64 {
        let mut tor = lock(&self.tor);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *tor = status;
        drop(tor);
        self.publish(status);
        generation
    }

    /// Set Tor's state, and run `also` under the same lock, if
    /// `generation` is still the current start. Whether it was.
    fn update(&self, generation: u64, status: NetStatus, also: impl FnOnce()) -> bool {
        let mut tor = lock(&self.tor);
        if self.generation.load(Ordering::SeqCst) != generation {
            return false;
        }
        also();
        let changed = *tor != status;
        *tor = status;
        drop(tor);
        if changed {
            self.publish(status);
        }
        true
    }

    fn tor_ready(&self) -> bool {
        matches!(*lock(&self.tor), NetStatus::Ready { .. })
    }
}

/// The network of the app: Tor, and the direct transport behind its
/// permits.
pub struct Net {
    /// What starts Tor: Arti in the app, a fake in tests, none in a `Net`
    /// that never has Tor.
    backend: Option<Arc<dyn TorBackend>>,
    config: Option<NetConfig>,
    /// The running Tor, between `start` and `stop`.
    tor: Mutex<Option<Arc<dyn RunningTor>>>,
    direct: Arc<dyn Transport>,
    shared: Arc<Shared>,
    /// One `start` or `stop` at a time.
    life: Mutex<()>,
    /// The person's private bridges, from the app's encrypted store:
    /// memory only, handed in at unlock and dropped at lock (R-01).
    private: Mutex<Option<Vec<BridgeLine>>>,
    /// A built-in transport being tried by a tap ("Probar con un puente"),
    /// kept in tor/settings.json once it works.
    trial: Mutex<Option<TransportKind>>,
    /// What the running start launched besides Tor: the bridge program,
    /// and the session's folder with private bridges.
    extras: Mutex<Extras>,
    /// Tests run a fake bridge program with these arguments.
    #[cfg(test)]
    pt_args: Mutex<Vec<std::ffi::OsString>>,
}

/// What a start launched besides Tor, stopped and destroyed with it.
#[derive(Default)]
struct Extras {
    pt: Option<PtProcess>,
    run: Option<std::path::PathBuf>,
}

impl Extras {
    /// After Tor stopped: the bridge program goes, then the session's
    /// folder, file by file (R-01).
    fn end(self) {
        if let Some(pt) = self.pt {
            pt.stop();
        }
        if let Some(run) = self.run {
            let _ = tor::dirs::destroy_tree(&run);
        }
    }
}

impl Default for Net {
    /// No Tor at all, the real direct transport, `Mode::Tor`: nothing
    /// connects without the session's permit.
    fn default() -> Self {
        Net {
            backend: None,
            config: None,
            tor: Mutex::new(None),
            direct: Arc::new(direct::Direct),
            shared: Arc::new(Shared::new(NetStatus::Off)),
            life: Mutex::new(()),
            private: Mutex::new(None),
            trial: Mutex::new(None),
            extras: Mutex::new(Extras::default()),
            #[cfg(test)]
            pt_args: Mutex::new(Vec::new()),
        }
    }
}

/// A transport handed in whole, as Tor (tests): always there, never
/// stopped.
#[cfg(any(test, feature = "test-util"))]
struct Fixed(Arc<dyn Transport>);

#[cfg(any(test, feature = "test-util"))]
impl Transport for Fixed {
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        iso: &'a Iso,
    ) -> futures_util::future::BoxFuture<'a, Result<BoxedIo, NetError>> {
        self.0.connect(target, iso)
    }
}

#[cfg(any(test, feature = "test-util"))]
impl RunningTor for Fixed {
    fn set_dormant(&self, _on: bool) {}
    fn stop(&self) {}
}

impl Net {
    /// A `Net` with no Tor at all, in `Mode::Tor`: nothing connects
    /// without the session's permit.
    pub fn new() -> Arc<Net> {
        Arc::new(Net::default())
    }

    /// The app's `Net`: Tor is Arti, with its folders in
    /// `config.tor_home`. It starts nothing until `start`.
    pub fn with_arti(config: NetConfig) -> Arc<Net> {
        Arc::new(Net {
            backend: Some(Arc::new(tor::arti::Arti)),
            config: Some(config),
            ..Net::default()
        })
    }

    /// A `Net` on the given transports, for tests: a ready `Mock` for Tor
    /// (or no Tor) and `Forbidden` (or another `Mock`) for direct.
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_transports(
        tor: Option<Arc<dyn Transport>>,
        direct: Arc<dyn Transport>,
    ) -> Arc<Net> {
        let status = match tor {
            Some(_) => NetStatus::Ready {
                transport: TransportKind::None,
            },
            None => NetStatus::Off,
        };
        Arc::new(Net {
            tor: Mutex::new(tor.map(|tor| Arc::new(Fixed(tor)) as Arc<dyn RunningTor>)),
            direct,
            shared: Arc::new(Shared::new(status)),
            ..Net::default()
        })
    }

    /// A `Net` whose Tor `backend` starts, for tests (`mock::FakeTor`).
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_backend(
        config: NetConfig,
        backend: Arc<dyn TorBackend>,
        direct: Arc<dyn Transport>,
    ) -> Arc<Net> {
        Arc::new(Net {
            backend: Some(backend),
            config: Some(config),
            direct,
            ..Net::default()
        })
    }

    /// Where this `Net` keeps Tor's files, if it has Tor.
    pub fn tor_home(&self) -> Option<&std::path::Path> {
        self.config.as_ref().map(|config| config.tor_home.as_path())
    }

    pub fn mode(&self) -> Mode {
        if self.shared.without_tor.load(Ordering::SeqCst) {
            Mode::Direct
        } else {
            Mode::Tor
        }
    }

    /// The state as it is now.
    pub fn status_now(&self) -> NetStatus {
        *self.shared.seen.borrow()
    }

    /// Every change of state, as the app's UI gets it (§2.2). No Tauri:
    /// the app turns it into its own event.
    pub fn status(&self) -> watch::Receiver<NetStatus> {
        self.shared.seen.subscribe()
    }

    /// Go without Tor until `back_to_tor` or the end of the process. Only
    /// the session's permit does this; the updater's is refused and changes
    /// nothing.
    pub fn allow_direct(&self, permit: DirectPermit) -> Result<(), NetError> {
        match permit.scope {
            Scope::Session => {
                self.shared.set_without_tor(true);
                Ok(())
            }
            Scope::Updater => Err(NetError::NotPermitted),
        }
    }

    /// "Volver a usar Tor": every connection from now on goes through Tor.
    /// A socket opened without it is not moved here: its holder hears the
    /// change on `route` and opens it again.
    pub fn back_to_tor(&self) {
        self.shared.set_without_tor(false);
    }

    /// Every change of mode, for whoever keeps a socket open (the relays):
    /// a socket opened in one mode is opened again once it changes, so
    /// "Conectar sin Tor" and "Volver a usar Tor" reach the sockets already
    /// open, not only the next ones (§2.8, design test 15).
    pub fn route(&self) -> watch::Receiver<Mode> {
        self.shared.route.subscribe()
    }

    /// A new session: nothing it opens shares a circuit with another's.
    pub fn session(&self) -> Session {
        Session::next()
    }

    /// Start Tor, unless it runs already or this `Net` has none. It
    /// returns at once: the start goes on underneath, and `status` tells
    /// how it goes. With `tor/run.marker` saying Arti likely died twice
    /// for being too old, it does not start (`Obsolete`, not confirmed);
    /// `retry` does.
    pub fn start(&self) {
        let _life = lock(&self.life);
        self.start_locked();
    }

    fn start_locked(&self) {
        let (Some(backend), Some(config)) = (&self.backend, &self.config) else {
            return;
        };
        if lock(&self.tor).is_some() {
            return;
        }
        let bridges = self.bridges();
        let transport = bridges.transport();
        // Kept in tor/settings.json once it works: a tried built-in.
        let remember = match &bridges {
            Bridges::Builtin(kind) if *lock(&self.trial) == Some(*kind) => Some(*kind),
            _ => None,
        };
        let Ok(marker) = RunMarker::begin(&config.tor_home) else {
            self.shared
                .next_generation(NetStatus::Obsolete { confirmed: false });
            return;
        };
        let generation = self.shared.next_generation(NetStatus::Starting { pct: 0 });
        let (progress, reports) = mpsc::channel();
        let mut extras = Extras::default();
        let launched =
            self.prepare(config, &bridges, &mut extras)
                .and_then(|(dirs, transports)| {
                    backend.launch(Launch {
                        dirs,
                        transport,
                        bridges: bridges.lines(),
                        transports,
                        progress,
                    })
                });
        match launched {
            Ok(running) => {
                *lock(&self.tor) = Some(running);
                *lock(&self.extras) = extras;
                let shared = Arc::clone(&self.shared);
                let remember = remember.map(|kind| (config.tor_home.clone(), kind));
                let watcher = std::thread::Builder::new()
                    .name("tor-status".to_string())
                    .spawn(move || {
                        watch_tor(&shared, generation, &reports, transport, &marker, remember)
                    });
                if watcher.is_err() {
                    // Without its watcher it would never be seen ready.
                    if let Some(running) = lock(&self.tor).take() {
                        running.stop();
                    }
                    std::mem::take(&mut *lock(&self.extras)).end();
                    self.shared.update(generation, failed(), || {});
                }
            }
            Err(error) => {
                extras.end();
                marker.clear();
                let status = match error {
                    LaunchError::PtMissing => NetStatus::PtMissing,
                    LaunchError::Obsolete => NetStatus::Obsolete { confirmed: true },
                    LaunchError::Failed(_) => failed(),
                };
                self.shared.update(generation, status, || {});
            }
        }
    }

    /// What a start needs before Tor: its folders (a session's own with
    /// private bridges, R-01) and, with bridges, the bridge program and
    /// where each of their transports listens. What it launches goes in
    /// `extras`, so that a failure later ends it too.
    fn prepare(
        &self,
        config: &NetConfig,
        bridges: &Bridges,
        extras: &mut Extras,
    ) -> Result<(TorDirs, Vec<PtMethod>), LaunchError> {
        let dirs = if bridges.is_private() {
            let (dirs, run) =
                TorDirs::session(&config.tor_home).map_err(|_| LaunchError::Failed("folders"))?;
            extras.run = Some(run);
            dirs
        } else {
            let dirs = TorDirs::fixed(&config.tor_home);
            std::fs::create_dir_all(&dirs.state)
                .and_then(|()| std::fs::create_dir_all(&dirs.cache))
                .map_err(|_| LaunchError::Failed("folders"))?;
            dirs
        };
        if *bridges == Bridges::None {
            return Ok((dirs, Vec::new()));
        }
        let protocols = bridges.protocols();
        if protocols.is_empty() {
            // A kind with no bridge to use (WebTunnel, meek): never start
            // without one.
            return Err(LaunchError::Failed("no bridges"));
        }
        let transports = match &config.pt {
            None => return Err(LaunchError::PtMissing),
            Some(PtLauncher::Unmanaged { socks }) => protocols
                .iter()
                .map(|protocol| PtMethod {
                    protocol: protocol.to_string(),
                    socks: *socks,
                })
                .collect(),
            Some(PtLauncher::Managed { path, sha256 }) => {
                let process = PtProcess::launch(
                    path,
                    sha256,
                    &self.pt_args(),
                    &protocols,
                    &dirs.state.join("lyrebird"),
                    tor::pt::HANDSHAKE,
                )
                .map_err(|error| match error {
                    PtError::Missing | PtError::Mismatch => LaunchError::PtMissing,
                    _ => LaunchError::Failed("bridge program"),
                })?;
                let transports = process.methods().to_vec();
                extras.pt = Some(process);
                transports
            }
        };
        Ok((dirs, transports))
    }

    #[cfg(test)]
    fn pt_args(&self) -> Vec<std::ffi::OsString> {
        lock(&self.pt_args).clone()
    }

    #[cfg(not(test))]
    fn pt_args(&self) -> Vec<std::ffi::OsString> {
        Vec::new()
    }

    /// Tests: run the bridge program with `args` (a fake one).
    #[cfg(test)]
    pub(crate) fn set_pt_test_args(&self, args: Vec<std::ffi::OsString>) {
        *lock(&self.pt_args) = args;
    }

    /// The bridges the next start uses: the private lines if the app
    /// handed them in, else a built-in transport being tried, else the one
    /// tor/settings.json keeps, else none.
    pub fn bridges(&self) -> Bridges {
        if let Some(lines) = lock(&self.private).as_ref() {
            return Bridges::Private(lines.clone());
        }
        if let Some(kind) = *lock(&self.trial) {
            return Bridges::Builtin(kind);
        }
        let kept = self
            .config
            .as_ref()
            .map(|config| TorSettings::load(&config.tor_home).transport)
            .unwrap_or_default();
        match kept {
            TransportKind::None => Bridges::None,
            kind => Bridges::Builtin(kind),
        }
    }

    /// Whether this build has a bridge program to run bridges with.
    pub fn has_bridge_program(&self) -> bool {
        self.config
            .as_ref()
            .is_some_and(|config| config.pt.is_some())
    }

    /// The person's private bridges, for the next start (or none): memory
    /// only. The app hands them in from its encrypted store at unlock and
    /// takes them away at lock; a start with them runs in a folder of the
    /// session's own (R-01). A built-in being tried is dropped.
    pub fn set_private_bridges(&self, lines: Option<Vec<BridgeLine>>) {
        *lock(&self.trial) = None;
        *lock(&self.private) = lines.filter(|lines| !lines.is_empty());
    }

    pub fn has_private_bridges(&self) -> bool {
        lock(&self.private).is_some()
    }

    /// "Probar con un puente" (§5.3), by a tap: start again through the
    /// built-in bridges of `kind`, and keep `kind` in tor/settings.json
    /// once Tor is ready through them. Only the built-in kinds; never over
    /// private bridges, which are the person's choice. `retry` goes back
    /// to what is kept.
    pub fn try_bridge(&self, kind: TransportKind) -> Result<(), NetError> {
        if !tor::bridges::BUILTIN.contains(&kind) || self.has_private_bridges() {
            return Err(NetError::NotPermitted);
        }
        let _life = lock(&self.life);
        *lock(&self.trial) = Some(kind);
        self.stop_locked();
        self.start_locked();
        Ok(())
    }

    /// When Trino opens: destroy the session folders (`run-*`) a cut left
    /// behind (R-01). Returns how many.
    pub fn destroy_leftover_runs(&self) -> usize {
        let _life = lock(&self.life);
        if lock(&self.tor).is_some() {
            return 0;
        }
        self.config.as_ref().map_or(0, |config| {
            tor::dirs::destroy_leftover_runs(&config.tor_home)
        })
    }

    /// Stop Tor (R-03): its tasks end and its files close before this
    /// returns. The state is `Off` until the next `start`. Blocks: from
    /// async code, call it on a blocking thread.
    pub fn stop(&self) {
        let _life = lock(&self.life);
        self.stop_locked();
    }

    fn stop_locked(&self) {
        let running = lock(&self.tor).take();
        // Whatever the old start's watcher sees from now on is dropped.
        self.shared.next_generation(NetStatus::Off);
        if let Some(running) = running {
            running.stop();
        }
        // Then lyrebird, and the folder of a session with private bridges.
        std::mem::take(&mut *lock(&self.extras)).end();
        // A clean stop: no death to count.
        if let Some(config) = &self.config {
            RunMarker::forgive(&config.tor_home);
        }
    }

    /// "Volver a intentar" and, on the "old version" screen, "Intentar de
    /// nuevo": stop Tor, forget the deaths `run.marker` counted and a
    /// built-in being tried, and start again with what is kept.
    pub fn retry(&self) {
        let _life = lock(&self.life);
        *lock(&self.trial) = None;
        self.stop_locked();
        self.start_locked();
    }

    /// Put Tor to sleep while nothing uses it (at lock, §2.6), or wake it.
    pub fn set_dormant(&self, on: bool) {
        if let Some(tor) = lock(&self.tor).as_ref() {
            tor.set_dormant(on);
        }
    }

    /// Wait for the network to be ready, at most `limit`: `Ok` at once
    /// without Tor (the session's permit) or with Tor ready; a starting or
    /// blocked Tor is waited for; with none started, obsolete or without
    /// its bridge program, `TorNotReady` at once. Never a reason to go
    /// direct.
    pub async fn ready(&self, limit: Duration) -> Result<(), NetError> {
        let mut seen = self.shared.seen.subscribe();
        let wait = async move {
            loop {
                let now = *seen.borrow_and_update();
                if now.is_ready() {
                    return Ok(());
                }
                if !now.may_become_ready() || seen.changed().await.is_err() {
                    return Err(NetError::TorNotReady);
                }
            }
        };
        tokio::time::timeout(limit, wait)
            .await
            .unwrap_or(Err(NetError::TorNotReady))
    }

    /// Wait, with no limit, until the network is ready: what a relay does
    /// before its own deadline starts (§2.4, design test 13).
    pub async fn until_ready(&self) {
        let mut seen = self.shared.seen.subscribe();
        loop {
            if seen.borrow_and_update().is_ready() || seen.changed().await.is_err() {
                return;
            }
        }
    }

    /// A connection to `target`, isolated by `iso`: through Tor in
    /// `Mode::Tor` (`TorNotReady` while it is not ready, never direct), and
    /// direct in `Mode::Direct`.
    pub async fn connect(&self, target: &Target, iso: &Iso) -> Result<BoxedIo, NetError> {
        match self.mode() {
            Mode::Direct => self.direct.connect(target, iso).await,
            Mode::Tor => {
                if !self.shared.tor_ready() {
                    return Err(NetError::TorNotReady);
                }
                let tor = lock(&self.tor).clone().ok_or(NetError::TorNotReady)?;
                tor.connect(target, iso).await
            }
        }
    }

    /// A direct connection for the updater, with its permit, to one of its
    /// hosts on 443, whatever the mode. Anything else is `NotPermitted`.
    pub async fn connect_for_update(
        &self,
        permit: &DirectPermit,
        target: &Target,
    ) -> Result<BoxedIo, NetError> {
        let allowed = permit.scope == Scope::Updater
            && target.port == 443
            && UPDATER_HOSTS.contains(&target.host.as_str());
        if !allowed {
            return Err(NetError::NotPermitted);
        }
        let iso = transport::detached_iso(IsoKind::UPDATE);
        self.direct.connect(target, &iso).await
    }
}

/// A start that could not even begin: told as Tor not finishing to
/// connect (§10.3, "Otro").
fn failed() -> NetStatus {
    NetStatus::Blocked {
        kind: BlockKind::CantBootstrap,
        pct: 0,
    }
}

/// Turns what one start of Tor reports into states, until that Tor stops
/// or a newer start replaces it. Also keeps `run.marker`: "ready" once Tor
/// is, and gone once Tor has run `SURVIVAL` since; and, once ready, the
/// tried transport in `remember`.
fn watch_tor(
    shared: &Shared,
    generation: u64,
    reports: &mpsc::Receiver<Progress>,
    transport: TransportKind,
    marker: &RunMarker,
    remember: Option<(std::path::PathBuf, TransportKind)>,
) {
    let mut watch = Watch::new(transport, Instant::now());
    let mut ready_at: Option<Instant> = None;
    let mut survived = false;
    loop {
        let now = Instant::now();
        let survival = ready_at
            .filter(|_| !survived)
            .map(|at| at + marker::SURVIVAL);
        let wake = match (watch.next_change(now), survival) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        let report = match wake {
            Some(at) => reports.recv_timeout(at.saturating_duration_since(now)),
            None => reports
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        let now = Instant::now();
        match report {
            Ok(Progress::Bootstrap {
                frac,
                ready,
                blocked,
            }) => watch.on(frac, ready, blocked, now),
            Ok(Progress::Obsolete) => {
                shared.update(generation, NetStatus::Obsolete { confirmed: true }, || {
                    marker.clear()
                });
                return;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
        }
        let status = watch.status(now);
        let first_ready = status.is_ready() && ready_at.is_none();
        if first_ready {
            ready_at = Some(now);
        }
        let lived = ready_at.is_some_and(|at| !survived && now >= at + marker::SURVIVAL);
        if lived {
            survived = true;
        }
        let current = shared.update(generation, status, || {
            if first_ready {
                marker.ready();
                // What worked is kept (§5.2): the kind only (R-25).
                if let Some((tor_home, kind)) = &remember {
                    let mut kept = TorSettings::load(tor_home);
                    kept.transport = *kind;
                    let _ = kept.save(tor_home);
                }
            }
            if lived {
                marker.clear();
            }
        });
        if !current {
            return;
        }
    }
}
