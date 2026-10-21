//! Pasted bridge lines (trino-net tor/bridges.rs): text a person copies
//! from a bot, an e-mail or a web page, checked before Arti or lyrebird
//! see it.
//!
//! - `parse_pasted` must not panic, Arti's parser included.
//! - What it takes, stored with `to_stored` and read back, is the same
//!   lines: the store's copy never turns into something else.
//! - A line it takes is within the documented limits.
#![no_main]

use libfuzzer_sys::fuzz_target;
use trino_net::tor::bridges::{parse_pasted, to_stored, MAX_ARGUMENTS, MAX_LINES};

fuzz_target!(|text: &str| {
    let Ok(lines) = parse_pasted(text) else {
        return;
    };
    assert!(!lines.is_empty() && lines.len() <= MAX_LINES);
    for line in &lines {
        let words: Vec<&str> = line.as_str().split(' ').collect();
        assert!(words.len() >= 3, "transport, address and fingerprint");
        let arguments = words[3..].join(";");
        assert!(arguments.len() <= MAX_ARGUMENTS);
        assert!(!line.as_str().contains(['\n', '\r', '\t']));
    }
    let stored = to_stored(&lines);
    let again = parse_pasted(&stored).expect("the stored lines parse again");
    let texts = |lines: &[trino_net::BridgeLine]| -> Vec<String> {
        lines.iter().map(|line| line.as_str().to_string()).collect()
    };
    assert_eq!(texts(&again), texts(&lines));
});
