//! lyrebird, launched by Trino itself (Tor design §5.1, R-01, R-22, R-24;
//! spike S2 and S13; TOR-7). No network, and never the real lyrebird: the
//! bridge program here is this very test binary, run as `fake_pt` below,
//! which speaks the managed-transport protocol and nothing else. Tor is
//! `FakeTor`, and the direct transport panics if touched.

use crate::mock::{FakeTor, Forbidden, Mock};
use crate::tor::bridges::{self, BridgeLine, Bridges};
use crate::tor::pt::{self, PtError, PtMethod, PtProcess};
use crate::*;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const OBFS4: &str = "obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 \
                     cert=YXJlIGZyZXF1ZW50bHkgZnVsbCBvZiBsaXR0bGUgbWVzc2FnZXMgeW91IGNhbiBmaW5kLg iat-mode=0";
const WEBTUNNEL: &str = "webtunnel [2001:db8::1]:443 0123456789ABCDEF0123456789ABCDEF01234567 \
                         url=https://bridge.example/secret-path ver=0.0.1";

/// A folder of its own under the system's temporary folder, removed at
/// the end. Never ~/.trino.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("trino-pt-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Scratch(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---- The fake bridge program ----

/// When this binary is launched as a bridge program (the managed-transport
/// variables are set), it is one: it answers as `mode` says (an argument
/// `trino-fake-pt=<mode>`), notes in its state folder that it ran, and,
/// unless told otherwise, leaves when its input closes, noting that too.
/// Run as a plain test, it does nothing.
#[test]
fn fake_pt() {
    if std::env::var_os("TOR_PT_MANAGED_TRANSPORT_VER").is_none() {
        return;
    }
    let mode = std::env::args()
        .find_map(|arg| arg.strip_prefix("trino-fake-pt=").map(str::to_string))
        .unwrap_or_default();
    let state = PathBuf::from(std::env::var_os("TOR_PT_STATE_LOCATION").unwrap());
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("ran"), std::process::id().to_string()).unwrap();
    let transports = std::env::var("TOR_PT_CLIENT_TRANSPORTS").unwrap_or_default();
    let mut out = std::io::stdout();
    // The test harness has written "test pt_tests::fake_pt ... " with no
    // end of line: the protocol starts on a line of its own.
    writeln!(out).unwrap();
    match mode.as_str() {
        "ok" | "deaf" => {
            writeln!(out, "VERSION 1").unwrap();
            for (n, name) in transports.split(',').enumerate() {
                writeln!(out, "CMETHOD {name} socks5 127.0.0.1:{}", 47100 + n).unwrap();
            }
            writeln!(out, "CMETHODS DONE").unwrap();
        }
        "env-error" => writeln!(out, "ENV-ERROR no TOR_PT_STATE_LOCATION").unwrap(),
        _ => {}
    }
    out.flush().unwrap();
    if mode == "deaf" {
        // Does not leave when its input closes: only a kill ends it.
        std::thread::sleep(Duration::from_secs(60));
        return;
    }
    let mut line = String::new();
    while std::io::stdin().lock().read_line(&mut line).unwrap_or(0) > 0 {
        line.clear();
    }
    std::fs::write(state.join("stopped"), b"stdin closed").unwrap();
}

/// This test binary as a bridge program in `mode`.
fn fake_args(mode: &str) -> Vec<OsString> {
    [
        "pt_tests::fake_pt",
        "--exact",
        "--nocapture",
        "--test-threads=1",
    ]
    .into_iter()
    .map(OsString::from)
    .chain([OsString::from(format!("trino-fake-pt={mode}"))])
    .collect()
}

fn this_binary() -> PathBuf {
    std::env::current_exe().unwrap()
}

fn sha256_of(path: &Path) -> [u8; 32] {
    Sha256::digest(std::fs::read(path).unwrap()).into()
}

