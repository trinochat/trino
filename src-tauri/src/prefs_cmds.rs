//! The commands of the account's preferences (cifrado local CL-2a). The
//! preferences themselves are the engine's (`trino_engine::prefs`, M4-0c).
//!
//! A child module of `commands`, so it reaches the helpers there.

use super::*;
use std::collections::BTreeMap;
pub(crate) use trino_engine::prefs::*;

/// Keep the account's preferences, the frontend's whole copy.
#[tauri::command]
pub async fn prefs_save(
    state: State<'_, AppState>,
    prefs: BTreeMap<String, String>,
) -> Result<(), CommandError> {
    save_in(&*state.inner.lock().await, &prefs)
}

/// The one import of what this device kept for the account before the
/// store: `entries` are the WebView's, and only this account's are taken.
#[tauri::command]
pub async fn prefs_import(
    state: State<'_, AppState>,
    entries: BTreeMap<String, String>,
) -> Result<PrefsImported, CommandError> {
    let imported = import_in(&*state.inner.lock().await, entries)?;
    // The news' old minSeq, kept by the WebView before the store, goes to
    // tor/seen.json now: the next save drops it from the preferences.
    crate::news_cmds::take_old_min_seq(
        &state.net,
        crate::news_cmds::old_min_seq_in(&imported.taken),
    );
    Ok(imported)
}

/// The account's preferences as the session has them now: after the user
/// chose a copy of them in the dialog at unlock, say.
#[tauri::command]
pub async fn prefs_get(
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, CommandError> {
    get_in(&*state.inner.lock().await)
}
