//! Starting with Windows (Settings › Notificaciones): the value `trino`
//! under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`, holding the
//! path of the app's exe, so Windows launches it at login and, once
//! unsealed, it receives in the background without being reopened. A no-op
//! on the other systems, so mobile and Linux builds still compile.
//!
//! FIX-2: these were sync commands, which Tauri runs on the window's
//! thread, and each one ran reg.exe and waited for it. Opening Notificaciones
//! reads the switch, so the whole app froze while reg.exe started. The key is
//! now read and written in-process with `winreg`, on a blocking thread, as
//! the text size is (a11y.rs).

/// The Run key, under `HKEY_CURRENT_USER`.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The name of the value in the Run key.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) const VALUE: &str = "trino";

/// What the value holds: the exe's path as it is, without quotes, as
/// `reg add /d` wrote it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn command_line(exe: &std::path::Path) -> String {
    exe.to_string_lossy().into_owned()
}

/// Writes the value into `run` (the Run key, or a key of the tests).
#[cfg(target_os = "windows")]
pub(crate) fn enable_in(run: &winreg::RegKey, exe: &std::path::Path) -> std::io::Result<()> {
    run.set_value(VALUE, &command_line(exe))
}

/// Removes the value from `run`. One that is not there is already off.
#[cfg(target_os = "windows")]
pub(crate) fn disable_in(run: &winreg::RegKey) -> std::io::Result<()> {
    match run.delete_value(VALUE) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Whether `run` has the value, of whatever type, as `reg query /v` said.
#[cfg(target_os = "windows")]
pub(crate) fn is_enabled_in(run: &winreg::RegKey) -> bool {
    run.get_raw_value(VALUE).is_ok()
}

/// Launch trino at login, or stop doing so. The write runs on a blocking
/// thread, away from the window's.
#[tauri::command]
pub async fn set_autostart(enable: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write(enable))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether trino is registered to launch at login. The read runs on a
/// blocking thread, away from the window's; one that fails reads as off.
#[tauri::command]
pub async fn get_autostart() -> bool {
    tauri::async_runtime::spawn_blocking(read)
        .await
        .unwrap_or(false)
}

/// The Run key is created when it is missing, as `reg add` did; turning
/// off a missing key or value is already done.
#[cfg(target_os = "windows")]
fn write(enable: bool) -> Result<(), String> {
    use winreg::{
        enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE},
        RegKey,
    };
    let user = RegKey::predef(HKEY_CURRENT_USER);
    if enable {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let (run, _) = user.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
        enable_in(&run, &exe).map_err(|e| e.to_string())
    } else {
        match user.open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE) {
            Ok(run) => disable_in(&run).map_err(|e| e.to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn write(_enable: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn read() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(RUN_KEY)
        .is_ok_and(|run| is_enabled_in(&run))
}

#[cfg(not(target_os = "windows"))]
fn read() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The value is the exe's path as `reg add /d` wrote it: no quotes, no
    /// arguments, spaces and all.
    #[test]
    fn the_value_is_the_exes_path_as_it_is() {
        let exe = std::path::Path::new(r"C:\Program Files\Trino Chat\trino.exe");
        assert_eq!(command_line(exe), r"C:\Program Files\Trino Chat\trino.exe");
    }

    #[test]
    fn the_key_and_the_value_are_the_ones_reg_used() {
        assert_eq!(RUN_KEY, r"Software\Microsoft\Windows\CurrentVersion\Run");
        assert_eq!(VALUE, "trino");
    }

    /// Both commands are async, so Tauri runs them off the window's
    /// thread: this does not compile when one of them is a sync function.
    #[test]
    fn both_commands_are_async() {
        fn future<F: std::future::Future>(_: F) {}
        future(get_autostart());
        future(set_autostart(false));
    }

    /// Tauri registers the commands of this module, not of commands.rs.
    #[test]
    fn the_app_registers_these_commands() {
        let lib = include_str!("lib.rs");
        let run = &lib[lib.find("pub fn run()").unwrap()..];
        assert!(run.contains("autostart::set_autostart,"));
        assert!(run.contains("autostart::get_autostart,"));
    }

    #[cfg(target_os = "windows")]
    mod registry {
        use super::super::*;
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};

        /// `HKCU\Software\TrinoTest-<random>`, gone when the test ends: the
        /// person's own Run key is never touched.
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
        fn enabling_writes_the_exes_path_as_a_string() {
            let run = TestKey::new();
            let exe = std::path::Path::new(r"C:\Program Files\Trino Chat\trino.exe");
            enable_in(&run.key, exe).unwrap();
            let raw = run.key.get_raw_value(VALUE).unwrap();
            assert_eq!(raw.vtype, winreg::enums::RegType::REG_SZ);
            let written: String = run.key.get_value(VALUE).unwrap();
            assert_eq!(written, r"C:\Program Files\Trino Chat\trino.exe");
            assert!(is_enabled_in(&run.key));
        }

        #[test]
        fn enabling_again_replaces_the_path() {
            let run = TestKey::new();
            enable_in(&run.key, std::path::Path::new(r"C:\old\trino.exe")).unwrap();
            enable_in(&run.key, std::path::Path::new(r"C:\new\trino.exe")).unwrap();
            let written: String = run.key.get_value(VALUE).unwrap();
            assert_eq!(written, r"C:\new\trino.exe");
        }

        #[test]
        fn disabling_removes_the_value_and_nothing_else() {
            let run = TestKey::new();
            run.key.set_value("other", &"C:\\other.exe").unwrap();
            enable_in(&run.key, std::path::Path::new(r"C:\trino.exe")).unwrap();
            disable_in(&run.key).unwrap();
            assert!(!is_enabled_in(&run.key));
            assert!(run.key.get_raw_value(VALUE).is_err());
            let other: String = run.key.get_value("other").unwrap();
            assert_eq!(other, "C:\\other.exe");
        }

        /// `reg delete` of a missing value failed, and the command ignored
        /// it: off stays off.
        #[test]
        fn disabling_when_off_is_fine() {
            let run = TestKey::new();
            disable_in(&run.key).unwrap();
            assert!(!is_enabled_in(&run.key));
        }

        #[test]
        fn a_missing_value_is_off() {
            let run = TestKey::new();
            assert!(!is_enabled_in(&run.key));
        }

        /// `reg query /v trino` succeeded for a value of any type.
        #[test]
        fn a_value_of_another_type_is_on() {
            let run = TestKey::new();
            run.key.set_value(VALUE, &1u32).unwrap();
            assert!(is_enabled_in(&run.key));
        }
    }
}