fn launch(mode: &str, state: &Path, protocols: &[&str]) -> Result<PtProcess, PtError> {
    let path = this_binary();
    PtProcess::launch(
        &path,
        &sha256_of(&path),
        &fake_args(mode),
        protocols,
        state,
        Duration::from_secs(20),
    )
}

fn wait_for(what: impl Fn() -> bool) {
    for _ in 0..200 {
        if what() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("never happened");
}

// ---- The managed-transport protocol ----

fn handshake(text: &str, protocols: &[&str]) -> Result<Vec<PtMethod>, PtError> {
    pt::read_handshake(text.as_bytes().lines().map_while(Result::ok), protocols)
}

#[test]
fn the_handshake_gives_one_local_socks_port_per_transport() {
    let methods = handshake(
        "running 1 test\nVERSION 1\nLOG SEVERITY=notice MESSAGE=\"hi\"\n\
         CMETHOD obfs4 socks5 127.0.0.1:41001\nCMETHOD webtunnel socks5 127.0.0.1:41002\n\
         CMETHODS DONE\nanything after\n",
        &["obfs4", "webtunnel"],
    )
    .unwrap();
    assert_eq!(
        methods,
        [
            PtMethod {
                protocol: "obfs4".into(),
                socks: "127.0.0.1:41001".parse().unwrap()
            },
            PtMethod {
                protocol: "webtunnel".into(),
                socks: "127.0.0.1:41002".parse().unwrap()
            },
        ]
    );
}

#[test]
fn a_handshake_that_is_not_right_is_refused() {
    let obfs4 = &["obfs4"][..];
    for (text, why) in [
        ("VERSION-ERROR no-version\n", "version"),
        ("ENV-ERROR no state\n", "environment"),
        (
            "VERSION 1\nCMETHOD-ERROR obfs4 broken\nCMETHODS DONE\n",
            "transport",
        ),
        // Done without the transport asked for.
        ("VERSION 1\nCMETHODS DONE\n", "transport"),
        // Done before saying its version.
        (
            "CMETHOD obfs4 socks5 127.0.0.1:41001\nCMETHODS DONE\n",
            "version",
        ),
        // A SOCKS port anywhere but this computer.
        (
            "VERSION 1\nCMETHOD obfs4 socks5 192.0.2.1:41001\nCMETHODS DONE\n",
            "address",
        ),
        (
            "VERSION 1\nCMETHOD obfs4 socks4 127.0.0.1:41001\nCMETHODS DONE\n",
            "address",
        ),
        // It left before it was done.
        (
            "VERSION 1\nCMETHOD obfs4 socks5 127.0.0.1:41001\n",
            "exited",
        ),
    ] {
        assert_eq!(
            handshake(text, obfs4),
            Err(PtError::Protocol(why)),
            "{text}"
        );
    }
}

// ---- Design test 72 (R-24): the hash before each launch ----

#[test]
fn lyrebird_with_a_wrong_hash_is_never_launched() {
    let scratch = Scratch::new("hash");
    let state = scratch.path().join("lyrebird");
    let path = this_binary();
    let mut wrong = sha256_of(&path);
    wrong[0] ^= 1;

    let launched = PtProcess::launch(
        &path,
        &wrong,
        &fake_args("ok"),
        &["obfs4"],
        &state,
        Duration::from_secs(20),
    );

    assert_eq!(launched.err(), Some(PtError::Mismatch));
    std::thread::sleep(Duration::from_millis(300));
    assert!(!state.join("ran").exists(), "it ran");
}

#[test]
fn a_missing_program_is_told_apart() {
    let scratch = Scratch::new("missing");
    let launched = PtProcess::launch(
        &scratch.path().join("lyrebird.exe"),
        &[0; 32],
        &[],
        &["obfs4"],
        &scratch.path().join("state"),
        Duration::from_secs(1),
    );
    assert_eq!(launched.err(), Some(PtError::Missing));
}

/// While it is checked and launched, the program is held open so that it
/// cannot be changed or removed in between (R-24). Windows only: elsewhere
/// a file open for reading does not stop a write.
#[cfg(windows)]
#[test]
fn the_program_cannot_be_changed_while_it_is_held() {
    let scratch = Scratch::new("held");
    let copy = scratch.path().join("program.bin");
    std::fs::write(&copy, b"lyrebird").unwrap();
    let held = pt::hold(&copy).unwrap();
    assert!(std::fs::OpenOptions::new().write(true).open(&copy).is_err());
    assert!(std::fs::remove_file(&copy).is_err());
    assert!(
        std::fs::read(&copy).is_ok(),
        "reading, as a launch does, still works"
    );
    drop(held);
    assert!(std::fs::remove_file(&copy).is_ok());
}

// ---- Launching and stopping (S2, S13) ----

#[test]
fn trino_launches_lyrebird_and_stopping_closes_its_input() {
    let scratch = Scratch::new("launch");
    let state = scratch.path().join("lyrebird");

    let process = launch("ok", &state, &["obfs4", "snowflake"]).unwrap();

    assert_eq!(
        process.methods(),
        [
            PtMethod {
                protocol: "obfs4".into(),
                socks: "127.0.0.1:47100".parse().unwrap()
            },
            PtMethod {
                protocol: "snowflake".into(),
                socks: "127.0.0.1:47101".parse().unwrap()
            },
        ]
    );
    assert!(state.join("ran").exists());
    assert!(!process.has_exited());

    process.stop();
    assert!(process.has_exited());
    // It left on its own when its input closed, as TOR_PT_EXIT_ON_STDIN_CLOSE asks.
    wait_for(|| state.join("stopped").exists());
}

#[test]
fn a_bridge_program_that_will_not_leave_is_killed() {
    let scratch = Scratch::new("deaf");
    let process = launch("deaf", &scratch.path().join("lyrebird"), &["obfs4"]).unwrap();
    process.stop();
    assert!(process.has_exited());
}

#[test]
fn a_bridge_program_that_says_no_is_stopped_and_refused() {
    let scratch = Scratch::new("env-error");
    assert_eq!(
        launch("env-error", &scratch.path().join("lyrebird"), &["obfs4"]).err(),
        Some(PtError::Protocol("environment"))
    );
    let path = this_binary();
    let silent = PtProcess::launch(
        &path,
        &sha256_of(&path),
        &fake_args("silent"),
        &["obfs4"],
        &scratch.path().join("silent"),
        Duration::from_secs(2),
    );
    assert_eq!(silent.err(), Some(PtError::Timeout));
}

// ---- A `Net` with bridges ----

/// A `Net` whose Tor is a `FakeTor` in `tor_home`, with `pt` as its bridge
/// program, and a direct transport that panics.
fn bridged_net(tor_home: &Path, pt: Option<PtLauncher>) -> (Arc<Net>, Arc<FakeTor>) {
    let fake = FakeTor::new(Mock::new());
    let net = Net::with_backend(
        NetConfig {
            tor_home: tor_home.to_path_buf(),
            pt,
        },
        Arc::clone(&fake) as Arc<dyn TorBackend>,
        Arc::new(Forbidden),
    );
    (net, fake)
}

fn settings(tor_home: &Path, transport: TransportKind) {
    TorSettings {
        transport,
        start: StartWhen::Open,
    }
    .save(tor_home)
    .unwrap();
}

async fn becomes(net: &Net, expected: NetStatus) {
    let mut status = net.status();
    let reached = tokio::time::timeout(Duration::from_secs(10), async {
        while *status.borrow_and_update() != expected {
            status.changed().await.unwrap();
        }
    })
    .await;
    assert!(
        reached.is_ok(),
        "still {:?}, never {expected:?}",
        net.status_now()
    );
}

fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(files_under(&path));
        } else {
            files.push(path);
        }
    }
    files
}

