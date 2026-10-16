//! The engine's events through Tauri (M4-0b): the app's `EventSink` sends
//! each one to the window as its `emit` did before the sink, under the same
//! name and as the same JSON (`trino_engine::events`).

use std::sync::Arc;
use tauri::{AppHandle, Emitter};
pub(crate) use trino_engine::events::EventSink;

/// The window's side of the engine's events.
pub(crate) struct TauriEvents(pub(crate) AppHandle);

impl EventSink for TauriEvents {
    fn emit_json(&self, name: &str, payload: String) {
        // `emit` would serialize the payload with serde_json::to_string;
        // the engine did, so the text goes as it is.
        let _ = self.0.emit_str(name, payload);
    }
}

/// The engine's events for `app`'s window, as the session's tasks share
/// them.
pub(crate) fn sink(app: AppHandle) -> Arc<dyn EventSink> {
    Arc::new(TauriEvents(app))
}

#[cfg(test)]
mod tests {
    /// Whether the code of `source`, its tests apart, sends its events only
    /// through an `EventSink`: no Tauri `Emitter`, and every `.emit(` an
    /// `events.emit(`.
    fn emits_only_through_the_sink(source: &str) -> bool {
        let source = source.replace("\r\n", "\n");
        let code = match source.find("\n#[cfg(test)]\nmod tests") {
            Some(tests) => &source[..tests],
            None => &source[..],
        };
        !code.contains("Emitter")
            && code.matches(".emit(").count() == code.matches("events.emit(").count()
    }

    /// M4-0b: the engine's side of the app (the session and what it
    /// receives, the profiles, the call log, the network's state) tells
    /// the UI through the engine's `EventSink`, never through Tauri, so it
    /// can move into the engine (M4-0c) as it is.
    #[test]
    fn the_engines_side_of_the_app_emits_only_through_the_sink() {
        for (name, source) in [
            ("commands.rs", include_str!("commands.rs")),
            ("profile.rs", include_str!("profile.rs")),
            ("call_log.rs", include_str!("call_log.rs")),
            ("net_cmds.rs", include_str!("net_cmds.rs")),
            ("contacts_cmds.rs", include_str!("contacts_cmds.rs")),
            ("groups_cmds.rs", include_str!("groups_cmds.rs")),
            ("history_cmds.rs", include_str!("history_cmds.rs")),
        ] {
            assert!(
                emits_only_through_the_sink(source),
                "{name} emits through Tauri"
            );
        }
    }

    #[test]
    fn the_check_sees_an_emit_through_tauri() {
        let sink = "fn f(events: &dyn EventSink) {\n    events.emit(\"a\", &1);\n}\n";
        assert!(emits_only_through_the_sink(sink));
        let tauri =
            "use tauri::Emitter;\nfn f(app: AppHandle) {\n    let _ = app.emit(\"a\", 1);\n}\n";
        assert!(!emits_only_through_the_sink(tauri));
        let unnamed = "fn f(app: &tauri::AppHandle) {\n    let _ = app.emit(\"a\", 1);\n}\n";
        assert!(!emits_only_through_the_sink(unnamed));
        let in_tests = format!("{sink}\n#[cfg(test)]\nmod tests {{\n    use tauri::Emitter;\n}}\n");
        assert!(emits_only_through_the_sink(&in_tests));
    }
}
