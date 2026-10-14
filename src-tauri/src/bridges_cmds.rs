//! Bridges in the app (Tor design §5; TOR-7): which lyrebird this build
//! ships and where it is, the person's choice of bridges, and their private
//! lines in the encrypted store. The screens are TOR-8's; these are the
//! commands they use.
//!
//! - lyrebird comes from the Tor Expert Bundle, whose signature
//!   scripts/fetch-lyrebird.sh checks with the Tor Browser Developers key,
//!   and a release build ships it as Tauri's external binary
//!   (tauri.bridges.conf.json), next to TrinoChat.exe. Its SHA-256 for each
//!   target is pinned in binaries/lyrebird.pin, which the build takes in:
//!   trino-net checks it before each launch (R-24). A build with no pin for
//!   its target has no bridge program, and bridges are "missing" (R-22).
//! - A choice: no bridge, a built-in kind (Snowflake, obfs4), or private
//!   lines. tor/settings.json keeps the kind and when Tor starts, nothing
//!   else (R-25); private lines go to `prefs.bin` under `net.bridges`,
//!   sealed in the store, which the frontend neither gets nor can change
//!   (prefs_cmds.rs), and to Tor in memory at each unlock. With them Tor
//!   starts at unlock and stops at lock, in a folder of the session's own
//!   (R-01). Before there is an account (the first run) they live in
//!   memory, and are sealed when the account is made.
//! - "Probar con un puente" tries a built-in kind and keeps it once it
//!   works (trino-net's `try_bridge`); nothing changes without a tap.

use super::*;
use trino_net::tor::bridges::{self, BridgeError, BridgeLine, Bridges, BUILTIN};
use trino_net::{Net, NetStatus, PtLauncher, StartWhen, TorSettings, TransportKind};

/// The key of the private lines in `prefs.bin`.
pub(crate) const NET_BRIDGES: &str = "net.bridges";

/// lyrebird's SHA-256 for each target, as scripts/fetch-lyrebird.sh wrote
/// it.
pub(crate) const LYREBIRD_PIN: &str = include_str!("../binaries/lyrebird.pin");

/// lyrebird's name next to TrinoChat.exe: Tauri drops the target from an
/// external binary's name (spike S9).
pub(crate) const LYREBIRD_FILE: &str = if cfg!(windows) {
    "lyrebird.exe"
} else {
    "lyrebird"
};

/// This build's target, as the pin names it.
const TARGET: &str = if cfg!(all(windows, target_arch = "x86_64", target_env = "msvc")) {
    "x86_64-pc-windows-msvc"
} else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
    "x86_64-unknown-linux-gnu"
} else {
    ""
};

/// The Expert Bundle's version and lyrebird's SHA-256 that `pin` gives
/// `target`: lines of `<target> <version> <sha256>`, `#` for comments.
pub(crate) fn pinned(pin: &str, target: &str) -> Option<(String, [u8; 32])> {
    pin.lines()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .find_map(|line| {
            let mut words = line.split_whitespace();
            if words.next()? != target {
                return None;
            }
            let version = words.next()?.to_string();
            let sha256: [u8; 32] = hex::decode(words.next()?).ok()?.try_into().ok()?;
            Some((version, sha256))
        })
}

/// The bridge program in `dir` (TrinoChat.exe's folder), if the build
/// pinned one.
pub(crate) fn launcher_in(dir: &Path, pin: Option<(String, [u8; 32])>) -> Option<PtLauncher> {
    pin.map(|(_, sha256)| PtLauncher::Managed {
        path: dir.join(LYREBIRD_FILE),
        sha256,
    })
}

/// The app's bridge program: lyrebird next to this executable, with the
/// SHA-256 pinned for this target. Whether the file is there is seen at
/// each start (R-22).
pub(crate) fn lyrebird() -> Option<PtLauncher> {
    let exe = std::env::current_exe().ok()?;
    launcher_in(exe.parent()?, pinned(LYREBIRD_PIN, TARGET))
}

