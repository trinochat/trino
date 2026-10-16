use crate::updater::Updater;
use std::sync::Arc;
use trino_engine::Engine;

// The session's state, the data folder and the session's records live in
// the engine (M4-0), under the same paths as before: `crate::state::
// InnerState`, `crate::state::trino_home`, `HistItem`…
pub use trino_engine::state::*;

/// What Tauri manages: the engine, and what only the desktop app has.
#[derive(Default)]
pub struct AppState {
    /// The session's state and what goes with it (`inner`, `call_active`,
    /// `session_gate`, `turn`, `lock_after_call`, `net`), read through
    /// `AppState` as before (`Deref`).
    pub engine: Engine,
    /// Trino's own updater (Tor design §6, updater.rs): the daily check,
    /// the verified installer held until the yes, and installing it.
    pub updater: Arc<Updater>,
}

/// `state.inner`, `state.net` and the rest of the engine's fields read as
/// they did when they were AppState's own.
impl std::ops::Deref for AppState {
    type Target = Engine;

    fn deref(&self) -> &Engine {
        &self.engine
    }
}

impl AppState {
    /// The app's state, with Tor (Arti) keeping its files in `tor_home()`
    /// and lyrebird as its bridge program.
    /// It starts nothing: `net_cmds::on_open` does, as decided.
    pub fn with_tor() -> Self {
        AppState {
            engine: Engine::with_net(trino_net::Net::with_arti(trino_net::NetConfig {
                tor_home: tor_home(),
                // lyrebird next to TrinoChat.exe, with its pinned SHA-256
                // (TOR-7); none in a build that does not ship it.
                pt: crate::commands::bridges_cmds::lyrebird(),
            })),
            ..AppState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands read `state.inner`, `state.net`… as AppState's own
    /// fields; since M4-0 they are its engine's.
    #[test]
    fn the_state_reads_through_to_its_engine() {
        let state = AppState::default();
        assert!(Arc::ptr_eq(&state.inner, &state.engine.inner));
        assert!(Arc::ptr_eq(&state.net, &state.engine.net));
        assert!(Arc::ptr_eq(&state.call_active, &state.engine.call_active));
        assert!(Arc::ptr_eq(
            &state.lock_after_call,
            &state.engine.lock_after_call
        ));
        assert!(std::ptr::eq(&state.turn, &state.engine.turn));
        assert!(std::ptr::eq(
            &state.session_gate,
            &state.engine.session_gate
        ));
    }
}
