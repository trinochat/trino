//! Tor in the app (Tor design §2.6): when trino-net's `Net` starts Tor,
//! puts it to sleep and stops it, and what the UI gets of its state.
//!
//! | Moment | Tor |
//! |---|---|
//! | Trino opens | the session folders a cut left (`tor/run-*`, private bridges) are destroyed; Tor starts, unless there is no account yet (the first run waits for the person: the "Conexión" step of TOR-6, or creating the account) or it starts at unlock |
//! | Unlock (`open_session`) | the private bridges sealed in the store go to Tor; it starts if it had not, and wakes |
//! | Lock | sleeps; with "Conectar a Tor solo después de desbloquear", or private bridges, stops (lyrebird with it, and the session's folder is destroyed) and forgets the private bridges |
//! | Quit | stops: Arti's runtime goes, and with it its files |
//! | "Borrar todo" | stops, then every file of tor/ is destroyed (storage_cmds.rs) |
//!
//! The UI gets every state as `net-changed` and asks for it with
//! `net_status`. "Conectar sin protección" and "Volver a conectarse de
//! forma privada" are trino-net's `allow_direct` and `back_to_tor`: the
//! first is `net_connect_without_tor`, in commands.rs, the one file of the
//! app allowed to build that permit; the second is `net_back_to_tor`, here.
//! Either way the relays' sockets already open move to the new way, since
//! each client follows `Net::route` (commands.rs, `relay_options`).

use crate::command_error::CommandError;
use crate::state::AppState;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use trino_net::{BridgeLine, Bridges, Net, NetStatus, StartWhen, TorSettings};

/// What the frontend listens to: every change of `NetStatus`.
pub const NET_CHANGED_EVENT: &str = "net-changed";

/// Trino opened, with its data in `home`: make tor/ (kept out of the
/// search index, like the rest of the data folder), destroy the session
/// folders of private bridges a cut left behind (R-01), and start Tor,
/// unless this is the first run or it starts at unlock (decision 11).
pub(crate) fn on_open(net: &Net, home: &Path) {
    let Some(tor_home) = net.tor_home() else {
        return;
    };
    if std::fs::create_dir_all(tor_home).is_ok() {
        let _ = crate::fsutil::mark_not_indexed(tor_home);
    }
    net.destroy_leftover_runs();
    let first_run = !home.join("vault.bin").exists();
    if first_run || TorSettings::load(tor_home).start == StartWhen::OnUnlock {
        return;
    }
    net.start();
}

/// A session opened, with the private bridges its store keeps (`stored`):
/// they go to Tor, and tor/settings.json is put back in step with them
/// (their kind, started at unlock), since a choice made while locked could
/// not reach the store. Then Tor starts if it had not (at unlock, or the
/// first run's account was just made) and wakes. Starting one that runs,
/// or that `run.marker` holds back, does nothing. Without stored lines,
/// what `net` holds stays: the first run's, sealed once the account is.
pub(crate) fn on_unlock(net: &Net, stored: Option<Vec<BridgeLine>>) {
    if let (Some(lines), Some(tor_home)) = (stored, net.tor_home()) {
        let in_step = TorSettings {
            transport: Bridges::Private(lines.clone()).transport(),
            start: StartWhen::OnUnlock,
        };
        if TorSettings::load(tor_home) != in_step {
            let _ = in_step.save(tor_home);
        }
        net.set_private_bridges(Some(lines));
    }
    net.start();
    net.set_dormant(false);
}

/// The session was locked: Tor sleeps while nothing uses it, or stops if
/// it starts at unlock or runs private bridges, which are then forgotten
/// until the next unlock (R-01): stopping ends lyrebird and destroys the
/// session's folder. Blocks while it stops.
pub(crate) fn on_lock(net: &Net) {
    let start = net
        .tor_home()
        .map(|tor_home| TorSettings::load(tor_home).start);
    if start == Some(StartWhen::OnUnlock) || net.has_private_bridges() {
        net.stop();
        net.set_private_bridges(None);
    } else {
        net.set_dormant(true);
    }
}

/// Trino is quitting: Tor stops, so Arti closes its files. Blocks while it
/// stops (11 ms in the spike, at most Arti's 5 s shutdown).
pub(crate) fn on_quit(net: &Net) {
    net.stop();
}

/// The state the UI shows now.
pub(crate) fn status_of(net: &Net) -> NetStatus {
    net.status_now()
}

/// Tell the UI every change of state, from the one there is now.
pub(crate) fn forward_status(app: AppHandle, net: &Net) {
    let mut status = net.status();
    tauri::async_runtime::spawn(async move {
        loop {
            let now = *status.borrow_and_update();
            let _ = app.emit(NET_CHANGED_EVENT, now);
            if status.changed().await.is_err() {
                return;
            }
        }
    });
}

/// The network's state now (`NetStatus`).
#[tauri::command]
pub async fn net_status(state: State<'_, AppState>) -> Result<NetStatus, CommandError> {
    Ok(status_of(&state.net))
}

