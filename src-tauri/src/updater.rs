//! Trino's updater in the app (Tor design §6, TOR-9): when it checks, what
//! the UI is told, asking before installing, and running the installer.
//! Checking the mirrors and the signatures is trino-net's
//! (`trino_net::update`), so the engine M4 extracts keeps it.
//!
//! - **Once a day** at a random time, with Trino open, locked too, and only
//!   while "Buscar actualizaciones cada día" is on (on by default, decision
//!   4; kept in `tor/update.json`). Each check asks the news and every
//!   mirror through Tor in a session of its own (§2.7, §7). "Buscar ahora"
//!   is `update_check_now`. Without Tor ("Conectar sin Tor") nothing is
//!   asked (§2.8); with Tor not ready nothing goes direct, and the check is
//!   tried again later.
//! - **A newer release** is downloaded through Tor and verified against the
//!   updater's key before anything is kept, and held open (Windows) so
//!   nobody changes it before it runs. Then the UI is told `ready` and
//!   asks: "Trino {version} está listo para instalar." [Instalar y
//!   reiniciar] [Ver novedades] [Más tarde]. **Nothing installs without
//!   that yes** (`update_install`, §6.3).
//! - **Installing:** during a call it waits for the hang-up; then the
//!   session locks, Tor stops (lyrebird with it: the installer must be able
//!   to replace lyrebird.exe, spike S9), and the NSIS installer runs per
//!   user, passive, over the installed Trino, and starts Trino again
//!   (`/P /UPDATE /R`). Trino leaves. The installer's hook renames a
//!   lyrebird.exe still running, as a backup (src-tauri/windows/hooks.nsh).
//! - **Linux, running as an AppImage** (TOR-13): the release is staged
//!   beside the running AppImage, verified, and the UI is told `ready`, as
//!   on Windows. On the yes, as on Windows, the session locks and Tor
//!   stops (lyrebird with it); then the staged file is checked once more,
//!   given the old mode and execute, synced and renamed over the AppImage
//!   (trino-net's `StagedAppImage::replace`), and Trino starts again from
//!   it and leaves (`relaunch`). Never sudo.
//! - **Linux otherwise** (a .deb or an .rpm, an AppImage in a folder Trino
//!   cannot write, or one that is gone) installs nothing (§6.1): the
//!   verified AppImage is left in Downloads and the UI is told `saved`,
//!   with why.
//! - **Arti obsolete** (§6.5, R-15): on the "old version" screen, after its
//!   confirmation, `update_check_without_tor` checks and downloads without
//!   Tor with the updater's own permit, which reaches trinochat.org and
//!   GitHub only, and with the same signature check. This file and
//!   commands.rs are the only ones that may build a permit (§2.8).
//!
//! The UI gets every change as `update-changed` (`UpdateInfo`); its
//! screens wait for the mockups (TOR-6).

use crate::command_error::{CommandError, ErrorCode};
use crate::state::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;
use trino_net::news::{Freeze, Version};
use trino_net::update::{
    self, AppImageError, HeldInstaller, Mirrors, NotInPlace, Platform, StagedAppImage, UpdateError,
    UpdateSettings,
};
use trino_net::{DirectPermit, HttpClient, Net};

/// What the frontend listens to: every change of `UpdateInfo`.
pub const UPDATE_CHANGED_EVENT: &str = "update-changed";

/// How Trino runs the NSIS installer (spike S9, tauri-plugin-updater's
/// passive mode): `/P` passive (a progress bar, no questions), `/UPDATE`
/// over the installed Trino without uninstalling it, `/R` starting Trino
/// again when done. Per user, so no administrator is asked for.
pub const INSTALLER_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"];

/// How often a waiting install looks whether the call ended.
const CALL_POLL: Duration = Duration::from_millis(500);

/// The longest the daily loop sleeps before it looks at the clock again:
/// a computer that slept through a due time checks soon after it wakes.
const LOOK_AGAIN: Duration = Duration::from_secs(10 * 60);

/// The folder of its own where Windows keeps a downloaded installer, under
/// the user's temporary folder (§6.1). Linux without Downloads keeps one of
/// the same name, private, in Trino's local data folder (TRN-NET-03).
const OWN_FOLDER: &str = "TrinoChat-update";

/// Where the updater is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UpdateState {
    /// No releases are made for this platform.
    Unsupported,
    /// Nothing checked yet in this run.
    Idle,
    Checking,
    /// No mirror offers a newer release.
    UpToDate,
    Downloading {
        version: String,
    },
    /// Downloaded, verified and held: the UI asks before installing.
    Ready {
        version: String,
    },
    /// Linux: the verified release is in Downloads; nothing installs.
    Saved {
        version: String,
        file: String,
        reason: SavedReason,
    },
    /// "Instalar y reiniciar" during a call: it waits for the hang-up.
    WaitingForCall {
        version: String,
    },
    /// The session locked, Tor stopped and the installer starting.
    Installing {
        version: String,
    },
    Failed {
        reason: UpdateFailure,
    },
}

/// Why a Linux release was saved in Downloads instead of replacing the
/// running AppImage.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SavedReason {
    /// Not running as an AppImage: a .deb or an .rpm.
    NotAppImage,
    /// The AppImage Trino runs from is gone.
    Missing,
    /// Its folder is not Trino's to write.
    NotWritable,
}

impl From<NotInPlace> for SavedReason {
    fn from(why: NotInPlace) -> Self {
        match why {
            NotInPlace::Missing => SavedReason::Missing,
            NotInPlace::NotWritable => SavedReason::NotWritable,
        }
    }
}

/// Why a check, a download or an install gave nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateFailure {
    /// "Conectar sin Tor": updates wait for Tor.
    WithoutTor,
    /// Tor is not ready: never a reason to go direct.
    TorNotReady,
    /// No mirror answered.
    NoAnswer,
    Download,
    /// The installer is not the one signed.
    Signature,
    /// It could not be kept on disk.
    Io,
    /// The installer did not start.
    Install,
}

impl From<UpdateError> for UpdateFailure {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::WithoutTor => UpdateFailure::WithoutTor,
            UpdateError::TorNotReady => UpdateFailure::TorNotReady,
            UpdateError::NoAnswer => UpdateFailure::NoAnswer,
            UpdateError::Download(_) => UpdateFailure::Download,
            UpdateError::Signature => UpdateFailure::Signature,
            UpdateError::Io => UpdateFailure::Io,
        }
    }
}

/// What the UI gets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub state: UpdateState,
    /// The version running.
    pub installed: String,
    /// "Buscar actualizaciones cada día".
    pub daily: bool,
    /// Whether updates look frozen, as the last daily check weighed the
    /// news against the mirrors (§6.4).
    pub freeze: Option<Freeze>,
}

