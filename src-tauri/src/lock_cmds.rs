//! Locking with the system (cifrado local CL-6a, design §7.2 and §12.6):
//! Trino locks when Windows locks, and when the computer goes to sleep or
//! hibernates, unless "Bloquear Trino al bloquear Windows" is off (on by
//! default, David's decision 4). Every lock, by hand, after the idle
//! minutes, from the tray or with the system, also renews the window, so
//! what it showed goes with the WebView that showed it.
//!
//! - **Keys first, the window after.** The lock drops the data key, the
//!   identity and the sessions (`forget_session`), and only then is the
//!   window renewed. If the computer sleeps in between, the window changes
//!   as it wakes.
//! - **During a call:** locking Windows waits for the call to end and locks
//!   then; going to sleep locks at once, since the call drops anyway.
//! - **A lock from the system writes nothing** (design test 49): history and
//!   sessions are saved with every change, and sleep gives about two
//!   seconds. Only what still waits for the store's index goes out
//!   (design §4.6), which is nothing unless writing the index failed.
//! - **The reason survives the window:** the lock keeps it, and the status
//!   gives it to the window that opens after, so its unlock screen says why
//!   Trino locked.
//!
//! A child module of `commands`, so it reaches the helpers there.

use super::*;
use crate::system_events::SystemEvent;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

/// The account preference of "Bloquear Trino al bloquear Windows": "0" is
/// off, anything else (or nothing) is on.
pub(crate) const LOCK_WITH_SYSTEM_PREF: &str = "trino.pref.lockWithSystem";

/// Emitted when the backend locked by itself (the system, or the tray): the
/// frontend drops the chats and shows the unlock screen, in case the window
/// could not be renewed.
#[cfg_attr(not(desktop), allow(dead_code))]
pub(crate) const VAULT_LOCKED_EVENT: &str = "vault-locked";

/// Emitted when "Bloquear" is chosen in the tray during a call: the frontend
/// asks to hang up first, as its own "Bloquear" does.
#[cfg_attr(not(desktop), allow(dead_code))]
pub(crate) const LOCK_REQUESTED_EVENT: &str = "lock-requested";

/// What made the system lock Trino.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemCause {
    /// Windows was locked, the session switched or disconnected.
    Session,
    /// The computer went to sleep or hibernated.
    Suspend,
}

/// Why Trino locked, as the unlock screen says it (`LockReason` of
/// src/screens/types.ts, but for the cold start, which is the frontend's).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LockReason {
    Manual,
    Idle { minutes: u32 },
    System { cause: SystemCause },
}

/// Who asked to lock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LockOrigin {
    /// The frontend (`lock_vault`): it saved what was pending first, and the
    /// history and sessions are saved once more, as before.
    Frontend,
    /// The backend by itself: the system or the tray. Nothing is written but
    /// what waits for the store's index, and the frontend is told.
    Backend,
}

/// The app's window, as a lock needs it.
pub(crate) trait MainWindow: Sync {
    /// The backend locked by itself: tell the window, in case it cannot be
    /// renewed.
    fn announce(&self, reason: LockReason);
    /// Close the window and open it again where it was, with a new WebView.
    fn renew(&self);
}

/// What an event of the system does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SystemAction {
    /// Lock now, for this cause.
    LockNow(SystemCause),
    /// A call is going on: lock when it ends.
    LockAfterCall,
    /// Nothing: no session, or the setting is off.
    Nothing,
}

/// What `event` does, given the setting, whether a session is open and
/// whether a call holds the microphone (design §7.2, test 48).
pub(crate) fn action_for(
    event: SystemEvent,
    setting_on: bool,
    unlocked: bool,
    call_active: bool,
) -> SystemAction {
    if !setting_on || !unlocked {
        return SystemAction::Nothing;
    }
    match event {
        SystemEvent::Suspending => SystemAction::LockNow(SystemCause::Suspend),
        SystemEvent::SessionLocked if call_active => SystemAction::LockAfterCall,
        SystemEvent::SessionLocked => SystemAction::LockNow(SystemCause::Session),
    }
}

/// Whether the account's "Bloquear Trino al bloquear Windows" is on: on
/// unless it was turned off.
pub(crate) fn lock_with_system(inner: &InnerState) -> bool {
    prefs_cmds::current_map(inner)
        .get(LOCK_WITH_SYSTEM_PREF)
        .is_none_or(|value| value != "0")
}

/// The call flag changed to `active`. Returns whether a lock waited for the
/// call to end, and so must happen now.
pub(crate) fn call_flag_changed(
    call_active: &AtomicBool,
    lock_after_call: &AtomicBool,
    active: bool,
) -> bool {
    call_active.store(active, Ordering::SeqCst);
    !active && lock_after_call.swap(false, Ordering::SeqCst)
}

