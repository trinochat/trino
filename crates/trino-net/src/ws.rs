//! WebSockets over any connection `Net` gives (Tor design §2.1, §3 R1).

use crate::{BoxedIo, Iso, Net, NetError, Target};
use rustls::ClientConfig;
use std::sync::{Arc, LazyLock};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};

/// A WebSocket, whatever carries it.
pub type WsStream = WebSocketStream<MaybeTlsStream<BoxedIo>>;

/// Open the WebSocket at `url` (ws:// or wss://) through `net`, isolated by
/// `iso`.
///
/// `wss://` speaks TLS over the connection, checked against the web's roots
/// as before Tor; `ws://` does not, which is what a relay's onion address
/// needs (Tor already encrypts it end to end). The host goes to the
/// transport by name and is never resolved here. There is no permit here:
/// a WebSocket never goes direct unless the whole `Net` is in
/// `Mode::Direct`.
pub async fn ws_connect(net: &Net, url: &str, iso: &Iso) -> Result<WsStream, NetError> {
    let request = url.into_client_request().map_err(|_| NetError::BadUrl)?;
    let default_port = match request.uri().scheme_str() {
        Some("wss") => 443,
        Some("ws") => 80,
        _ => return Err(NetError::BadUrl),
    };
    let host = request
        .uri()
        .host()
        .filter(|host| !host.is_empty())
        .ok_or(NetError::BadUrl)?;
    // An IPv6 literal comes in brackets, which belong to the URL only.
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let target = Target::new(host, request.uri().port_u16().unwrap_or(default_port));

    let io = net.connect(&target, iso).await?;
    let tls = Connector::Rustls(Arc::clone(&TLS));
    let (ws, _) = tokio_tungstenite::client_async_tls_with_config(request, io, None, Some(tls))
        .await
        .map_err(|e| NetError::Handshake(handshake_reason(&e)))?;
    Ok(ws)
}

/// The TLS of wss://: the web's roots (webpki-roots, as tokio-tungstenite
/// used before Tor), TLS 1.2 and 1.3, with ring as the provider, so it does
/// not depend on which provider the rest of the process installs or
/// enables.
static TLS: LazyLock<Arc<ClientConfig>> = LazyLock::new(|| {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config =
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports the default TLS versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
    Arc::new(config)
});

/// A short reason for a failed handshake: never the URL, nor what the
/// server said.
fn handshake_reason(error: &WsError) -> &'static str {
    match error {
        WsError::Tls(_) => "tls",
        WsError::Io(_) | WsError::ConnectionClosed | WsError::AlreadyClosed => "closed",
        WsError::Http(_) | WsError::HttpFormat(_) => "http",
        _ => "protocol",
    }
}