fn runs_in(tor_home: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(tor_home)
        .unwrap()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("run-"))
        })
        .collect()
}

/// Design test 25: the program is the one the host names, and Arti gets
/// the SOCKS port it opened for each transport, as an unmanaged transport.
#[test]
fn the_pt_binary_path_comes_from_the_host() {
    let home = Scratch::new("host-path");
    settings(home.path(), TransportKind::Obfs4);
    let path = this_binary();
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Managed {
            sha256: sha256_of(&path),
            path,
        }),
    );
    net.set_pt_test_args(fake_args("ok"));

    net.start();

    let launch = fake.last_launch().expect("Tor was launched");
    assert_eq!(launch.transport, TransportKind::Obfs4);
    assert_eq!(launch.bridges, bridges::builtin(TransportKind::Obfs4));
    assert_eq!(
        launch.transports,
        [PtMethod {
            protocol: "obfs4".into(),
            socks: "127.0.0.1:47100".parse().unwrap()
        }]
    );
    // Built-in bridges are public: the fixed folders, with lyrebird's
    // state in state/lyrebird.
    assert_eq!(launch.dirs, TorDirs::fixed(home.path()));
    let state = home.path().join("state").join("lyrebird");
    assert!(state.join("ran").exists());

    // Stopping Tor stops lyrebird (S13).
    net.stop();
    wait_for(|| state.join("stopped").exists());
}

