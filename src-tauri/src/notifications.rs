//! Windows shows a toast only for an app it knows: one with a Start menu
//! shortcut that carries its AppUserModelID (what Tauri's installer makes),
//! or one registered under `HKCU\Software\Classes\AppUserModelId`. The
//! notification plugin sends every toast as `app.trino.chat`, the bundle's
//! identifier (its desktop.rs, unless the exe runs from `target\debug` or
//! `target\release`, where it borrows PowerShell's), so an exe that was not
//! installed got its toasts dropped by Windows without a word, and
//! "Probar notificación" did nothing.
//!
//! At start, then, the app registers its own AppUserModelID when it is
//! missing (the name "Trino Chat" and the app's icon) and takes it as the
//! process's own, so the taskbar, the shortcut and the toasts are the same
//! app. The uninstaller removes the key (windows/hooks.nsh). The plugin
//! names the AppUserModelID on every toast, so the process's own is not
//! what lets a toast through; the registration is.
//!
//! "Probar notificación" goes through `test_notification`, which sends the
//! toast with the same AppUserModelID the plugin uses and says what Windows
//! did with it: shown, notifications off for Trino, off for the whole user,
//! off by a policy, or refused. The plugin itself drops the error.

use serde::Serialize;
use std::path::Path;

/// The bundle's identifier (tauri.conf.json), the AppUserModelID of the
/// installed shortcut and of every toast.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const APP_ID: &str = "app.trino.chat";

/// The name Windows shows on the toasts and in its notification settings.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) const DISPLAY_NAME: &str = "Trino Chat";

/// PowerShell's AppUserModelID, which the plugin borrows when the exe runs
/// from `target\debug` or `target\release` (tauri-winrt-notification's
/// `Toast::POWERSHELL_APP_ID`).
#[cfg_attr(not(windows), allow(dead_code))]
const POWERSHELL_APP_ID: &str =
    "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/// The app's icon, for the toasts of an exe that was not installed.
#[cfg_attr(not(windows), allow(dead_code))]
const ICON: &[u8] = include_bytes!("../icons/128x128.png");

/// What the system did with "Probar notificación".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TestOutcome {
    Shown,
    /// Notifications are off for Trino in Windows' settings.
    OffForApp,
    /// Notifications are off for the whole user.
    OffForUser,
    /// A group policy keeps them off.
    OffByPolicy,
    /// The system would not show it, or failed to.
    Refused,
}

/// The AppUserModelID the plugin gives a toast of the exe in `exe_dir`
/// (tauri-plugin-notification's desktop.rs): the bundle's `identifier`,
/// or PowerShell's when the exe runs from `target\debug` or
/// `target\release`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn toast_app_id(exe_dir: &Path, identifier: &str) -> String {
    let dir = exe_dir.display().to_string();
    if dir.ends_with(r"\target\debug") || dir.ends_with(r"\target\release") {
        POWERSHELL_APP_ID.to_string()
    } else {
        identifier.to_string()
    }
}

/// Why Windows will not show a toast, from the notifier's `Setting`
/// (`NotificationSetting`: 0 enabled, 1 off for the app, 2 off for the
/// user, 3 off by policy, 4 off by the manifest), or `None` when it may.
/// A setting that cannot be read, which is what an AppUserModelID Windows
/// does not know gives, is a refusal.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn refusal(setting: Option<i32>) -> Option<TestOutcome> {
    match setting {
        Some(0) => None,
        Some(1) => Some(TestOutcome::OffForApp),
        Some(2) => Some(TestOutcome::OffForUser),
        Some(3) => Some(TestOutcome::OffByPolicy),
        _ => Some(TestOutcome::Refused),
    }
}

/// The key of `app_id` under `Software\Classes`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn key_path(app_id: &str) -> String {
    format!(r"AppUserModelId\{app_id}")
}

/// Writes the app's icon as `notification-icon.png` in `dir`, unless it is
/// there already, and returns its path.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn write_icon(dir: &Path) -> std::io::Result<std::path::PathBuf> {
    let path = dir.join("notification-icon.png");
    if std::fs::read(&path).ok().as_deref() != Some(ICON) {
        std::fs::create_dir_all(dir)?;
        std::fs::write(&path, ICON)?;
    }
    Ok(path)
}