/// What the person chose (TOR-8's screens).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeChoice {
    /// Straight to Tor.
    None,
    /// The built-in bridges of Snowflake or obfs4.
    Builtin { transport: TransportKind },
    /// Pasted lines, the person's private bridges.
    Private { text: String },
}

/// A pasted line that is not a bridge, by its number (from 1; 0 for the
/// text as a whole).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LineError {
    pub line: usize,
    pub error: BridgeError,
}

/// What checking pasted lines found.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Checked {
    /// How many bridges, when every line is one.
    pub lines: usize,
    pub errors: Vec<LineError>,
}

/// What a choice did.
#[derive(Debug, Serialize)]
pub struct BridgesSet {
    /// Whether it was kept; never with errors.
    pub saved: bool,
    pub errors: Vec<LineError>,
    /// The network's state after it: Tor starts again with the choice if
    /// it was running.
    pub status: NetStatus,
}

/// The bridges as the UI shows them: never the lines themselves.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgesInfo {
    /// The kind in use: the private lines' when there are some.
    pub transport: TransportKind,
    /// Whether private lines are in use; `None` while an account is locked
    /// (they are sealed).
    pub private: Option<bool>,
    /// How many private lines.
    pub lines: usize,
    pub start: StartWhen,
    /// Whether this build has the bridge program at all.
    pub program: bool,
    /// The built-in kinds, in the order to try them (§5.3).
    pub builtin: Vec<TransportKind>,
}

fn errors_of(found: Vec<(usize, BridgeError)>) -> Vec<LineError> {
    found
        .into_iter()
        .map(|(line, error)| LineError { line, error })
        .collect()
}

/// Check pasted text, keeping nothing.
pub(crate) fn check(text: &str) -> Checked {
    match bridges::parse_pasted(text) {
        Ok(lines) => Checked {
            lines: lines.len(),
            errors: Vec::new(),
        },
        Err(found) => Checked {
            lines: 0,
            errors: errors_of(found),
        },
    }
}

/// The private lines kept under `net.bridges`, if they are bridges.
pub(crate) fn stored_lines(stored: Option<&str>) -> Option<Vec<BridgeLine>> {
    bridges::parse_pasted(stored?).ok()
}

/// The private lines in a `prefs.bin` as `load_session` read it.
pub(crate) fn stored_in(prefs: Option<&serde_json::Value>) -> Option<Vec<BridgeLine>> {
    stored_lines(prefs?.get(NET_BRIDGES)?.as_str())
}

/// Whether the session in `inner` has a store to seal private lines in.
fn has_store(inner: &InnerState) -> bool {
    inner.identity.is_some()
        && matches!(
            inner.storage.prefs_now(),
            Some((_, PrefsImport::Done | PrefsImport::Pending))
        )
}

/// Keep `choice`: in tor/settings.json, in the store, and in `net` for
/// its next start. `has_account` says whether this device has an account
/// (else this is the first run, and private lines stay in memory until it
/// is made). Bad lines keep nothing.
pub(crate) fn choose(
    inner: &InnerState,
    net: &Net,
    has_account: bool,
    choice: BridgeChoice,
) -> Result<BridgesSet, CommandError> {
    let tor_home = net
        .tor_home()
        .ok_or_else(|| CommandError::internal("no Tor in this build"))?
        .to_path_buf();
    let mut settings = TorSettings::load(&tor_home);
    let private = match choice {
        BridgeChoice::None => {
            settings.transport = TransportKind::None;
            None
        }
        BridgeChoice::Builtin { transport } => {
            if !BUILTIN.contains(&transport) {
                return Err(CommandError::internal("not a built-in bridge"));
            }
            settings.transport = transport;
            None
        }
        BridgeChoice::Private { text } => {
            let text = Zeroizing::new(text);
            match bridges::parse_pasted(&text) {
                Ok(lines) => Some(lines),
                Err(found) => {
                    return Ok(BridgesSet {
                        saved: false,
                        errors: errors_of(found),
                        status: net.status_now(),
                    })
                }
            }
        }
    };
    let needs_program = settings.transport != TransportKind::None || private.is_some();
    if needs_program && !net.has_bridge_program() {
        return Err(CommandError::internal("this build has no bridge program"));
    }
    match &private {
        Some(lines) => {
            if has_account {
                if !has_store(inner) {
                    return Err(super::contacts_cmds::sealed());
                }
                let kept = Zeroizing::new(bridges::to_stored(lines));
                prefs_cmds::set_backend_pref(inner, NET_BRIDGES, Some(&kept))?;
            }
            settings.transport = Bridges::Private(lines.clone()).transport();
            settings.start = StartWhen::OnUnlock;
        }
        None => {
            let had_private = net.has_private_bridges()
                || (has_store(inner) && prefs_cmds::current_map(inner).contains_key(NET_BRIDGES));
            if has_store(inner) {
                prefs_cmds::set_backend_pref(inner, NET_BRIDGES, None)?;
            }
            // Private lines are what made Tor start at unlock; leaving them
            // goes back to starting at open. Any other choice keeps what the
            // person chose with "Conectarse solo después de desbloquear".
            if had_private {
                settings.start = StartWhen::Open;
            }
        }
    }
    settings.save(&tor_home).map_err(|e| CommandError::io(&e))?;
    net.set_private_bridges(private);
    Ok(BridgesSet {
        saved: true,
        errors: Vec::new(),
        status: net.status_now(),
    })
}

