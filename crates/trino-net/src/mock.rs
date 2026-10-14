//! In-memory transports for tests (Tor design §2.1, feature "test-util").
//! Nothing here touches the network.

use crate::{BoxedIo, Iso, NetError, Target, Transport};
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use tokio::io::DuplexStream;
use tokio::sync::mpsc;

/// How much a pipe holds before a write waits for the other end.
const PIPE: usize = 64 * 1024;

/// A transport whose servers live in the test: each `listen`ed host and
/// port gets the server end of an in-memory pipe for every connection to
/// it. Every connection asked for is recorded, served or not.
#[derive(Default)]
pub struct Mock {
    listeners: Mutex<HashMap<(String, u16), mpsc::UnboundedSender<DuplexStream>>>,
    seen: Mutex<Vec<(Target, Iso)>>,
}

/// The server side of one `listen`.
pub struct MockListener {
    connections: mpsc::UnboundedReceiver<DuplexStream>,
}

impl MockListener {
    /// The server end of the next connection; `None` once the `Mock` is
    /// gone.
    pub async fn accept(&mut self) -> Option<DuplexStream> {
        self.connections.recv().await
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Mock {
    pub fn new() -> Arc<Mock> {
        Arc::new(Mock::default())
    }

    /// Serve `host`:`port`. A later `listen` on the same place replaces it.
    pub fn listen(&self, host: &str, port: u16) -> MockListener {
        let (sender, connections) = mpsc::unbounded_channel();
        lock(&self.listeners).insert((host.to_string(), port), sender);
        MockListener { connections }
    }

    /// Every connection asked for so far, in order, with its token.
    pub fn connections(&self) -> Vec<(Target, Iso)> {
        lock(&self.seen).clone()
    }
}

impl Transport for Mock {
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>> {
        lock(&self.seen).push((target.clone(), iso.clone()));
        let listener = lock(&self.listeners)
            .get(&(target.host.clone(), target.port))
            .cloned();
        Box::pin(async move {
            let listener = listener.ok_or(NetError::Connect("refused"))?;
            let (client, server) = tokio::io::duplex(PIPE);
            listener
                .send(server)
                .map_err(|_| NetError::Connect("refused"))?;
            Ok(Box::new(client) as BoxedIo)
        })
    }
}

/// The direct transport of a test where nothing may go direct: using it
/// fails the test.
pub struct Forbidden;

impl Transport for Forbidden {
    fn connect<'a>(
        &'a self,
        _target: &'a Target,
        _iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>> {
        panic!("the direct transport was used where only Tor may be");
    }
}

/// A Tor for tests (design test 12): it starts at once, connects through
/// its `Mock`, and reports only what the test tells it to. It records
/// what was asked of it.
pub struct FakeTor {
    mock: Arc<Mock>,
    state: Arc<Mutex<FakeState>>,
}

#[derive(Default)]
struct FakeState {
    progress: Option<std::sync::mpsc::Sender<crate::Progress>>,
    next_error: Option<crate::LaunchError>,
    launches: Vec<crate::TransportKind>,
    last: Option<Launched>,
    log: Vec<&'static str>,
}

/// What a `FakeTor` was last launched with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launched {
    pub dirs: crate::TorDirs,
    pub transport: crate::TransportKind,
    pub bridges: Vec<crate::BridgeLine>,
    pub transports: Vec<crate::PtMethod>,
}

/// One start of a `FakeTor`.
struct FakeRunning {
    mock: Arc<Mock>,
    state: Arc<Mutex<FakeState>>,
}

impl FakeTor {
    pub fn new(mock: Arc<Mock>) -> Arc<FakeTor> {
        Arc::new(FakeTor {
            mock,
            state: Arc::default(),
        })
    }

    /// Report `progress`, as the running Tor would. Nothing if none runs.
    pub fn report(&self, progress: crate::Progress) {
        if let Some(sender) = lock(&self.state).progress.as_ref() {
            let _ = sender.send(progress);
        }
    }

    /// Report that Tor is at `pct` %.
    pub fn at(&self, pct: u8) {
        self.report(crate::Progress::Bootstrap {
            frac: f32::from(pct) / 100.0,
            ready: false,
            blocked: None,
        });
    }

    /// Report that Tor is ready.
    pub fn ready(&self) {
        self.report(crate::Progress::Bootstrap {
            frac: 1.0,
            ready: true,
            blocked: None,
        });
    }

    /// The next `launch` fails with `error`.
    pub fn fail_next(&self, error: crate::LaunchError) {
        lock(&self.state).next_error = Some(error);
    }

    /// The transport of every launch so far.
    pub fn launches(&self) -> Vec<crate::TransportKind> {
        lock(&self.state).launches.clone()
    }

    /// What the last launch was given, if any.
    pub fn last_launch(&self) -> Option<Launched> {
        lock(&self.state).last.clone()
    }

    /// What was asked of it, in order: "launch", "stop", "sleep", "wake".
    pub fn log(&self) -> Vec<&'static str> {
        lock(&self.state).log.clone()
    }
}

impl crate::TorBackend for FakeTor {
    fn launch(
        &self,
        launch: crate::tor::Launch,
    ) -> Result<Arc<dyn crate::RunningTor>, crate::LaunchError> {
        let mut state = lock(&self.state);
        state.log.push("launch");
        state.launches.push(launch.transport);
        state.last = Some(Launched {
            dirs: launch.dirs.clone(),
            transport: launch.transport,
            bridges: launch.bridges.clone(),
            transports: launch.transports.clone(),
        });
        if let Some(error) = state.next_error.take() {
            return Err(error);
        }
        state.progress = Some(launch.progress);
        Ok(Arc::new(FakeRunning {
            mock: Arc::clone(&self.mock),
            state: Arc::clone(&self.state),
        }))
    }
}

impl Transport for FakeRunning {
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>> {
        self.mock.connect(target, iso)
    }
}

impl crate::RunningTor for FakeRunning {
    fn set_dormant(&self, on: bool) {
        lock(&self.state)
            .log
            .push(if on { "sleep" } else { "wake" });
    }

    fn stop(&self) {
        let mut state = lock(&self.state);
        state.log.push("stop");
        // As Arti's runtime going: nothing reports any more.
        state.progress = None;
    }
}
