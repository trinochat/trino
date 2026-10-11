//! The system's text size, which the frontend follows by default (Settings >
//! Accessibility > Text size, "Como el sistema").
//!
//! WebView2 does not apply Windows' text size by itself: the host has to
//! (`ICoreWebView2Controller3`). So the app reads it and the frontend sets
//! its root font size from it. On Windows it is `TextScaleFactor` under
//! `HKCU\Software\Microsoft\Accessibility`, a DWORD percentage from 100 to
//! 225 that is absent at 100 %. It is read in-process with `winreg`: running
//! `reg query` failed where the policy that blocks the registry tools is on,
//! started a process on every focus of the window, and `Command::new("reg")`
//! looks in the app's own folder before System32. On the other systems the
//! factor is 1.0: WKWebView does not follow the text size of macOS, and
//! WebKitGTK may already apply GNOME's, which would scale it twice.

/// The factor for the value of `TextScaleFactor`: the percentage over 100,
/// such as 1.25 for 125. No value, or 0, is 1.0. Windows goes up to 225 %;
/// the frontend keeps the factor between 1.0 and 2.0.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn text_scale_from_percent(percent: Option<u32>) -> f32 {
    percent
        .filter(|percent| *percent > 0)
        .map_or(1.0, |percent| percent as f32 / 100.0)
}

/// The system's text size as a factor, such as 1.25 for Windows at 125 %, or
/// 1.0 where it cannot be read. The read runs on a blocking thread, away from
/// the window's.
#[tauri::command]
pub async fn system_text_scale() -> f32 {
    tauri::async_runtime::spawn_blocking(read_text_scale)
        .await
        .unwrap_or(1.0)
}

/// `TextScaleFactor`, read straight from the registry. A missing key or
/// value, or one that is not a DWORD, reads as 100 %.
#[cfg(target_os = "windows")]
fn read_text_scale() -> f32 {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let percent = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Accessibility")
        .and_then(|key| key.get_value::<u32, _>("TextScaleFactor"))
        .ok();
    text_scale_from_percent(percent)
}

#[cfg(not(target_os = "windows"))]
fn read_text_scale() -> f32 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::{read_text_scale, text_scale_from_percent};

    #[test]
    fn reads_the_percentage_as_a_factor() {
        assert_eq!(text_scale_from_percent(Some(100)), 1.0);
        assert_eq!(text_scale_from_percent(Some(125)), 1.25);
        assert_eq!(text_scale_from_percent(Some(150)), 1.5);
    }

    #[test]
    fn passes_225_percent_through_for_the_frontend_to_cap() {
        assert_eq!(text_scale_from_percent(Some(225)), 2.25);
    }

    /// Windows deletes the value when the text size goes back to 100 %.
    #[test]
    fn reads_100_percent_when_the_value_is_missing() {
        assert_eq!(text_scale_from_percent(None), 1.0);
    }

    #[test]
    fn reads_100_percent_from_zero() {
        assert_eq!(text_scale_from_percent(Some(0)), 1.0);
    }

    /// The real read, in this process: whatever this machine is set to, it
    /// is a factor Windows can give, and 1.0 elsewhere.
    #[test]
    fn reads_a_factor_this_system_can_give() {
        let factor = read_text_scale();
        assert!((1.0..=2.25).contains(&factor), "{factor}");
        if cfg!(not(target_os = "windows")) {
            assert_eq!(factor, 1.0);
        }
    }
}
