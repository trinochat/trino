//! The call log (K13).
//!
//! A call that ended is a `HistItem` of its contact's chat: in history.bin,
//! encrypted with the identity's history key like every message, and in the
//! chat at the time it started, so it sits before what was written during
//! it. It counts toward the chat's `HISTORY_CAP`, goes with the chat's
//! disappearing messages (`ttl`, `prune_expired`), and moves or goes with the
//! contact on rename and remove, as the rest of the chat does. Nothing is
//! sent to the contact: each side keeps its own view.

use crate::command_error::{CommandError, ErrorCode};
use crate::state::{AppState, HistItem, InnerState};
use serde::Serialize;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, State};
use thiserror::Error;

// The calls themselves, as the chat history keeps them, are the engine's
// (M4-0): `HistItem` holds them.
pub use trino_engine::call_log::{CallDirection, CallEvent, CallOutcome};

/// One call of the log: the contact, and when the call started.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CallLogEntry {
    pub peer: String,
    pub ts: i64,
    pub call: CallEvent,
}

/// What the frontend listens to (`onCallLogged`, src/lib/api.ts).
pub const CALL_LOGGED_EVENT: &str = "call-logged";
/// How many calls the log answers with, when not asked for a number.
pub const DEFAULT_LIMIT: usize = 200;
/// The most calls the log answers with.
pub const MAX_LIMIT: usize = 500;
/// A call lasts a day at most.
const MAX_DURATION_SECS: u32 = 86_400;
/// The longest disappearing-message timer is a year.
const MAX_TTL_SECS: i64 = 31_536_000;
/// A call is recorded when it ends, so it started in the past: within a
/// week, and no more than five minutes ahead of this clock.
const OLDEST_START_SECS: i64 = 7 * 86_400;
const NEWEST_START_SECS: i64 = 300;

/// Why a call cannot be recorded: the caller's mistake, or a chat that
/// cannot keep it.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum InvalidCall {
    #[error("the call id must be 16 to 64 letters, digits, '-' or '_'")]
    Id,
    #[error("only an answered call lasts, and no more than a day")]
    Duration,
    #[error("the call must have started within the last week")]
    StartedAt,
    #[error("the ttl must be 1 s to a year")]
    Ttl,
    /// The chat holds `HISTORY_CAP` items, all newer than the call: the
    /// cap would drop it as soon as it went in.
    #[error("the chat keeps only messages newer than the call")]
    OlderThanTheChat,
}

/// Check a call before it is recorded. The id follows the rule of the call
/// signals (trino-core `call_signal.rs`), where it comes from.
pub fn validate(call: &CallEvent, started_at: i64, now: i64) -> Result<(), InvalidCall> {
    let id_ok = (16..=64).contains(&call.id.len())
        && call
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !id_ok {
        return Err(InvalidCall::Id);
    }
    let answered = call.outcome == CallOutcome::Answered;
    if call.duration_sec > MAX_DURATION_SECS || (!answered && call.duration_sec != 0) {
        return Err(InvalidCall::Duration);
    }
    if !(now - OLDEST_START_SECS..=now + NEWEST_START_SECS).contains(&started_at) {
        return Err(InvalidCall::StartedAt);
    }
    if call
        .ttl
        .is_some_and(|ttl| !(1..=MAX_TTL_SECS).contains(&ttl))
    {
        return Err(InvalidCall::Ttl);
    }
    Ok(())
}

/// What `record` did with a call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recorded {
    /// It is in the chat now.
    New(CallLogEntry),
    /// The chat had it already, with this id: recording is idempotent.
    Existing(CallLogEntry),
}

impl Recorded {
    pub fn entry(self) -> CallLogEntry {
        match self {
            Recorded::New(entry) | Recorded::Existing(entry) => entry,
        }
    }
}

