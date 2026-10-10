//! The system's text size, which the frontend follows by default (Settings >
//! Accessibility > Text size, "Como el sistema").
//!
//! WebView2 does not apply Windows' text size by itself: the host has to
//! (`ICoreWebView2Controller3`). So the app reads it and the frontend sets
//! its root font size from it. On Windows it is `TextScaleFactor` under
//! `HKCU\Software\Microsoft\Accessibility`, a percentage from 100 to 225 that
//! is absent at 100 %; `reg query` reads it without a new dependency. On the
//! other systems the factor is 1.0: WKWebView does not follow the text size
//! of macOS, and WebKitGTK may already apply GNOME's, which would scale it
//! twice.

/// The factor in the output of
/// `reg query HKCU\Software\Microsoft\Accessibility /v TextScaleFactor`: the
/// percentage over 100, such as 1.25 for `0x7d`. Anything else, an absent
/// value included, is 1.0. Windows goes up to 225 %; the frontend keeps the
/// factor between 1.0 and 2.0.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn parse_text_scale(output: &str) -> f32 {
    output
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            match (fields.next(), fields.next(), fields.next()) {
                (Some(name), Some("REG_DWORD"), Some(value))
                    if name.eq_ignore_ascii_case("TextScaleFactor") =>
                {
                    let digits = value
                        .strip_prefix("0x")
                        .or_else(|| value.strip_prefix("0X"))?;
                    u32::from_str_radix(digits, 16).ok()
                }
                _ => None,
            }
        })
        .filter(|percent| *percent > 0)
        .map_or(1.0, |percent| percent as f32 / 100.0)
}

/// The system's text size as a factor, such as 1.25 for Windows at 125 %, or
/// 1.0 where it cannot be read. `reg` runs on a blocking thread, away from the
/// window's.
#[tauri::command]
pub async fn system_text_scale() -> f32 {
    tauri::async_runtime::spawn_blocking(read_text_scale)
        .await
        .unwrap_or(1.0)
}

#[cfg(target_os = "windows")]
fn read_text_scale() -> f32 {
    use std::os::windows::process::CommandExt;
    /// Runs `reg` without flashing a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Accessibility",
            "/v",
            "TextScaleFactor",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map_or(1.0, |output| {
            parse_text_scale(&String::from_utf8_lossy(&output.stdout))
        })
}

#[cfg(not(target_os = "windows"))]
fn read_text_scale() -> f32 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::parse_text_scale;

    const HEADER: &str = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Accessibility\r\n";

    /// What `reg query HKCU\Software\Microsoft\Accessibility /v TextScaleFactor` prints.
    fn reg_output(value: &str) -> String {
        format!("{HEADER}    TextScaleFactor    REG_DWORD    {value}\r\n\r\n")
    }

    #[test]
    fn reads_the_percentage_as_a_factor() {
        assert_eq!(parse_text_scale(&reg_output("0x7d")), 1.25);
        assert_eq!(parse_text_scale(&reg_output("0x64")), 1.0);
        assert_eq!(parse_text_scale(&reg_output("0x96")), 1.5);
    }

    #[test]
    fn passes_225_percent_through_for_the_frontend_to_cap() {
        assert_eq!(parse_text_scale(&reg_output("0xe1")), 2.25);
    }

    #[test]
    fn reads_100_percent_when_the_value_is_absent() {
        assert_eq!(parse_text_scale(""), 1.0);
        assert_eq!(parse_text_scale(HEADER), 1.0);
    }

    #[test]
    fn reads_100_percent_from_anything_else() {
        assert_eq!(parse_text_scale(&reg_output("0xzz")), 1.0);
        assert_eq!(parse_text_scale(&reg_output("0x0")), 1.0);
        assert_eq!(parse_text_scale(&reg_output("125")), 1.0);
        assert_eq!(
            parse_text_scale("    TextScaleFactor    REG_SZ    0x7d\r\n"),
            1.0
        );
        assert_eq!(
            parse_text_scale("    OtherValue    REG_DWORD    0x7d\r\n"),
            1.0
        );
        assert_eq!(
            parse_text_scale(
                "ERROR: The system was unable to find the specified registry key or value."
            ),
            1.0
        );
    }

    #[test]
    fn accepts_capitals_and_spaces_as_reg_prints_them() {
        assert_eq!(
            parse_text_scale("\tTEXTSCALEFACTOR\tREG_DWORD\t0X7D\n"),
            1.25
        );
    }
}