/// The first run's private lines, sealed in the account just made.
pub(crate) fn keep_first_run_lines(inner: &InnerState, net: &Net) -> Result<(), CommandError> {
    let Bridges::Private(lines) = net.bridges() else {
        return Ok(());
    };
    if prefs_cmds::current_map(inner).contains_key(NET_BRIDGES) {
        return Ok(());
    }
    let kept = Zeroizing::new(bridges::to_stored(&lines));
    prefs_cmds::set_backend_pref(inner, NET_BRIDGES, Some(&kept))
}

/// The bridges as the UI shows them.
pub(crate) fn info(inner: &InnerState, net: &Net) -> BridgesInfo {
    let settings = net.tor_home().map(TorSettings::load).unwrap_or_default();
    let in_use = net.bridges();
    // Private lines: in Tor's memory, or sealed in an open store; unknown
    // while an account is locked.
    let private_lines = match &in_use {
        Bridges::Private(lines) => Some(lines.len()),
        _ if has_store(inner) => Some(
            stored_lines(
                prefs_cmds::current_map(inner)
                    .get(NET_BRIDGES)
                    .map(String::as_str),
            )
            .map_or(0, |lines| lines.len()),
        ),
        _ => None,
    };
    BridgesInfo {
        transport: in_use.transport(),
        private: private_lines.map(|lines| lines > 0),
        lines: private_lines.unwrap_or(0),
        start: settings.start,
        program: net.has_bridge_program(),
        builtin: BUILTIN.to_vec(),
    }
}

/// "Conectarse solo después de desbloquear" (Tor design §10.2, R-25): Tor
/// starts at unlock and stops at lock, or starts when Trino opens. With
/// private lines it always starts at unlock, so turning it off is refused.
/// What the UI shows after it.
pub(crate) fn set_start_on_unlock(
    inner: &InnerState,
    net: &Net,
    on: bool,
) -> Result<BridgesInfo, CommandError> {
    let tor_home = net
        .tor_home()
        .ok_or_else(|| CommandError::internal("no Tor in this build"))?
        .to_path_buf();
    let shown = info(inner, net);
    if !on && shown.private != Some(false) {
        return Err(CommandError::internal(
            "with private bridges Tor starts at unlock",
        ));
    }
    let mut settings = TorSettings::load(&tor_home);
    settings.start = if on {
        StartWhen::OnUnlock
    } else {
        StartWhen::Open
    };
    settings.save(&tor_home).map_err(|e| CommandError::io(&e))?;
    Ok(info(inner, net))
}

/// Whether this device has an account.
fn has_account() -> bool {
    vault_path().exists()
}