/// Registers `app_id` under `classes` (`HKCU\Software\Classes`, or a key
/// of the tests): the key, its `DisplayName` when missing, and its
/// `IconUri` when one is given and the key has none, or names a file that
/// is gone. What is there already stays.
#[cfg(windows)]
pub(crate) fn register_in(
    classes: &winreg::RegKey,
    app_id: &str,
    icon: Option<&Path>,
) -> std::io::Result<()> {
    let (key, _) = classes.create_subkey(key_path(app_id))?;
    if key.get_value::<String, _>("DisplayName").is_err() {
        key.set_value("DisplayName", &DISPLAY_NAME)?;
    }
    if let Some(icon) = icon {
        let present = key
            .get_value::<String, _>("IconUri")
            .is_ok_and(|uri| Path::new(&uri).is_file());
        if !present {
            key.set_value("IconUri", &icon.as_os_str())?;
        }
    }
    Ok(())
}

/// At start: the app's AppUserModelID is registered for this user when it
/// is missing, with its icon in the app's local data folder, so Windows
/// shows its toasts whether or not it was installed. A failure leaves the
/// toasts as they were; nothing else depends on it.
#[cfg(windows)]
pub(crate) fn on_start(app: &tauri::AppHandle) {
    use tauri::Manager;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let icon = app
        .path()
        .app_local_data_dir()
        .ok()
        .and_then(|dir| write_icon(&dir).ok());
    let _ = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(r"Software\Classes")
        .and_then(|(classes, _)| register_in(&classes, APP_ID, icon.as_deref()));
}

#[cfg(not(windows))]
pub(crate) fn on_start(_app: &tauri::AppHandle) {}

/// Takes `app_id` as this process's AppUserModelID. Before any window, so
/// the taskbar groups them under it.
#[cfg(windows)]
pub(crate) fn set_process_app_id(app_id: &str) -> windows::core::Result<()> {
    use windows::{core::HSTRING, Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID};
    // SAFETY: a valid, NUL-terminated string that outlives the call.
    unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(app_id)) }
}

/// "Probar notificación": sends `title` and `body` as a message's toast is
/// sent, and says what the system did with it. On Windows the toast goes
/// with the plugin's AppUserModelID, and Windows' answer comes back; the
/// plugin elsewhere, which shows it or fails.
#[tauri::command]
pub async fn test_notification(app: tauri::AppHandle, title: String, body: String) -> TestOutcome {
    #[cfg(windows)]
    {
        let exe_dir = tauri::utils::platform::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_default();
        let app_id = toast_app_id(&exe_dir, &app.config().identifier);
        tauri::async_runtime::spawn_blocking(move || win::show(&app_id, &title, &body))
            .await
            .unwrap_or(TestOutcome::Refused)
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        match app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .sound("default")
            .show()
        {
            Ok(()) => TestOutcome::Shown,
            Err(_) => TestOutcome::Refused,
        }
    }
}

/// The toast through WinRT, the way tauri-winrt-notification sends it.
#[cfg(windows)]
mod win {
    use super::{refusal, TestOutcome};
    use windows::core::{Interface, Result, HSTRING};
    use windows::Data::Xml::Dom::{IXmlNode, XmlDocument};
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

    pub(super) fn show(app_id: &str, title: &str, body: &str) -> TestOutcome {
        let Ok(notifier) =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
        else {
            return TestOutcome::Refused;
        };
        if let Some(refused) = refusal(notifier.Setting().ok().map(|setting| setting.0)) {
            return refused;
        }
        match toast(title, body).and_then(|toast| notifier.Show(&toast)) {
            Ok(()) => TestOutcome::Shown,
            Err(_) => TestOutcome::Refused,
        }
    }

