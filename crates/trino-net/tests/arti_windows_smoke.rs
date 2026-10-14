//! Arti starts on Windows (Tor spike S0, Tor design §2.3 and §6.6).
//!
//! `saturating-time` 0.5.0, which Arti 0.47 uses for every saturating
//! operation on a `SystemTime`, looks for the smallest `SystemTime` with
//! steps down to 1 ns. On Windows a `SystemTime` moves in 100 ns steps, so
//! subtracting less leaves it unchanged and that search never ends: Arti
//! hangs at "15 %: fetching a consensus" with a core busy, because the
//! first such operation is in parsing the consensus. The workspace patches
//! the crate (vendor/saturating-time, `[patch.crates-io]` at the root);
//! these tests fail if that patch is lost, or an Arti update brings the
//! loop back, before a build ships that cannot connect.
//!
//! No network: the consensus is a test one (tests/data). They run on every
//! platform; the hang only ever happened on Windows, where the CI's
//! Windows job runs them.

use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Well past the 93 ms the real consensus takes with the patch.
const LIMIT: Duration = Duration::from_secs(5);

/// `work`'s result, or a failed test if it does not return within `LIMIT`.
/// A thread that hangs is left spinning; the test process ends with it.
fn returns_within_limit<T: Send + 'static>(
    what: &str,
    work: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (done, result) = mpsc::channel();
    thread::spawn(move || {
        let _ = done.send(work());
    });
    result.recv_timeout(LIMIT).unwrap_or_else(|_| {
        panic!("{what} did not return in {LIMIT:?}: saturating-time's Windows loop is back")
    })
}

#[test]
fn the_smallest_system_time_is_found() {
    use saturating_time::SaturatingTime;
    use std::time::SystemTime;

    let min = returns_within_limit("SystemTime::min_value", SystemTime::min_value);

    // It is the smallest: nothing below it.
    assert!(min.checked_sub(Duration::from_secs(1)).is_none());
}

#[test]
fn a_consensus_is_parsed_without_the_network() {
    let text = include_str!("data/mdconsensus1.txt").replace("\r\n", "\n");

    let parsed = returns_within_limit("MdConsensus::parse", move || {
        tor_netdoc::doc::netstatus::MdConsensus::parse(&text)
            .map(|_| ())
            .map_err(|e| e.to_string())
    });

    assert_eq!(parsed, Ok(()));
}
