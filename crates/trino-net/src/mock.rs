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