/// Design test 69 (R-22).
#[tokio::test]
async fn a_missing_pt_binary_is_its_own_state() {
    let home = Scratch::new("pt-missing");
    settings(home.path(), TransportKind::Snowflake);
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Managed {
            path: home.path().join("lyrebird.exe"),
            sha256: [7; 32],
        }),
    );

    net.start();

    becomes(&net, NetStatus::PtMissing).await;
    assert!(fake.log().is_empty(), "Tor started without its bridges");
    // Never a reason to go without the bridge.
    assert_eq!(net.mode(), Mode::Tor);

    // A build without the program at all says the same.
    let (net, fake) = bridged_net(home.path(), None);
    net.start();
    becomes(&net, NetStatus::PtMissing).await;
    assert!(fake.log().is_empty());
}

#[tokio::test]
async fn a_program_that_is_not_the_one_shipped_is_missing_too() {
    let home = Scratch::new("pt-wrong");
    settings(home.path(), TransportKind::Obfs4);
    let path = this_binary();
    let mut wrong = sha256_of(&path);
    wrong[31] ^= 0x80;
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Managed {
            path,
            sha256: wrong,
        }),
    );
    net.set_pt_test_args(fake_args("ok"));

    net.start();

    becomes(&net, NetStatus::PtMissing).await;
    assert!(fake.log().is_empty());
    assert!(!home.path().join("state/lyrebird/ran").exists());
}

#[tokio::test]
async fn a_kind_with_no_bridge_to_use_never_starts_without_one() {
    // WebTunnel and meek have no built-in bridge: never go without one.
    let home = Scratch::new("no-lines");
    settings(home.path(), TransportKind::Webtunnel);
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    net.start();
    becomes(
        &net,
        NetStatus::Blocked {
            kind: BlockKind::CantBootstrap,
            pct: 0,
        },
    )
    .await;
    assert!(fake.log().is_empty());
}

#[test]
fn an_unmanaged_transport_is_given_to_arti_as_it_is() {
    // iPhone's IPtProxy (M4): someone else runs the program.
    let home = Scratch::new("unmanaged");
    settings(home.path(), TransportKind::Snowflake);
    let socks: std::net::SocketAddr = "127.0.0.1:47200".parse().unwrap();
    let (net, fake) = bridged_net(home.path(), Some(PtLauncher::Unmanaged { socks }));
    net.start();
    let launch = fake.last_launch().unwrap();
    assert_eq!(
        launch.transports,
        [PtMethod {
            protocol: "snowflake".into(),
            socks
        }]
    );
    net.stop();
}

// ---- Design test 51 (R-01): private bridges, a folder per session ----

