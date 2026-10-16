//! Where the engine's events go (M4-0b): what the UI hears without asking,
//! such as a message received, a relay that came up or a contact whose
//! session needs a new handshake.
//!
//! The engine names an event and gives its payload; an `EventSink` takes
//! them to the UI. The desktop app's sends them to its window through
//! Tauri (src-tauri/src/events.rs), the mobile apps' will through FFI, and
//! tests record them (`RecordingSink`). Every name and payload is the one
//! the desktop app emitted before the sink: the frontend does not change.

use serde::Serialize;

/// Takes the engine's events to the UI.
pub trait EventSink: Send + Sync {
    /// Send the event `name` with `payload`, its JSON as
    /// `serde_json::to_string` writes it: the text Tauri's `emit` sent for
    /// the same value (its `EmitArgs::new`).
    fn emit_json(&self, name: &str, payload: String);
}

impl<'a> dyn EventSink + 'a {
    /// Send `payload` as the event `name`. A payload that does not
    /// serialize sends nothing, as Tauri's `emit` sent nothing for it.
    ///
    /// Through `serde_json::to_string`, never a `serde_json::Value`: the
    /// fields go in the order the payload has them, as they did.
    pub fn emit<T: Serialize + ?Sized>(&self, name: &str, payload: &T) {
        if let Ok(json) = serde_json::to_string(payload) {
            self.emit_json(name, json);
        }
    }
}

/// A sink that keeps every event it gets, in order, for tests.
#[cfg(any(test, feature = "test-util"))]
#[derive(Default)]
pub struct RecordingSink {
    events: std::sync::Mutex<Vec<(String, String)>>,
}

#[cfg(any(test, feature = "test-util"))]
impl RecordingSink {
    /// A new sink, shared as the engine holds one.
    pub fn new() -> std::sync::Arc<RecordingSink> {
        std::sync::Arc::default()
    }

    /// The events so far, each its name and its JSON, oldest first.
    pub fn events(&self) -> Vec<(String, String)> {
        self.events.lock().unwrap().clone()
    }

    /// The names of the events so far, oldest first.
    pub fn names(&self) -> Vec<String> {
        self.events().into_iter().map(|(name, _)| name).collect()
    }
}

#[cfg(any(test, feature = "test-util"))]
impl EventSink for RecordingSink {
    fn emit_json(&self, name: &str, payload: String) {
        self.events
            .lock()
            .unwrap()
            .push((name.to_string(), payload));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Its fields in an order that is not the alphabet's.
    #[derive(Serialize)]
    struct Payload {
        from_handle: String,
        text: String,
        timestamp: i64,
        avatar: Option<String>,
    }

    fn payload() -> Payload {
        Payload {
            from_handle: "ana".to_string(),
            text: "hola \"tú\"".to_string(),
            timestamp: 1_760_000_000,
            avatar: None,
        }
    }

    #[test]
    fn an_event_goes_out_as_the_json_tauri_sent_for_it() {
        let recording = RecordingSink::new();
        let sink: Arc<dyn EventSink> = recording.clone();

        sink.emit("message-received", &payload());

        let expected = serde_json::to_string(&payload()).unwrap();
        assert_eq!(
            expected,
            r#"{"from_handle":"ana","text":"hola \"tú\"","timestamp":1760000000,"avatar":null}"#
        );
        assert_eq!(
            recording.events(),
            [("message-received".to_string(), expected)]
        );
    }

    #[test]
    fn plain_values_go_out_as_they_did() {
        let recording = RecordingSink::new();
        let sink: &dyn EventSink = &*recording;

        sink.emit("resync-needed", &"ana".to_string());
        sink.emit("call-quit-requested", &());
        sink.emit("count", &3_usize);

        assert_eq!(
            recording.events(),
            [
                ("resync-needed".to_string(), r#""ana""#.to_string()),
                ("call-quit-requested".to_string(), "null".to_string()),
                ("count".to_string(), "3".to_string()),
            ]
        );
    }

    #[test]
    fn a_payload_that_does_not_serialize_sends_nothing() {
        // A map whose keys are not strings does not make JSON.
        let refused: std::collections::HashMap<(u8, u8), u8> = [((1, 2), 3)].into();
        let recording = RecordingSink::new();
        let sink: &dyn EventSink = &*recording;

        sink.emit("refused", &refused);
        sink.emit("after", &1_u8);

        assert_eq!(recording.names(), ["after"]);
    }
}
