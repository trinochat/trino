//! "Delete for me" (W8, K11): one message goes from this device's history
//! for good, and the encrypted history.bin is written again without it.
//!
//! A child module of `commands`, so it reaches the helpers there (sessions,
//! sending, persistence) without making them public.

use super::contacts_cmds::{not_found, sealed};
use super::{history_path, write_history};
use crate::command_error::CommandError;
use crate::state::{AppState, HistItem};
use std::collections::HashMap;
use tauri::State;

/// Delete from `history[convo]` the first message sent at `ts` by `side`
/// whose text is `text` or whose file has `sha256` (both, when both are
/// given). The first one that matches, never one by its position: positions
/// move as messages arrive and expire.
///
/// One of `text` and `sha256` must say which message: an item with neither,
/// such as a call (K13), is never a message the user picked.
pub(crate) fn delete_item(
    history: &mut HashMap<String, Vec<HistItem>>,
    convo: &str,
    ts: i64,
    side: &str,
    text: Option<&str>,
    sha256: Option<&str>,
) -> Result<(), CommandError> {
    use zeroize::Zeroize;
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
                && text.is_none_or(|text| item.text.as_deref() == Some(text))
                && sha256.is_none_or(|sha256| {
                    item.file.as_ref().is_some_and(|file| file.sha256 == sha256)
                })
        })
        .ok_or_else(|| not_found("no such message"))?;
    let mut removed = items.remove(position);
    if let Some(text) = removed.text.as_mut() {
        text.zeroize();
    }
    if let Some(file) = removed.file.as_mut() {
        super::zeroize_file_ref(file);
    }
    Ok(())
}

/// Delete one message here, for good (K11).
#[tauri::command]
pub async fn delete_history_item(
    state: State<'_, AppState>,
    convo: String,
    ts: i64,
    side: String,
    text: Option<String>,
    sha256: Option<String>,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(sealed());
    }
    delete_item(
        &mut inner.history,
        &convo,
        ts,
        &side,
        text.as_deref(),
        sha256.as_deref(),
    )?;
    // Unlike other saves, a failure here is the caller's to know: the message
    // would come back at the next unlock.
    write_history(&inner, &history_path()).map_err(|error| CommandError::io(&error))?;
    Ok(())
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

        delete_item(&mut history, "ana", NOW, "me", Some("hola"), None).unwrap();

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

        delete_item(&mut history, "grp:g1", NOW, "them", None, Some("bb")).unwrap();

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
            let error = delete_item(&mut history, convo, ts, side, Some(body), None).unwrap_err();
            assert_eq!(
                error.code,
                ErrorCode::NotFound,
                "{convo} {ts} {side} {body}"
            );
        }
        let error = delete_item(&mut history, "ana", NOW, "me", None, Some("aa")).unwrap_err();
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

        let error = delete_item(&mut history, "ana", NOW, "me", None, None).unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        assert_eq!(history["ana"].len(), 1);
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
}
