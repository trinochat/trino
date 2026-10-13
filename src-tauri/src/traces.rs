//! What Trino leaves outside `~/.trino` through the WebView and Windows
//! (cifrado local CL-6b, design §8 and §12.6, test 70):
//!
//! - **Autofill:** WebView2's "Suggestions" keep what is typed in text
//!   fields, such as a contact's new name or a group's. tauri.conf.json turns
//!   them off for the window (`generalAutofillEnabled`), which every renewed
//!   window takes too.
//! - **The download history:** a file saved from a chat goes through the
//!   WebView, which lists its name, path and time in the profile's history.
//!   Trino clears that list after each download (once it is over), as every
//!   window opens (at start and after each lock, which renews the window) and
//!   on "Borrar todo".
//! - **Minidumps:** a WebView2 process that crashes leaves a minidump, which
//!   may hold what was on screen, in its failure report folder. They are
//!   destroyed as every window opens and on "Borrar todo".
//! - **Windows Error Reporting:** Trino's own process asks for no heap in a
//!   report (`WerSetFlags`) and is excluded from WER for this user
//!   (`WerAddExcludedApplication`), as the app starts. That exclusion is a
//!   value under HKCU that names the program.
//!
//! None of this protects with the computer open (design §8): it removes what
//! the WebView and Windows keep on their own once it is no longer needed.

use std::io;
use std::path::Path;

/// The extension of a minidump.
#[cfg_attr(not(windows), allow(dead_code))]
const MINIDUMP_EXTENSION: &str = "dmp";

/// Destroys the minidumps under `dir` (with `fsutil::destroy_file`) and
/// leaves everything else; returns how many went. A folder that is not
/// there has none.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn remove_minidumps(dir: &Path) -> io::Result<usize> {
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        entries => entries?,
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            removed += remove_minidumps(&path)?;
        } else if kind.is_file()
            && path
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case(MINIDUMP_EXTENSION))
        {
            crate::fsutil::destroy_file(&path)?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Asks Windows to put no heap in a report of this process (`WerSetFlags`
/// with `WER_FAULT_REPORTING_FLAG_NOHEAP`). Only this process: nothing is
/// written anywhere.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn limit_crash_reports() {
    #[cfg(windows)]
    {
        use windows::Win32::System::ErrorReporting::{
            WerSetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP,
        };
        // SAFETY: it takes a flag and sets it for this process.
        let _ = unsafe { WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP) };
    }
}