/// What installing needs from the app: Tauri in the app, a recorder in the
/// tests.
pub(crate) trait InstallHost {
    /// Lock the session, as "Bloquear" does.
    async fn lock(&self);
    /// Stop Tor, and lyrebird with it.
    async fn stop_tor(&self);
    /// Start Tor again, after an installer that did not start.
    async fn start_tor(&self);
    /// Start the installer at `path` with `args`.
    fn launch(&self, path: &Path, args: &[&str]) -> std::io::Result<()>;
    /// Leave, so the installer can replace Trino.
    fn exit(&self);
    /// Leave, and start the AppImage just replaced (Linux).
    fn relaunch(&self);
}

/// What waits for the yes, verified.
enum Prepared {
    /// Windows: the NSIS installer, held open until it runs.
    Installer(HeldInstaller),
    /// Linux: the AppImage staged beside the running one.
    AppImage(StagedAppImage),
}

impl Prepared {
    fn version(&self) -> Version {
        match self {
            Prepared::Installer(installer) => installer.version(),
            Prepared::AppImage(staged) => staged.version(),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0)
}

/// The version this build is: the bundle's (tauri.conf.json), which is
/// the crate's.
pub(crate) fn installed() -> Version {
    env!("CARGO_PKG_VERSION")
        .parse()
        .expect("the crate's version is major.minor.patch")
}

/// Where a downloaded release goes (TRN-NET-03).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ReleaseDir {
    /// A folder only the user reaches already: Downloads on Linux, the
    /// user's own temporary folder on Windows.
    Users(PathBuf),
    /// Linux without Downloads: a folder of Trino's own in its local data
    /// folder, made and checked private (0700, a real folder, not a link)
    /// before each download.
    Private(PathBuf),
    /// Linux with neither: nothing is saved, rather than in the shared
    /// temporary folder, where another local user could take the name first.
    Nowhere,
}

/// Where a Linux release is saved: Downloads when the system names one, else
/// a private folder in Trino's local data folder; never the shared /tmp. A
/// relative folder would land wherever Trino was started, so it is none.
pub(crate) fn linux_release_dir(
    downloads: Option<PathBuf>,
    app_data: Option<PathBuf>,
) -> ReleaseDir {
    let absolute = |dir: &PathBuf| dir.is_absolute();
    match (downloads.filter(absolute), app_data.filter(absolute)) {
        (Some(downloads), _) => ReleaseDir::Users(downloads),
        (None, Some(data)) => ReleaseDir::Private(data.join(OWN_FOLDER)),
        (None, None) => ReleaseDir::Nowhere,
    }
}

/// Where releases go before Trino has looked for Downloads: on Windows the
/// folder of its own in the user's temporary folder (§6.1); on Linux nowhere
/// yet, since its temporary folder is shared.
pub(crate) fn default_release_dir(linux: bool, temp: &Path) -> ReleaseDir {
    if linux {
        ReleaseDir::Nowhere
    } else {
        ReleaseDir::Users(temp.join(OWN_FOLDER))
    }
}

/// Make `dir` a folder of the user's alone: created with mode 0700, a real
/// folder and not a link, owned by whoever owns its parent (Trino's data
/// folder) and closed to everyone else (TRN-NET-03).
#[cfg(unix)]
pub(crate) fn private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    let refused = |why: &str| std::io::Error::other(why.to_string());
    let parent = dir.parent().ok_or_else(|| refused("no parent folder"))?;
    std::fs::create_dir_all(parent)?;
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => return Err(error),
        _ => {}
    }
    let found = std::fs::symlink_metadata(dir)?;
    if !found.file_type().is_dir() {
        return Err(refused("not a folder of its own"));
    }
    if found.uid() != std::fs::metadata(parent)?.uid() {
        return Err(refused("a folder of someone else"));
    }
    if found.permissions().mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Elsewhere the folder is under the user's own data folder already.
#[cfg(not(unix))]
pub(crate) fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

/// The app's updater.
pub struct Updater {
    platform: Option<Platform>,
    installed: Version,
    mirrors: Mirrors<'static>,
    /// Where a downloaded release goes.
    dir: Mutex<ReleaseDir>,
    /// Linux: the AppImage Trino runs from, which a release replaces.
    appimage: Mutex<Option<PathBuf>>,
    state: Mutex<UpdateState>,
    freeze: Mutex<Option<Freeze>>,
    /// The verified release, waiting for the yes.
    held: Mutex<Option<Prepared>>,
    /// One check or download at a time.
    busy: tokio::sync::Mutex<()>,
    installing: AtomicBool,
    /// Rings on every change, for `update-changed`.
    changed: tokio::sync::watch::Sender<u64>,
    /// Rings when the switch changes, for the daily loop.
    wake: tokio::sync::Notify,
}

impl Default for Updater {
    fn default() -> Self {
        Updater::new(
            Platform::current(),
            installed(),
            Mirrors::trino(),
            std::env::temp_dir().join(OWN_FOLDER),
        )
        .with_release_dir(default_release_dir(
            cfg!(target_os = "linux"),
            &std::env::temp_dir(),
        ))
    }
}

impl Updater {
    pub(crate) fn new(
        platform: Option<Platform>,
        installed: Version,
        mirrors: Mirrors<'static>,
        dir: PathBuf,
    ) -> Self {
        let state = if platform.is_some() {
            UpdateState::Idle
        } else {
            UpdateState::Unsupported
        };
        Updater {
            platform,
            installed,
            mirrors,
            dir: Mutex::new(ReleaseDir::Users(dir)),
            appimage: Mutex::new(None),
            state: Mutex::new(state),
            freeze: Mutex::new(None),
            held: Mutex::new(None),
            busy: tokio::sync::Mutex::new(()),
            installing: AtomicBool::new(false),
            changed: tokio::sync::watch::channel(0).0,
            wake: tokio::sync::Notify::new(),
        }
    }

    fn with_release_dir(self, dir: ReleaseDir) -> Self {
        self.set_release_dir(dir);
        self
    }

    /// Download releases into `dir` instead (Linux: Downloads, or a
    /// private folder of Trino's own).
    pub(crate) fn set_release_dir(&self, dir: ReleaseDir) {
        *lock(&self.dir) = dir;
    }

    /// The folder to download into now: a private one is made and checked
    /// first, and with nowhere to save nothing is downloaded (TRN-NET-03).
    pub(crate) fn release_path(&self) -> Result<PathBuf, UpdateError> {
        match lock(&self.dir).clone() {
            ReleaseDir::Users(dir) => Ok(dir),
            ReleaseDir::Private(dir) => {
                private_dir(&dir).map(|()| dir).map_err(|_| UpdateError::Io)
            }
            ReleaseDir::Nowhere => Err(UpdateError::Io),
        }
    }

    /// Linux, running as an AppImage: releases replace `appimage`.
    pub(crate) fn set_appimage(&self, appimage: PathBuf) {
        *lock(&self.appimage) = Some(appimage);
    }

