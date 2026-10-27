//! Ajustes › Privacidad › Edad (uso responsable UR-10, U17, U23). What an
//! age means and how it changes are the engine's (`trino_engine::age`);
//! these commands save the account after each change. The age stays on this
//! device: nothing here sends it anywhere.
//!
//! - `get_age`: the range in force, a change to "18 o más" that waits, and
//!   whether a change now would be at once (the first 24 hours);
//! - `set_age`: "16 o 17" at once, which drops the requests that did not
//!   come by your links; "18 o más" in 7 days, or at once in the first day;
//! - `cancel_age_change`: cancels a change to "18 o más" that waits.
//!
//! A child module of `commands`, so it reaches the helpers there
//! (persistence) without making them public.

use super::persist_account;
use crate::command_error::{CommandError, ErrorCode};
use crate::state::{AppState, InnerState};
use tauri::State;
use trino_engine::age::{self, AgeView, Bracket};
use trino_engine::contacts::sealed;

fn open(inner: &InnerState) -> Result<(), CommandError> {
    inner.identity.as_ref().map(drop).ok_or_else(sealed)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The account, and the requests a change to "16 o 17" dropped.
fn save(inner: &InnerState) -> Result<(), CommandError> {
    persist_account(inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    trino_engine::requests::save(inner);
    Ok(())
}

/// The age in force; a change that came due takes effect first.
#[tauri::command]
pub async fn get_age(state: State<'_, AppState>) -> Result<AgeView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let now = now();
    if age::apply(&mut inner, now) {
        save(&inner)?;
    }
    Ok(age::view(&inner, now))
}

/// Change the age to `bracket` (U17, U23).
#[tauri::command]
pub async fn set_age(
    state: State<'_, AppState>,
    bracket: Bracket,
) -> Result<AgeView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let shown = age::change(&mut inner, bracket, now())?;
    save(&inner)?;
    Ok(shown)
}

/// Cancel a change to "18 o más" that waits.
#[tauri::command]
pub async fn cancel_age_change(state: State<'_, AppState>) -> Result<AgeView, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let shown = age::cancel_change(&mut inner, now())?;
    save(&inner)?;
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The JSON src/lib/api.ts reads: the range as "minor" or "adult".
    #[test]
    fn the_age_reaches_the_ui_as_api_ts_reads_it() {
        let shown = AgeView {
            bracket: Bracket::Minor,
            adult_from: Some(1_792_000_000),
            instant: false,
            from_store: false,
        };
        assert_eq!(
            serde_json::to_value(shown).unwrap(),
            serde_json::json!({
                "bracket": "minor",
                "adult_from": 1_792_000_000,
                "instant": false,
                "from_store": false
            })
        );
        let asked: Bracket = serde_json::from_str("\"adult\"").unwrap();
        assert_eq!(asked, Bracket::Adult);
    }
}
