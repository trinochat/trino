//! What carries a connection (Tor design §2.1), the tokens that decide
//! which connections may share a Tor circuit (§2.7), and the permits to go
//! without Tor (§2.8).

use crate::NetError;
use futures_util::future::BoxFuture;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncRead, AsyncWrite};

/// A connected byte stream, whatever carries it: a Tor stream, a direct
/// socket, or a test's in-memory pipe.
pub trait Io: AsyncRead + AsyncWrite + Send + Unpin {}

impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}

/// A connection, its carrier erased.
pub type BoxedIo = Box<dyn Io>;

/// Where a connection goes: a host name and a port.
///
/// The name is handed to the transport as it is. Nothing in this crate
/// resolves it: with Tor the exit looks it up, so the resolver of this
/// machine and its network never see it (design test 3).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Target {
    pub host: String,
    pub port: u16,
}

impl Target {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Target {
            host: host.into(),
            port,
        }
    }
}

/// Something that opens connections: Tor, the direct transport, or a
/// test's. `Net` picks which one; nothing else should call one directly.
pub trait Transport: Send + Sync {
    /// A connection to `target`. Two connections may share a Tor circuit
    /// only if their `iso` are equal.
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>>;
}

/// A class of traffic. It is open (R-14): a kind is its name, and any code
/// can make one with `IsoKind::new`, as P1 will for its mailboxes, without
/// touching this crate. Two kinds with the same name are the same kind.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct IsoKind(&'static str);

impl IsoKind {
    /// A messaging relay, one token per relay URL.
    pub const RELAY: IsoKind = IsoKind("relay");
    /// The network inspector's own connection to a relay.
    pub const INSPECTOR: IsoKind = IsoKind("inspector");
    /// One upload or download.
    pub const BLOSSOM: IsoKind = IsoKind("blossom");
    /// The TURN credentials of one call.
    pub const TURN: IsoKind = IsoKind("turn");
    /// One @name lookup, registration or release.
    pub const NAME: IsoKind = IsoKind("name");
    /// One invitation, by (tid, role).
    pub const INVITE: IsoKind = IsoKind("invite");
    /// One update check.
    pub const UPDATE: IsoKind = IsoKind("update");
    /// One read of the news.
    pub const NEWS: IsoKind = IsoKind("news");

    pub const fn new(name: &'static str) -> Self {
        IsoKind(name)
    }

    pub fn name(self) -> &'static str {
        self.0
    }
}

impl fmt::Debug for IsoKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "IsoKind({})", self.0)
    }
}

/// An isolation token: a session, a kind and a key (§2.2, §2.7). Two
/// connections may share a circuit only if their tokens are equal, so a
/// relay cannot match its exit address with another relay's, nor one
/// session's with the next.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Iso {
    session: u64,
    kind: IsoKind,
    key: Vec<u8>,
}

impl Iso {
    pub fn kind(&self) -> IsoKind {
        self.kind
    }
}

impl fmt::Debug for Iso {
    // Never the key: it is a relay URL, a mailbox or an invitation.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Iso")
            .field("session", &self.session)
            .field("kind", &self.kind)
            .field("key_len", &self.key.len())
            .finish()
    }
}

/// Every session of the process gets its own number, whichever `Net` made
/// it, so no two sessions ever hand out equal tokens.
static SESSIONS: AtomicU64 = AtomicU64::new(1);

/// What one unlock uses (§2.6). Nothing it opens shares a circuit with
/// another session's.
#[derive(Clone, Debug)]
pub struct Session {
    id: u64,
}

impl Session {
    pub(crate) fn next() -> Self {
        Session {
            id: SESSIONS.fetch_add(1, Ordering::Relaxed),
        }
    }

    /// The token of `kind` and `key` in this session.
    pub fn iso(&self, kind: IsoKind, key: impl AsRef<[u8]>) -> Iso {
        Iso {
            session: self.id,
            kind,
            key: key.as_ref().to_vec(),
        }
    }
}

/// The token for a connection made outside every session: the updater's,
/// with its permit.
pub(crate) fn detached_iso(kind: IsoKind) -> Iso {
    Iso {
        session: 0,
        kind,
        key: Vec::new(),
    }
}

/// Leave to connect without Tor (§2.8, R-07). There are two, and nothing
/// else ever opens a direct connection:
///
/// - `for_session`: "Conectar sin Tor (solo esta vez)", after its
///   confirmation. `Net::allow_direct` puts the whole `Net` in
///   `Mode::Direct` until `back_to_tor` or the end of the process; it is
///   never saved, and there is nothing in it to save.
/// - `for_updater`: the "old version" screen, after its confirmation, when
///   Arti is obsolete. Only `Net::connect_for_update` takes it: HTTPS to
///   trinochat.org and GitHub's release hosts, never a WebSocket, and the
///   mode of everything else stays as it was.
///
/// The constructors are public because the app is another crate, so the
/// workspace's clippy.toml disallows calling them; the app may do it under
/// an `#[allow]` in its two places only (the `net_connect_without_tor`
/// command and the updater), which the app's tests check.
///
/// A permit cannot be copied, cloned or serialized:
///
/// ```compile_fail
/// fn copies<T: Clone>() {}
/// copies::<trino_net::DirectPermit>();
/// ```
#[derive(Debug)]
pub struct DirectPermit {
    pub(crate) scope: Scope,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Scope {
    Session,
    Updater,
}

impl DirectPermit {
    /// "Conectar sin Tor (solo esta vez)".
    pub fn for_session() -> Self {
        DirectPermit {
            scope: Scope::Session,
        }
    }

    /// The updater, when Arti is obsolete.
    pub fn for_updater() -> Self {
        DirectPermit {
            scope: Scope::Updater,
        }
    }
}
