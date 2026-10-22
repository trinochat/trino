//! The diagnostic log, `trino-gui-debug.log` in the data directory (T3).
//!
//! It exists to find out why something failed in a live test on a
//! developer's own machine, so:
//! - only debug builds write it. A release build never creates it. Before
//!   T3 every build wrote `trino-gui.log`, with names in it: every build
//!   removes that one (`remove_stale_log`), and the log of T3 has a name of
//!   its own so a debug build never appends to it;
//! - a line is fixed text and numbers. `note` takes a `&'static str` and
//!   `Plain` is only for numbers and yes/no, so a line can never carry a
//!   name, a file name, a key or a prefix of one, an event id or anything a
//!   message says.
//!
//! This module is the only writer of the file. The checks that the app's
//! sources log fixed text only, and through here, are in the app's diag.rs.

use std::path::Path;

/// The log a debug build writes.
pub const LOG_FILE: &str = "trino-gui-debug.log";
/// The log every build wrote before T3: contacts' names, file names and
/// key prefixes. Nothing writes it any more.
pub const LEGACY_LOG_FILE: &str = "trino-gui.log";

/// The kind of build that is running: only a debug build keeps the log.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Build {
    Debug,
    Release,
}

impl Build {
    pub const CURRENT: Build = if cfg!(debug_assertions) {
        Build::Debug
    } else {
        Build::Release
    };

    fn keeps_the_log(self) -> bool {
        self == Build::Debug
    }
}

/// A value a log line may show: a number or yes/no, never text.
pub trait Plain: std::fmt::Display {}

impl Plain for bool {}
impl Plain for u8 {}
impl Plain for u16 {}
impl Plain for u32 {}
impl Plain for u64 {}
impl Plain for usize {}
impl Plain for i32 {}
impl Plain for i64 {}

/// Log `text`.
pub fn note(text: &'static str) {
    note_with(text, &[]);
}

/// Log `text` followed by `name=value` for each field.
pub fn note_with(text: &'static str, fields: &[(&'static str, &dyn Plain)]) {
    capture::note(text, fields);
    // Tests never write to the real data directory: the engine's own, and
    // the app's, which build the engine with `test-util`.
    if cfg!(any(test, feature = "test-util")) {
        return;
    }
    // trino_home() honours the mobile sandbox override; dirs::home_dir()
    // points outside the sandbox on Android, where every write would fail.
    let log = crate::state::trino_home().join(LOG_FILE);
    write_line(&log, Build::CURRENT, text, fields);
}