/// Start Tor again with what is kept, if it was running: a choice made
/// before Tor started (the first run's "Conexión" step) waits for it.
async fn restart_if_running(net: &Arc<Net>) -> Result<NetStatus, CommandError> {
    let net = Arc::clone(net);
    tokio::task::spawn_blocking(move || {
        if net.status_now() != NetStatus::Off {
            net.retry();
        }
        net.status_now()
    })
    .await
    .map_err(|_| CommandError::internal("tor worker failed"))
}

/// The bridges as the UI shows them (TOR-8).
#[tauri::command]
pub async fn net_bridges_get(state: State<'_, AppState>) -> Result<BridgesInfo, CommandError> {
    Ok(info(&*state.inner.lock().await, &state.net))
}

/// Check pasted lines without keeping them, for the paste field.
#[tauri::command]
pub async fn net_bridges_check(text: String) -> Result<Checked, CommandError> {
    let text = Zeroizing::new(text);
    Ok(check(&text))
}

/// Keep the person's choice of bridges, and start Tor again with it if it
/// was running.
#[tauri::command]
pub async fn net_bridges_set(
    state: State<'_, AppState>,
    choice: BridgeChoice,
) -> Result<BridgesSet, CommandError> {
    let mut set = {
        let inner = state.inner.lock().await;
        choose(&inner, &state.net, has_account(), choice)?
    };
    if set.saved {
        set.status = restart_if_running(&state.net).await?;
    }
    Ok(set)
}

/// "Conectarse solo después de desbloquear", in Ajustes › Privacidad ›
/// Conexión › Opciones avanzadas. It takes effect at the next lock or
/// opening: Tor keeps running now.
#[tauri::command]
pub async fn net_set_start_on_unlock(
    state: State<'_, AppState>,
    on: bool,
) -> Result<BridgesInfo, CommandError> {
    set_start_on_unlock(&*state.inner.lock().await, &state.net, on)
}