#[tokio::test]
async fn private_bridges_use_a_per_session_tor_folder_destroyed_on_lock_and_exit() {
    let home = Scratch::new("private");
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    let lines = bridges::parse_pasted(&format!("{OBFS4}\n{WEBTUNNEL}")).unwrap();
    net.set_private_bridges(Some(lines.clone()));
    assert!(net.has_private_bridges());

    net.start();
    let launch = fake.last_launch().unwrap();
    assert_eq!(launch.bridges, lines);
    assert_eq!(launch.transport, TransportKind::Obfs4);
    let protocols: Vec<&str> = launch
        .transports
        .iter()
        .map(|t| t.protocol.as_str())
        .collect();
    assert_eq!(protocols, ["obfs4", "webtunnel"]);
    // Not state/ and cache/: run-<random>/state and run-<random>/cache.
    let runs = runs_in(home.path());
    assert_eq!(runs.len(), 1);
    assert_eq!(launch.dirs.state, runs[0].join("state"));
    assert_eq!(launch.dirs.cache, runs[0].join("cache"));
    // What Arti would keep there: the whole line (F47).
    std::fs::write(launch.dirs.cache.join("dir.sqlite3"), OBFS4).unwrap();
    std::fs::write(launch.dirs.cache.join("dir.sqlite3-wal"), OBFS4).unwrap();
    std::fs::write(launch.dirs.state.join("guards.json"), "192.0.2.10").unwrap();
    fake.ready();
    becomes(
        &net,
        NetStatus::Ready {
            transport: TransportKind::Obfs4,
        },
    )
    .await;

    // Locked (or quit, or wiped): Tor stops and the folder is destroyed.
    net.stop();
    assert!(
        runs_in(home.path()).is_empty(),
        "the session's folder is left"
    );
    for file in files_under(home.path()) {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        assert!(
            !text.contains("192.0.2.10"),
            "{} holds the bridge",
            file.display()
        );
        assert!(
            !text.contains("cert="),
            "{} holds the bridge",
            file.display()
        );
    }
    // tor/settings.json was never written with them.
    assert_eq!(TorSettings::load(home.path()), TorSettings::default());

    // Each start is a session of its own, in a new folder.
    net.start();
    let second = runs_in(home.path());
    assert_eq!(second.len(), 1);
    assert_ne!(second[0], runs[0]);
    // Forgotten at the lock: the next start goes straight to Tor, in the
    // fixed folders, until the unlock hands the lines in again.
    net.stop();
    net.set_private_bridges(None);
    assert!(!net.has_private_bridges());
    net.start();
    assert_eq!(
        fake.last_launch().unwrap().dirs,
        TorDirs::fixed(home.path())
    );
    assert!(fake.last_launch().unwrap().bridges.is_empty());
    net.stop();
}

#[test]
fn the_folders_a_cut_left_are_destroyed_when_trino_opens() {
    let home = Scratch::new("leftover");
    let left = home.path().join("run-0123abcd");
    std::fs::create_dir_all(left.join("cache")).unwrap();
    std::fs::write(left.join("cache/dir.sqlite3"), OBFS4).unwrap();
    std::fs::create_dir_all(home.path().join("state")).unwrap();
    std::fs::write(home.path().join("state/guards.json"), b"kept").unwrap();
    std::fs::write(home.path().join("run.marker"), b"kept").unwrap();
    let (net, _fake) = bridged_net(home.path(), None);

    assert_eq!(net.destroy_leftover_runs(), 1);

    assert!(!left.exists());
    assert!(home.path().join("state/guards.json").exists());
    assert!(
        home.path().join("run.marker").exists(),
        "run.marker is not a run-* folder"
    );
}