/// Start Tor, as the first run's "Conexión" step will (TOR-6). Nothing if
/// it runs already.
#[tauri::command]
pub async fn net_start(state: State<'_, AppState>) -> Result<NetStatus, CommandError> {
    let net = Arc::clone(&state.net);
    tokio::task::spawn_blocking(move || {
        net.start();
        status_of(&net)
    })
    .await
    .map_err(|_| CommandError::internal("tor worker failed"))
}

/// "Volver a conectarse de forma privada" (Tor design §2.8): everything
/// goes through Tor again, the relays' open sockets included, and Tor
/// starts if it was not running. Blocks while it starts one.
pub(crate) fn back_to_tor(net: &Net) -> NetStatus {
    net.back_to_tor();
    net.start();
    status_of(net)
}

/// "Volver a conectarse de forma privada", in Ajustes › Privacidad ›
/// Conexión while "Sin protección" lasts.
#[tauri::command]
pub async fn net_back_to_tor(state: State<'_, AppState>) -> Result<NetStatus, CommandError> {
    let net = Arc::clone(&state.net);
    tokio::task::spawn_blocking(move || back_to_tor(&net))
        .await
        .map_err(|_| CommandError::internal("tor worker failed"))
}

/// "Volver a intentar", and "Intentar de nuevo" on the "old version"
/// screen: stop Tor and start it again, forgetting the deaths
/// `run.marker` counted.
#[tauri::command]
pub async fn net_retry(state: State<'_, AppState>) -> Result<NetStatus, CommandError> {
    let net = Arc::clone(&state.net);
    tokio::task::spawn_blocking(move || {
        net.retry();
        status_of(&net)
    })
    .await
    .map_err(|_| CommandError::internal("tor worker failed"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;
    use trino_net::mock::{FakeTor, Forbidden, Mock};
    use trino_net::{Net, NetConfig, NetStatus, StartWhen, TorBackend, TorSettings, TransportKind};

    /// A `Net` whose Tor is a `FakeTor` with its folder at `tor_home`, and
    /// whose direct transport fails the test if touched.
    pub(crate) fn fake_tor(tor_home: &Path) -> (Arc<Net>, Arc<FakeTor>, Arc<Mock>) {
        let mock = Mock::new();
        let fake = FakeTor::new(Arc::clone(&mock));
        let net = Net::with_backend(
            NetConfig {
                tor_home: tor_home.to_path_buf(),
                pt: None,
            },
            Arc::clone(&fake) as Arc<dyn TorBackend>,
            Arc::new(Forbidden),
        );
        (net, fake, mock)
    }

    /// A data folder with an account in it (a vault), and its Tor folder.
    fn with_account(scratch: &ScratchDir) -> std::path::PathBuf {
        std::fs::write(scratch.path().join("vault.bin"), b"vault").unwrap();
        scratch.path().join(crate::state::TOR_DIR)
    }

    pub(crate) async fn becomes(net: &Net, expected: NetStatus) {
        let mut status = net.status();
        let reached = tokio::time::timeout(Duration::from_secs(5), async {
            while *status.borrow_and_update() != expected {
                status.changed().await.unwrap();
            }
        })
        .await;
        assert!(reached.is_ok(), "still {:?}", net.status_now());
    }

    // ---- Decision 11 and §2.6: when Tor starts ----

    #[test]
    fn tor_starts_when_trino_opens_with_an_account() {
        let scratch = ScratchDir::new("tor-open");
        let tor_home = with_account(&scratch);
        let (net, fake, _) = fake_tor(&tor_home);

        on_open(&net, scratch.path());

        assert_eq!(fake.log(), ["launch"]);
        assert!(tor_home.is_dir());
        net.stop();
    }

    #[test]
    fn the_first_run_waits_for_the_person_before_tor() {
        // No account yet: the "Conexión" step (TOR-6), or creating the
        // account, starts it, so whoever needs a bridge picks one before
        // any connection to Tor (§9.2).
        let scratch = ScratchDir::new("tor-first-run");
        let (net, fake, _) = fake_tor(&scratch.path().join(crate::state::TOR_DIR));

        on_open(&net, scratch.path());

        assert!(fake.log().is_empty());
        assert_eq!(net.status_now(), NetStatus::Off);
        on_unlock(&net, None);
        assert_eq!(fake.log(), ["launch", "wake"]);
        net.stop();
    }

    /// Design test 73 (R-25, §10.2).
    #[test]
    fn on_unlock_start_waits_for_the_unlock_and_stops_on_lock() {
        let scratch = ScratchDir::new("tor-on-unlock");
        let tor_home = with_account(&scratch);
        TorSettings {
            transport: TransportKind::None,
            start: StartWhen::OnUnlock,
        }
        .save(&tor_home)
        .unwrap();
        let (net, fake, _) = fake_tor(&tor_home);

        on_open(&net, scratch.path());
        assert!(fake.log().is_empty(), "started before the unlock");

        on_unlock(&net, None);
        assert_eq!(fake.log(), ["launch", "wake"]);

        on_lock(&net);
        assert_eq!(fake.log(), ["launch", "wake", "stop"]);
        assert_eq!(net.status_now(), NetStatus::Off);
    }

    /// Design test 20, the Tor half (lock_cmds.rs has the lock itself).
    #[tokio::test]
    async fn at_lock_a_tor_started_at_open_sleeps_and_wakes_at_unlock() {
        let scratch = ScratchDir::new("tor-sleep");
        let tor_home = with_account(&scratch);
        let (net, fake, _) = fake_tor(&tor_home);
        on_open(&net, scratch.path());
        fake.ready();
        becomes(
            &net,
            NetStatus::Ready {
                transport: TransportKind::None,
            },
        )
        .await;

        on_lock(&net);
        assert_eq!(fake.log(), ["launch", "sleep"]);
        assert!(net.status_now().is_ready(), "asleep, not stopped");

        on_unlock(&net, None);
        assert_eq!(fake.log(), ["launch", "sleep", "wake"], "one Tor");
        net.stop();
    }

    #[test]
    fn quitting_stops_tor() {
        let scratch = ScratchDir::new("tor-quit");
        let tor_home = with_account(&scratch);
        let (net, fake, _) = fake_tor(&tor_home);
        on_open(&net, scratch.path());

        on_quit(&net);

        assert_eq!(fake.log(), ["launch", "stop"]);
    }

    // ---- Design test 16: the folder follows the data folder ----

    #[test]
    fn tor_dirs_live_under_trino_home_and_follow_trino_home() {
        assert_eq!(
            crate::state::tor_home(),
            crate::state::trino_home().join("tor")
        );
        let state = crate::state::AppState::with_tor();
        assert_eq!(
            state.net.tor_home(),
            Some(crate::state::tor_home().as_path())
        );
        // Built, never started: nothing of Arti runs in a test.
        assert_eq!(state.net.status_now(), NetStatus::Off);
    }

    // ---- What the UI gets (TOR-6 builds on it) ----

    #[test]
    fn the_ui_hears_every_state_as_net_changed() {
        assert_eq!(NET_CHANGED_EVENT, "net-changed");
        let net = Net::new();
        assert_eq!(status_of(&net), NetStatus::Off);
    }

    // ---- Design test 28: nothing opens a direct connection ----

    /// Every way out the app has today, on a `Net` in Tor mode whose
    /// direct transport panics: relays, the inspector, an upload, a
    /// download (a sticker without a thumbnail is fetched the same way,
    /// by `fetch_file`), a call's TURN credentials and the news (TOR-10).
    /// Each reaches Tor, by name. The @name, invitations and the updater
    /// come with TOR-9 and TOR-11 and join this test then.
    #[tokio::test]
    async fn the_whole_app_in_tor_mode_opens_nothing_direct() {
        use crate::nostr::{inspector_connector, relay_connector};
        use trino_net::IsoKind;

        let tor = Mock::new();
        let net = Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn trino_net::Transport>),
            Arc::new(Forbidden),
        );
        let session = net.session();
        let me = crate::identity::create_identity();

        // Nobody listens in the Mock: every attempt is refused, after Tor
        // was asked for it.
        let relays = relay_connector(Arc::clone(&net), session.clone(), IsoKind::RELAY);
        assert!(relays("wss://nos.lol".to_string()).await.is_err());
        let inspector = inspector_connector(Arc::clone(&net), session);
        assert!(inspector("wss://nostr.mom".to_string()).await.is_err());
        let blob = b"cipher".to_vec();
        let sha = hex::encode(crate::crypto::sha256(&blob));
        assert!(crate::blossom::upload(&net, &me, &blob, &sha)
            .await
            .is_err());
        assert!(
            crate::blossom::download(&net, "https://evil.example/x", &sha)
                .await
                .is_err()
        );
        let gate = crate::turn::TurnGate::default();
        let client = crate::turn::TurnClient::production(Arc::clone(&net));
        assert!(crate::turn::turn_servers(
            &gate,
            &client,
            gate.session(),
            "0123456789abcdef0123456789abcdef"
        )
        .await
        .is_err());
        let news = trino_net::HttpClient::new(Arc::clone(&net));
        assert_eq!(
            crate::news_cmds::fetch(&news, 1_792_065_600).await.status,
            trino_net::news::NewsStatus::Bundled
        );
        assert!(
            tor.connections()
                .iter()
                .any(|(target, iso)| target.host == "trinochat.org" && iso.kind() == IsoKind::NEWS),
            "the news did not go through Tor"
        );

        let mut hosts: Vec<String> = tor
            .connections()
            .into_iter()
            .map(|(target, _)| format!("{}:{}", target.host, target.port))
            .collect();
        hosts.sort();
        hosts.dedup();
        assert_eq!(
            hosts,
            [
                "blossom.band:443",
                "blossom.primal.net:443",
                "nos.lol:443",
                "nostr.mom:443",
                "trinochat.org:443",
            ]
        );
    }
}