/// Put `call`, started at `started_at`, into `peer`'s chat in `inner`, in
/// order of time, and save the history (encrypted). The same id twice
/// answers with the call already there and changes nothing. A call older
/// than everything a full chat keeps is refused (`OlderThanTheChat`), and
/// nothing changes: the cap would drop it at once.
pub fn record(
    inner: &mut InnerState,
    peer: &str,
    call: CallEvent,
    started_at: i64,
    now: i64,
) -> Result<Recorded, CommandError> {
    if inner.identity.is_none() {
        return Err(CommandError::new(ErrorCode::NoVault, "the vault is locked"));
    }
    // A contact's chat only: a contact named like a group's history key
    // ("grp:<gid>") would otherwise put a call in that group.
    if !inner.friends.contains_key(peer) || peer.starts_with("grp:") {
        return Err(CommandError::internal("unknown contact"));
    }
    validate(&call, started_at, now).map_err(|e| CommandError::internal(e.to_string()))?;
    let items = inner.history.entry(peer.to_string()).or_default();
    if let Some(existing) = items.iter().find(|item| {
        item.call
            .as_ref()
            .is_some_and(|recorded| recorded.id == call.id)
    }) {
        return Ok(Recorded::Existing(log_entry(peer, existing)));
    }
    let item = HistItem {
        side: match call.direction {
            CallDirection::Outgoing => "me",
            CallDirection::Incoming => "them",
        }
        .to_string(),
        from: None,
        text: None,
        file: None,
        call: Some(call),
        ts: started_at,
    };
    let entry = log_entry(peer, &item);
    // After whatever has the same time: messages written during the call
    // come after it.
    let at = items.partition_point(|other| other.ts <= started_at);
    // The cap then drops the oldest: those before index `dropped`.
    let dropped = (items.len() + 1).saturating_sub(crate::commands::HISTORY_CAP);
    if at < dropped {
        let older = InvalidCall::OlderThanTheChat;
        return Err(CommandError::internal(older.to_string()));
    }
    items.insert(at, item);
    if items.len() > crate::commands::HISTORY_CAP {
        let excess = items.len() - crate::commands::HISTORY_CAP;
        items.drain(0..excess);
    }
    crate::commands::save_history(inner);
    Ok(Recorded::New(entry))
}

fn log_entry(peer: &str, item: &HistItem) -> CallLogEntry {
    CallLogEntry {
        peer: peer.to_string(),
        ts: item.ts,
        call: item.call.clone().expect("a call item"),
    }
}

/// The calls in every contact's chat, newest first: `limit` of them, 200
/// when not given, never more than 500. Groups have no calls.
pub fn list(history: &HashMap<String, Vec<HistItem>>, limit: Option<u32>) -> Vec<CallLogEntry> {
    let limit = limit.map_or(DEFAULT_LIMIT, |n| (n as usize).min(MAX_LIMIT));
    let mut calls: Vec<CallLogEntry> = history
        .iter()
        .filter(|(convo, _)| !convo.starts_with("grp:"))
        .flat_map(|(peer, items)| {
            items
                .iter()
                .filter(|item| item.call.is_some())
                .map(move |item| log_entry(peer, item))
        })
        .collect();
    // Newest first; the id settles calls that started together.
    calls.sort_by(|a, b| b.ts.cmp(&a.ts).then_with(|| b.call.id.cmp(&a.call.id)));
    calls.truncate(limit);
    calls
}

/// Whether `item` is a call whose disappearing-message timer has run out
/// at `now` (`prune_expired`). Other items are never expired here.
pub fn expired(item: &HistItem, now: i64) -> bool {
    item.call
        .as_ref()
        .and_then(|call| call.ttl)
        .is_some_and(|ttl| item.ts + ttl <= now)
}

/// Record a call that ended in its contact's chat, at the time it started
/// (epoch seconds), and answer with the log entry (K13). A new call is also
/// sent to the UI as `call-logged`; the same `id` again answers with the
/// call already recorded. Invalid input is `internal`, and so is a call
/// older than everything its full chat keeps: then nothing is stored and
/// no `call-logged` goes out.
#[tauri::command]
pub async fn record_call(
    app: AppHandle,
    state: State<'_, AppState>,
    peer: String,
    call: CallEvent,
    started_at: i64,
) -> Result<CallLogEntry, CommandError> {
    let now = chrono::Utc::now().timestamp();
    let recorded = record(&mut *state.inner.lock().await, &peer, call, started_at, now)?;
    if let Recorded::New(entry) = &recorded {
        let _ = app.emit(CALL_LOGGED_EVENT, entry);
    }
    Ok(recorded.entry())
}

