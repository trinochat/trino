//! Relays that also have an onion address (Tor design §3 R1 and N7).
//!
//! With Tor, a relay with an onion is tried there first: the connection
//! never leaves Tor, so no exit and no Cloudflare in front of the relay
//! see it. If the onion fails, the relay's domain is tried through a Tor
//! exit. Never direct.

use crate::{ws_connect, Iso, Mode, Net, NetError, WsStream};
use std::time::Duration;

/// How long the onion of a relay gets before its domain is tried (§3.1):
/// an onion circuit takes longer than an exit's.
pub const ONION_DEADLINE: Duration = Duration::from_secs(45);

/// Each relay and its onion, as `ws://` (Tor already encrypts it end to
/// end).
///
/// - relay.trinochat.org: Trino's own relay, whose onion was deployed on
///   10 Oct 2026 (trino-infra docs/spec.md §5).
/// - nostr.oxtr.dev: the onion its web server announces in
///   `Onion-Location` (9 Oct 2026). Through Tor exits its domain answered
///   4 times in 15 (spike S6) and 1 in 3 on 29 Oct, so it is worth it by
///   its onion: on 29 Oct the onion connected 4 times in 4 and passed the
///   whole P1 battery of the relay spike (`spike-relays.md`, third part).
///   It is a default relay since then (decision 13 as of 29 Oct); if the
///   onion fails, its domain is tried through Tor.
const ONIONS: &[(&str, &str)] = &[
    (
        "wss://relay.trinochat.org",
        "ws://fpptihzvmwl5scdbd5xdk6utq6dwyucf3z4ctkso3cftjovtyazc6cad.onion",
    ),
    (
        "wss://nostr.oxtr.dev",
        "ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion",
    ),
];

/// The onion of the relay at `url`, if it has one.
pub fn onion_of(url: &str) -> Option<&'static str> {
    let url = url.trim_end_matches('/');
    ONIONS
        .iter()
        .find(|(relay, _)| relay.eq_ignore_ascii_case(url))
        .map(|(_, onion)| *onion)
}

/// The longest a relay's connection may take: its onion's deadline first,
/// if it has one, then `deadline` for its domain.
pub fn relay_deadline(url: &str, deadline: Duration) -> Duration {
    match onion_of(url) {
        Some(_) => ONION_DEADLINE + deadline,
        None => deadline,
    }
}

/// The relay's WebSocket: its onion first, within `onion_deadline`, when
/// it has one and the `Net` goes through Tor; then its domain, through the
/// same `Net` (so through Tor), on the same token.
pub async fn ws_connect_relay(
    net: &Net,
    url: &str,
    iso: &Iso,
    onion_deadline: Duration,
) -> Result<WsStream, NetError> {
    if let (Some(onion), Mode::Tor) = (onion_of(url), net.mode()) {
        if let Ok(Ok(ws)) = tokio::time::timeout(onion_deadline, ws_connect(net, onion, iso)).await
        {
            return Ok(ws);
        }
    }
    ws_connect(net, url, iso).await
}