/// Lock the session for `reason`, and then renew the window, if a session
/// was open. Returns whether one was.
pub(crate) async fn lock_and_renew(
    state: &AppState,
    window: &dyn MainWindow,
    reason: Option<LockReason>,
    origin: LockOrigin,
) -> bool {
    let was_open = {
        let _gate = state.session_gate.lock().await;
        let mut inner = state.inner.lock().await;
        // Whatever waited for a call to end is this lock.
        state.lock_after_call.store(false, Ordering::SeqCst);
        let was_open = inner.identity.is_some();
        if origin == LockOrigin::Frontend {
            // As before: the history and the sessions once more.
            save_ratchets(&inner);
            save_history(&inner);
        }
        // Only what waits for the store's index (design §4.6).
        inner.storage.flush_for_lock();
        forget_session(&mut inner, &state.turn);
        if was_open {
            // A second lock, with none open, keeps the first one's reason.
            inner.lock_reason = reason;
        }
        was_open
    };
    if !was_open {
        return false;
    }
    dbg_log("vault LOCKED");
    if origin == LockOrigin::Backend {
        if let Some(reason) = reason {
            window.announce(reason);
        }
    }
    window.renew();
    true
}

/// The app's window through Tauri.
pub(crate) struct TauriMainWindow(pub(crate) AppHandle);

impl MainWindow for TauriMainWindow {
    fn announce(&self, reason: LockReason) {
        let _ = self.0.emit(VAULT_LOCKED_EVENT, reason);
    }

    fn renew(&self) {
        #[cfg(desktop)]
        crate::window_renewal::renew(&self.0);
    }
}

/// Lock from the backend, without waiting: the tray, and the end of a call
/// that a lock of Windows waited for.
pub(crate) fn lock_from_backend(app: AppHandle, reason: LockReason) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let window = TauriMainWindow(app.clone());
        lock_and_renew(&state, &window, Some(reason), LockOrigin::Backend).await;
    });
}

/// "Bloquear" in the tray: at once, or during a call, through the frontend,
/// which asks to hang up first as its own "Bloquear" does.
#[cfg(desktop)]
pub(crate) fn tray_lock(app: &AppHandle) {
    if app.state::<AppState>().call_active.load(Ordering::SeqCst) {
        crate::window_renewal::show(app);
        let _ = app.emit(LOCK_REQUESTED_EVENT, ());
    } else {
        lock_from_backend(app.clone(), LockReason::Manual);
    }
}

