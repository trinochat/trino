//! Arti (Tor design §2.3), on a tokio runtime of its own.
//!
//! `TorClient` has no `stop` (R-03), and its background tasks keep copies
//! of its runtime, so dropping the client does not end them. So Arti gets
//! a runtime of its own, on a thread of its own: `stop` drops the app's
//! copy of the client and shuts that runtime down, which ends every task
//! of Arti and, with them, closes its SQLite and its locks. The spike
//! measured it (S13): 11 ms, the WebSocket left open fails with "Circuit
//! closed", and every file of the folder can then be overwritten and
//! removed. The streams Arti hands out work from the app's runtime while
//! Arti's lives.
//!
//! Nothing here installs a log subscriber: Arti's `tracing` events go
//! nowhere, and nothing reaches the disk (R-25).

use super::bridges::BridgeLine;
use super::pt::PtMethod;
use super::{Launch, LaunchError, RunningTor, TorBackend, TorDirs};
use crate::{BlockKind, BoxedIo, Iso, NetError, Progress, Target, Transport};
use arti_client::config::pt::TransportConfigBuilder;
use arti_client::config::{BridgeConfigBuilder, TorClientConfigBuilder};
use arti_client::isolation::IsolationHelper;
use arti_client::status::{BlockageKind, BootstrapStatus};
use arti_client::{DormantMode, ErrorKind, HasKind, StreamPrefs, TorClient, TorClientConfig};
use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use std::sync::{mpsc, Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;
use tor_rtcompat::tokio::TokioRustlsRuntime;

type Client = TorClient<TokioRustlsRuntime>;

/// How long `stop` lets Arti's tasks end before leaving them.
const SHUTDOWN: Duration = Duration::from_secs(5);

/// The pause before trying a bootstrap again after it failed.
const BOOTSTRAP_RETRY: Duration = Duration::from_secs(10);

/// Arti, in the app.
pub struct Arti;

/// rustls needs a crypto provider for the process before Arti's TLS is
/// built (§2.3): ring, the one already in the tree. Installing it twice is
/// no error.
pub fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Arti's configuration: the folders of `dirs`, the `bridges`, each
/// transport of theirs as an unmanaged one at its SOCKS port (pt.rs), and
/// everything else as Arti has it (circuits, guards, timeouts: Trino
/// invents no network policy, §2.3).
pub(crate) fn config(
    dirs: &TorDirs,
    bridges: &[BridgeLine],
    transports: &[PtMethod],
) -> Result<TorClientConfig, LaunchError> {
    let mut builder = TorClientConfigBuilder::from_directories(&dirs.state, &dirs.cache);
    for line in bridges {
        let bridge = line
            .as_str()
            .parse::<BridgeConfigBuilder>()
            .map_err(|_| LaunchError::Failed("bridge"))?;
        builder.bridges().bridges().push(bridge);
    }
    for method in transports {
        let protocol = method
            .protocol
            .parse()
            .map_err(|_| LaunchError::Failed("transport"))?;
        let mut transport = TransportConfigBuilder::default();
        transport.protocols(vec![protocol]).proxy_addr(method.socks);
        builder.bridges().transports().push(transport);
    }
    builder
        .build()
        .map_err(|_| LaunchError::Failed("configuration"))
}

impl TorBackend for Arti {
    fn launch(&self, launch: Launch) -> Result<Arc<dyn RunningTor>, LaunchError> {
        // Every bridge needs its transport's SOCKS port: the bridge
        // program, which `Net` launches (pt.rs). Arti never runs one.
        let unserved = launch.bridges.iter().any(|line| {
            launch
                .transports
                .iter()
                .all(|method| method.protocol != line.protocol())
        });
        if unserved {
            return Err(LaunchError::PtMissing);
        }
        install_crypto_provider();
        let config = config(&launch.dirs, &launch.bridges, &launch.transports)?;
        let progress = launch.progress;

        let (created, client) = mpsc::channel();
        let (stop, stopped) = mpsc::channel::<()>();
        let thread = std::thread::Builder::new()
            .name("tor".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .thread_name("tor")
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(_) => {
                        let _ = created.send(Err(LaunchError::Failed("runtime")));
                        return;
                    }
                };
                let made = runtime.block_on(async {
                    let handle = TokioRustlsRuntime::current()
                        .map_err(|_| LaunchError::Failed("runtime"))?;
                    TorClient::with_runtime(handle)
                        .config(config)
                        .create_unbootstrapped()
                        .map_err(|e| launch_error(&e))
                });
                match made {
                    Ok(client) => {
                        runtime.spawn(report(Arc::clone(&client), progress.clone()));
                        runtime.spawn(bootstrap(Arc::clone(&client), progress));
                        let _ = created.send(Ok(client));
                    }
                    Err(error) => {
                        let _ = created.send(Err(error));
                        return;
                    }
                }
                // Until `stop`, or until the app's side is gone.
                let _ = stopped.recv();
                runtime.shutdown_timeout(SHUTDOWN);
            })
            .map_err(|_| LaunchError::Failed("thread"))?;

        let client = client
            .recv()
            .map_err(|_| LaunchError::Failed("runtime"))??;
        Ok(Arc::new(ArtiTor {
            client: Mutex::new(Some(client)),
            stop: Mutex::new(Some(stop)),
            thread: Mutex::new(Some(thread)),
        }))
    }
}