/// "Probar con un puente" (§5.3): start again through the built-in
/// bridges of `transport`, kept once Tor is ready through them.
#[tauri::command]
pub async fn net_bridges_try(
    state: State<'_, AppState>,
    transport: TransportKind,
) -> Result<NetStatus, CommandError> {
    let net = Arc::clone(&state.net);
    tokio::task::spawn_blocking(move || {
        net.try_bridge(transport)
            .map_err(|_| CommandError::internal("not a bridge to try"))?;
        Ok(net.status_now())
    })
    .await
    .map_err(|_| CommandError::internal("tor worker failed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::net_cmds::tests::{becomes, fake_tor};
    use std::collections::BTreeMap;
    use trino_net::{BridgeError, NetStatus, PtLauncher, StartWhen, TorSettings, TransportKind};

    const NOW: i64 = 1_760_000_000;
    const PASSPHRASE: &str = "correct horse battery staple";
    const OBFS4: &str = "obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 \
                         cert=YXJlIGZyZXF1ZW50bHkgZnVsbCBvZiBsaXR0bGUgbWVzc2FnZXMgeW91IGNhbiBmaW5kLg iat-mode=0";

    /// An account in `home`, unlocked as `open_session` fills the session.
    fn unlocked_account(home: &Path) -> InnerState {
        let files = DataFiles::in_home(home.to_path_buf());
        let (me, app) =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap();
        let loaded = load_session(&files, &me, Some(&app), None).unwrap();
        let mut inner = InnerState {
            identity: Some(me),
            ..InnerState::default()
        };
        inner.storage.set(loaded.storage);
        apply_loaded(
            &mut inner,
            loaded.account,
            loaded.history,
            loaded.sessions,
            loaded.profiles,
            NOW,
        );
        inner
    }

    /// A `Net` like the app's, with a bridge program someone else runs (no
    /// process in these tests), and its Tor folder in `home`/tor.
    fn bridged(home: &Path) -> (Arc<trino_net::Net>, Arc<trino_net::mock::FakeTor>) {
        let fake = trino_net::mock::FakeTor::new(trino_net::mock::Mock::new());
        let net = trino_net::Net::with_backend(
            trino_net::NetConfig {
                tor_home: home.join(crate::state::TOR_DIR),
                pt: Some(PtLauncher::Unmanaged {
                    socks: "127.0.0.1:47200".parse().unwrap(),
                }),
            },
            Arc::clone(&fake) as Arc<dyn trino_net::TorBackend>,
            Arc::new(trino_net::mock::Forbidden),
        );
        (net, fake)
    }

    fn private(text: &str) -> BridgeChoice {
        BridgeChoice::Private {
            text: text.to_string(),
        }
    }

    fn settings_of(home: &Path) -> TorSettings {
        TorSettings::load(&home.join(crate::state::TOR_DIR))
    }

    // ---- Where lyrebird is, and which one ----

    #[test]
    fn the_pin_names_lyrebird_for_each_target() {
        let pin = "# a comment\n\
                   x86_64-pc-windows-msvc 15.0.25 6e218e85f9a7ae2481f5402ded822471a9a9d0c7e66b05db3842b93fa5c1f02e\n\
                   x86_64-unknown-linux-gnu 15.0.25 nothex\n";
        let windows = pinned(pin, "x86_64-pc-windows-msvc").unwrap();
        assert_eq!(windows.0, "15.0.25");
        assert_eq!(
            hex::encode(windows.1),
            "6e218e85f9a7ae2481f5402ded822471a9a9d0c7e66b05db3842b93fa5c1f02e"
        );
        assert_eq!(pinned(pin, "x86_64-unknown-linux-gnu"), None, "a bad hash");
        assert_eq!(pinned(pin, "aarch64-apple-darwin"), None);
    }

    #[test]
    fn the_committed_pin_is_the_verified_expert_bundle() {
        // The lyrebird of the Expert Bundle 15.0.25 whose signature the
        // spike checked (S1).
        let (version, sha256) = pinned(LYREBIRD_PIN, "x86_64-pc-windows-msvc").unwrap();
        assert_eq!(version, "15.0.25");
        assert_eq!(
            hex::encode(sha256),
            "6e218e85f9a7ae2481f5402ded822471a9a9d0c7e66b05db3842b93fa5c1f02e"
        );
    }

    /// Design test 25, the host's half: Tauri puts an external binary
    /// next to TrinoChat.exe without its target suffix (spike S9).
    #[test]
    fn the_bridge_program_is_next_to_trino() {
        let dir = Path::new("C:/Program Files/Trino Chat");
        let sha256 = [9; 32];
        assert_eq!(
            launcher_in(dir, Some(("15.0.25".to_string(), sha256))),
            Some(PtLauncher::Managed {
                path: dir.join(LYREBIRD_FILE),
                sha256,
            })
        );
        assert_eq!(launcher_in(dir, None), None, "a build with no pin has none");
        assert_eq!(
            LYREBIRD_FILE,
            if cfg!(windows) {
                "lyrebird.exe"
            } else {
                "lyrebird"
            }
        );
    }

    /// The overlay a release build passes to `tauri build --config`: the
    /// base configuration names no external binary, so a build without
    /// lyrebird (tests, CI, development) still builds.
    #[test]
    fn lyrebird_ships_only_through_the_bridges_config() {
        let base: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(base["bundle"].get("externalBin").is_none());
        let bridges: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.bridges.conf.json")).unwrap();
        assert_eq!(
            bridges["bundle"]["externalBin"],
            serde_json::json!(["binaries/lyrebird"])
        );
        // Its licence (GPL-3.0) goes with it.
        assert!(bridges["bundle"]["resources"]
            .as_object()
            .unwrap()
            .contains_key("binaries/lyrebird-LICENSE.txt"));
    }

    // ---- Design test 18: private lines live in the store ----

    #[test]
    fn private_bridge_lines_live_in_the_store_never_in_tor_settings() {
        let scratch = ScratchDir::new("bridges-store");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());

        let set = choose(&inner, &net, true, private(&format!("Bridge {OBFS4}"))).unwrap();

        assert!(set.errors.is_empty());
        assert!(set.saved);
        // In prefs.bin, sealed in the store.
        let stored = prefs_cmds::current_map(&inner);
        assert_eq!(
            stored.get(NET_BRIDGES).map(String::as_str),
            Some(
                OBFS4
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .as_str()
            )
        );
        // tor/settings.json: the kind, and to start at unlock (R-25).
        assert_eq!(
            settings_of(scratch.path()),
            TorSettings {
                transport: TransportKind::Obfs4,
                start: StartWhen::OnUnlock,
            }
        );
        let text = std::fs::read_to_string(scratch.path().join("tor/settings.json")).unwrap();
        assert!(!text.contains("192.0.2.10"), "{text}");
        assert!(!text.contains("private"), "{text}");
        // In memory for the next start.
        assert!(net.has_private_bridges());

        // The frontend never gets them, and cannot change or drop them.
        let (shown, _) = prefs_cmds::prefs_of(&inner);
        assert!(shown.unwrap_or_default().get(NET_BRIDGES).is_none());
        assert!(prefs_cmds::get_in(&inner)
            .unwrap()
            .unwrap_or_default()
            .get(NET_BRIDGES)
            .is_none());
        let mut from_frontend = BTreeMap::new();
        from_frontend.insert(NET_BRIDGES.to_string(), "obfs4 1.2.3.4:5 x".to_string());
        from_frontend.insert("autolock".to_string(), "5".to_string());
        prefs_cmds::save_in(&inner, &from_frontend).unwrap();
        let kept = prefs_cmds::current_map(&inner);
        assert!(kept[NET_BRIDGES].contains("192.0.2.10"));
        assert_eq!(kept["autolock"], "5");
        prefs_cmds::save_in(&inner, &BTreeMap::new()).unwrap();
        assert!(prefs_cmds::current_map(&inner).contains_key(NET_BRIDGES));

        // And they read back as the lines they were.
        let read = stored_lines(
            prefs_cmds::current_map(&inner)
                .get(NET_BRIDGES)
                .map(String::as_str),
        )
        .unwrap();
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].transport(), TransportKind::Obfs4);
    }

    #[test]
    fn bad_lines_save_nothing_and_say_where() {
        let scratch = ScratchDir::new("bridges-bad");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());

        let set = choose(
            &inner,
            &net,
            true,
            private(&format!("{OBFS4}\nobfs3 1.2.3.4:5")),
        )
        .unwrap();

        assert!(!set.saved);
        assert_eq!(
            set.errors,
            [LineError {
                line: 2,
                error: BridgeError::UnknownTransport
            }]
        );
        assert!(!prefs_cmds::current_map(&inner).contains_key(NET_BRIDGES));
        assert_eq!(settings_of(scratch.path()), TorSettings::default());
        assert!(!net.has_private_bridges());
        // Checking is the same, and keeps nothing either.
        assert_eq!(
            check("obfs3 1.2.3.4:5").errors,
            [LineError {
                line: 1,
                error: BridgeError::UnknownTransport
            }]
        );
        assert_eq!(check(OBFS4).lines, 1);
    }

    #[test]
    fn a_built_in_choice_or_none_forgets_the_private_lines() {
        let scratch = ScratchDir::new("bridges-builtin");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());
        choose(&inner, &net, true, private(OBFS4)).unwrap();

        let set = choose(
            &inner,
            &net,
            true,
            BridgeChoice::Builtin {
                transport: TransportKind::Snowflake,
            },
        )
        .unwrap();

        assert!(set.saved);
        assert!(!prefs_cmds::current_map(&inner).contains_key(NET_BRIDGES));
        assert!(!net.has_private_bridges());
        assert_eq!(
            settings_of(scratch.path()),
            TorSettings {
                transport: TransportKind::Snowflake,
                start: StartWhen::Open,
            }
        );

        choose(&inner, &net, true, BridgeChoice::None).unwrap();
        assert_eq!(settings_of(scratch.path()), TorSettings::default());

        // Only the built-in kinds there are.
        for transport in [
            TransportKind::Meek,
            TransportKind::Webtunnel,
            TransportKind::None,
        ] {
            assert!(choose(&inner, &net, true, BridgeChoice::Builtin { transport }).is_err());
        }
    }

    // ---- §10.2 and R-25: "Conectarse solo después de desbloquear" ----

    #[test]
    fn the_start_at_unlock_option_is_kept_and_a_bridge_choice_keeps_it() {
        let scratch = ScratchDir::new("bridges-start-option");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());

        let shown = set_start_on_unlock(&inner, &net, true).unwrap();
        assert_eq!(shown.start, StartWhen::OnUnlock);
        assert_eq!(settings_of(scratch.path()).start, StartWhen::OnUnlock);

        // A built-in bridge, or none, keeps what the person chose.
        let builtin = BridgeChoice::Builtin {
            transport: TransportKind::Snowflake,
        };
        choose(&inner, &net, true, builtin).unwrap();
        assert_eq!(
            settings_of(scratch.path()),
            TorSettings {
                transport: TransportKind::Snowflake,
                start: StartWhen::OnUnlock,
            }
        );
        choose(&inner, &net, true, BridgeChoice::None).unwrap();
        assert_eq!(settings_of(scratch.path()).start, StartWhen::OnUnlock);

        let shown = set_start_on_unlock(&inner, &net, false).unwrap();
        assert_eq!(shown.start, StartWhen::Open);
        assert_eq!(settings_of(scratch.path()), TorSettings::default());
    }

    #[test]
    fn with_private_lines_tor_always_starts_at_unlock() {
        // The switch is on and fixed (PropTorSimple, card 6): turning it off
        // is refused and changes nothing.
        let scratch = ScratchDir::new("bridges-start-private");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());
        choose(&inner, &net, true, private(OBFS4)).unwrap();

        assert!(set_start_on_unlock(&inner, &net, false).is_err());
        assert_eq!(settings_of(scratch.path()).start, StartWhen::OnUnlock);
        assert_eq!(
            set_start_on_unlock(&inner, &net, true).unwrap().start,
            StartWhen::OnUnlock
        );
    }

    #[test]
    fn a_locked_account_cannot_take_private_lines() {
        let scratch = ScratchDir::new("bridges-locked");
        let (net, _fake) = bridged(scratch.path());
        let locked = InnerState::default();
        assert!(choose(&locked, &net, true, private(OBFS4)).is_err());
        assert!(!net.has_private_bridges());
        // A built-in kind needs no store.
        assert!(
            choose(
                &locked,
                &net,
                true,
                BridgeChoice::Builtin {
                    transport: TransportKind::Obfs4
                }
            )
            .unwrap()
            .saved
        );
    }

    #[test]
    fn a_build_without_lyrebird_offers_no_bridges() {
        let scratch = ScratchDir::new("bridges-none");
        let inner = unlocked_account(scratch.path());
        let (net, _fake, _mock) = fake_tor(&scratch.path().join("tor"));
        assert!(choose(&inner, &net, true, private(OBFS4)).is_err());
        assert!(choose(&inner, &net, true, BridgeChoice::None).is_ok());
        assert!(!info(&inner, &net).program);
    }

    #[test]
    fn lines_pasted_before_the_account_are_sealed_when_it_is_made() {
        // The first run (§2.5): no store yet, so memory only.
        let scratch = ScratchDir::new("bridges-first-run");
        let (net, _fake) = bridged(scratch.path());
        let set = choose(&InnerState::default(), &net, false, private(OBFS4)).unwrap();
        assert!(set.saved);
        assert!(net.has_private_bridges());

        let inner = unlocked_account(scratch.path());
        keep_first_run_lines(&inner, &net).unwrap();

        assert!(prefs_cmds::current_map(&inner)[NET_BRIDGES].contains("192.0.2.10"));
    }

    #[test]
    fn what_the_ui_is_told() {
        let scratch = ScratchDir::new("bridges-info");
        let inner = unlocked_account(scratch.path());
        let (net, _fake) = bridged(scratch.path());
        let shown = info(&inner, &net);
        assert_eq!(shown.transport, TransportKind::None);
        assert_eq!(shown.private, Some(false));
        assert!(shown.program);
        assert_eq!(
            shown.builtin,
            [TransportKind::Snowflake, TransportKind::Obfs4]
        );

        choose(&inner, &net, true, private(OBFS4)).unwrap();
        let shown = info(&inner, &net);
        assert_eq!(shown.private, Some(true));
        assert_eq!(shown.lines, 1);
        assert_eq!(shown.transport, TransportKind::Obfs4);
        assert_eq!(shown.start, StartWhen::OnUnlock);
        // Nothing of the lines themselves.
        let json = serde_json::to_string(&shown).unwrap();
        assert!(!json.contains("192.0.2.10"), "{json}");

        // Locked, the store cannot say.
        net.set_private_bridges(None);
        assert_eq!(info(&InnerState::default(), &net).private, None);
    }

    // ---- The lifecycle (§2.6) with private bridges ----

    #[tokio::test]
    async fn at_unlock_the_stored_lines_reach_tor_and_at_lock_they_go() {
        let scratch = ScratchDir::new("bridges-unlock");
        let inner = unlocked_account(scratch.path());
        let (net, fake) = bridged(scratch.path());
        choose(&inner, &net, true, private(OBFS4)).unwrap();
        net.set_private_bridges(None);

        // The unlock reads them from the store and hands them to Tor.
        let stored = stored_lines(
            prefs_cmds::current_map(&inner)
                .get(NET_BRIDGES)
                .map(String::as_str),
        );
        crate::net_cmds::on_unlock(&net, stored);
        let launch = fake.last_launch().unwrap();
        assert_eq!(launch.bridges.len(), 1);
        let run = launch.dirs.state.parent().unwrap().to_path_buf();
        assert!(run
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("run-"));
        fake.ready();
        becomes(
            &net,
            NetStatus::Ready {
                transport: TransportKind::Obfs4,
            },
        )
        .await;

        // The lock stops Tor, destroys the session's folder and forgets them.
        crate::net_cmds::on_lock(&net);
        assert!(!run.exists());
        assert!(!net.has_private_bridges());
        assert_eq!(net.status_now(), NetStatus::Off);
    }

    #[test]
    fn an_unlock_puts_the_settings_back_in_step_with_the_stored_lines() {
        // A built-in chosen while locked does not replace the private lines
        // (they are sealed): the next unlock uses them again.
        let scratch = ScratchDir::new("bridges-step");
        let (net, fake) = bridged(scratch.path());
        TorSettings {
            transport: TransportKind::Snowflake,
            start: StartWhen::Open,
        }
        .save(&scratch.path().join("tor"))
        .unwrap();
        let lines = trino_net::tor::bridges::parse_pasted(OBFS4).ok();
        crate::net_cmds::on_unlock(&net, lines);
        assert_eq!(
            settings_of(scratch.path()),
            TorSettings {
                transport: TransportKind::Obfs4,
                start: StartWhen::OnUnlock,
            }
        );
        assert_eq!(fake.last_launch().unwrap().transport, TransportKind::Obfs4);
        net.stop();
    }

    #[test]
    fn trino_opening_destroys_the_folders_a_cut_left() {
        let scratch = ScratchDir::new("bridges-leftover");
        std::fs::write(scratch.path().join("vault.bin"), b"vault").unwrap();
        let run = scratch.path().join("tor").join("run-0123");
        std::fs::create_dir_all(run.join("cache")).unwrap();
        std::fs::write(run.join("cache/dir.sqlite3"), OBFS4).unwrap();
        let (net, _fake) = bridged(scratch.path());
        crate::net_cmds::on_open(&net, scratch.path());
        assert!(!run.exists());
        net.stop();
    }

    // ---- Design test 70 (R-22) ----

    #[test]
    fn lyrebird_is_excluded_from_wer_at_every_start() {
        // Whatever the bridges: the value in HKCU says only that Trino is
        // installed, never that bridges are used.
        let names = crate::traces::excluded_from_crash_reports();
        assert!(names.iter().any(|name| name == "lyrebird.exe"), "{names:?}");
        let this = std::env::current_exe().unwrap();
        let this = this.file_name().unwrap();
        assert!(names.iter().any(|name| name == this), "{names:?}");
    }
}