    /// When Trino opens on Windows: the installers an earlier update left
    /// in the folder of its own go. Never anything else.
    pub(crate) fn remove_leftovers(&self) {
        let ReleaseDir::Users(dir) = lock(&self.dir).clone() else {
            return;
        };
        if dir.file_name().is_some_and(|name| name == OWN_FOLDER) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    pub(crate) fn state(&self) -> UpdateState {
        lock(&self.state).clone()
    }

    fn set(&self, state: UpdateState) {
        *lock(&self.state) = state;
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
    }

    /// What the UI gets now.
    pub(crate) fn info(&self, net: &Net) -> UpdateInfo {
        UpdateInfo {
            state: self.state(),
            installed: self.installed.to_string(),
            daily: net
                .tor_home()
                .map(UpdateSettings::load)
                .unwrap_or_default()
                .daily,
            freeze: lock(&self.freeze).clone(),
        }
    }

    /// "Buscar actualizaciones cada día", on or off: kept, and the daily
    /// loop told.
    pub(crate) fn set_daily(&self, net: &Net, on: bool) -> std::io::Result<()> {
        if let Some(tor_home) = net.tor_home() {
            UpdateSettings::set_daily(tor_home, on)?;
        }
        self.wake.notify_one();
        self.changed.send_modify(|n| *n = n.wrapping_add(1));
        Ok(())
    }

    /// One check through `client` at `now`, and the download of a newer
    /// release. Through Tor it is a daily check (the news and the mirrors,
    /// §6.4); through the updater's permit, the mirrors only. Returns
    /// whether a mirror answered; nothing when a check runs already, or
    /// during an install.
    pub(crate) async fn check(&self, client: &HttpClient, now: u64) -> bool {
        let Some(platform) = self.platform else {
            return false;
        };
        let Ok(_busy) = self.busy.try_lock() else {
            return false;
        };
        if self.installing.load(Ordering::SeqCst) {
            return false;
        }
        self.set(UpdateState::Checking);
        let check = if client.is_for_update() {
            let session = client.net().session();
            let source = self.mirrors.source;
            update::check(
                client,
                &session,
                source,
                self.mirrors.key,
                platform,
                self.installed,
            )
            .await
        } else {
            let daily = update::daily(client, &self.mirrors, platform, self.installed, now).await;
            *lock(&self.freeze) = daily.news.freeze;
            daily.check
        };
        let check = match check {
            Ok(check) => check,
            Err(error) => {
                self.set(self.kept_or(UpdateState::Failed {
                    reason: error.into(),
                }));
                return false;
            }
        };
        let Some(offer) = check.newer else {
            self.set(self.kept_or(UpdateState::UpToDate));
            return true;
        };
        let held = lock(&self.held).as_ref().map(Prepared::version);
        if held.is_some_and(|held| held >= offer.version) {
            self.set(self.kept_or(UpdateState::UpToDate));
            return true;
        }

        self.set(UpdateState::Downloading {
            version: offer.version.to_string(),
        });
        let state = self.prepare(client, platform, &offer).await;
        self.set(state);
        true
    }

    /// Download `offer` and get it ready for the yes: on Windows the
    /// installer, held; on Linux the AppImage, staged beside the running
    /// one, or else saved in Downloads.
    async fn prepare(
        &self,
        client: &HttpClient,
        platform: Platform,
        offer: &update::Offer,
    ) -> UpdateState {
        let version = offer.version.to_string();
        let session = client.net().session();
        let (source, key) = (self.mirrors.source, self.mirrors.key);
        let reason = match platform {
            Platform::WindowsX64 => {
                let dir = match self.release_path() {
                    Ok(dir) => dir,
                    Err(error) => {
                        return self.kept_or(UpdateState::Failed {
                            reason: error.into(),
                        })
                    }
                };
                return match update::download(client, &session, source, key, offer, &dir).await {
                    Ok(installer) => self.ready(Prepared::Installer(installer)),
                    Err(error) => self.kept_or(UpdateState::Failed {
                        reason: error.into(),
                    }),
                };
            }
            Platform::LinuxX64 => {
                let appimage = lock(&self.appimage).clone();
                match appimage {
                    None => SavedReason::NotAppImage,
                    Some(appimage) => {
                        match update::download_appimage(
                            client, &session, source, key, offer, &appimage,
                        )
                        .await
                        {
                            Ok(staged) => return self.ready(Prepared::AppImage(staged)),
                            Err(AppImageError::NotInPlace(why)) => why.into(),
                            Err(AppImageError::Update(error)) => {
                                return self.kept_or(UpdateState::Failed {
                                    reason: error.into(),
                                })
                            }
                        }
                    }
                }
            }
        };
        // Saved in Downloads: Trino installs nothing itself.
        let dir = match self.release_path() {
            Ok(dir) => dir,
            Err(error) => {
                return self.kept_or(UpdateState::Failed {
                    reason: error.into(),
                })
            }
        };
        match update::download(client, &session, source, key, offer, &dir).await {
            Ok(installer) => {
                let file = installer.path().display().to_string();
                drop(installer);
                UpdateState::Saved {
                    version,
                    file,
                    reason,
                }
            }
            Err(error) => self.kept_or(UpdateState::Failed {
                reason: error.into(),
            }),
        }
    }

    /// `prepared` waits for the yes: the UI asks.
    fn ready(&self, prepared: Prepared) -> UpdateState {
        let version = prepared.version().to_string();
        *lock(&self.held) = Some(prepared);
        UpdateState::Ready { version }
    }

    /// `state`, unless a verified release waits: then it stays ready.
    fn kept_or(&self, state: UpdateState) -> UpdateState {
        match lock(&self.held).as_ref() {
            Some(held) => UpdateState::Ready {
                version: held.version().to_string(),
            },
            None => state,
        }
    }

    /// "Instalar y reiniciar", the yes the UI asked for (§6.3). Only with
    /// a verified release waiting. During a call (`call_active`) it waits
    /// for the hang-up; then the session locks and Tor stops. On Windows
    /// the installer starts and Trino leaves; if it does not start, Tor
    /// starts again and the installer stays held for another try. On Linux
    /// the staged AppImage replaces the running one, and Trino starts again
    /// from it; if it cannot (it fails its last check, or the AppImage is
    /// gone), Tor starts again, the staged file goes, and the next check
    /// downloads the release again.
    pub(crate) async fn install(
        &self,
        host: &impl InstallHost,
        call_active: &AtomicBool,
    ) -> Result<(), CommandError> {
        let Some(version) = lock(&self.held)
            .as_ref()
            .map(|held| held.version().to_string())
        else {
            return Err(CommandError::new(
                ErrorCode::NotFound,
                "no update is ready to install",
            ));
        };
        if self.installing.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        // A check running now finishes first.
        let _busy = self.busy.lock().await;
        if call_active.load(Ordering::SeqCst) {
            self.set(UpdateState::WaitingForCall {
                version: version.clone(),
            });
            while call_active.load(Ordering::SeqCst) {
                tokio::time::sleep(CALL_POLL).await;
            }
        }
        self.set(UpdateState::Installing {
            version: version.clone(),
        });
        host.lock().await;
        host.stop_tor().await;
        let prepared = lock(&self.held).take();
        let installer = match prepared {
            Some(Prepared::AppImage(staged)) => return self.replace_appimage(host, staged).await,
            Some(Prepared::Installer(installer)) => Some(installer),
            None => None,
        };
        let launched = match &installer {
            Some(installer) => host.launch(installer.path(), &INSTALLER_ARGS),
            None => Err(std::io::Error::other("no installer")),
        };
        match launched {
            Ok(()) => {
                // Started: the installer replaces Trino, which leaves.
                drop(installer);
                host.exit();
                Ok(())
            }
            Err(_) => {
                *lock(&self.held) = installer.map(Prepared::Installer);
                self.installing.store(false, Ordering::SeqCst);
                self.set(UpdateState::Failed {
                    reason: UpdateFailure::Install,
                });
                host.start_tor().await;
                Ok(())
            }
        }
    }

    /// Linux, after the lock and with Tor stopped: `staged` replaces the
    /// running AppImage (checked once more, off the async threads: it reads
    /// the whole file), and Trino starts again from it.
    async fn replace_appimage(
        &self,
        host: &impl InstallHost,
        staged: StagedAppImage,
    ) -> Result<(), CommandError> {
        let key = self.mirrors.key;
        let replaced = tokio::task::spawn_blocking(move || staged.replace(key))
            .await
            .unwrap_or(Err(UpdateError::Io));
        match replaced {
            Ok(_) => {
                host.relaunch();
                Ok(())
            }
            Err(error) => {
                self.installing.store(false, Ordering::SeqCst);
                self.set(UpdateState::Failed {
                    reason: match error {
                        UpdateError::Signature => UpdateFailure::Signature,
                        _ => UpdateFailure::Install,
                    },
                });
                host.start_tor().await;
                Ok(())
            }
        }
    }
}

/// The updater's client without Tor (§6.5, R-15): only on the "old
/// version" screen, after its confirmation, while Arti is obsolete. With
/// its permit, the one other place being `net_connect_without_tor`
/// (commands.rs, §2.8).
#[allow(clippy::disallowed_methods)] // the updater's own permit (§2.8)
pub(crate) fn client_without_tor(net: Arc<Net>) -> Result<HttpClient, CommandError> {
    HttpClient::for_update(net, DirectPermit::for_updater())
        .map_err(|_| CommandError::internal("only while Tor's version is obsolete"))
}

// ---- Tauri ----

/// Installing through Tauri: the app's lock, its Tor and its exit.
struct TauriInstall(tauri::AppHandle);

/// The window does not need renewing: Trino is leaving.
struct Leaving;

impl crate::commands::lock_cmds::MainWindow for Leaving {
    fn announce(&self, _reason: crate::commands::lock_cmds::LockReason) {}
    fn renew(&self) {}
}

impl InstallHost for TauriInstall {
    async fn lock(&self) {
        use crate::commands::lock_cmds::{lock_and_renew, LockOrigin, LockReason};
        use tauri::Manager;
        let state = self.0.state::<AppState>();
        lock_and_renew(
            &state,
            &Leaving,
            Some(LockReason::Manual),
            LockOrigin::Backend,
        )
        .await;
    }

