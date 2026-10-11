//! The real state of the relay connections (K3): how many relays are up, as
//! the `connection_status` command and the `connection-changed` event.
//!
//! The inbox used to say "connected" whatever happened, and a relay that
//! failed its first connection was never tried again. Now each client keeps
//! trying (nostr.rs) and knows whether its socket is up
//! (`NostrClient::is_connected`, set by its connection task); this module
//! counts them.

use crate::command_error::CommandError;
use crate::nostr::NostrClient;
use crate::state::AppState;
use serde::Serialize;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::sync::mpsc;

/// What the frontend listens to (`onConnectionChanged`, src/lib/api.ts).
pub const CONNECTION_CHANGED_EVENT: &str = "connection-changed";

/// Changes closer together than this go out as one event: three relays
/// coming up at unlock are one change for the UI, not three.
pub const DEBOUNCE: Duration = Duration::from_millis(500);

/// One relay of the session, and whether its socket is up.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RelayStatus {
    pub url: String,
    pub connected: bool,
}

/// How many of the session's relays are up (`ConnectionStatus`,
/// src/lib/api.ts).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ConnectionStatus {
    pub up: usize,
    pub total: usize,
    pub relays: Vec<RelayStatus>,
}

impl ConnectionStatus {
    /// The status of `clients`, in their order. A locked session has none:
    /// 0 of 0.
    pub fn of(clients: &[Arc<NostrClient>]) -> Self {
        let relays: Vec<RelayStatus> = clients
            .iter()
            .map(|client| RelayStatus {
                url: client.url().to_string(),
                connected: client.is_connected(),
            })
            .collect();
        ConnectionStatus {
            up: relays.iter().filter(|relay| relay.connected).count(),
            total: relays.len(),
            relays,
        }
    }
}

/// Runs `emit` once at the end of every window that saw a change (`poke`),
/// so a burst of changes goes out as one event. The first change after a
/// quiet spell opens the window, so a relay that keeps flapping still gets
/// one event per window; `emit` reads the state when the window closes.
/// Stops once every `Debouncer` handle is dropped.
pub struct Debouncer {
    pokes: mpsc::UnboundedSender<()>,
}

impl Debouncer {
    pub fn spawn<F, Fut>(window: Duration, emit: F) -> Self
    where
        F: Fn() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (pokes, mut changes) = mpsc::unbounded_channel::<()>();
        tokio::spawn(async move {
            while changes.recv().await.is_some() {
                tokio::time::sleep(window).await;
                // The changes of this window go out together.
                while changes.try_recv().is_ok() {}
                emit().await;
            }
        });
        Debouncer { pokes }
    }

    /// Something changed.
    pub fn poke(&self) {
        let _ = self.pokes.send(());
    }
}

/// How many relays are up right now (K3). A locked session has none.
#[tauri::command]
pub async fn connection_status(
    state: State<'_, AppState>,
) -> Result<ConnectionStatus, CommandError> {
    Ok(ConnectionStatus::of(&state.inner.lock().await.relays))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nostr::test_relay::{unreachable_client, wait_until, Answer, TestRelay};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn the_status_counts_the_relays_that_are_up() {
        let relay = TestRelay::start(Answer::Accept).await;
        let up = relay.client().await;
        let down = unreachable_client(Arc::default());

        let status = ConnectionStatus::of(&[up.clone(), down.clone()]);

        assert_eq!(
            status,
            ConnectionStatus {
                up: 1,
                total: 2,
                relays: vec![
                    RelayStatus {
                        url: relay.url.clone(),
                        connected: true,
                    },
                    RelayStatus {
                        url: "ws://127.0.0.1:9".to_string(),
                        connected: false,
                    },
                ],
            }
        );
        // Locked: no relays at all.
        assert_eq!(
            ConnectionStatus::of(&[]),
            ConnectionStatus {
                up: 0,
                total: 0,
                relays: vec![],
            }
        );
        up.close();
        down.close();
    }

    #[test]
    fn the_ui_receives_the_status_in_the_contract_shape() {
        // `ConnectionStatus` in src/lib/api.ts.
        let status = ConnectionStatus {
            up: 1,
            total: 2,
            relays: vec![
                RelayStatus {
                    url: "wss://relay.damus.io".to_string(),
                    connected: true,
                },
                RelayStatus {
                    url: "wss://nos.lol".to_string(),
                    connected: false,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "up": 1,
                "total": 2,
                "relays": [
                    { "url": "wss://relay.damus.io", "connected": true },
                    { "url": "wss://nos.lol", "connected": false },
                ],
            })
        );
        assert_eq!(CONNECTION_CHANGED_EVENT, "connection-changed");
    }

    fn counting(emitted: &Arc<AtomicUsize>) -> impl Fn() -> std::future::Ready<()> {
        let emitted = Arc::clone(emitted);
        move || {
            emitted.fetch_add(1, Ordering::SeqCst);
            std::future::ready(())
        }
    }

    #[tokio::test]
    async fn changes_close_together_go_out_as_one_event() {
        let emitted = Arc::new(AtomicUsize::new(0));
        let changes = Debouncer::spawn(Duration::from_millis(50), counting(&emitted));

        // Three relays connecting at once, say.
        for _ in 0..5 {
            changes.poke();
        }

        wait_until("the event", || emitted.load(Ordering::SeqCst) == 1).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), 1, "a burst is one event");

        changes.poke();
        wait_until("the next event", || emitted.load(Ordering::SeqCst) == 2).await;
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(emitted.load(Ordering::SeqCst), 2, "no change, no event");
    }

    #[tokio::test]
    async fn the_event_waits_for_the_window_to_close() {
        let emitted = Arc::new(AtomicUsize::new(0));
        let changes = Debouncer::spawn(Duration::from_millis(400), counting(&emitted));

        changes.poke();
        tokio::time::sleep(Duration::from_millis(50)).await;

        assert_eq!(
            emitted.load(Ordering::SeqCst),
            0,
            "sent before the window closed"
        );
        wait_until("the event", || emitted.load(Ordering::SeqCst) == 1).await;
    }

    #[test]
    fn the_window_is_half_a_second() {
        assert_eq!(DEBOUNCE, Duration::from_millis(500));
    }
}
