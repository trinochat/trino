//! Reportar (uso responsable UR-5, `Uso responsable/diseno.md` §6). What a
//! report carries, how it is sealed and how it goes are the engine's
//! (`trino_engine::report`); these commands save what changed.
//!
//! - `report_preview`: whom it names (their fingerprint and their own name)
//!   and whether this build can seal one;
//! - `send_report`: makes it, seals it, queues it and, if asked, blocks
//!   them (from a report); the session's watcher sends it by Tor;
//! - `list_sent_reports` and `cancel_report`: Ajustes > Privacidad >
//!   Reportes enviados, only codes and days, for 30 days.
//!
//! A child module of `commands`, so it reaches the helpers there
//! (persistence) without making them public.

use super::block_cmds::TargetWire;
use super::persist_account;
use crate::command_error::{CommandError, ErrorCode};
use crate::state::{AppState, InnerState};
use serde::Serialize;
use tauri::State;
use trino_engine::block::{self, BlockOrigin};
use trino_engine::contacts::sealed;
use trino_engine::report::{self, Created, Draft, Preview, SentView};

fn open(inner: &InnerState) -> Result<(), CommandError> {
    inner.identity.as_ref().map(drop).ok_or_else(sealed)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// What `send_report` answers.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SentReport {
    #[serde(flatten)]
    pub created: Created,
    /// Blocked from the report, when asked; `false` with a key clash.
    pub blocked: bool,
}

/// Make the report and, if `and_block`, block them from it: the report
/// first, since a request goes with its block.
pub(crate) fn send(
    inner: &mut InnerState,
    target: TargetWire,
    draft: &Draft,
    and_block: bool,
    keys: &[(u8, [u8; 32])],
    now: i64,
) -> Result<SentReport, CommandError> {
    let (target, _) = target.target();
    let created = report::create(inner, &target, draft, keys, now)?;
    let blocked = and_block
        && match block::block(inner, &target, BlockOrigin::Report, now) {
            Ok(_) => true,
            Err(error) if error.code == ErrorCode::KeyClash => false,
            Err(error) => return Err(error),
        };
    Ok(SentReport { created, blocked })
}

/// Whom `target` names, for the confirmation. Changes nothing.
#[tauri::command]
pub async fn report_preview(
    state: State<'_, AppState>,
    target: TargetWire,
) -> Result<Preview, CommandError> {
    let inner = state.inner.lock().await;
    open(&inner)?;
    report::preview(&inner, &target.target().0, &report::configured_keys())
}

/// Make the report of `draft` about `target`, and block them if `block`.
#[tauri::command]
pub async fn send_report(
    state: State<'_, AppState>,
    target: TargetWire,
    draft: Draft,
    block: bool,
) -> Result<SentReport, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let keys = report::configured_keys();
    let sent = send(&mut inner, target, &draft, block, &keys, now())?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    if sent.blocked {
        trino_engine::requests::save(&inner);
    }
    inner.report_watch.notify_one();
    Ok(sent)
}

/// Reportes enviados, the latest first. What is 30 days old goes first.
#[tauri::command]
pub async fn list_sent_reports(state: State<'_, AppState>) -> Result<Vec<SentView>, CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    let now = now();
    if inner.reports.prune(now) {
        persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    }
    Ok(report::list(&inner, now))
}

/// Cancel the report `id` while it waits.
#[tauri::command]
pub async fn cancel_report(state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    open(&inner)?;
    inner.reports.cancel(&id)?;
    persist_account(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use trino_engine::identity::{create_identity, generate_x25519, public_bundle_for};
    use trino_engine::requests::{self, Incoming, Item, Via};

    const NOW: i64 = 1_760_000_000;

    fn draft() -> Draft {
        serde_json::from_value(serde_json::json!({
            "category": "spam",
            "mode": "key_only",
            "note": "publicidad",
        }))
        .unwrap()
    }

    /// A stranger's request, as Solicitudes keeps it.
    fn with_request() -> (InnerState, String) {
        let (me, ana) = (create_identity(), create_identity());
        let mut inner = InnerState {
            identity: Some(me),
            ..InnerState::default()
        };
        requests::receive(
            &mut inner,
            Incoming {
                bundle: public_bundle_for(&ana),
                name: "ana".into(),
                via: Via::Name,
                item: Item::Text {
                    text: "compra aquí".into(),
                    at: NOW,
                },
                nostr_proven: true,
                dh_proven: false,
            },
            NOW,
        );
        (inner, hex::encode(ana.ik_sign.pub_bytes))
    }

    #[test]
    fn ur5_reporting_a_request_and_blocking_it_from_the_report() {
        let (mut inner, key) = with_request();
        let trino = generate_x25519();
        let target = TargetWire::Request {
            ik_sign_pub: key.clone(),
        };
        let sent = send(
            &mut inner,
            target,
            &draft(),
            true,
            &[(1, trino.pub_bytes)],
            NOW,
        )
        .unwrap();
        assert!(sent.created.queued && sent.blocked);
        assert!(inner.blocked.blocks_identity(&key));
        assert_eq!(block::list(&inner)[0].from, BlockOrigin::Report);
        assert!(inner.requests.is_empty(), "the request went with the block");
        assert_eq!(report::list(&inner, NOW)[0].id, sent.created.id);
    }

    #[test]
    fn ur5_without_blocking_and_without_a_key_nothing_changes() {
        let (mut inner, key) = with_request();
        let target = TargetWire::Request {
            ik_sign_pub: key.clone(),
        };
        let sent = send(&mut inner, target, &draft(), false, &[], NOW).unwrap();
        assert!(!sent.created.queued && !sent.blocked);
        assert!(!inner.blocked.blocks_identity(&key));
        assert!(inner.reports.is_empty());
        let json = serde_json::to_value(&sent).unwrap();
        let keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["blocked", "day", "id", "queued"]);
    }
}