    async fn stop_tor(&self) {
        use tauri::Manager;
        let net = Arc::clone(&self.0.state::<AppState>().net);
        let _ = tokio::task::spawn_blocking(move || net.stop()).await;
    }

    async fn start_tor(&self) {
        use tauri::Manager;
        let net = Arc::clone(&self.0.state::<AppState>().net);
        let _ = tokio::task::spawn_blocking(move || net.start()).await;
    }

    fn launch(&self, path: &Path, args: &[&str]) -> std::io::Result<()> {
        std::process::Command::new(path)
            .args(args)
            .spawn()
            .map(|_| ())
    }

    fn exit(&self) {
        self.0.exit(0);
    }

    /// Tauri starts `$APPIMAGE` again once Trino has left (and the
    /// single-instance plugin has let go of its name): the file just
    /// replaced, at the same path.
    fn relaunch(&self) {
        self.0.request_restart();
    }
}

/// When Trino opens: where releases go, the leftovers of an earlier
/// update, every change told to the UI, and the daily loop.
#[cfg(desktop)]
pub(crate) fn on_open(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let state = app.state::<AppState>();
    let updater = Arc::clone(&state.updater);
    if cfg!(target_os = "linux") {
        // Downloads, or a private folder of Trino's own; never /tmp.
        let path = app.path();
        updater.set_release_dir(linux_release_dir(
            path.download_dir().ok(),
            path.app_local_data_dir().ok(),
        ));
        // Running as an AppImage: releases replace it, and what an earlier
        // run left staged beside it goes.
        if let Some(appimage) = update::running_appimage(
            std::env::var_os("APPIMAGE").as_deref(),
            std::env::current_exe().ok().as_deref(),
        ) {
            update::remove_appimage_leftovers(&appimage);
            updater.set_appimage(appimage);
        }
    } else {
        updater.remove_leftovers();
    }

    let mut changed = updater.changed.subscribe();
    let (app_for_events, net) = (app.clone(), Arc::clone(&state.net));
    let told = Arc::clone(&updater);
    tauri::async_runtime::spawn(async move {
        while changed.changed().await.is_ok() {
            let _ = app_for_events.emit(UPDATE_CHANGED_EVENT, told.info(&net));
        }
    });

    let net = Arc::clone(&state.net);
    tauri::async_runtime::spawn(daily_loop(net, updater));
}

/// Once a day at a random time, while the switch is on (§6.3).
#[cfg(desktop)]
async fn daily_loop(net: Arc<Net>, updater: Arc<Updater>) {
    use rand::SeedableRng;
    let mut rng = rand::rngs::StdRng::from_entropy();
    let client = HttpClient::new(Arc::clone(&net));
    let mut next: Option<u64> = None;
    loop {
        let now = now();
        if next.is_none() {
            let settings = net.tor_home().map(UpdateSettings::load).unwrap_or_default();
            next = settings.next_check(now, &mut rng);
        }
        let Some(at) = next else {
            // Off: wait for the switch.
            updater.wake.notified().await;
            continue;
        };
        if now >= at {
            next = if updater.check(&client, now).await {
                None
            } else {
                Some(update::retry_at(now, &mut rng))
            };
            continue;
        }
        let wait = Duration::from_secs(at - now).min(LOOK_AGAIN);
        tokio::select! {
            () = tokio::time::sleep(wait) => {}
            () = updater.wake.notified() => next = None,
        }
    }
}

/// Where the updater is, for Ajustes and the "ready" notice.
#[tauri::command]
pub async fn update_status(state: State<'_, AppState>) -> Result<UpdateInfo, CommandError> {
    Ok(state.updater.info(&state.net))
}

/// "Buscar actualizaciones cada día", on or off.
#[tauri::command]
pub async fn update_set_daily(
    state: State<'_, AppState>,
    on: bool,
) -> Result<UpdateInfo, CommandError> {
    state
        .updater
        .set_daily(&state.net, on)
        .map_err(|error| CommandError::io(&error))?;
    Ok(state.updater.info(&state.net))
}

/// "Buscar ahora": a check through Tor, in the background; the UI hears
/// how it goes as `update-changed`.
#[tauri::command]
pub async fn update_check_now(state: State<'_, AppState>) -> Result<UpdateInfo, CommandError> {
    let (updater, net) = (Arc::clone(&state.updater), Arc::clone(&state.net));
    let client = HttpClient::new(Arc::clone(&net));
    tauri::async_runtime::spawn(async move { updater.check(&client, now()).await });
    Ok(state.updater.info(&state.net))
}

/// "Buscar la versión nueva sin Tor…" on the "old version" screen, after
/// its confirmation (§6.5): only while Arti is obsolete, to trinochat.org
/// and GitHub only, with the same signatures. In the background.
#[tauri::command]
pub async fn update_check_without_tor(
    state: State<'_, AppState>,
) -> Result<UpdateInfo, CommandError> {
    let client = client_without_tor(Arc::clone(&state.net))?;
    let updater = Arc::clone(&state.updater);
    tauri::async_runtime::spawn(async move { updater.check(&client, now()).await });
    Ok(state.updater.info(&state.net))
}

/// "Instalar y reiniciar": the yes. During a call it waits for the
/// hang-up; then Trino locks, stops Tor, starts the installer and leaves
/// (Windows), or replaces its AppImage and starts again from it (Linux).
#[tauri::command]
pub async fn update_install(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateInfo, CommandError> {
    if lock(&state.updater.held).is_none() {
        return Err(CommandError::new(
            ErrorCode::NotFound,
            "no update is ready to install",
        ));
    }
    let (updater, call_active) = (Arc::clone(&state.updater), Arc::clone(&state.call_active));
    tauri::async_runtime::spawn(async move {
        let host = TauriInstall(app);
        let _ = updater.install(&host, &call_active).await;
    });
    Ok(state.updater.info(&state.net))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::net_cmds::tests::{becomes, fake_tor};
    use std::sync::Mutex as StdMutex;
    use trino_net::mock::{FakeTor, Mock};
    use trino_net::news::Signer;
    use trino_net::update::{Source, UpdateKey};
    use trino_net::{
        mock_http, HostRule, LaunchError, NetConfig, NetStatus, RedirectPolicy, TorBackend,
        Transport, TransportKind,
    };

    /// Made by the real `tauri signer` with a throwaway key
    /// (crates/trino-net/src/update/testdata/README.md): an "installer" of
    /// Trino 0.2.0 for Windows and its signature.
    const TAURI_PUBLIC: &str =
        include_str!("../../crates/trino-net/src/update/testdata/tauri-test.key.pub");
    const TAURI_FILE: &[u8] =
        include_bytes!("../../crates/trino-net/src/update/testdata/tauri-installer.bin");
    const TAURI_SIG: &str =
        include_str!("../../crates/trino-net/src/update/testdata/tauri-installer.sig");
    const SIGNED_NAME: &str = "Trino Chat_0.2.0_x64-setup.exe";
    /// The same for Linux: an "AppImage" of Trino 0.2.0, with another
    /// throwaway key (TOR-13).
    const APPIMAGE_PUBLIC: &str =
        include_str!("../../crates/trino-net/src/update/testdata/tauri-appimage-test.key.pub");
    const APPIMAGE_FILE: &[u8] =
        include_bytes!("../../crates/trino-net/src/update/testdata/tauri-appimage.bin");
    const APPIMAGE_SIG: &str =
        include_str!("../../crates/trino-net/src/update/testdata/tauri-appimage.sig");
    const APPIMAGE_NAME: &str = "Trino Chat_0.2.0_amd64.AppImage";
    /// What the running AppImage holds in these tests.
    const RUNNING: &[u8] = b"the AppImage running now, 0.1.0";

    const MANIFESTS: [&str; 1] = ["https://trinochat.org/updates/latest.json"];
    const SOURCE: Source = Source {
        manifests: &MANIFESTS,
        redirects: RedirectPolicy::to(&[]),
        installer_hosts: &[HostRule::Exact("trinochat.org")],
    };
    /// Nobody serves the news in these tests: the bundled copy.
    const FEEDS: [&str; 1] = ["https://news.trino.invalid/feed.json"];
    const NOW: u64 = 1_792_065_600;

    fn test_updater(dir: PathBuf) -> Updater {
        let key: &'static UpdateKey = Box::leak(Box::new(
            UpdateKey::from_tauri(TAURI_PUBLIC).expect("the test key"),
        ));
        Updater::new(
            Some(Platform::WindowsX64),
            "0.1.0".parse().unwrap(),
            Mirrors {
                source: &SOURCE,
                key,
                signer: Signer::trino_updates(),
                feeds: &FEEDS,
            },
            dir,
        )
    }