    /// The title and the body as text nodes, so no character of theirs is
    /// read as XML.
    fn toast(title: &str, body: &str) -> Result<ToastNotification> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(
            r#"<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>"#,
        ))?;
        let texts = xml.GetElementsByTagName(&HSTRING::from("text"))?;
        for (index, text) in [title, body].into_iter().enumerate() {
            let node = texts.Item(index as u32)?;
            node.AppendChild(
                &xml.CreateTextNode(&HSTRING::from(text))?
                    .cast::<IXmlNode>()?,
            )?;
        }
        ToastNotification::CreateToastNotification(&xml)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The one the plugin uses is the bundle's identifier.
    #[test]
    fn the_app_id_is_the_bundles_identifier() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
        assert_eq!(conf["productName"], DISPLAY_NAME);
    }

    /// The same choice as the plugin's desktop.rs, so the test toast is
    /// sent as the real ones are.
    #[test]
    fn the_toast_goes_as_the_plugin_sends_it() {
        for dir in [
            r"C:\Users\ana\Downloads",
            r"C:\Users\ana\AppData\Local\Trino Chat",
            r"C:\Users\ana\AppData\Local\trino-build\target-tor\release",
            r"C:\proyectos\trino\target\release\bundle",
        ] {
            assert_eq!(toast_app_id(Path::new(dir), APP_ID), APP_ID, "{dir}");
        }
        for dir in [
            r"C:\proyectos\trino\target\debug",
            r"C:\proyectos\trino\target\release",
        ] {
            assert_eq!(
                toast_app_id(Path::new(dir), APP_ID),
                POWERSHELL_APP_ID,
                "{dir}"
            );
        }
    }

    /// Each of Windows' settings says why, and an unknown app is refused.
    #[test]
    fn windows_settings_say_why() {
        assert_eq!(refusal(Some(0)), None);
        assert_eq!(refusal(Some(1)), Some(TestOutcome::OffForApp));
        assert_eq!(refusal(Some(2)), Some(TestOutcome::OffForUser));
        assert_eq!(refusal(Some(3)), Some(TestOutcome::OffByPolicy));
        assert_eq!(refusal(Some(4)), Some(TestOutcome::Refused));
        assert_eq!(refusal(Some(9)), Some(TestOutcome::Refused));
        assert_eq!(refusal(None), Some(TestOutcome::Refused));
    }

    /// The UI reads these names (src/lib/api.ts, `NotificationTest`).
    #[test]
    fn the_outcomes_are_sent_in_snake_case() {
        let names: Vec<_> = [
            TestOutcome::Shown,
            TestOutcome::OffForApp,
            TestOutcome::OffForUser,
            TestOutcome::OffByPolicy,
            TestOutcome::Refused,
        ]
        .iter()
        .map(|outcome| serde_json::to_value(outcome).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                "shown",
                "off_for_app",
                "off_for_user",
                "off_by_policy",
                "refused"
            ]
        );
    }

    #[test]
    fn the_key_is_under_app_user_model_id() {
        assert_eq!(key_path(APP_ID), r"AppUserModelId\app.trino.chat");
    }

    /// A folder of this test's own, gone when it ends.
    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn the_icon_is_written_once_and_kept() {
        let dir = TempDir(
            std::env::temp_dir().join(format!("trino-test-icon-{:016x}", rand::random::<u64>())),
        );
        let path = write_icon(&dir.0.join("app")).unwrap();
        assert_eq!(path, dir.0.join("app").join("notification-icon.png"));
        assert_eq!(std::fs::read(&path).unwrap(), ICON);
        // A damaged one is written again.
        std::fs::write(&path, b"no").unwrap();
        assert_eq!(write_icon(&dir.0.join("app")).unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), ICON);
    }

    /// The uninstaller removes what the app registered.
    #[test]
    fn the_uninstaller_removes_the_key() {
        let hooks = include_str!("../windows/hooks.nsh").replace("\r\n", "\n");
        let uninstall = &hooks[hooks.find("!macro NSIS_HOOK_POSTUNINSTALL").unwrap()..];
        let uninstall = &uninstall[..uninstall.find("!macroend").unwrap()];
        assert!(
            uninstall.contains(&format!(
                r#"DeleteRegKey HKCU "Software\Classes\{}""#,
                key_path(APP_ID)
            )),
            "{uninstall}"
        );
    }

    /// The app registers itself at start and takes its AppUserModelID
    /// before any window; the test button goes through the command.
    #[test]
    fn the_app_registers_itself_at_start() {
        let lib = include_str!("lib.rs").replace("\r\n", "\n");
        let run = &lib[lib.find("pub fn run()").unwrap()..];
        let builder = run.find("tauri::Builder::default()").unwrap();
        let process = run
            .find("notifications::set_process_app_id(")
            .expect("run() takes the AppUserModelID");
        assert!(process < builder, "before any window");
        let setup = &run[run.find(".setup(").unwrap()..];
        assert!(
            setup.contains("notifications::on_start("),
            "setup registers it"
        );
        assert!(run.contains("notifications::test_notification,"));
    }

    #[cfg(windows)]
    mod registry {
        use super::super::*;
        use super::TempDir;
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};

        /// `HKCU\Software\TrinoTest-<random>`, gone when the test ends:
        /// nothing of the person's own registry is touched.
        struct TestKey {
            path: String,
            key: RegKey,
        }
        impl TestKey {
            fn new() -> Self {
                let path = format!(r"Software\TrinoTest-{:016x}", rand::random::<u64>());
                let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
                    .create_subkey(&path)
                    .unwrap();
                TestKey { path, key }
            }
        }
        impl Drop for TestKey {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.path);
            }
        }

        #[test]
        fn a_missing_key_is_registered_with_the_name_and_the_icon() {
            let classes = TestKey::new();
            let dir = TempDir(
                std::env::temp_dir()
                    .join(format!("trino-test-aumid-{:016x}", rand::random::<u64>())),
            );
            let icon = write_icon(&dir.0).unwrap();
            register_in(&classes.key, APP_ID, Some(&icon)).unwrap();
            let key = classes.key.open_subkey(key_path(APP_ID)).unwrap();
            assert_eq!(
                key.get_value::<String, _>("DisplayName").unwrap(),
                "Trino Chat"
            );
            assert_eq!(
                key.get_value::<String, _>("IconUri").unwrap(),
                icon.to_string_lossy()
            );
        }

        #[test]
        fn without_an_icon_only_the_name() {
            let classes = TestKey::new();
            register_in(&classes.key, APP_ID, None).unwrap();
            let key = classes.key.open_subkey(key_path(APP_ID)).unwrap();
            assert_eq!(
                key.get_value::<String, _>("DisplayName").unwrap(),
                "Trino Chat"
            );
            assert!(key.get_value::<String, _>("IconUri").is_err());
        }

        /// What is there stays, but an icon that is gone is replaced.
        #[test]
        fn what_is_there_stays() {
            let classes = TestKey::new();
            let (key, _) = classes.key.create_subkey(key_path(APP_ID)).unwrap();
            key.set_value("DisplayName", &"Otro nombre").unwrap();
            key.set_value("IconUri", &r"C:\no\existe\icono.png")
                .unwrap();
            let dir = TempDir(
                std::env::temp_dir()
                    .join(format!("trino-test-aumid-{:016x}", rand::random::<u64>())),
            );
            let icon = write_icon(&dir.0).unwrap();
            register_in(&classes.key, APP_ID, Some(&icon)).unwrap();
            assert_eq!(
                key.get_value::<String, _>("DisplayName").unwrap(),
                "Otro nombre"
            );
            assert_eq!(
                key.get_value::<String, _>("IconUri").unwrap(),
                icon.to_string_lossy()
            );
            // A present icon is kept.
            let other = dir.0.join("otro.png");
            std::fs::write(&other, ICON).unwrap();
            key.set_value("IconUri", &other.to_string_lossy().as_ref())
                .unwrap();
            register_in(&classes.key, APP_ID, Some(&icon)).unwrap();
            assert_eq!(
                key.get_value::<String, _>("IconUri").unwrap(),
                other.to_string_lossy()
            );
        }

        /// Only this test process takes it.
        #[test]
        fn the_process_takes_the_app_id() {
            set_process_app_id(APP_ID).unwrap();
            use windows::Win32::UI::Shell::GetCurrentProcessExplicitAppUserModelID;
            // SAFETY: the returned string is the caller's, freed here.
            let id = unsafe {
                let id = GetCurrentProcessExplicitAppUserModelID().unwrap();
                let text = id.to_string().unwrap();
                windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as *const _));
                text
            };
            assert_eq!(id, APP_ID);
        }
    }
}