/// The calls of every chat, newest first; 200 when `limit` is left out, 500
/// at most (K13).
#[tauri::command]
pub async fn list_call_history(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<CallLogEntry>, CommandError> {
    let inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(CommandError::new(ErrorCode::NoVault, "the vault is locked"));
    }
    Ok(list(&inner.history, limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::identity::{create_identity, public_bundle_for};
    use crate::state::{FriendRecord, HistItem, InnerState};
    use serde::Deserialize;
    use serde_json::json;

    const NOW: i64 = 1_760_000_000;
    const ID: &str = "0123456789abcdef0123456789abcdef";

    fn call(id: &str, outcome: CallOutcome, duration_sec: u32) -> CallEvent {
        CallEvent {
            id: id.to_string(),
            direction: CallDirection::Outgoing,
            video: false,
            outcome,
            duration_sec,
            ttl: None,
        }
    }

    fn missed(id: &str) -> CallEvent {
        CallEvent {
            direction: CallDirection::Incoming,
            ..call(id, CallOutcome::Missed, 0)
        }
    }

    fn text(ts: i64, body: &str) -> HistItem {
        HistItem {
            side: "me".to_string(),
            from: None,
            text: Some(body.to_string()),
            file: None,
            call: None,
            ts,
        }
    }

    /// An unlocked session with the contacts `handles`.
    fn session_with(handles: &[&str]) -> InnerState {
        let mut inner = InnerState {
            identity: Some(create_identity()),
            ..InnerState::default()
        };
        for handle in handles {
            inner.friends.insert(
                handle.to_string(),
                FriendRecord {
                    handle: handle.to_string(),
                    bundle: public_bundle_for(&create_identity()),
                    added_at: 0,
                    avatar: None,
                    previous_fingerprint: None,
                    key_changed_at: None,
                    via_group: None,
                },
            );
        }
        inner
    }

    fn calls_of(items: &[HistItem]) -> Vec<&str> {
        items
            .iter()
            .filter_map(|item| item.call.as_ref().map(|call| call.id.as_str()))
            .collect()
    }

    // ---- validation ----

    #[test]
    fn a_valid_call_passes() {
        let answered = call(ID, CallOutcome::Answered, 754);
        assert_eq!(validate(&answered, NOW - 754, NOW), Ok(()));
        let with_ttl = CallEvent {
            ttl: Some(3_600),
            ..missed(&"a".repeat(64))
        };
        assert_eq!(validate(&with_ttl, NOW, NOW), Ok(()));
        // An answered call can last no time at all.
        assert_eq!(
            validate(
                &call("A-b_c-D".repeat(3).as_str(), CallOutcome::Answered, 0),
                NOW,
                NOW
            ),
            Ok(())
        );
    }

    #[test]
    fn the_id_is_16_to_64_letters_digits_dashes_or_underscores() {
        for bad in [
            "0123456789abcde".to_string(), // 15
            "a".repeat(65),
            "0123456789abcdef 0".to_string(),
            "0123456789abcdef/0".to_string(),
            "0123456789abcdefñ".to_string(),
            String::new(),
        ] {
            assert_eq!(
                validate(&missed(&bad), NOW, NOW),
                Err(InvalidCall::Id),
                "{bad:?}"
            );
        }
        assert_eq!(validate(&missed(&"0".repeat(16)), NOW, NOW), Ok(()));
    }

    #[test]
    fn only_an_answered_call_has_a_duration_and_never_more_than_a_day() {
        for outcome in [
            CallOutcome::Missed,
            CallOutcome::Declined,
            CallOutcome::Unanswered,
            CallOutcome::Cancelled,
            CallOutcome::Failed,
        ] {
            assert_eq!(
                validate(&call(ID, outcome, 1), NOW, NOW),
                Err(InvalidCall::Duration),
                "{outcome:?}"
            );
            assert_eq!(validate(&call(ID, outcome, 0), NOW, NOW), Ok(()));
        }
        assert_eq!(
            validate(&call(ID, CallOutcome::Answered, 86_400), NOW, NOW),
            Ok(())
        );
        assert_eq!(
            validate(&call(ID, CallOutcome::Answered, 86_401), NOW, NOW),
            Err(InvalidCall::Duration)
        );
    }

    #[test]
    fn a_call_started_between_a_week_ago_and_five_minutes_ahead() {
        let week = 7 * 86_400;
        assert_eq!(validate(&missed(ID), NOW - week, NOW), Ok(()));
        assert_eq!(validate(&missed(ID), NOW + 300, NOW), Ok(()));
        assert_eq!(
            validate(&missed(ID), NOW - week - 1, NOW),
            Err(InvalidCall::StartedAt)
        );
        assert_eq!(
            validate(&missed(ID), NOW + 301, NOW),
            Err(InvalidCall::StartedAt)
        );
    }

    #[test]
    fn the_ttl_is_one_second_to_one_year() {
        for (ttl, expected) in [
            (1, Ok(())),
            (31_536_000, Ok(())),
            (0, Err(InvalidCall::Ttl)),
            (-5, Err(InvalidCall::Ttl)),
            (31_536_001, Err(InvalidCall::Ttl)),
        ] {
            let with_ttl = CallEvent {
                ttl: Some(ttl),
                ..missed(ID)
            };
            assert_eq!(validate(&with_ttl, NOW, NOW), expected, "{ttl}");
        }
    }

    // ---- recording ----

    #[test]
    fn a_call_goes_into_its_contacts_chat_by_when_it_started() {
        let mut inner = session_with(&["ana"]);
        inner.history.insert(
            "ana".to_string(),
            vec![text(NOW - 600, "antes"), text(NOW - 100, "durante")],
        );

        let entry = record(
            &mut inner,
            "ana",
            call(ID, CallOutcome::Answered, 300),
            NOW - 400,
            NOW,
        )
        .unwrap()
        .entry();

        assert_eq!(
            entry,
            CallLogEntry {
                peer: "ana".to_string(),
                ts: NOW - 400,
                call: call(ID, CallOutcome::Answered, 300),
            }
        );
        let chat = &inner.history["ana"];
        assert_eq!(chat.len(), 3);
        // Started before what was written during the call.
        assert_eq!(chat[1].ts, NOW - 400);
        assert_eq!(calls_of(chat), [ID]);
        assert_eq!(chat[1].side, "me", "an outgoing call is ours");
        assert!(chat[1].text.is_none() && chat[1].file.is_none());
    }

    #[test]
    fn an_incoming_call_is_on_the_contacts_side() {
        let mut inner = session_with(&["ana"]);
        record(&mut inner, "ana", missed(ID), NOW, NOW).unwrap();
        assert_eq!(inner.history["ana"][0].side, "them");
    }

    #[test]
    fn the_same_call_twice_is_recorded_once() {
        let mut inner = session_with(&["ana"]);
        let first = record(&mut inner, "ana", missed(ID), NOW - 30, NOW).unwrap();
        // A retry, even with other details, answers with what is there.
        let again = record(
            &mut inner,
            "ana",
            call(ID, CallOutcome::Declined, 0),
            NOW,
            NOW,
        )
        .unwrap();

        assert!(matches!(first, Recorded::New(_)));
        assert!(matches!(again, Recorded::Existing(_)));
        assert_eq!(again.entry(), first.entry());
        assert_eq!(inner.history["ana"].len(), 1);
    }

    #[test]
    fn calls_count_toward_the_history_cap_of_their_chat() {
        let mut inner = session_with(&["ana"]);
        let full: Vec<HistItem> = (0..crate::commands::HISTORY_CAP as i64)
            .map(|n| text(NOW - 1_000 + n, "x"))
            .collect();
        inner.history.insert("ana".to_string(), full);

        record(&mut inner, "ana", missed(ID), NOW, NOW).unwrap();

        let chat = &inner.history["ana"];
        assert_eq!(chat.len(), crate::commands::HISTORY_CAP);
        assert_eq!(calls_of(chat), [ID]);
        assert_eq!(chat[0].ts, NOW - 999, "the oldest message made room");
    }

    #[test]
    fn a_call_older_than_all_a_full_chat_keeps_is_not_recorded() {
        // The cap would drop it at once, while the UI heard it was logged.
        let mut inner = session_with(&["ana"]);
        let full: Vec<HistItem> = (0..crate::commands::HISTORY_CAP as i64)
            .map(|n| text(NOW - 500 + n, "x"))
            .collect();
        inner.history.insert("ana".to_string(), full);

        let first = record(&mut inner, "ana", missed(ID), NOW - 3_600, NOW).unwrap_err();
        let again = record(&mut inner, "ana", missed(ID), NOW - 3_600, NOW).unwrap_err();

        assert_eq!(first.code, ErrorCode::Internal);
        assert_eq!(first.message, InvalidCall::OlderThanTheChat.to_string());
        assert_eq!(again, first, "the same id answers the same");
        let chat = &inner.history["ana"];
        assert_eq!(chat.len(), crate::commands::HISTORY_CAP);
        assert!(calls_of(chat).is_empty());
        assert_eq!(chat[0].ts, NOW - 500, "a message made room for nothing");
    }

    #[test]
    fn a_call_is_only_recorded_for_a_contact_of_an_open_session() {
        let mut sealed = InnerState::default();
        let error = record(&mut sealed, "ana", missed(ID), NOW, NOW).unwrap_err();
        assert_eq!(error.code, ErrorCode::NoVault);

        let mut inner = session_with(&["ana"]);
        let unknown = record(&mut inner, "bob", missed(ID), NOW, NOW).unwrap_err();
        assert_eq!(unknown.code, ErrorCode::Internal);
        let invalid = record(&mut inner, "ana", missed("short"), NOW, NOW).unwrap_err();
        assert_eq!(invalid.code, ErrorCode::Internal);
        assert!(inner.history.is_empty(), "nothing was recorded");
    }

    #[test]
    fn a_call_never_lands_in_a_groups_history() {
        // A contact can be named like a group's history key.
        let mut inner = session_with(&["grp:abc"]);
        let error = record(&mut inner, "grp:abc", missed(ID), NOW, NOW).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        assert!(inner.history.is_empty());
    }

    // ---- the log ----

    fn history_with_calls() -> std::collections::HashMap<String, Vec<HistItem>> {
        let mut inner = session_with(&["ana", "bob"]);
        inner
            .history
            .insert("ana".to_string(), vec![text(NOW - 50, "hola")]);
        inner
            .history
            .insert("grp:g1".to_string(), vec![text(NOW - 10, "en el grupo")]);
        for (peer, id, started) in [
            ("ana", "a1aaaaaaaaaaaaaa", NOW - 300),
            ("bob", "b1bbbbbbbbbbbbbb", NOW - 200),
            ("ana", "a2aaaaaaaaaaaaaa", NOW - 100),
        ] {
            record(&mut inner, peer, missed(id), started, NOW).unwrap();
        }
        inner.history
    }

    #[test]
    fn the_log_lists_only_calls_newest_first() {
        let log = list(&history_with_calls(), None);

        let seen: Vec<(&str, &str, i64)> = log
            .iter()
            .map(|e| (e.peer.as_str(), e.call.id.as_str(), e.ts))
            .collect();
        assert_eq!(
            seen,
            [
                ("ana", "a2aaaaaaaaaaaaaa", NOW - 100),
                ("bob", "b1bbbbbbbbbbbbbb", NOW - 200),
                ("ana", "a1aaaaaaaaaaaaaa", NOW - 300),
            ]
        );
    }

    #[test]
    fn the_log_is_200_long_unless_asked_and_never_over_500() {
        let mut inner = session_with(&["ana"]);
        for n in 0..600 {
            let id = format!("{n:016}");
            record(&mut inner, "ana", missed(&id), NOW - 600 + n, NOW).unwrap();
        }
        // Keep all 600 calls despite the history cap, to test the limits.
        let mut history = inner.history.clone();
        let more: Vec<HistItem> = (0..100)
            .map(|n| HistItem {
                call: Some(missed(&format!("x{n:015}"))),
                text: None,
                ..text(NOW - 2_000 + n, "")
            })
            .collect();
        history.get_mut("ana").unwrap().extend(more);

        assert_eq!(list(&history, None).len(), 200);
        assert_eq!(list(&history, Some(3)).len(), 3);
        assert_eq!(list(&history, Some(10_000)).len(), 500);
        assert_eq!(list(&history, Some(0)).len(), 0);
        assert_eq!(list(&history, Some(3))[0].ts, NOW - 1);
    }

    #[test]
    fn calls_go_with_the_chats_disappearing_messages() {
        let with_ttl = HistItem {
            call: Some(CallEvent {
                ttl: Some(60),
                ..missed(ID)
            }),
            text: None,
            ..text(NOW - 100, "")
        };
        let without = HistItem {
            call: Some(missed(ID)),
            text: None,
            ..text(NOW - 100, "")
        };
        assert!(expired(&with_ttl, NOW));
        assert!(!expired(&with_ttl, NOW - 41));
        assert!(!expired(&without, NOW + 1_000_000));
        assert!(!expired(&text(NOW - 100, "hola"), NOW));
    }

    // ---- what the UI and other versions read ----

    #[test]
    fn the_ui_receives_a_log_entry_in_snake_case() {
        let entry = CallLogEntry {
            peer: "ana".to_string(),
            ts: NOW,
            call: CallEvent {
                video: true,
                ttl: Some(86_400),
                ..call(ID, CallOutcome::Answered, 240)
            },
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            json!({
                "peer": "ana",
                "ts": NOW,
                "call": {
                    "id": ID,
                    "direction": "outgoing",
                    "video": true,
                    "outcome": "answered",
                    "duration_sec": 240,
                    "ttl": 86_400,
                },
            })
        );
        let no_ttl = serde_json::to_value(missed(ID)).unwrap();
        assert!(no_ttl.get("ttl").is_none(), "{no_ttl}");
        assert_eq!(no_ttl["direction"], "incoming");
        assert_eq!(no_ttl["outcome"], "missed");
    }

    #[test]
    fn a_history_item_carries_its_call_only_when_it_has_one() {
        let plain = serde_json::to_value(text(NOW, "hola")).unwrap();
        assert!(plain.get("call").is_none(), "{plain}");
        let with_call = HistItem {
            call: Some(missed(ID)),
            text: None,
            ..text(NOW, "")
        };
        assert_eq!(serde_json::to_value(&with_call).unwrap()["call"]["id"], ID);
    }

    #[test]
    fn a_history_from_before_the_call_log_still_loads() {
        let old = br#"{"ana":[{"side":"me","text":"hola","ts":1760000000},
                             {"side":"them","file":{"url":"u","key":"k","sha256":"s","mime":"image/png","name":"a.png","size":3},"ts":1760000001}]}"#;
        let history: std::collections::HashMap<String, Vec<HistItem>> =
            serde_json::from_slice(old).unwrap();
        assert!(history["ana"].iter().all(|item| item.call.is_none()));
        assert!(list(&history, None).is_empty());
    }

    #[test]
    fn version_0_1_0_reads_a_history_with_calls_without_breaking() {
        // A frozen copy of `HistItem` in 0.1.0 (gui@0.1.0:src-tauri/src/state.rs).
        #[derive(Deserialize)]
        #[allow(dead_code)]
        struct HistItemV010 {
            side: String,
            #[serde(default)]
            from: Option<String>,
            #[serde(default)]
            text: Option<String>,
            #[serde(default)]
            file: Option<serde_json::Value>,
            ts: i64,
        }
        let mut inner = session_with(&["ana"]);
        inner
            .history
            .insert("ana".to_string(), vec![text(NOW - 10, "hola")]);
        record(&mut inner, "ana", missed(ID), NOW, NOW).unwrap();
        let saved = serde_json::to_vec(&inner.history).unwrap();

        let read: std::collections::HashMap<String, Vec<HistItemV010>> =
            serde_json::from_slice(&saved).expect("0.1.0 reads it");
        assert_eq!(read["ana"].len(), 2);
        assert_eq!(read["ana"][1].ts, NOW);
    }

    #[test]
    fn a_recorded_call_travels_inside_the_encrypted_history() {
        use crate::fsutil::scratch::ScratchDir;
        use crate::store::session::tests::{reopen, store_cell};
        // Recorded without a storage, so nothing reaches the real data
        // directory; then written as `save_history` writes the history, to
        // a store in a scratch directory.
        let mut inner = session_with(&["ana"]);
        record(&mut inner, "ana", missed(ID), NOW, NOW).unwrap();
        let scratch = ScratchDir::new("call-log-history");
        inner.storage = store_cell(scratch.path());

        crate::commands::write_history(&inner).unwrap();

        let written = std::fs::read(scratch.path().join("store").join("history.bin")).unwrap();
        assert!(
            !written.windows(ID.len()).any(|w| w == ID.as_bytes()),
            "the call id is in clear"
        );
        let mut reloaded = InnerState::default();
        crate::commands::load_history(&mut reloaded, reopen(scratch.path()).history);
        assert_eq!(list(&reloaded.history, None), list(&inner.history, None));
        assert_eq!(list(&reloaded.history, None).len(), 1);
        // Under another data key, it is nothing: the store is another
        // account's, and opens empty.
        let other = crate::store::session::SessionStore::open(
            scratch.path(),
            &crate::store::session::tests::record(2),
            None,
        )
        .unwrap();
        assert!(matches!(
            other.history,
            crate::store::session::Found::Absent
        ));
    }
}
