//! "Delete for me" (W8, K11): one message goes from this device's history
//! for good, and the encrypted history.bin is written again without it.
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::contacts_cmds::{not_found, sealed};
use super::{history_path, write_history};
use crate::command_error::CommandError;
use crate::state::{AppState, HistItem, InnerState};
use std::collections::HashMap;
use std::path::Path;
use tauri::State;

/// Take out of `history[convo]` the first message sent at `ts` by `side`
/// (and, in a group, by `from`, when given) whose text is `text` or whose
/// file has `sha256` (both, when both are given). The first one that
/// matches, never one by its position: positions move as messages arrive
/// and expire. Returns it with where it was, for `write_without`.
///
/// One of `text` and `sha256` must say which message: an item with neither,
/// such as a call (K13), is never a message the user picked.
pub(crate) fn delete_item(
    history: &mut HashMap<String, Vec<HistItem>>,
    convo: &str,
    ts: i64,
    side: &str,
    from: Option<&str>,
    text: Option<&str>,
    sha256: Option<&str>,
) -> Result<(usize, HistItem), CommandError> {
    if text.is_none() && sha256.is_none() {
        return Err(CommandError::internal(
            "say which message: its text or the sha256 of its file",
        ));
    }
    let items = history
        .get_mut(convo)
        .ok_or_else(|| not_found("no such conversation"))?;
    let position = items
        .iter()
        .position(|item| {
            item.ts == ts
                && item.side == side
                && from.is_none_or(|from| item.from.as_deref() == Some(from))
                && text.is_none_or(|text| item.text.as_deref() == Some(text))
                && sha256.is_none_or(|sha256| {
                    item.file.as_ref().is_some_and(|file| file.sha256 == sha256)
                })
        })
        .ok_or_else(|| not_found("no such message"))?;
    Ok((position, items.remove(position)))
}

/// Write history.bin to `path` without `removed`, the message `delete_item`
/// took out of `convo` with where it was, then wipe it. A failure here is
/// the caller's to know, unlike other saves: the message goes back where it
/// was, so the chat shows what history.bin still holds and trying again
/// finds it.
pub(crate) fn write_without(
    inner: &mut InnerState,
    path: &Path,
    convo: &str,
    removed: (usize, HistItem),
) -> Result<(), CommandError> {
    use zeroize::Zeroize;
    let (position, mut removed) = removed;
    if let Err(error) = write_history(inner, path) {
        let items = inner.history.entry(convo.to_string()).or_default();
        items.insert(position.min(items.len()), removed);
        return Err(CommandError::io(&error));
    }
    if let Some(text) = removed.text.as_mut() {
        text.zeroize();
    }
    if let Some(file) = removed.file.as_mut() {
        super::zeroize_file_ref(file);
    }
    Ok(())
}

