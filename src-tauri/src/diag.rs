//! The diagnostic log is the engine's (`trino_engine::diag`, M4-0). It
//! stays under its old path here, `crate::diag::…`, and the checks that
//! read the app's own sources stay with them: every line the app logs is
//! fixed text, and only the engine's diag.rs opens the log.

pub(crate) use trino_engine::diag::*;

#[cfg(test)]
mod tests {
    #[test]
    fn every_session_that_opens_cleans_up_by_the_running_build() {
        // Split from the engine's
        // `only_a_debug_build_keeps_a_log_and_the_running_build_decides`:
        // the clean-up whenever a session opens (unseal and forge) goes by
        // the build that is running.
        let commands = include_str!("commands.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let clean_ups = "remove_stale_log(&files.home, crate::diag::Build::CURRENT)";
        assert_eq!(commands.matches(clean_ups).count(), 2, "unseal and forge");
    }

    #[test]
    fn a_wipe_removes_both_logs() {
        // The wipe lives in storage_cmds.rs since cifrado local (CL-1b).
        let storage: String = include_str!("storage_cmds.rs").split_whitespace().collect();
        let wipe = storage
            .split("pub(super)fnwipe_home(")
            .nth(1)
            .and_then(|rest| rest.split("#[cfg(test)]").next())
            .unwrap();
        assert!(
            wipe.contains("crate::diag::LOG_FILE"),
            "wipe leaves a debug build's log behind"
        );
        assert!(
            wipe.contains("crate::diag::LEGACY_LOG_FILE"),
            "wipe leaves the log from before T3 behind"
        );
    }

    /// The calls to the log in `source` whose arguments build text at run
    /// time, with their line numbers. Text built at run time is what can
    /// carry a name, a file name, a key or a prefix of one, an event id or
    /// what a message says.
    fn runtime_text_in_log_calls(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for call in ["dbg_log(", "dlog(", "note(", "note_with("] {
            for (start, _) in source.match_indices(call) {
                let before = source[..start].chars().next_back();
                if before.is_some_and(|c| c.is_alphanumeric() || c == '_')
                    || source[..start].trim_end().ends_with("fn")
                {
                    continue; // a longer name, or the definition
                }
                let args = call_arguments(&source[start + call.len()..]);
                if args.contains("format!") || args.contains("to_string") {
                    let line = source[..start].matches('\n').count() + 1;
                    let first = args.lines().next().unwrap_or_default().trim();
                    found.push(format!("line {line}: {call}{first}"));
                }
            }
        }
        found.sort();
        found
    }

    /// The text of a call's arguments, up to the parenthesis that closes it.
    /// Parentheses inside string literals do not count.
    fn call_arguments(rest: &str) -> &str {
        let (mut depth, mut in_string, mut escaped) = (1usize, false, false);
        for (at, c) in rest.char_indices() {
            if in_string {
                match (escaped, c) {
                    (true, _) => escaped = false,
                    (false, '\\') => escaped = true,
                    (false, '"') => in_string = false,
                    _ => {}
                }
                continue;
            }
            match c {
                '"' => in_string = true,
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        return &rest[..at];
                    }
                }
                _ => {}
            }
        }
        rest
    }

    /// The files that log: the commands module with its child modules (the
    /// contacts, groups, history and profile commands) and the relay client.
    const LOGGING_SOURCES: [(&str, &str); 6] = [
        ("commands.rs", include_str!("commands.rs")),
        ("contacts_cmds.rs", include_str!("contacts_cmds.rs")),
        ("groups_cmds.rs", include_str!("groups_cmds.rs")),
        ("history_cmds.rs", include_str!("history_cmds.rs")),
        ("profile.rs", include_str!("profile.rs")),
        (
            "nostr.rs",
            include_str!("../../crates/trino-engine/src/nostr.rs"),
        ),
    ];

    #[test]
    fn log_lines_are_never_built_from_runtime_values() {
        for (file, source) in LOGGING_SOURCES {
            let found = runtime_text_in_log_calls(source);
            assert!(
                found.is_empty(),
                "{file} logs text built at run time ({} calls):\n{}",
                found.len(),
                found.join("\n")
            );
        }
    }

    #[test]
    fn the_scan_finds_runtime_text_and_passes_fixed_text() {
        let source = r#"
            fn dbg_log(text: &'static str) { crate::diag::note(text); }
            dbg_log("vault locked (a paren)");
            note_with("handshake present", &[("spk_id", &id)]);
            dbg_log(&format!("  OK: text from '{}'", friend.handle));
            dlog(
                &format!("WS EVENT from={}", log_prefix(&event.pubkey, 16)),
            );
            note(reason.to_string());
        "#;
        let found = runtime_text_in_log_calls(source);
        assert_eq!(found.len(), 3, "{found:?}");
        assert!(found[0].contains("friend.handle"), "{found:?}");
    }

    #[test]
    fn only_this_module_opens_the_log() {
        // A second writer could put in the log what this one keeps out.
        for (file, source) in LOGGING_SOURCES {
            assert!(!source.contains("OpenOptions"), "{file} opens files itself");
        }
    }
}
