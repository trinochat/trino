//! The events of the system that lock Trino (cifrado local CL-6a, design
//! §7.2): Windows locked, the session switched, disconnected or logged off
//! (`WTSRegisterSessionNotification`), and the computer going to sleep or
//! hibernating (`RegisterSuspendResumeNotification`, `PBT_APMSUSPEND`).
//!
//! On Windows, a thread of its own keeps a hidden window and its message
//! loop, apart from the WebView, so the events arrive while the WebView is
//! hidden, held back or gone. What each message means is a pure function
//! (`event_of`), tested on every system; what an event does is
//! `commands::lock_cmds`'s.

/// An event of the system that may lock Trino.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SystemEvent {
    /// Windows was locked, or the session switched, disconnected or logged
    /// off: someone else may sit at the screen next.
    SessionLocked,
    /// The computer is going to sleep or to hibernate. Windows waits about
    /// two seconds for this message's answer.
    Suspending,
}

// The messages and codes of the Windows SDK (WinUser.h), here so the
// mapping is tested on every system; the Windows build checks them against
// the `windows` crate.
pub(crate) const WM_WTSSESSION_CHANGE: u32 = 0x02B1;
pub(crate) const WTS_CONSOLE_DISCONNECT: usize = 0x2;
pub(crate) const WTS_REMOTE_DISCONNECT: usize = 0x4;
pub(crate) const WTS_SESSION_LOGOFF: usize = 0x6;
pub(crate) const WTS_SESSION_LOCK: usize = 0x7;
pub(crate) const WM_POWERBROADCAST: u32 = 0x0218;
pub(crate) const PBT_APMSUSPEND: usize = 0x4;

/// The event a window message carries, if it is one that locks.
pub(crate) fn event_of(message: u32, wparam: usize) -> Option<SystemEvent> {
    match (message, wparam) {
        (
            WM_WTSSESSION_CHANGE,
            WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT | WTS_SESSION_LOGOFF,
        ) => Some(SystemEvent::SessionLocked),
        (WM_POWERBROADCAST, PBT_APMSUSPEND) => Some(SystemEvent::Suspending),
        _ => None,
    }
}

/// Hear the events of the system on a thread of its own, for as long as
/// the app runs, and hand each to `on_event` there. Nothing is heard if the
/// hidden window cannot be made: Trino still locks by hand and after the
/// idle minutes.
#[cfg(windows)]
pub(crate) fn listen(on_event: impl Fn(SystemEvent) + Send + Sync + 'static) {
    if HANDLER.set(Box::new(on_event)).is_err() {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("trino-system-events".into())
        .spawn(|| {
            // SAFETY: see `run_message_loop`.
            unsafe { run_message_loop() }
        });
}

#[cfg(windows)]
type Handler = Box<dyn Fn(SystemEvent) + Send + Sync>;

/// What `listen` was given: the window procedure is a plain function.
#[cfg(windows)]
static HANDLER: std::sync::OnceLock<Handler> = std::sync::OnceLock::new();

/// A top-level window that is never shown, so that the broadcast
/// `WM_POWERBROADCAST` of a classic sleep reaches it as well as what it
/// registers for: the session's changes and, with Modern Standby, sleep.
///
/// SAFETY: plain Win32 calls on this thread's own window. The class name
/// and the title are static strings; `msg` lives across the loop; the
/// window procedure touches nothing but `HANDLER`, and catches panics so
/// none unwinds into Windows.
#[cfg(windows)]
unsafe fn run_message_loop() {
    use windows::core::w;
    use windows::Win32::Foundation::{HANDLE, HINSTANCE};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Power::RegisterSuspendResumeNotification;
    use windows::Win32::System::RemoteDesktop::{
        WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassExW, TranslateMessage,
        DEVICE_NOTIFY_WINDOW_HANDLE, MSG, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_OVERLAPPED,
    };

    let Ok(module) = (unsafe { GetModuleHandleW(None) }) else {
        return;
    };
    let instance = HINSTANCE(module.0);
    let class_name = w!("TrinoSystemEvents");
    let class = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(window_procedure),
        hInstance: instance,
        lpszClassName: class_name,
        ..Default::default()
    };
    if unsafe { RegisterClassExW(&class) } == 0 {
        return;
    }
    let Ok(window) = (unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name,
            w!(""),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
    }) else {
        return;
    };
    // Either may fail alone (no Terminal Services, an old system): the
    // other still works.
    let _ = unsafe { WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION) };
    let _ =
        unsafe { RegisterSuspendResumeNotification(HANDLE(window.0), DEVICE_NOTIFY_WINDOW_HANDLE) };

    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn window_procedure(
    window: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    if let (Some(event), Some(handler)) = (event_of(message, wparam.0), HANDLER.get()) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(event)));
    }
    if message == WM_POWERBROADCAST {
        // TRUE: Trino agrees to the change of power state.
        return windows::Win32::Foundation::LRESULT(1);
    }
    // SAFETY: the arguments are the ones Windows passed in.
    unsafe {
        windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(window, message, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locking_switching_disconnecting_and_logging_off_lock_the_session() {
        for code in [
            WTS_SESSION_LOCK,
            WTS_CONSOLE_DISCONNECT,
            WTS_REMOTE_DISCONNECT,
            WTS_SESSION_LOGOFF,
        ] {
            assert_eq!(
                event_of(WM_WTSSESSION_CHANGE, code),
                Some(SystemEvent::SessionLocked),
                "code {code}"
            );
        }
    }

    #[test]
    fn going_to_sleep_or_hibernating_is_suspending() {
        assert_eq!(
            event_of(WM_POWERBROADCAST, PBT_APMSUSPEND),
            Some(SystemEvent::Suspending)
        );
    }

    #[test]
    fn unlocking_waking_up_and_other_messages_lock_nothing() {
        const WTS_CONSOLE_CONNECT: usize = 0x1;
        const WTS_SESSION_LOGON: usize = 0x5;
        const WTS_SESSION_UNLOCK: usize = 0x8;
        const PBT_APMRESUMEAUTOMATIC: usize = 0x12;
        const PBT_APMPOWERSTATUSCHANGE: usize = 0xA;
        for code in [WTS_CONSOLE_CONNECT, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK] {
            assert_eq!(event_of(WM_WTSSESSION_CHANGE, code), None, "code {code}");
        }
        for code in [PBT_APMRESUMEAUTOMATIC, PBT_APMPOWERSTATUSCHANGE] {
            assert_eq!(event_of(WM_POWERBROADCAST, code), None, "code {code}");
        }
        // A lock code under another message.
        assert_eq!(event_of(0x0010, WTS_SESSION_LOCK), None);
    }

    /// The codes here are the SDK's.
    #[cfg(windows)]
    #[test]
    fn the_codes_are_the_windows_sdks() {
        use windows::Win32::UI::WindowsAndMessaging as wm;
        assert_eq!(WM_WTSSESSION_CHANGE, wm::WM_WTSSESSION_CHANGE);
        assert_eq!(WTS_CONSOLE_DISCONNECT, wm::WTS_CONSOLE_DISCONNECT as usize);
        assert_eq!(WTS_REMOTE_DISCONNECT, wm::WTS_REMOTE_DISCONNECT as usize);
        assert_eq!(WTS_SESSION_LOGOFF, wm::WTS_SESSION_LOGOFF as usize);
        assert_eq!(WTS_SESSION_LOCK, wm::WTS_SESSION_LOCK as usize);
        assert_eq!(WM_POWERBROADCAST, wm::WM_POWERBROADCAST);
        assert_eq!(PBT_APMSUSPEND, wm::PBT_APMSUSPEND as usize);
    }
}