fn launch_error(error: &arti_client::Error) -> LaunchError {
    if error.kind() == ErrorKind::SoftwareDeprecated {
        LaunchError::Obsolete
    } else {
        LaunchError::Failed("arti")
    }
}

/// Every change of Arti's bootstrap status, to `progress`.
async fn report(client: Arc<Client>, progress: mpsc::Sender<Progress>) {
    let mut events = client.bootstrap_events();
    let _ = progress.send(progress_of(&client.bootstrap_status()));
    while let Some(status) = events.next().await {
        if progress.send(progress_of(&status)).is_err() {
            return;
        }
    }
}

/// Bootstrap, and again after a pause if it fails, until it is done or
/// Arti says it is too old. Readiness is not taken from here: with a warm
/// cache `bootstrap()` returns before Arti is ready for traffic (S3).
async fn bootstrap(client: Arc<Client>, progress: mpsc::Sender<Progress>) {
    loop {
        match client.bootstrap().await {
            Ok(()) => return,
            Err(error) if error.kind() == ErrorKind::SoftwareDeprecated => {
                let _ = progress.send(Progress::Obsolete);
                return;
            }
            Err(_) => tokio::time::sleep(BOOTSTRAP_RETRY).await,
        }
    }
}

fn progress_of(status: &BootstrapStatus) -> Progress {
    Progress::Bootstrap {
        frac: status.as_frac(),
        ready: status.ready_for_traffic(),
        blocked: status.blocked().and_then(|b| block_kind(&b.kind())),
    }
}

/// Arti's blockage as the app words it. `Disabled` only happens with a
/// client told not to bootstrap, which Trino never makes.
pub(crate) fn block_kind(kind: &BlockageKind) -> Option<BlockKind> {
    Some(match kind {
        BlockageKind::Offline => BlockKind::Offline,
        BlockageKind::Filtering => BlockKind::Filtering,
        BlockageKind::CantReachTor => BlockKind::CantReachTor,
        BlockageKind::ClockSkewed => BlockKind::ClockSkewed,
        BlockageKind::CantBootstrap => BlockKind::CantBootstrap,
        _ => return None,
    })
}

/// Two connections share a circuit only if their tokens are equal: a
/// token is a session, a kind and a key (§2.7).
impl IsolationHelper for Iso {
    fn compatible_same_type(&self, other: &Self) -> bool {
        self == other
    }

    fn join_same_type(&self, other: &Self) -> Option<Self> {
        (self == other).then(|| self.clone())
    }
}

/// Arti once started.
struct ArtiTor {
    /// The app's copy of the client; `stop` drops it, or the SQLite and
    /// the locks it holds would outlive Arti's runtime.
    client: Mutex<Option<Arc<Client>>>,
    stop: Mutex<Option<mpsc::Sender<()>>>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Transport for ArtiTor {
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>> {
        let client = lock(&self.client).clone();
        Box::pin(async move {
            let client = client.ok_or(NetError::TorNotReady)?;
            let mut prefs = StreamPrefs::new();
            prefs.set_isolation(iso.clone());
            // The name goes to the exit, which resolves it (design test 3).
            let stream = client
                .connect_with_prefs((target.host.as_str(), target.port), &prefs)
                .await
                .map_err(|e| NetError::Connect(stream_reason(&e)))?;
            Ok(Box::new(stream) as BoxedIo)
        })
    }
}

/// A short reason for a stream that failed, never the address.
fn stream_reason(error: &arti_client::Error) -> &'static str {
    match error.kind() {
        ErrorKind::RemoteConnectionRefused => "refused",
        ErrorKind::TorNetworkTimeout | ErrorKind::RemoteNetworkTimeout => "timeout",
        ErrorKind::RemoteHostNotFound => "not found",
        ErrorKind::BootstrapRequired => "not ready",
        _ => "tor",
    }
}

impl RunningTor for ArtiTor {
    fn set_dormant(&self, on: bool) {
        if let Some(client) = lock(&self.client).as_ref() {
            client.set_dormant(if on {
                DormantMode::Soft
            } else {
                DormantMode::Normal
            });
        }
    }

    fn stop(&self) {
        // The app's copy of the client first, then Arti's runtime.
        drop(lock(&self.client).take());
        drop(lock(&self.stop).take());
        if let Some(thread) = lock(&self.thread).take() {
            let _ = thread.join();
        }
    }
}

impl Drop for ArtiTor {
    fn drop(&mut self) {
        self.stop();
    }
}
