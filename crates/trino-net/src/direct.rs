//! The direct transport: the only place of the program that opens a socket
//! without Tor (Tor design §2.1, §3.2). `Net` reaches it only with a
//! `DirectPermit`.

use crate::{BoxedIo, Iso, NetError, Target, Transport};
use futures_util::future::BoxFuture;

pub(crate) struct Direct;

impl Transport for Direct {
    fn connect<'a>(
        &'a self,
        target: &'a Target,
        _iso: &'a Iso,
    ) -> BoxFuture<'a, Result<BoxedIo, NetError>> {
        Box::pin(async move {
            // The one direct connection of the program, behind a permit
            // (lib.rs). Without Tor the name is resolved here, as it always
            // was before Tor.
            #[allow(clippy::disallowed_methods)]
            let socket = tokio::net::TcpStream::connect((target.host.as_str(), target.port))
                .await
                .map_err(|e| NetError::Connect(crate::io_reason(&e)))?;
            // A relay's small frames go out at once.
            let _ = socket.set_nodelay(true);
            Ok(Box::new(socket) as BoxedIo)
        })
    }
}
