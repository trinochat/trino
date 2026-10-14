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
//! - No Tauri and nothing of the app (§2.1): the host hands everything in,
//!   so the engine M4 extracts takes this crate as it is.
//!
//! Tor itself (Arti, its own runtime, bootstrap and states) comes with
//! TOR-5; until then a `Net` has no Tor and every connection without a
//! permit is `TorNotReady`.

mod direct;
#[cfg(any(test, feature = "test-util"))]
pub mod mock;
mod transport;
mod ws;

#[cfg(test)]
mod tests;

pub use transport::{BoxedIo, DirectPermit, Io, Iso, IsoKind, Session, Target, Transport};
pub use ws::{ws_connect, WsStream};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use thiserror::Error;
use transport::Scope;

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

/// The network of the app: Tor, and the direct transport behind its
/// permits.
pub struct Net {
    tor: Option<Arc<dyn Transport>>,
    direct: Arc<dyn Transport>,
    /// Set only by `allow_direct` with the session's permit. Memory only:
    /// nothing here can save it.
    without_tor: AtomicBool,
}

impl Default for Net {
    /// No Tor yet, the real direct transport, `Mode::Tor`.
    fn default() -> Self {
        Net {
            tor: None,
            direct: Arc::new(direct::Direct),
            without_tor: AtomicBool::new(false),
        }
    }
}

impl Net {
    /// A `Net` in `Mode::Tor`. It starts nothing.
    pub fn new() -> Arc<Net> {
        Arc::new(Net::default())
    }

    /// A `Net` on the given transports, for tests: `Mock` for Tor and
    /// `Forbidden` (or another `Mock`) for direct.
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_transports(
        tor: Option<Arc<dyn Transport>>,
        direct: Arc<dyn Transport>,
    ) -> Arc<Net> {
        Arc::new(Net {
            tor,
            direct,
            without_tor: AtomicBool::new(false),
        })
    }

    pub fn mode(&self) -> Mode {
        if self.without_tor.load(Ordering::SeqCst) {
            Mode::Direct
        } else {
            Mode::Tor
        }
    }

    /// Go without Tor until `back_to_tor` or the end of the process. Only
    /// the session's permit does this; the updater's is refused and changes
    /// nothing.
    pub fn allow_direct(&self, permit: DirectPermit) -> Result<(), NetError> {
        match permit.scope {
            Scope::Session => {
                self.without_tor.store(true, Ordering::SeqCst);
                Ok(())
            }
            Scope::Updater => Err(NetError::NotPermitted),
        }
    }

    /// "Volver a usar Tor": every connection from now on goes through Tor.
    pub fn back_to_tor(&self) {
        self.without_tor.store(false, Ordering::SeqCst);
    }

    /// A new session: nothing it opens shares a circuit with another's.
    pub fn session(&self) -> Session {
        Session::next()
    }

    /// A connection to `target`, isolated by `iso`: through Tor in
    /// `Mode::Tor` (`TorNotReady` while it is not ready, never direct), and
    /// direct in `Mode::Direct`.
    pub async fn connect(&self, target: &Target, iso: &Iso) -> Result<BoxedIo, NetError> {
        let transport = match self.mode() {
            Mode::Direct => Arc::clone(&self.direct),
            Mode::Tor => self.tor.clone().ok_or(NetError::TorNotReady)?,
        };
        transport.connect(target, iso).await
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