#[test]
fn a_destroyed_folder_is_overwritten_before_it_goes() {
    let home = Scratch::new("destroy");
    let run = home.path().join("run-x");
    std::fs::create_dir_all(run.join("a/b")).unwrap();
    std::fs::write(run.join("a/b/c"), b"secret").unwrap();
    std::fs::write(run.join("d"), b"").unwrap();
    // The bytes written over each file are not its own.
    let file = run.join("a/b/c");
    let mut seen = Vec::new();
    crate::tor::dirs::destroy_tree_with(&run, &mut |path: &Path| {
        seen.push(std::fs::read(path).unwrap());
    })
    .unwrap();
    assert!(!run.exists());
    assert!(!file.exists());
    assert!(
        seen.iter().all(|bytes| bytes.as_slice() != b"secret"),
        "{seen:?}"
    );
    assert_eq!(seen.len(), 2);
}

// ---- Remembering what worked, never changing without a tap ----

#[tokio::test]
async fn a_bridge_tried_is_remembered_once_it_works() {
    let home = Scratch::new("try");
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    net.start();
    fake.report(Progress::Bootstrap {
        frac: 0.1,
        ready: false,
        blocked: Some(BlockKind::Filtering),
    });
    becomes(
        &net,
        NetStatus::Blocked {
            kind: BlockKind::Filtering,
            pct: 10,
        },
    )
    .await;

    // "Probar con un puente": Snowflake, by a tap.
    net.try_bridge(TransportKind::Snowflake).unwrap();
    assert_eq!(
        fake.launches(),
        [TransportKind::None, TransportKind::Snowflake]
    );
    assert_eq!(
        TorSettings::load(home.path()).transport,
        TransportKind::None,
        "kept before it works"
    );
    fake.ready();
    becomes(
        &net,
        NetStatus::Ready {
            transport: TransportKind::Snowflake,
        },
    )
    .await;
    wait_for(|| TorSettings::load(home.path()).transport == TransportKind::Snowflake);
    assert_eq!(TorSettings::load(home.path()).start, StartWhen::Open);
    net.stop();
}

#[tokio::test]
async fn a_bridge_tried_that_does_not_work_is_not_kept() {
    let home = Scratch::new("try-fails");
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    net.start();
    net.try_bridge(TransportKind::Obfs4).unwrap();
    // "Volver a intentar" goes back to what was kept.
    net.retry();
    assert_eq!(
        fake.launches(),
        [
            TransportKind::None,
            TransportKind::Obfs4,
            TransportKind::None
        ]
    );
    fake.ready();
    becomes(
        &net,
        NetStatus::Ready {
            transport: TransportKind::None,
        },
    )
    .await;
    assert_eq!(
        TorSettings::load(home.path()).transport,
        TransportKind::None
    );
    net.stop();
}