/// Excludes this program from Windows Error Reporting for this user
/// (`WerAddExcludedApplication`, under HKCU). Not in tests: it writes the
/// registry.
#[cfg(windows)]
pub(crate) fn exclude_from_crash_reports() {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::ErrorReporting::WerAddExcludedApplication;
    let Some(name) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_name().map(|name| name.to_owned()))
    else {
        return;
    };
    let wide: Vec<u16> = name.encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` ends in NUL and outlives the call, which keeps no
    // pointer to it.
    let _ = unsafe { WerAddExcludedApplication(PCWSTR(wide.as_ptr()), false) };
}

/// What every new window needs, at start and after each lock
/// (`window_renewal::prepare`): its downloads leave no history once over,
/// and the history and minidumps of before go.
#[cfg(desktop)]
pub(crate) fn on_new_window(_window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    let _ = _window.with_webview(|webview| {
        // SAFETY: on the main thread, where WebView2 wants its calls, with
        // the controller of a webview that is alive.
        unsafe { win::on_new_webview(&webview.controller()) }
    });
}

/// The download history and the minidumps go now, through the app's
/// window if there is one: on each lock, before the window is renewed, and
/// on "Borrar todo".
#[cfg(desktop)]
pub(crate) fn clear(_app: &tauri::AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        if let Some(window) = _app.get_webview_window(crate::window_renewal::MAIN) {
            let _ = window.with_webview(|webview| {
                // SAFETY: as in `on_new_window`.
                unsafe { win::clear_webview(&webview.controller()) }
            });
        }
    }
}

/// WebView2 through `webview2-com`, the version wry builds.
#[cfg(windows)]
mod win {
    use std::path::PathBuf;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Environment11, ICoreWebView2Profile2,
        ICoreWebView2_13, ICoreWebView2_2, ICoreWebView2_4,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DOWNLOAD_HISTORY, COREWEBVIEW2_DOWNLOAD_STATE,
        COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS,
    };
    use webview2_com::{
        take_pwstr, ClearBrowsingDataCompletedHandler, DownloadStartingEventHandler,
        StateChangedEventHandler,
    };
    use windows::core::{Interface, Result, PWSTR};

    /// A new window: watch its downloads, and clear what is left.
    pub(super) unsafe fn on_new_webview(controller: &ICoreWebView2Controller) {
        let Ok(webview) = controller.CoreWebView2() else {
            return;
        };
        let _ = watch_downloads(&webview);
        clear(&webview);
    }

    pub(super) unsafe fn clear_webview(controller: &ICoreWebView2Controller) {
        if let Ok(webview) = controller.CoreWebView2() {
            clear(&webview);
        }
    }

    /// The download history now, and the minidumps on a thread of their
    /// own, away from the window's.
    unsafe fn clear(webview: &ICoreWebView2) {
        let _ = clear_download_history(webview);
        if let Ok(folder) = failure_report_folder(webview) {
            std::thread::spawn(move || super::remove_minidumps(&folder));
        }
    }

    /// Each download, once over (finished or interrupted), clears the
    /// download history. The default handling of the download stays: the
    /// WebView saves it and shows it as before.
    unsafe fn watch_downloads(webview: &ICoreWebView2) -> Result<()> {
        let mut token = 0i64;
        webview.cast::<ICoreWebView2_4>()?.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(|sender, args| {
                let (Some(webview), Some(args)) = (sender, args) else {
                    return Ok(());
                };
                let mut token = 0i64;
                args.DownloadOperation()?.add_StateChanged(
                    &StateChangedEventHandler::create(Box::new(move |operation, _| {
                        let Some(operation) = operation else {
                            return Ok(());
                        };
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        operation.State(&mut state)?;
                        if state != COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                            let _ = clear_download_history(&webview);
                        }
                        Ok(())
                    })),
                    &mut token,
                )
            })),
            &mut token,
        )
    }

    /// `ClearBrowsingData` with the download history only: the name, path
    /// and time of each file saved through the WebView.
    unsafe fn clear_download_history(webview: &ICoreWebView2) -> Result<()> {
        webview
            .cast::<ICoreWebView2_13>()?
            .Profile()?
            .cast::<ICoreWebView2Profile2>()?
            .ClearBrowsingData(
                COREWEBVIEW2_BROWSING_DATA_KINDS_DOWNLOAD_HISTORY,
                &ClearBrowsingDataCompletedHandler::create(Box::new(|_| Ok(()))),
            )
    }

    /// Where WebView2's processes leave their minidumps.
    unsafe fn failure_report_folder(webview: &ICoreWebView2) -> Result<PathBuf> {
        let environment = webview
            .cast::<ICoreWebView2_2>()?
            .Environment()?
            .cast::<ICoreWebView2Environment11>()?;
        let mut folder = PWSTR::null();
        environment.FailureReportFolderPath(&mut folder)?;
        Ok(PathBuf::from(take_pwstr(folder)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use std::fs;

    /// Design §12.6, test 70: the window of tauri.conf.json, the one every
    /// renewal opens again, has WebView2's autofill off.
    #[test]
    fn general_autofill_is_off() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|window| window["label"] == "main")
            .unwrap()
            .clone();
        let window: tauri::utils::config::WindowConfig = serde_json::from_value(main).unwrap();
        assert!(!window.general_autofill_enabled);
        assert!(window.content_protected, "still out of captures (SC-1)");
    }

    #[test]
    fn minidumps_are_destroyed_and_nothing_else() {
        let dir = ScratchDir::new("minidumps");
        let reports = dir.path().join("Crashpad");
        fs::create_dir_all(reports.join("reports")).unwrap();
        fs::create_dir_all(reports.join("attachments/x")).unwrap();
        fs::write(reports.join("reports/one.dmp"), b"what was on screen").unwrap();
        fs::write(reports.join("attachments/x/two.DMP"), b"more").unwrap();
        fs::write(reports.join("settings.dat"), b"crashpad").unwrap();
        fs::write(reports.join("reports/notes.txt"), b"kept").unwrap();

        assert_eq!(remove_minidumps(&reports).unwrap(), 2);
        assert!(!reports.join("reports/one.dmp").exists());
        assert!(!reports.join("attachments/x/two.DMP").exists());
        assert!(reports.join("settings.dat").exists());
        assert!(reports.join("reports/notes.txt").exists());
        assert_eq!(remove_minidumps(&reports).unwrap(), 0, "twice is nothing");
    }

    #[test]
    fn a_missing_report_folder_has_nothing_to_remove() {
        let dir = ScratchDir::new("minidumps-none");
        assert_eq!(remove_minidumps(&dir.path().join("absent")).unwrap(), 0);
    }

    /// Only this test process: `WerSetFlags` writes nothing anywhere.
    #[cfg(windows)]
    #[test]
    fn the_process_gives_no_heap_to_crash_reports() {
        use windows::Win32::System::ErrorReporting::{
            WerGetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP,
        };
        use windows::Win32::System::Threading::GetCurrentProcess;
        limit_crash_reports();
        // SAFETY: the pseudo handle of this process needs no closing.
        let flags = unsafe { WerGetFlags(GetCurrentProcess()) }.unwrap();
        assert_ne!(flags.0 & WER_FAULT_REPORTING_FLAG_NOHEAP.0, 0);
    }
}