/// Delete one message here, for good (K11). `from` names the sender of a
/// group message, so one of two members who sent the same text in the same
/// second is told apart; left out, the first that matches goes.
#[tauri::command]
pub async fn delete_history_item(
    state: State<'_, AppState>,
    convo: String,
    ts: i64,
    side: String,
    from: Option<String>,
    text: Option<String>,
    sha256: Option<String>,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(sealed());
    }
    let removed = delete_item(
        &mut inner.history,
        &convo,
        ts,
        &side,
        from.as_deref(),
        text.as_deref(),
        sha256.as_deref(),
    )?;
    write_without(&mut inner, &history_path(), &convo, removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::commands::load_history;
    use crate::fsutil::scratch::ScratchDir;
    use crate::state::InnerState;
    use serde_json::json;

    const NOW: i64 = 1_760_000_000;

    /// Items are read from JSON, as history.bin holds them, so fields other
    /// units add to `HistItem` with a default do not break these tests.
    fn item(value: serde_json::Value) -> HistItem {
        serde_json::from_value(value).unwrap()
    }

    fn text(side: &str, body: &str, ts: i64) -> HistItem {
        item(json!({ "side": side, "text": body, "ts": ts }))
    }

    fn file(side: &str, sha256: &str, ts: i64) -> HistItem {
        item(json!({
            "side": side,
            "file": {
                "url": "https://blossom.example/x",
                "key": "00".repeat(32),
                "sha256": sha256,
                "mime": "image/jpeg",
                "name": "foto.jpg",
                "size": 10,
            },
            "ts": ts,
        }))
    }

    fn texts(items: &[HistItem]) -> Vec<(String, Option<&str>)> {
        items
            .iter()
            .map(|i| (i.side.clone(), i.text.as_deref()))
            .collect()
    }

    #[test]
    fn deletes_the_first_message_that_matches_and_nothing_else() {
        let mut history = HashMap::from([
            (
                "ana".to_string(),
                vec![
                    text("me", "hola", NOW),
                    text("them", "hola", NOW),
                    text("me", "hola", NOW),
                    text("me", "chao", NOW + 1),
                ],
            ),
            ("bob".to_string(), vec![text("me", "hola", NOW)]),
        ]);

        delete_item(&mut history, "ana", NOW, "me", None, Some("hola"), None).unwrap();

        assert_eq!(
            texts(&history["ana"]),
            [
                ("them".to_string(), Some("hola")),
                ("me".to_string(), Some("hola")),
                ("me".to_string(), Some("chao")),
            ]
        );
        assert_eq!(texts(&history["bob"]), [("me".to_string(), Some("hola"))]);
    }

    #[test]
    fn deletes_a_file_by_its_sha256() {
        let mut history = HashMap::from([(
            "grp:g1".to_string(),
            vec![file("them", "aa", NOW), file("them", "bb", NOW)],
        )]);

        delete_item(&mut history, "grp:g1", NOW, "them", None, None, Some("bb")).unwrap();

        let left: Vec<&str> = history["grp:g1"]
            .iter()
            .map(|i| i.file.as_ref().unwrap().sha256.as_str())
            .collect();
        assert_eq!(left, ["aa"]);
    }

    #[test]
    fn a_message_that_is_not_there_is_not_found() {
        let mut history = HashMap::from([("ana".to_string(), vec![text("me", "hola", NOW)])]);

        for (convo, ts, side, body) in [
            ("bob", NOW, "me", "hola"),
            ("ana", NOW + 1, "me", "hola"),
            ("ana", NOW, "them", "hola"),
            ("ana", NOW, "me", "otra"),
        ] {
            let error =
                delete_item(&mut history, convo, ts, side, None, Some(body), None).unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::NotFound,
                "{convo} {ts} {side} {body}"
            );
        }
        let error =
            delete_item(&mut history, "ana", NOW, "me", None, None, Some("aa")).unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(history["ana"].len(), 1);
    }

    #[test]
    fn something_must_say_which_message() {
        // An item with neither text nor file is not a message the user can
        // pick, such as a call (K13): it is never matched.
        let mut history = HashMap::from([(
            "ana".to_string(),
            vec![item(json!({ "side": "me", "ts": NOW }))],
        )]);

        let error = delete_item(&mut history, "ana", NOW, "me", None, None, None).unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(history["ana"].len(), 1);
    }

    #[test]
    fn a_call_in_the_chat_is_never_deleted_for_me() {
        // K13 keeps each call as an item of its contact's chat, with neither
        // text nor file, at the time it started. "Delete for me" names a
        // message by its text or its file, so nothing can name a call; the
        // text sent at that same second still goes.
        let call = item(json!({
            "side": "me",
            "call": {
                "id": "call-0123456789abcdef",
                "direction": "outgoing",
                "video": false,
                "outcome": "answered",
                "duration_sec": 240,
            },
            "ts": NOW,
        }));
        assert!(call.call.is_some());
        let mut history = HashMap::from([("ana".to_string(), vec![call, text("me", "hola", NOW)])]);

        for (body, sha256) in [
            (None, None),
            (Some(""), None),
            (None, Some("")),
            (Some(""), Some("")),
        ] {
            assert!(
                delete_item(&mut history, "ana", NOW, "me", None, body, sha256).is_err(),
                "{body:?} {sha256:?}"
            );
        }
        delete_item(&mut history, "ana", NOW, "me", None, Some("hola"), None).unwrap();

        let left = &history["ana"];
        assert_eq!(left.len(), 1);
        let kept = left[0].call.as_ref().expect("the call is still there");
        assert_eq!(kept.id, "call-0123456789abcdef");
    }

    #[test]
    fn a_deleted_message_stays_deleted_after_a_reload() {
        let scratch = ScratchDir::new("delete-for-me");
        let path = scratch.path().join("history.bin");
        let mut inner = InnerState {
            history_key: Some([7; 32]),
            ..InnerState::default()
        };
        inner.history.insert(
            "ana".into(),
            vec![text("me", "se queda", NOW), text("me", "se va", NOW + 1)],
        );

        delete_item(
            &mut inner.history,
            "ana",
            NOW + 1,
            "me",
            None,
            Some("se va"),
            None,
        )
        .unwrap();
        write_history(&inner, &path).unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert!(
            !String::from_utf8_lossy(&bytes).contains("se queda"),
            "in the clear"
        );
        let mut reloaded = InnerState {
            history_key: Some([7; 32]),
            ..InnerState::default()
        };
        load_history(&mut reloaded, &path);
        assert_eq!(
            texts(&reloaded.history["ana"]),
            [("me".to_string(), Some("se queda"))]
        );
    }

    #[test]
    fn a_message_comes_back_where_it_was_when_history_bin_cannot_be_written() {
        let scratch = ScratchDir::new("delete-for-me-fails");
        // A directory where history.bin should go: no write can replace it.
        let path = scratch.path().join("history.bin");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("inside"), b"x").unwrap();
        let mut inner = InnerState {
            history_key: Some([7; 32]),
            ..InnerState::default()
        };
        inner.history.insert(
            "ana".into(),
            vec![
                text("me", "uno", NOW),
                text("me", "dos", NOW + 1),
                text("me", "tres", NOW + 2),
            ],
        );
        let removed = delete_item(
            &mut inner.history,
            "ana",
            NOW + 1,
            "me",
            None,
            Some("dos"),
            None,
        );

        let error = write_without(&mut inner, &path, "ana", removed.unwrap()).unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert_eq!(
            texts(&inner.history["ana"]),
            [
                ("me".to_string(), Some("uno")),
                ("me".to_string(), Some("dos")),
                ("me".to_string(), Some("tres")),
            ],
            "the chat shows what history.bin still holds"
        );
        // Trying again finds it.
        let again = delete_item(
            &mut inner.history,
            "ana",
            NOW + 1,
            "me",
            None,
            Some("dos"),
            None,
        );
        assert_eq!(again.unwrap().0, 1);
    }

    /// A message of `sender` in a group, as it arrives.
    fn from(sender: &str, body: &str, ts: i64) -> HistItem {
        item(json!({ "side": "them", "from": sender, "text": body, "ts": ts }))
    }

    #[test]
    fn in_a_group_the_sender_says_which_message() {
        // Bob and Carol both sent "ok" in the same second.
        let both = || {
            HashMap::from([(
                "grp:g1".to_string(),
                vec![from("bob", "ok", NOW), from("carol", "ok", NOW)],
            )])
        };
        let senders = |history: &HashMap<String, Vec<HistItem>>| -> Vec<String> {
            history["grp:g1"]
                .iter()
                .filter_map(|i| i.from.clone())
                .collect()
        };

        let mut history = both();
        delete_item(
            &mut history,
            "grp:g1",
            NOW,
            "them",
            Some("carol"),
            Some("ok"),
            None,
        )
        .unwrap();
        assert_eq!(senders(&history), ["bob"]);

        // Without `from`, the first that matches goes, as before.
        let mut history = both();
        delete_item(&mut history, "grp:g1", NOW, "them", None, Some("ok"), None).unwrap();
        assert_eq!(senders(&history), ["carol"]);

        let mut history = both();
        let error = delete_item(
            &mut history,
            "grp:g1",
            NOW,
            "them",
            Some("dave"),
            Some("ok"),
            None,
        )
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert_eq!(senders(&history), ["bob", "carol"]);
    }
}