/// Design test 27: a blocked start keeps its transport until a tap, and a
/// tap only reaches the built-in bridges.
#[tokio::test]
async fn no_transport_change_without_a_tap() {
    let home = Scratch::new("no-tap");
    settings(home.path(), TransportKind::Obfs4);
    let (net, fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    net.start();
    fake.report(Progress::Bootstrap {
        frac: 0.5,
        ready: false,
        blocked: Some(BlockKind::Filtering),
    });
    becomes(
        &net,
        NetStatus::Blocked {
            kind: BlockKind::Filtering,
            pct: 50,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fake.launches(), [TransportKind::Obfs4]);
    assert_eq!(
        TorSettings::load(home.path()).transport,
        TransportKind::Obfs4
    );

    for kind in [
        TransportKind::None,
        TransportKind::Meek,
        TransportKind::Webtunnel,
    ] {
        assert_eq!(
            net.try_bridge(kind),
            Err(NetError::NotPermitted),
            "{kind:?}"
        );
    }
    // Private lines are the person's choice: a try does not replace them.
    net.set_private_bridges(Some(vec![OBFS4.parse::<BridgeLine>().unwrap()]));
    assert_eq!(
        net.try_bridge(TransportKind::Snowflake),
        Err(NetError::NotPermitted)
    );
    assert_eq!(fake.launches(), [TransportKind::Obfs4]);
    net.stop();
}

#[test]
fn the_bridges_a_start_will_use() {
    let home = Scratch::new("in-use");
    let (net, _fake) = bridged_net(home.path(), None);
    assert_eq!(net.bridges(), Bridges::None);
    settings(home.path(), TransportKind::Obfs4);
    assert_eq!(net.bridges(), Bridges::Builtin(TransportKind::Obfs4));
    net.set_private_bridges(Some(vec![OBFS4.parse::<BridgeLine>().unwrap()]));
    assert!(net.bridges().is_private());
    assert!(!net.has_bridge_program());
    let (net, _fake) = bridged_net(
        home.path(),
        Some(PtLauncher::Unmanaged {
            socks: "127.0.0.1:47200".parse().unwrap(),
        }),
    );
    assert!(net.has_bridge_program());
}

// ---- Arti's configuration with bridges ----

#[test]
fn arti_gets_the_bridges_and_their_unmanaged_transports() {
    let home = Scratch::new("arti-bridges");
    let dirs = TorDirs::fixed(home.path());
    let lines = bridges::builtin(TransportKind::Obfs4);
    let transports = [PtMethod {
        protocol: "obfs4".into(),
        socks: "127.0.0.1:47300".parse().unwrap(),
    }];
    let config = tor::arti::config(&dirs, &lines, &transports).expect("a configuration");
    let shown = format!("{config:?}");
    assert!(shown.contains("127.0.0.1:47300"), "{shown}");
    assert!(shown.contains("37.218.245.14"), "{shown}");
    assert!(
        files_under(home.path()).is_empty(),
        "nothing of Arti is made"
    );
}

#[test]
fn arti_needs_a_transport_for_every_bridge() {
    // No SOCKS port for the bridges' transport: the program is missing,
    // and nothing of Arti is made (no network).
    let home = Scratch::new("arti-no-pt");
    let (progress, _reports) = std::sync::mpsc::channel();
    let launched = tor::arti::Arti.launch(tor::Launch {
        dirs: TorDirs::fixed(home.path()),
        transport: TransportKind::Obfs4,
        bridges: bridges::builtin(TransportKind::Obfs4),
        transports: vec![PtMethod {
            protocol: "snowflake".into(),
            socks: "127.0.0.1:47300".parse().unwrap(),
        }],
        progress,
    });
    assert_eq!(launched.err(), Some(LaunchError::PtMissing));
    assert!(files_under(home.path()).is_empty());
}

// ---- With the real lyrebird (by hand) ----

/// Needs a real lyrebird at `TRINO_LYREBIRD` (the one
/// scripts/fetch-lyrebird.sh extracts and checks). No network: lyrebird
/// only opens its SOCKS ports on this computer until something connects.
#[test]
#[ignore = "needs a real lyrebird in TRINO_LYREBIRD"]
fn local_lyrebird_speaks_the_protocol_and_leaves_when_stopped() {
    let path = PathBuf::from(std::env::var_os("TRINO_LYREBIRD").expect("TRINO_LYREBIRD"));
    let scratch = Scratch::new("lyrebird");
    let state = scratch.path().join("lyrebird");
    let protocols = ["obfs4", "snowflake", "webtunnel"];
    let process = PtProcess::launch(
        &path,
        &sha256_of(&path),
        &[],
        &protocols,
        &state,
        Duration::from_secs(15),
    )
    .unwrap();
    let names: Vec<&str> = process
        .methods()
        .iter()
        .map(|m| m.protocol.as_str())
        .collect();
    assert_eq!(names, protocols);
    assert!(process.methods().iter().all(|m| m.socks.ip().is_loopback()));
    let started = std::time::Instant::now();
    process.stop();
    assert!(process.has_exited());
    // It left by itself when its input closed, well before the kill.
    assert!(
        started.elapsed() < Duration::from_millis(1900),
        "{:?}",
        started.elapsed()
    );
}
