//! The engine as a host holds it: the session's state and what goes with
//! it. The desktop app keeps one in its `AppState`, beside what only the
//! desktop has (the updater).

use crate::state::InnerState;
use crate::turn::TurnGate;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tokio::sync::Mutex;
use trino_net::Net;

#[derive(Default)]
pub struct Engine {
    pub inner: Arc<Mutex<InnerState>>,
    /// Set by the frontend while a call holds the microphone or camera. Read
    /// when the window is closed or the app quits, without taking `inner`.
    pub call_active: Arc<AtomicBool>,
    /// Held for the whole of `forge`, `unseal`, `lock_vault` and `wipe`, so
    /// one of them at a time creates, opens, closes or deletes the identity.
    /// Kept apart from `inner` because they hold it across the slow key
    /// derivation, which must not stall everything else.
    pub session_gate: Mutex<()>,
    /// Ties the requests for TURN credentials to the unlocked session; it
    /// keeps none (see turn.rs).
    pub turn: TurnGate,
    /// Windows was locked during a call: Trino locks when the call ends
    /// (cifrado local CL-6a, design §7.2). Cleared by every lock.
    pub lock_after_call: Arc<AtomicBool>,
    /// Every connection of the app goes through it (Tor design §2): Tor,
    /// started and stopped with the app, and the two permits to go without
    /// it. `Engine::default()` has none, so tests never start Arti; the
    /// app's own comes from `Engine::with_net` with Arti.
    pub net: Arc<Net>,
}

impl Engine {
    /// The network time as this engine's connections saw it (P1 §3.5).
    pub fn net_clock(&self) -> crate::mailboxes::clock::NetClock {
        crate::mailboxes::clock::NetClock::of_net(&self.net)
    }

    /// An engine whose connections go through `net`; nothing else differs
    /// from `Engine::default()`.
    pub fn with_net(net: Arc<Net>) -> Self {
        Engine {
            net,
            ..Engine::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    #[test]
    fn with_net_takes_that_net_and_starts_as_the_default_does() {
        let net = Arc::new(Net::default());
        let engine = Engine::with_net(Arc::clone(&net));
        assert!(Arc::ptr_eq(&engine.net, &net), "another net");
        assert!(!engine.call_active.load(Ordering::SeqCst));
        assert!(!engine.lock_after_call.load(Ordering::SeqCst));
        let inner = engine.inner.try_lock().expect("nothing holds it");
        assert!(inner.identity.is_none(), "a session open from the start");
        assert!(engine.session_gate.try_lock().is_ok());
    }
}