    fn linux_updater(dir: PathBuf) -> Updater {
        let key: &'static UpdateKey = Box::leak(Box::new(
            UpdateKey::from_tauri(APPIMAGE_PUBLIC).expect("the test key"),
        ));
        Updater::new(
            Some(Platform::LinuxX64),
            "0.1.0".parse().unwrap(),
            Mirrors {
                source: &SOURCE,
                key,
                signer: Signer::trino_updates(),
                feeds: &FEEDS,
            },
            dir,
        )
    }

    fn linux_manifest() -> Vec<u8> {
        serde_json::json!({
            "version": "0.2.0",
            "platforms": { "linux-x86_64": {
                "url": "https://trinochat.org/updates/Trino.Chat_0.2.0_amd64.AppImage",
                "signature": APPIMAGE_SIG.trim(),
            } }
        })
        .to_string()
        .into_bytes()
    }

    /// The AppImage Trino runs from, in `scratch`, as the person named it.
    fn running_appimage(scratch: &ScratchDir) -> PathBuf {
        let apps = scratch.path().join("Apps");
        std::fs::create_dir_all(&apps).unwrap();
        let appimage = apps.join("trino.AppImage");
        std::fs::write(&appimage, RUNNING).unwrap();
        appimage
    }

    /// A Linux updater that found Trino 0.2.0 through `net`'s Tor (`mock`
    /// serves trinochat.org), running from `appimage` if there is one.
    async fn linux_release(
        scratch: &ScratchDir,
        net: &Arc<Net>,
        mock: &Mock,
        appimage: Option<PathBuf>,
    ) -> Updater {
        mock_http::serve(
            mock,
            "https://trinochat.org",
            vec![ok(&linux_manifest()), ok(APPIMAGE_FILE)],
        );
        let updater = linux_updater(scratch.path().join("Downloads"));
        if let Some(appimage) = appimage {
            updater.set_appimage(appimage);
        }
        assert!(updater.check(&client(net), NOW).await);
        updater
    }

    fn manifest() -> Vec<u8> {
        serde_json::json!({
            "version": "0.2.0",
            "pub_date": "2026-11-05T00:00:00Z",
            "platforms": { "windows-x86_64": {
                "url": "https://trinochat.org/updates/Trino.Chat_0.2.0_x64-setup.exe",
                "signature": TAURI_SIG.trim(),
            } }
        })
        .to_string()
        .into_bytes()
    }

    fn ok(body: &[u8]) -> mock_http::Reply {
        mock_http::response("200 OK", "", body)
    }

    /// A ready Tor (a `FakeTor` over the returned `Mock`), its folder in
    /// `scratch`, with a direct transport that fails the test.
    async fn ready(scratch: &ScratchDir) -> (Arc<Net>, Arc<Mock>) {
        let (net, fake, mock) = fake_tor(&scratch.path().join(crate::state::TOR_DIR));
        net.start();
        fake.ready();
        becomes(
            &net,
            NetStatus::Ready {
                transport: TransportKind::None,
            },
        )
        .await;
        (net, mock)
    }

    fn client(net: &Arc<Net>) -> HttpClient {
        HttpClient::with_tls(Arc::clone(net), mock_http::test_tls())
    }

    /// An updater with Trino 0.2.0 downloaded, verified and held, through
    /// `net`'s Tor (`mock` serves trinochat.org).
    async fn with_a_release(scratch: &ScratchDir, net: &Arc<Net>, mock: &Mock) -> Updater {
        mock_http::serve(
            mock,
            "https://trinochat.org",
            vec![ok(&manifest()), ok(TAURI_FILE)],
        );
        let updater = test_updater(scratch.path().join("downloads"));
        assert!(updater.check(&client(net), NOW).await);
        updater
    }

    /// What installing did, in order.
    #[derive(Default)]
    struct Recorder {
        log: StdMutex<Vec<String>>,
        launch_fails: bool,
        /// The AppImage a relaunch starts, to say which one it finds.
        appimage: Option<PathBuf>,
    }

    impl Recorder {
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }

        fn note(&self, what: String) {
            self.log.lock().unwrap().push(what);
        }
    }

    impl InstallHost for Recorder {
        async fn lock(&self) {
            self.note("lock".into());
        }

        async fn stop_tor(&self) {
            self.note("stop tor".into());
        }

        async fn start_tor(&self) {
            self.note("start tor".into());
        }

        fn launch(&self, path: &Path, args: &[&str]) -> std::io::Result<()> {
            let name = path.file_name().unwrap().to_string_lossy();
            self.note(format!("launch {name} {}", args.join(" ")));
            // Held: nobody can change it before it runs (Windows).
            #[cfg(windows)]
            assert!(std::fs::OpenOptions::new().write(true).open(path).is_err());
            if self.launch_fails {
                return Err(std::io::Error::other("no"));
            }
            Ok(())
        }

        fn exit(&self) {
            self.note("exit".into());
        }

        fn relaunch(&self) {
            let found = self
                .appimage
                .as_ref()
                .and_then(|path| std::fs::read(path).ok());
            let which = match found.as_deref() {
                Some(APPIMAGE_FILE) => "the new AppImage",
                Some(RUNNING) => "the old AppImage",
                _ => "nothing",
            };
            self.note(format!("relaunch {which}"));
        }
    }

    #[tokio::test]
    async fn a_newer_release_is_downloaded_through_tor_verified_and_held() {
        let scratch = ScratchDir::new("update-ready");
        let (net, mock) = ready(&scratch).await;

        let updater = with_a_release(&scratch, &net, &mock).await;

        assert_eq!(
            updater.state(),
            UpdateState::Ready {
                version: "0.2.0".into()
            }
        );
        let kept = scratch.path().join("downloads").join(SIGNED_NAME);
        assert_eq!(std::fs::read(&kept).unwrap(), TAURI_FILE);
        let info = serde_json::to_value(updater.info(&net)).unwrap();
        assert_eq!(info["state"]["state"], "ready");
        assert_eq!(info["state"]["version"], "0.2.0");
        assert_eq!(info["installed"], "0.1.0");
        assert_eq!(info["daily"], true);
        // Through Tor (the direct transport panics if touched).
        assert!(mock
            .connections()
            .iter()
            .any(|(target, _)| target.host == "trinochat.org"));
        // A second check finds the same release: it stays ready, nothing
        // downloaded again.
        mock_http::serve(&mock, "https://trinochat.org", vec![ok(&manifest())]);
        assert!(updater.check(&client(&net), NOW).await);
        assert_eq!(
            updater.state(),
            UpdateState::Ready {
                version: "0.2.0".into()
            }
        );
        drop(updater);
        net.stop();
    }

    /// Design test 41.
    #[tokio::test]
    async fn nothing_installs_without_a_yes_and_a_call_waits() {
        let scratch = ScratchDir::new("update-yes");
        let (net, mock) = ready(&scratch).await;
        let host = Recorder::default();
        let no_call = AtomicBool::new(false);

        // Nothing verified and held: a yes installs nothing.
        let fresh = test_updater(scratch.path().join("none"));
        let error = fresh.install(&host, &no_call).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(host.log().is_empty());

        // A release ready: the check alone runs nothing.
        let updater = with_a_release(&scratch, &net, &mock).await;
        assert!(host.log().is_empty());

        // The yes during a call: it waits for the hang-up.
        let call = AtomicBool::new(true);
        let hang_up = async {
            let waiting = UpdateState::WaitingForCall {
                version: "0.2.0".into(),
            };
            while updater.state() != waiting {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            tokio::time::sleep(CALL_POLL * 2).await;
            assert!(host.log().is_empty(), "{:?}", host.log());
            call.store(false, Ordering::SeqCst);
        };
        let (installed, ()) = tokio::join!(updater.install(&host, &call), hang_up);
        installed.unwrap();

        // Then: lock, stop Tor (and lyrebird), run the installer per user,
        // passive, over Trino and starting it again, and leave.
        assert_eq!(
            host.log(),
            [
                "lock".to_string(),
                "stop tor".to_string(),
                format!("launch {SIGNED_NAME} /P /UPDATE /R"),
                "exit".to_string(),
            ]
        );
        net.stop();
    }

    #[tokio::test]
    async fn an_installer_that_does_not_start_gives_tor_back_and_stays_for_another_try() {
        let scratch = ScratchDir::new("update-fails");
        let (net, mock) = ready(&scratch).await;
        let updater = with_a_release(&scratch, &net, &mock).await;
        let host = Recorder {
            launch_fails: true,
            ..Recorder::default()
        };

        updater
            .install(&host, &AtomicBool::new(false))
            .await
            .unwrap();

        assert_eq!(
            host.log(),
            [
                "lock".to_string(),
                "stop tor".to_string(),
                format!("launch {SIGNED_NAME} /P /UPDATE /R"),
                "start tor".to_string(),
            ]
        );
        assert_eq!(
            updater.state(),
            UpdateState::Failed {
                reason: UpdateFailure::Install
            }
        );
        // Still held: another yes tries again.
        let again = Recorder::default();
        updater
            .install(&again, &AtomicBool::new(false))
            .await
            .unwrap();
        assert_eq!(again.log().last().map(String::as_str), Some("exit"));
        net.stop();
    }

    /// TOR-13: running as an AppImage, the verified release is staged
    /// beside it and replaces it only on the yes; then Trino starts again
    /// from it, Tor and lyrebird stopped first, as on Windows.
    #[tokio::test]
    async fn on_linux_the_running_appimage_is_replaced_on_the_yes_and_starts_again() {
        let scratch = ScratchDir::new("update-appimage");
        let (net, mock) = ready(&scratch).await;
        let appimage = running_appimage(&scratch);
        let host = Recorder {
            appimage: Some(appimage.clone()),
            ..Recorder::default()
        };

        let updater = linux_release(&scratch, &net, &mock, Some(appimage.clone())).await;

        // Ready, and asked: nothing replaced, nothing in Downloads.
        assert_eq!(
            updater.state(),
            UpdateState::Ready {
                version: "0.2.0".into()
            }
        );
        assert_eq!(std::fs::read(&appimage).unwrap(), RUNNING);
        assert!(!scratch.path().join("Downloads").exists());
        assert!(host.log().is_empty());

        updater
            .install(&host, &AtomicBool::new(false))
            .await
            .unwrap();

        assert_eq!(
            host.log(),
            [
                "lock".to_string(),
                "stop tor".to_string(),
                "relaunch the new AppImage".to_string(),
            ]
        );
        assert_eq!(std::fs::read(&appimage).unwrap(), APPIMAGE_FILE);
        let left: Vec<_> = std::fs::read_dir(appimage.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(left, ["trino.AppImage"]);
        net.stop();
    }

    /// A .deb (or an .rpm): no AppImage to replace, so the release is
    /// saved in Downloads, as before, and nothing installs.
    #[tokio::test]
    async fn on_linux_without_an_appimage_the_release_is_saved_in_downloads() {
        let scratch = ScratchDir::new("update-deb");
        let (net, mock) = ready(&scratch).await;

        let updater = linux_release(&scratch, &net, &mock, None).await;

        let saved = scratch.path().join("Downloads").join(APPIMAGE_NAME);
        assert_eq!(
            updater.state(),
            UpdateState::Saved {
                version: "0.2.0".into(),
                file: saved.display().to_string(),
                reason: SavedReason::NotAppImage,
            }
        );
        assert_eq!(std::fs::read(&saved).unwrap(), APPIMAGE_FILE);
        let info = serde_json::to_value(updater.info(&net)).unwrap();
        assert_eq!(info["state"]["state"], "saved");
        assert_eq!(info["state"]["reason"], "notAppImage");
        let host = Recorder::default();
        let error = updater
            .install(&host, &AtomicBool::new(false))
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::NotFound);
        assert!(host.log().is_empty());
        net.stop();
    }

    /// An AppImage that cannot be replaced (its folder is not Trino's to
    /// write, or it is gone): the release goes to Downloads, the state
    /// says why, and the AppImage is left as it is. Never sudo.
    #[tokio::test]
    async fn on_linux_an_appimage_that_cannot_be_replaced_falls_back_to_downloads() {
        // The staged file cannot be made beside it (a folder sits there).
        let scratch = ScratchDir::new("update-appimage-blocked");
        let (net, mock) = ready(&scratch).await;
        let appimage = running_appimage(&scratch);
        let blocked = appimage
            .parent()
            .unwrap()
            .join(format!(".{APPIMAGE_NAME}.part"));
        std::fs::create_dir(&blocked).unwrap();

        let updater = linux_release(&scratch, &net, &mock, Some(appimage.clone())).await;

        let saved = scratch.path().join("Downloads").join(APPIMAGE_NAME);
        assert_eq!(
            updater.state(),
            UpdateState::Saved {
                version: "0.2.0".into(),
                file: saved.display().to_string(),
                reason: SavedReason::NotWritable,
            }
        );
        assert_eq!(std::fs::read(&saved).unwrap(), APPIMAGE_FILE);
        assert_eq!(std::fs::read(&appimage).unwrap(), RUNNING);
        net.stop();

        // Gone since Trino opened.
        let scratch = ScratchDir::new("update-appimage-gone");
        let (net, mock) = ready(&scratch).await;
        let gone = scratch.path().join("Apps").join("trino.AppImage");

        let updater = linux_release(&scratch, &net, &mock, Some(gone)).await;

        assert_eq!(
            updater.state(),
            UpdateState::Saved {
                version: "0.2.0".into(),
                file: scratch
                    .path()
                    .join("Downloads")
                    .join(APPIMAGE_NAME)
                    .display()
                    .to_string(),
                reason: SavedReason::Missing,
            }
        );
        net.stop();
    }

    /// The AppImage gone between the download and the yes: nothing is
    /// replaced, nothing starts, Tor comes back, and the staged file goes.
    #[tokio::test]
    async fn on_linux_an_appimage_that_cannot_be_replaced_on_the_yes_gives_tor_back() {
        let scratch = ScratchDir::new("update-appimage-late");
        let (net, mock) = ready(&scratch).await;
        let appimage = running_appimage(&scratch);
        let updater = linux_release(&scratch, &net, &mock, Some(appimage.clone())).await;
        std::fs::remove_file(&appimage).unwrap();
        let host = Recorder::default();

        updater
            .install(&host, &AtomicBool::new(false))
            .await
            .unwrap();

        assert_eq!(
            host.log(),
            [
                "lock".to_string(),
                "stop tor".to_string(),
                "start tor".to_string(),
            ]
        );
        assert_eq!(
            updater.state(),
            UpdateState::Failed {
                reason: UpdateFailure::Install
            }
        );
        assert_eq!(
            std::fs::read_dir(appimage.parent().unwrap())
                .unwrap()
                .count(),
            0
        );
        net.stop();
    }

    /// Design test 42, in the app: "Conectar sin Tor" checks nothing.
    #[tokio::test]
    #[allow(clippy::disallowed_methods)] // the session's permit, to test it
    async fn no_check_runs_without_tor() {
        let (tor, direct) = (Mock::new(), Mock::new());
        let net = Net::with_transports(
            Some(Arc::clone(&tor) as Arc<dyn Transport>),
            Arc::clone(&direct) as Arc<dyn Transport>,
        );
        net.allow_direct(DirectPermit::for_session()).unwrap();
        let scratch = ScratchDir::new("update-direct");
        let updater = test_updater(scratch.path().to_path_buf());

        assert!(!updater.check(&client(&net), NOW).await);

        assert_eq!(
            updater.state(),
            UpdateState::Failed {
                reason: UpdateFailure::WithoutTor
            }
        );
        assert!(tor.connections().is_empty());
        assert!(direct.connections().is_empty());
    }

    /// Design test 59, in the app: the updater's permit only with Arti
    /// obsolete, straight to trinochat.org, and no news asked.
    #[tokio::test]
    async fn the_updaters_permit_is_only_for_an_obsolete_tor_and_goes_straight_to_its_hosts() {
        let scratch = ScratchDir::new("update-permit");
        let (ready_net, _) = ready(&scratch).await;
        assert!(client_without_tor(Arc::clone(&ready_net)).is_err());
        ready_net.stop();

        let direct = Mock::new();
        let fake = FakeTor::new(Mock::new());
        fake.fail_next(LaunchError::Obsolete);
        let net = Net::with_backend(
            NetConfig {
                tor_home: scratch.path().join("obsolete"),
                pt: None,
            },
            fake as Arc<dyn TorBackend>,
            Arc::clone(&direct) as Arc<dyn Transport>,
        );
        net.start();
        becomes(&net, NetStatus::Obsolete { confirmed: true }).await;
        let client = client_without_tor(Arc::clone(&net)).unwrap();
        let updater = test_updater(scratch.path().join("downloads"));

        // Nobody answers there; what matters is where it went.
        updater.check(&client, NOW).await;

        let hosts: Vec<String> = direct
            .connections()
            .into_iter()
            .map(|(target, _)| format!("{}:{}", target.host, target.port))
            .collect();
        assert_eq!(hosts, ["trinochat.org:443"]);
        assert_eq!(net.mode(), trino_net::Mode::Tor, "nothing else changed");
    }

    #[tokio::test]
    async fn the_switch_is_kept_in_tor_and_told() {
        let scratch = ScratchDir::new("update-switch");
        let (net, _, _) = fake_tor(&scratch.path().join(crate::state::TOR_DIR));
        let updater = test_updater(scratch.path().to_path_buf());
        assert!(updater.info(&net).daily);

        updater.set_daily(&net, false).unwrap();

        assert!(!updater.info(&net).daily);
        assert!(!UpdateSettings::load(net.tor_home().unwrap()).daily);
    }

    #[test]
    fn the_installer_runs_passive_over_the_installed_trino_and_starts_it_again() {
        // Spike S9: /P passive, /UPDATE without uninstalling, /R relaunch.
        assert_eq!(INSTALLER_ARGS, ["/P", "/UPDATE", "/R"]);
    }

    /// Tor design §6.2 and spike S9: Windows ships one NSIS installer, per
    /// user (no administrator), whose hook moves a running lyrebird.exe
    /// out of the way; the version the updater compares is the bundle's.
    #[test]
    fn the_bundle_is_one_nsis_installer_per_user_with_the_lyrebird_hook() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("tauri.conf.json")).unwrap())
                .unwrap();
        let bundle = &conf["bundle"];
        let targets: Vec<&str> = bundle["targets"]
            .as_array()
            .expect("a list of targets")
            .iter()
            .map(|target| target.as_str().unwrap())
            .collect();
        assert!(targets.contains(&"nsis"), "{targets:?}");
        assert!(!targets.contains(&"msi"), "{targets:?}");
        let nsis = &bundle["windows"]["nsis"];
        assert_eq!(nsis["installMode"], "currentUser");
        let hooks = root.join(nsis["installerHooks"].as_str().expect("a hook file"));
        let hooks = std::fs::read_to_string(hooks).unwrap();
        assert!(hooks.contains("!macro NSIS_HOOK_PREINSTALL"), "{hooks}");
        assert!(hooks.contains("lyrebird.exe"), "{hooks}");
        assert_eq!(conf["version"], installed().to_string());
    }

    /// TRN-NET-03: without a Downloads folder, Linux saved releases in
    /// /tmp/TrinoChat-update, a name any local user could take first.
    #[test]
    fn trn_net_03_a_linux_release_never_goes_to_the_shared_temporary_folder() {
        let downloads = std::env::temp_dir().join("home").join("Descargas");
        let data = std::env::temp_dir()
            .join("home")
            .join(".local/share/org.trino.chat");
        assert_eq!(
            linux_release_dir(Some(downloads.clone()), Some(data.clone())),
            ReleaseDir::Users(downloads.clone())
        );
        assert_eq!(
            linux_release_dir(None, Some(data.clone())),
            ReleaseDir::Private(data.join(OWN_FOLDER))
        );
        assert_eq!(linux_release_dir(None, None), ReleaseDir::Nowhere);
        // A relative folder would land wherever Trino was started.
        assert_eq!(
            linux_release_dir(Some("Descargas".into()), Some(".local".into())),
            ReleaseDir::Nowhere
        );
        // Before Trino looks for Downloads, Linux has nowhere to save;
        // Windows keeps the user's own temporary folder.
        let temp = std::env::temp_dir();
        assert_eq!(default_release_dir(true, &temp), ReleaseDir::Nowhere);
        assert_eq!(
            default_release_dir(false, &temp),
            ReleaseDir::Users(temp.join(OWN_FOLDER))
        );
    }

    #[test]
    fn trn_net_03_a_linux_updater_with_nowhere_to_save_downloads_nothing() {
        let updater = linux_updater(PathBuf::new());
        updater.set_release_dir(ReleaseDir::Nowhere);
        assert!(updater.release_path().is_err());
        let scratch = ScratchDir::new("update-private");
        let private = scratch.path().join("data").join(OWN_FOLDER);
        updater.set_release_dir(ReleaseDir::Private(private.clone()));
        assert_eq!(updater.release_path().unwrap(), private);
        assert!(private.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn trn_net_03_the_private_folder_is_the_users_alone_and_never_a_link() {
        use std::os::unix::fs::PermissionsExt;
        let scratch = ScratchDir::new("update-private-unix");
        let private = scratch.path().join("data").join(OWN_FOLDER);
        private_dir(&private).unwrap();
        let mode = std::fs::symlink_metadata(&private)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        // One made open before is closed again.
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o777)).unwrap();
        private_dir(&private).unwrap();
        let mode = std::fs::symlink_metadata(&private)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        // A link planted in its place is refused, not followed.
        let elsewhere = scratch.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let planted = scratch.path().join("data").join("planted");
        std::os::unix::fs::symlink(&elsewhere, &planted).unwrap();
        assert!(private_dir(&planted).is_err());
    }
}