/// Append one line to the log at `path`, if `build` keeps one.
fn write_line(path: &Path, build: Build, text: &str, fields: &[(&str, &dyn Plain)]) {
    use std::io::Write;
    if !build.keeps_the_log() {
        return;
    }
    let mut line = format!(
        "[{}] {}",
        chrono::Utc::now().format("%Y-%m-%d %H:%M:%S"),
        text
    );
    for (name, value) in fields {
        line.push_str(&format!(" {name}={value}"));
    }
    line.push('\n');
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Remove from `home` the log every build wrote before T3, and, in a build
/// that keeps no log, a debug build's log as well, so it leaves none.
/// Called whenever a session opens, so the first unlock after an update
/// removes them. Best effort: there is nothing to tell the user if it fails.
pub fn remove_stale_log(home: &Path, build: Build) {
    let _ = std::fs::remove_file(home.join(LEGACY_LOG_FILE));
    if !build.keeps_the_log() {
        let _ = std::fs::remove_file(home.join(LOG_FILE));
    }
}

/// What the engine's tests see of the log: the lines this thread would
/// write while `capture::lines` runs, without their time (clave de
/// emergencia RC-03: both unlock paths leave the same ones). Outside the
/// engine's tests it keeps nothing.
pub mod capture {
    use super::Plain;
    #[cfg(test)]
    use std::cell::RefCell;

    #[cfg(test)]
    thread_local! {
        static LINES: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    }

    pub(super) fn note(text: &str, fields: &[(&str, &dyn Plain)]) {
        #[cfg(test)]
        LINES.with(|lines| {
            if let Some(lines) = lines.borrow_mut().as_mut() {
                let mut line = text.to_string();
                for (name, value) in fields {
                    line.push_str(&format!(" {name}={value}"));
                }
                lines.push(line);
            }
        });
        #[cfg(not(test))]
        let _ = (text, fields);
    }

    /// What `work` returns, and the lines it logged on this thread.
    #[cfg(test)]
    pub fn lines<R>(work: impl FnOnce() -> R) -> (R, Vec<String>) {
        LINES.with(|lines| *lines.borrow_mut() = Some(Vec::new()));
        let done = work();
        let lines = LINES.with(|lines| lines.borrow_mut().take().unwrap_or_default());
        (done, lines)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;

    #[test]
    fn a_release_build_never_writes_the_log() {
        let scratch = ScratchDir::new("diag-release");
        let log = scratch.path().join(LOG_FILE);

        write_line(&log, Build::Release, "relays connected", &[("up", &1usize)]);

        assert!(!log.exists(), "a release build wrote {LOG_FILE}");
    }

    #[test]
    fn a_debug_build_writes_fixed_text_and_numbers() {
        let scratch = ScratchDir::new("diag-debug");
        let log = scratch.path().join(LOG_FILE);

        write_line(
            &log,
            Build::Debug,
            "relays connected",
            &[("up", &2usize), ("total", &3usize), ("live", &true)],
        );
        write_line(&log, Build::Debug, "vault locked", &[]);

        let written = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2, "{written}");
        assert!(lines[0].starts_with('['), "{written}");
        assert!(
            lines[0].ends_with("] relays connected up=2 total=3 live=true"),
            "{written}"
        );
        assert!(lines[1].ends_with("] vault locked"), "{written}");
    }

    #[test]
    fn only_a_debug_build_keeps_a_log_and_the_running_build_decides() {
        assert!(Build::Debug.keeps_the_log());
        assert!(!Build::Release.keeps_the_log());
        // Every line, and the clean-up whenever a session opens (unseal and
        // forge), go by the build that is running.
        // (The clean-up's, in the app's commands.rs, are checked there.)
        let diag = include_str!("diag.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(diag.contains("write_line(&log, Build::CURRENT, text, fields)"));
    }

    /// What the versions before T3 wrote in every build: names in it.
    const BEFORE_T3: &str = "[2026-10-01 10:00:00] SESSION OPEN handle='ana'\n";

    #[test]
    fn a_release_build_removes_the_log_an_older_version_left() {
        let scratch = ScratchDir::new("diag-stale");
        let log = scratch.path().join("trino-gui.log");
        std::fs::write(&log, BEFORE_T3).unwrap();
        let debug_log = scratch.path().join("trino-gui-debug.log");
        std::fs::write(&debug_log, "[2026-10-11 10:00:00] vault locked\n").unwrap();
        let history = scratch.path().join("history.bin");
        std::fs::write(&history, b"sealed").unwrap();

        remove_stale_log(scratch.path(), Build::Release);

        assert!(
            !log.exists(),
            "the log an older version left is still there"
        );
        assert!(!debug_log.exists(), "a debug build's log is still there");
        assert!(history.exists(), "only the logs go");
        // Nothing left to remove is fine as well.
        remove_stale_log(scratch.path(), Build::Release);
    }

    #[test]
    fn a_debug_build_keeps_its_own_log_and_removes_the_one_from_before_t3() {
        let scratch = ScratchDir::new("diag-keep");
        let before_t3 = scratch.path().join("trino-gui.log");
        std::fs::write(&before_t3, BEFORE_T3).unwrap();
        let own = scratch.path().join("trino-gui-debug.log");
        std::fs::write(&own, "[2026-10-11 10:00:00] vault locked\n").unwrap();

        remove_stale_log(scratch.path(), Build::Debug);

        assert!(!before_t3.exists(), "the log from before T3 is still there");
        assert!(own.exists());
        assert_eq!(LOG_FILE, "trino-gui-debug.log", "it appends to the old log");
    }
}
