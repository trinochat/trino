//! Trino's own updater (Tor design §6, decision 5; R-05, R-06, R-07; spike
//! S7): Tauri's plugin always uses a reqwest of its own, so it could not go
//! through Tor. This one goes through `HttpClient`.
//!
//! - **Every mirror is asked** (`Source::TRINO`: trinochat.org and GitHub
//!   Releases of the public `trinochat/releases`; the web's onion joins
//!   when it exists), each on a circuit of its own within the check's
//!   session (`IsoKind::UPDATE`). A mirror serving an old release, validly
//!   signed, does not hide a newer one (R-06).
//! - **GitHub's redirects** are followed only over https, at most three
//!   times, to `github.com`, `release-assets.githubusercontent.com` and
//!   `objects.githubusercontent.com` by their exact names
//!   (`GITHUB_REDIRECTS`, R-05).
//! - **The signed version decides**, not the announced one: each mirror's
//!   signature is checked for its trusted comment before anything is
//!   downloaded (sig.rs), and an entry whose signed version is not the one
//!   it announces is refused. Only a version above the installed one is
//!   offered, never the same or an older one.
//! - **The installer** comes from the mirrors' own hosts only, over https,
//!   and is checked whole against the signature before it is written, then
//!   once more from disk while it is held open (`HeldInstaller`), so what
//!   runs is what was signed.
//! - **Without Tor** ("Conectar sin Tor") nothing is checked: updates wait
//!   for Tor (§2.8). With Tor not ready, nothing goes direct. Only the
//!   updater's own permit, on the "old version" screen when Arti is
//!   obsolete, goes direct, and only to these hosts
//!   (`HttpClient::for_update`, §6.5).
//!
//! - **Once a day** (schedule.rs, §6.3): at a random time, with a switch
//!   kept in `tor/update.json`; each daily check asks the news and the
//!   mirrors in one session of its own (`daily`, §2.7, §7), so the news'
//!   `latest` is weighed against what the mirrors offer (§6.4).
//!
//! No Tauri here: asking before installing and running the installer are
//! the app's (src-tauri/src/updater.rs).

mod manifest;
mod schedule;
mod sig;

pub use manifest::Platform;
pub use schedule::{retry_at, UpdateSettings, RETRY_MAX, RETRY_MIN, UPDATE_FILE};
pub use sig::{
    HeldInstaller, SigError, SignedComment, UpdateKey, TRINO_UPDATER_KEY, TRINO_UPDATER_KEY_ID,
};

use crate::news::{self, News, Seen, Signer, Version};
use crate::{http::MAX_REDIRECTS, Session};
use crate::{Deadlines, HostRule, HttpClient, HttpError, IsoKind, Mode, RedirectPolicy, Request};
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use url::Url;

/// Where latest.json is (§6.4): trinochat.org, and GitHub Releases of the
/// public repository of releases (decision 6).
pub const MANIFEST_MIRRORS: [&str; 2] = [
    "https://trinochat.org/updates/latest.json",
    "https://github.com/trinochat/releases/releases/latest/download/latest.json",
];

/// Where GitHub's release downloads redirect (spike S7: github.com twice,
/// then release-assets.githubusercontent.com). Exact names only.
pub const GITHUB_REDIRECTS: RedirectPolicy = RedirectPolicy::to(&[
    HostRule::Exact("github.com"),
    HostRule::Exact("release-assets.githubusercontent.com"),
    HostRule::Exact("objects.githubusercontent.com"),
]);

/// The most a manifest may take.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

/// The most an installer may take. Trino's is about 15 MB with Arti and
/// lyrebird (spike S1).
pub const MAX_INSTALLER_BYTES: usize = 128 * 1024 * 1024;

/// A manifest gets what the news get (§3.1): 30 s to connect through Tor,
/// a minute in all.
pub const MANIFEST_DEADLINES: Deadlines = Deadlines {
    connect: Duration::from_secs(30),
    total: Duration::from_secs(60),
    idle: Some(Duration::from_secs(30)),
};

/// An installer of ~15 MB took 41 s through Tor (spike S7); this leaves
/// room for a slow circuit, and gives up on one that stalls.
pub const INSTALLER_DEADLINES: Deadlines = Deadlines {
    connect: Duration::from_secs(30),
    total: Duration::from_secs(20 * 60),
    idle: Some(Duration::from_secs(60)),
};

/// Where the updater looks, and where it may be sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Source {
    /// Every latest.json, all asked.
    pub manifests: &'static [&'static str],
    /// Where their redirects, and the installer's, may go.
    pub redirects: RedirectPolicy,
    /// Where an installer may be downloaded from (https only).
    pub installer_hosts: &'static [HostRule],
}

