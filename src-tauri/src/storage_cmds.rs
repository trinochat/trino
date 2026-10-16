//! The commands of the store's dialog at unlock (cifrado local CL-1b, CL-1c;
//! design §6.2 and §11.4). Where the open session keeps its data is the
//! engine's (`trino_engine::storage`, M4-0c).
//!
//! A child module of `commands`, so it reaches the helpers there.

use super::*;
use crate::state::trino_home;
use crate::store::report::IntegrityReport;
pub(crate) use trino_engine::storage::*;

/// "Usar esa copia" or "Seguir sin ella" in the dialog at unlock (design
/// §6.2), for one file that waits.
#[tauri::command]
pub async fn store_choose(
    state: State<'_, AppState>,
    file: String,
    use_it: bool,
) -> Result<IntegrityReport, CommandError> {
    choose_in(&mut *state.inner.lock().await, &file, use_it)
}

/// "Ver qué traen" in the dialog at unlock.
#[tauri::command]
pub async fn legacy_files_preview(
    state: State<'_, AppState>,
) -> Result<LegacyPreview, CommandError> {
    preview_in(&*state.inner.lock().await, &trino_home())
}

/// "Importarlos" in the dialog at unlock.
#[tauri::command]
pub async fn legacy_files_import(
    state: State<'_, AppState>,
) -> Result<IntegrityReport, CommandError> {
    let now = chrono::Utc::now().timestamp();
    import_in(&mut *state.inner.lock().await, &trino_home(), now)
}

/// "Borrarlos" in the dialog at unlock.
#[tauri::command]
pub async fn legacy_files_remove(
    state: State<'_, AppState>,
) -> Result<IntegrityReport, CommandError> {
    remove_in(&mut *state.inner.lock().await, &trino_home())
}