/// An event of the system, on the thread that hears them: the lock is done
/// before this returns, within the two seconds sleep gives.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn on_system_event(app: &AppHandle, event: SystemEvent) {
    let state = app.state::<AppState>();
    tauri::async_runtime::block_on(async {
        let action = {
            let inner = state.inner.lock().await;
            action_for(
                event,
                lock_with_system(&inner),
                inner.identity.is_some(),
                state.call_active.load(Ordering::SeqCst),
            )
        };
        let cause = match action {
            SystemAction::Nothing => return,
            SystemAction::LockNow(cause) => cause,
            SystemAction::LockAfterCall => {
                state.lock_after_call.store(true, Ordering::SeqCst);
                // The call may have ended in between, before the flag was
                // there to see: then it is this event's to lock.
                if state.call_active.load(Ordering::SeqCst)
                    || !state.lock_after_call.swap(false, Ordering::SeqCst)
                {
                    return;
                }
                SystemCause::Session
            }
        };
        let window = TauriMainWindow(app.clone());
        let reason = LockReason::System { cause };
        lock_and_renew(&state, &window, Some(reason), LockOrigin::Backend).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::session::tests::store_cell;
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::sync::Mutex as StdMutex;

    /// A window that records what a lock asked of it, and whether the
    /// session was already closed when it was renewed.
    #[derive(Default)]
    struct Recording {
        state: Option<Arc<AppState>>,
        calls: StdMutex<Vec<String>>,
    }

    impl Recording {
        fn over(state: &Arc<AppState>) -> Self {
            Recording {
                state: Some(Arc::clone(state)),
                calls: StdMutex::default(),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl MainWindow for Recording {
        fn announce(&self, reason: LockReason) {
            self.calls.lock().unwrap().push(format!(
                "announce {}",
                serde_json::to_string(&reason).unwrap()
            ));
        }

        fn renew(&self) {
            let closed = self.state.as_ref().is_none_or(|state| {
                let inner = state
                    .inner
                    .try_lock()
                    .expect("the lock let go of the state");
                inner.identity.is_none() && !inner.storage.is_open()
            });
            self.calls
                .lock()
                .unwrap()
                .push(format!("renew, session closed: {closed}"));
        }
    }

    /// An open session over a new store in `home`, with one message in
    /// memory that nothing saved yet.
    fn unlocked(home: &Path) -> Arc<AppState> {
        let state = AppState::default();
        {
            let mut inner = state.inner.try_lock().unwrap();
            inner.identity = Some(create_identity());
            inner.handle = Some("Ana".into());
            inner.storage = store_cell(home);
            inner.history.insert(
                "Bob".into(),
                vec![HistItem {
                    side: "them".into(),
                    from: None,
                    text: Some("no guardado".into()),
                    file: None,
                    call: None,
                    ts: 1,
                }],
            );
        }
        Arc::new(state)
    }

    /// Every file under `dir`, with its bytes.
    fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, base: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, base, out);
                } else {
                    let name = path
                        .strip_prefix(base)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    out.insert(name, std::fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, dir, &mut out);
        out
    }

    const SESSION: SystemCause = SystemCause::Session;
    const SUSPEND: SystemCause = SystemCause::Suspend;

    /// Design §12.6, test 48: a pure function from the event to the action.
    #[test]
    fn session_lock_waits_for_the_call_and_suspend_locks_at_once() {
        use SystemEvent::{SessionLocked, Suspending};
        // On, unlocked, no call: both lock now.
        assert_eq!(
            action_for(SessionLocked, true, true, false),
            SystemAction::LockNow(SESSION)
        );
        assert_eq!(
            action_for(Suspending, true, true, false),
            SystemAction::LockNow(SUSPEND)
        );
        // During a call: locking Windows waits; sleep does not.
        assert_eq!(
            action_for(SessionLocked, true, true, true),
            SystemAction::LockAfterCall
        );
        assert_eq!(
            action_for(Suspending, true, true, true),
            SystemAction::LockNow(SUSPEND)
        );
        // The setting off, or no session: nothing, call or not.
        for event in [SessionLocked, Suspending] {
            for call in [false, true] {
                assert_eq!(action_for(event, false, true, call), SystemAction::Nothing);
                assert_eq!(action_for(event, true, false, call), SystemAction::Nothing);
            }
        }
    }

    /// David's decision 4: on by default, and it can be turned off.
    #[test]
    fn locking_with_the_system_is_on_unless_turned_off() {
        let scratch = ScratchDir::new("lock-setting");
        let inner = InnerState {
            storage: store_cell(scratch.path()),
            ..InnerState::default()
        };
        assert!(lock_with_system(&inner), "on by default");
        assert!(
            lock_with_system(&InnerState::default()),
            "on with no session"
        );

        let save = |value: &str| {
            let prefs =
                serde_json::to_vec(&serde_json::json!({ LOCK_WITH_SYSTEM_PREF: value })).unwrap();
            inner.storage.write_prefs(&prefs).unwrap();
        };
        save("0");
        assert!(!lock_with_system(&inner), "turned off");
        save("1");
        assert!(lock_with_system(&inner), "turned on again");
    }

    #[test]
    fn a_lock_that_waited_for_the_call_happens_when_it_ends() {
        let (call, waiting) = (AtomicBool::new(true), AtomicBool::new(true));
        // The call goes on: nothing yet.
        assert!(!call_flag_changed(&call, &waiting, true));
        assert!(call.load(Ordering::SeqCst));
        // It ends: lock now, once.
        assert!(call_flag_changed(&call, &waiting, false));
        assert!(!call.load(Ordering::SeqCst));
        assert!(!call_flag_changed(&call, &waiting, false));
        // No lock waiting: the end of a call locks nothing.
        let (call, waiting) = (AtomicBool::new(true), AtomicBool::new(false));
        assert!(!call_flag_changed(&call, &waiting, false));
    }

    /// Design §12.6, test 49: a lock from the system writes nothing, not
    /// even the message in memory, and still drops the keys and the names.
    #[tokio::test]
    async fn the_system_lock_writes_nothing() {
        let scratch = ScratchDir::new("lock-writes-nothing");
        let state = unlocked(scratch.path());
        let before = snapshot(scratch.path());

        let window = Recording::default();
        let reason = LockReason::System { cause: SUSPEND };
        assert!(lock_and_renew(&state, &window, Some(reason), LockOrigin::Backend).await);

        assert_eq!(snapshot(scratch.path()), before, "the lock wrote");
        let inner = state.inner.lock().await;
        assert!(inner.identity.is_none());
        assert!(!inner.storage.is_open());
        assert!(inner.history.is_empty());
        assert_eq!(inner.handle, None);
    }

    /// The same check sees a write: the lock of the frontend saves the
    /// history once more, as before.
    #[tokio::test]
    async fn the_frontends_lock_still_saves_the_history() {
        let scratch = ScratchDir::new("lock-frontend-saves");
        let state = unlocked(scratch.path());
        let before = snapshot(scratch.path());

        let window = Recording::default();
        assert!(
            lock_and_renew(
                &state,
                &window,
                Some(LockReason::Manual),
                LockOrigin::Frontend
            )
            .await
        );

        assert_ne!(snapshot(scratch.path()), before);
    }

    /// Design §12.6, test 68: manual, idle and system locks all renew the
    /// window, after the session is closed; only the backend's own lock
    /// tells the frontend.
    #[tokio::test]
    async fn every_lock_recreates_the_webview() {
        let cases = [
            (LockReason::Manual, LockOrigin::Frontend, None),
            (LockReason::Idle { minutes: 5 }, LockOrigin::Frontend, None),
            (
                LockReason::System { cause: SESSION },
                LockOrigin::Backend,
                Some(r#"announce {"kind":"system","cause":"session"}"#),
            ),
            (
                LockReason::System { cause: SUSPEND },
                LockOrigin::Backend,
                Some(r#"announce {"kind":"system","cause":"suspend"}"#),
            ),
            // "Bloquear" in the tray.
            (
                LockReason::Manual,
                LockOrigin::Backend,
                Some(r#"announce {"kind":"manual"}"#),
            ),
        ];
        for (reason, origin, announced) in cases {
            let scratch = ScratchDir::new("lock-renews");
            let state = unlocked(scratch.path());
            let window = Recording::over(&state);

            assert!(lock_and_renew(&state, &window, Some(reason), origin).await);

            let mut expected: Vec<String> = announced.map(str::to_owned).into_iter().collect();
            expected.push("renew, session closed: true".into());
            assert_eq!(window.calls(), expected, "{reason:?} from {origin:?}");
        }
    }

    /// A second lock, as the frontend's after the system's, finds no
    /// session: the window is not renewed twice.
    #[tokio::test]
    async fn a_lock_without_a_session_leaves_the_window_alone() {
        let state = Arc::new(AppState::default());
        let window = Recording::over(&state);
        assert!(
            !lock_and_renew(
                &state,
                &window,
                Some(LockReason::Manual),
                LockOrigin::Frontend
            )
            .await
        );
        assert!(
            !lock_and_renew(
                &state,
                &window,
                Some(LockReason::Manual),
                LockOrigin::Backend
            )
            .await
        );
        assert_eq!(window.calls(), Vec::<String>::new());
    }

    /// The window that opens after the lock reads why from the status.
    #[tokio::test]
    async fn the_status_after_a_lock_says_why_until_the_next_unlock() {
        let scratch = ScratchDir::new("lock-reason");
        let state = unlocked(scratch.path());
        let reason = LockReason::Idle { minutes: 5 };
        lock_and_renew(
            &state,
            &Recording::default(),
            Some(reason),
            LockOrigin::Frontend,
        )
        .await;

        let vault = scratch.path().join("vault.bin");
        let inner = state.inner.lock().await;
        let status = storage_cmds::status_of(&inner, scratch.path(), &vault);
        assert_eq!(status.lock_reason, Some(reason));
        assert_eq!(
            serde_json::to_value(status.lock_reason).unwrap(),
            serde_json::json!({ "kind": "idle", "minutes": 5 })
        );
        drop(inner);

        // Open again: no reason while unlocked.
        state.inner.lock().await.identity = Some(create_identity());
        let inner = state.inner.lock().await;
        assert_eq!(
            storage_cmds::status_of(&inner, scratch.path(), &vault).lock_reason,
            None
        );
    }

    /// A lock clears one that waited for the call: it already happened.
    #[tokio::test]
    async fn a_lock_forgets_the_lock_that_waited_for_the_call() {
        let scratch = ScratchDir::new("lock-waiting");
        let state = unlocked(scratch.path());
        state.lock_after_call.store(true, Ordering::SeqCst);
        lock_and_renew(
            &state,
            &Recording::default(),
            Some(LockReason::Manual),
            LockOrigin::Frontend,
        )
        .await;
        assert!(!state.lock_after_call.load(Ordering::SeqCst));
    }

    #[test]
    fn lock_reasons_read_as_the_frontend_sends_them() {
        let read = |json: serde_json::Value| serde_json::from_value::<LockReason>(json).unwrap();
        assert_eq!(
            read(serde_json::json!({ "kind": "manual" })),
            LockReason::Manual
        );
        assert_eq!(
            read(serde_json::json!({ "kind": "idle", "minutes": 1 })),
            LockReason::Idle { minutes: 1 }
        );
        assert_eq!(
            read(serde_json::json!({ "kind": "system", "cause": "suspend" })),
            LockReason::System { cause: SUSPEND }
        );
        assert!(
            serde_json::from_value::<LockReason>(serde_json::json!({ "kind": "cold" })).is_err()
        );
    }
}