impl Source {
    /// Trino's mirrors.
    pub const TRINO: Source = Source {
        manifests: &MANIFEST_MIRRORS,
        redirects: GITHUB_REDIRECTS,
        installer_hosts: &[
            HostRule::Exact("trinochat.org"),
            HostRule::Exact("github.com"),
        ],
    };

    fn allows_installer(&self, url: &str) -> bool {
        Url::parse(url).is_ok_and(|url| {
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url
                    .host_str()
                    .is_some_and(|host| self.installer_hosts.iter().any(|rule| rule.allows(host)))
        })
    }
}

/// Why a check or a download gave nothing. Short and fixed: never what a
/// mirror sent.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum UpdateError {
    /// "Conectar sin Tor": updates wait for Tor (§2.8).
    #[error("updates wait for Tor")]
    WithoutTor,
    /// Tor is not ready: never a reason to go direct.
    #[error("Tor is not ready yet")]
    TorNotReady,
    /// No mirror answered with a manifest.
    #[error("no mirror answered")]
    NoAnswer,
    /// The installer could not be downloaded.
    #[error("the download failed ({0})")]
    Download(HttpError),
    /// The installer is not the one signed.
    #[error("the installer is not the one signed")]
    Signature,
    /// It could not be written or read back.
    #[error("the installer could not be kept")]
    Io,
}

/// A release newer than the installed one, as a mirror offers it, its
/// signed version checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: Version,
    /// Where the installer is.
    pub url: String,
    signed: SignedComment,
}

impl Offer {
    pub fn signed(&self) -> &SignedComment {
        &self.signed
    }
}

/// What one check found.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Check {
    /// The highest signed version any mirror offers, newer or not: what
    /// the news' `latest` is compared with against a freeze (§6.4).
    pub offered: Option<Version>,
    /// The highest of them, if it is above the installed version.
    pub newer: Option<Offer>,
    /// How many mirrors answered with a manifest.
    pub answered: usize,
    /// How many of those were refused: not a manifest, no entry for this
    /// platform, a signature that does not check out, a signed version
    /// that is not the one announced, or an installer elsewhere.
    pub refused: usize,
}

/// What one mirror gave.
enum Answer {
    /// Nothing: not reachable, not 200, too large, or a refused redirect.
    Nothing(HttpError),
    Refused,
    Offer(Offer),
}

/// Whether `client` may check at all: not in "Conectar sin Tor", unless it
/// is the updater's own permit.
fn may_check(client: &HttpClient) -> Result<(), UpdateError> {
    if client.net().mode() == Mode::Direct && !client.is_for_update() {
        return Err(UpdateError::WithoutTor);
    }
    Ok(())
}

async fn fetch(
    client: &HttpClient,
    session: &Session,
    source: &Source,
    url: &str,
    max: usize,
    deadlines: Deadlines,
) -> Result<Vec<u8>, HttpError> {
    let iso = session.iso(IsoKind::UPDATE, url);
    let request = Request::get(url)?.follow(source.redirects);
    let mut response = client.send(request, &iso, deadlines).await?;
    if response.status() != 200 {
        return Err(HttpError::Network);
    }
    response.read_capped(max).await
}

async fn ask(
    client: &HttpClient,
    session: &Session,
    source: &Source,
    key: &UpdateKey,
    platform: Platform,
    url: &str,
) -> Answer {
    let body = match fetch(
        client,
        session,
        source,
        url,
        MAX_MANIFEST_BYTES,
        MANIFEST_DEADLINES,
    )
    .await
    {
        Ok(body) => body,
        Err(error) => return Answer::Nothing(error),
    };
    let Some(entry) = manifest::parse(&body, platform) else {
        return Answer::Refused;
    };
    let Ok(signed) = key.check_comment(&entry.signature, platform) else {
        return Answer::Refused;
    };
    if signed.version() != entry.version || !source.allows_installer(&entry.url) {
        return Answer::Refused;
    }
    Answer::Offer(Offer {
        version: entry.version,
        url: entry.url,
        signed,
    })
}

/// Ask every mirror of `source` through `client`, within `session`, for a
/// release for `platform` signed by `key` and newer than `installed`.
pub async fn check(
    client: &HttpClient,
    session: &Session,
    source: &Source,
    key: &UpdateKey,
    platform: Platform,
    installed: Version,
) -> Result<Check, UpdateError> {
    may_check(client)?;
    let answers = futures_util::future::join_all(
        source
            .manifests
            .iter()
            .map(|url| ask(client, session, source, key, platform, url)),
    )
    .await;

    let mut check = Check::default();
    let mut tor_not_ready = false;
    let mut offers = Vec::new();
    for answer in answers {
        match answer {
            Answer::Nothing(error) => tor_not_ready |= error == HttpError::TorNotReady,
            Answer::Refused => {
                check.answered += 1;
                check.refused += 1;
            }
            Answer::Offer(offer) => {
                check.answered += 1;
                offers.push(offer);
            }
        }
    }
    if check.answered == 0 {
        return Err(if tor_not_ready {
            UpdateError::TorNotReady
        } else {
            UpdateError::NoAnswer
        });
    }
    // The first mirror wins a tie: trinochat.org before GitHub.
    let best = offers
        .into_iter()
        .fold(None::<Offer>, |best, offer| match best {
            Some(best) if best.version >= offer.version => Some(best),
            _ => Some(offer),
        });
    check.offered = best.as_ref().map(|offer| offer.version);
    check.newer = best.filter(|offer| offer.version > installed);
    Ok(check)
}

/// Download `offer`'s installer through `client`, within `session`, check
/// it against its signature, keep it in `dir` under the name it was signed
/// with, and hold it there, checked once more, until it runs.
pub async fn download(
    client: &HttpClient,
    session: &Session,
    source: &Source,
    key: &UpdateKey,
    offer: &Offer,
    dir: &Path,
) -> Result<HeldInstaller, UpdateError> {
    may_check(client)?;
    if !source.allows_installer(&offer.url) {
        return Err(UpdateError::Download(HttpError::Redirect));
    }
    let bytes = fetch(
        client,
        session,
        source,
        &offer.url,
        MAX_INSTALLER_BYTES,
        INSTALLER_DEADLINES,
    )
    .await
    .map_err(|error| match error {
        HttpError::TorNotReady => UpdateError::TorNotReady,
        error => UpdateError::Download(error),
    })?;
    key.verify(&offer.signed, &bytes)
        .map_err(|_| UpdateError::Signature)?;

    // The signed name: a platform's bundle name, so no folder in it.
    let name = offer.signed.file();
    let path = dir.join(name);
    let partial = dir.join(format!(".{name}.part"));
    let kept = std::fs::create_dir_all(dir)
        .and_then(|()| std::fs::write(&partial, &bytes))
        .and_then(|()| std::fs::rename(&partial, &path));
    if kept.is_err() {
        let _ = std::fs::remove_file(&partial);
        return Err(UpdateError::Io);
    }
    key.hold_verified(&offer.signed, &path).map_err(|error| {
        let _ = std::fs::remove_file(&path);
        match error {
            SigError::Io => UpdateError::Io,
            _ => UpdateError::Signature,
        }
    })
}

/// Where a daily check looks, and whose signatures it takes.
#[derive(Clone, Copy)]
pub struct Mirrors<'a> {
    /// The manifests and the installers.
    pub source: &'a Source,
    /// The updater's key.
    pub key: &'a UpdateKey,
    /// The news' key.
    pub signer: &'a Signer,
    /// The news' feeds.
    pub feeds: &'a [&'a str],
}

impl Mirrors<'static> {
    /// Trino's: its mirrors, its updater key and "Trino Updates".
    pub fn trino() -> Mirrors<'static> {
        Mirrors {
            source: &Source::TRINO,
            key: UpdateKey::trino(),
            signer: Signer::trino_updates(),
            feeds: &news::FEED_MIRRORS,
        }
    }
}

/// What a daily check found.
#[derive(Debug)]
pub struct Daily {
    /// The news, with the freeze weighed against what the mirrors offer.
    pub news: News,
    /// The mirrors.
    pub check: Result<Check, UpdateError>,
}

/// One daily check (§6.3, §6.4, §7): the news and every mirror, through
/// `client`, in a session of its own (§2.7), at `now`. When a mirror
/// answered, the day is kept in `tor/update.json`, and the news' freeze is
/// weighed against the highest version offered: a `latest` no mirror
/// offers is "Hay una versión nueva que no pudimos bajar."
pub async fn daily(
    client: &HttpClient,
    mirrors: &Mirrors<'_>,
    platform: Platform,
    installed: Version,
    now: u64,
) -> Daily {
    let net = client.net();
    let session = net.session();
    let tor_home = net.tor_home();
    let (mut news, check) = futures_util::join!(
        news::check(
            client,
            &session,
            mirrors.signer,
            mirrors.feeds,
            tor_home,
            now
        ),
        check(
            client,
            &session,
            mirrors.source,
            mirrors.key,
            platform,
            installed
        ),
    );
    if let (Ok(check), Some(tor_home)) = (&check, tor_home) {
        news.freeze = Seen::load(tor_home).freeze(now, check.offered.as_ref());
        // Not kept now (a full disk): checked again the same day.
        let _ = UpdateSettings::record_check(tor_home, now);
    }
    Daily { news, check }
}

const _: () = assert!(
    MAX_REDIRECTS == 3,
    "GitHub's chain takes up to three hops (S7)"
);
