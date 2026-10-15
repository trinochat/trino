//! The tests of the updater (Tor design §6 and §11.6–§11.8: tests 36–40,
//! 42, 43, 54, 56 and 59, with R-05, R-06 and R-07; spike S7). Tor is the
//! in-memory `Mock`, the mirrors are servers of mock_http.rs with the test
//! CA, and the direct transport fails the test if anything touches it,
//! except in the tests of the updater's own permit.
//!
//! The keys and signatures are made here as `tauri signer generate` and
//! `tauri signer sign` make them (minisign, a BLAKE2b-512 of the file signed
//! with Ed25519, and the Tauri base64 around it), except three files: a
//! public key, a file and its signature that the real `tauri signer` CLI
//! (tauri-cli 2.11.2) made with a throwaway key (testdata/README.md).

use crate::mock::{FakeTor, Forbidden, Mock};
use crate::mock_http::{self, Reply};
use crate::news;
use crate::news::Version;
use crate::update::{
    self, AppImageError, Check, HeldInstaller, Mirrors, NotInPlace, Platform, SigError, Source,
    StagedAppImage, UpdateError, UpdateKey, UpdateSettings, GITHUB_REDIRECTS, MANIFEST_MIRRORS,
    TRINO_UPDATER_KEY, TRINO_UPDATER_KEY_ID,
};
use crate::*;
use base64::Engine;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

async fn within<T>(work: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), work)
        .await
        .expect("still waiting after 10 s")
}

/// A folder of its own under the system's temporary folder, removed at
/// the end. Never ~/.trino.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let path =
            std::env::temp_dir().join(format!("trino-update-{name}-{}-{n}", std::process::id()));
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

// ---- Keys and signatures, made as `tauri signer` makes them ----

/// A minisign key pair, as `tauri signer generate` makes one: an Ed25519
/// key and an id of 8 random bytes.
struct TestSigner {
    key: ed25519_dalek::SigningKey,
    id: [u8; 8],
}

impl TestSigner {
    fn new() -> TestSigner {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        let mut id = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut seed);
        rand::thread_rng().fill_bytes(&mut id);
        TestSigner {
            key: ed25519_dalek::SigningKey::from_bytes(&seed),
            id,
        }
    }

    /// The minisign line: "Ed", the id and the public key, in base64.
    fn line(&self) -> String {
        let mut bytes = b"Ed".to_vec();
        bytes.extend_from_slice(&self.id);
        bytes.extend_from_slice(self.key.verifying_key().as_bytes());
        B64.encode(bytes)
    }

    /// The id as minisign prints it.
    fn id_text(&self) -> String {
        self.id.iter().rev().map(|b| format!("{b:02X}")).collect()
    }

    /// The .pub file `tauri signer generate` writes.
    fn pub_file(&self) -> String {
        format!(
            "untrusted comment: minisign public key: {}\n{}\n",
            self.id_text(),
            self.line()
        )
    }

    /// The public key as Tauri hands it out: the .pub file in base64.
    fn tauri_public(&self) -> String {
        B64.encode(self.pub_file())
    }

    /// The minisign text of a signature of `data` with `comment` as its
    /// trusted comment: "ED", a BLAKE2b-512 of the data signed, and the
    /// global signature over that signature and the comment.
    fn minisig(&self, data: &[u8], comment: &str) -> String {
        use blake2::Digest;
        let hash = blake2::Blake2b512::digest(data);
        self.minisig_raw(b"ED", &hash, comment)
    }

    fn minisig_raw(&self, algorithm: &[u8; 2], signed: &[u8], comment: &str) -> String {
        use ed25519_dalek::Signer;
        let signature = self.key.sign(signed).to_bytes();
        let mut global_input = signature.to_vec();
        global_input.extend_from_slice(comment.as_bytes());
        let global = self.key.sign(&global_input).to_bytes();
        let mut first = algorithm.to_vec();
        first.extend_from_slice(&self.id);
        first.extend_from_slice(&signature);
        format!(
            "untrusted comment: signature from tauri secret key\n{}\ntrusted comment: {comment}\n{}\n",
            B64.encode(first),
            B64.encode(global)
        )
    }

    /// The signature as `tauri signer sign` writes it in the .sig file and
    /// latest.json: the minisign text in base64.
    fn sign(&self, data: &[u8], comment: &str) -> String {
        B64.encode(self.minisig(data, comment))
    }

    /// What `tauri signer sign` signs a Windows installer of `version` with.
    fn sign_installer(&self, data: &[u8], version: &str) -> String {
        self.sign(data, &comment(version))
    }

    fn update_key(&self) -> UpdateKey {
        UpdateKey::from_tauri(&self.tauri_public()).unwrap()
    }
}

/// The trusted comment `tauri signer sign` writes for the NSIS installer
/// of `version`.
fn comment(version: &str) -> String {
    format!("timestamp:1792014682\tfile:Trino Chat_{version}_x64-setup.exe")
}

fn v(text: &str) -> Version {
    text.parse().unwrap()
}

// ---- Test vectors of the real `tauri signer` ----

const TAURI_PUBLIC: &str = include_str!("update/testdata/tauri-test.key.pub");
const TAURI_FILE: &[u8] = include_bytes!("update/testdata/tauri-installer.bin");
const TAURI_SIG: &str = include_str!("update/testdata/tauri-installer.sig");
/// The same for an AppImage, named as tauri-bundler names Trino's (TOR-13).
const TAURI_APPIMAGE_PUBLIC: &str = include_str!("update/testdata/tauri-appimage-test.key.pub");
const TAURI_APPIMAGE: &[u8] = include_bytes!("update/testdata/tauri-appimage.bin");
const TAURI_APPIMAGE_SIG: &str = include_str!("update/testdata/tauri-appimage.sig");

// ---- The production key ----

#[test]
fn the_updater_key_is_davids_tauri_key() {
    // Made by David with `tauri signer generate`; its private half never
    // leaves him. Pinned exactly: a change here is a change of key.
    assert_eq!(
        TRINO_UPDATER_KEY,
        "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJBNjg2MUZDNzAxQjc1RDcKUldUWGRSdHcvR0ZvS3NFLzU0ZGRlS0pQeXRvV2JoSVhVeE9kVkpMRVV5bkQ1bFBNcHhva1lNa2YK"
    );
    assert_eq!(TRINO_UPDATER_KEY_ID, "2A6861FC701B75D7");
    let key = UpdateKey::trino();
    assert_eq!(key.key_id(), "2A6861FC701B75D7");
    assert_eq!(
        key.minisign_line(),
        "RWTXdRtw/GFoKsE/54ddeKJPytoWbhIXUxOdVJLEUynD5lPMpxokYMkf"
    );
    // A signature by any other key is refused by it.
    let other = TestSigner::new();
    assert_eq!(
        key.check_comment(&other.sign_installer(b"x", "0.2.0"), Platform::WindowsX64)
            .err(),
        Some(SigError::KeyId)
    );
}

#[test]
fn a_key_is_taken_as_tauri_writes_it_as_a_pub_file_or_as_its_line() {
    let signer = TestSigner::new();
    let from_tauri = UpdateKey::from_tauri(&signer.tauri_public()).unwrap();
    let from_file = UpdateKey::from_tauri(&signer.pub_file()).unwrap();
    let from_line = UpdateKey::from_tauri(&signer.line()).unwrap();
    for key in [&from_tauri, &from_file, &from_line] {
        assert_eq!(key.key_id(), signer.id_text());
        assert_eq!(key.minisign_line(), signer.line());
    }
    for bad in [
        "",
        "not base64 at all!",
        &B64.encode("untrusted comment: x\n"),
        &B64.encode([0u8; 42]),
        &signer.line()[..20],
    ] {
        assert_eq!(
            UpdateKey::from_tauri(bad).err(),
            Some(SigError::Key),
            "{bad}"
        );
    }
}

// ---- Design test 36 and what `tauri signer` writes ----

#[test]
fn a_file_signed_by_the_real_tauri_signer_verifies() {
    let key = UpdateKey::from_tauri(TAURI_PUBLIC).unwrap();
    assert_eq!(key.key_id(), "58B446BCF27F15C2");

    let signed = key.check_comment(TAURI_SIG, Platform::WindowsX64).unwrap();
    assert_eq!(signed.version(), v("0.2.0"));
    assert_eq!(signed.file(), "Trino Chat_0.2.0_x64-setup.exe");
    assert_eq!(signed.timestamp(), 1_792_017_567);
    key.verify(&signed, TAURI_FILE).unwrap();

    let mut changed = TAURI_FILE.to_vec();
    changed[0] ^= 1;
    assert_eq!(key.verify(&signed, &changed), Err(SigError::Installer));
}

/// The AppImage tauri-bundler makes (`Trino Chat_<version>_amd64.AppImage`),
/// signed by the real `tauri signer`: taken for Linux only.
#[test]
fn an_appimage_signed_by_the_real_tauri_signer_verifies_for_linux() {
    let key = UpdateKey::from_tauri(TAURI_APPIMAGE_PUBLIC).unwrap();
    assert_eq!(key.key_id(), "E026FF4801EC1A7C");

    let signed = key
        .check_comment(TAURI_APPIMAGE_SIG, Platform::LinuxX64)
        .unwrap();
    assert_eq!(signed.version(), v("0.2.0"));
    assert_eq!(signed.file(), "Trino Chat_0.2.0_amd64.AppImage");
    assert_eq!(signed.timestamp(), 1_792_102_211);
    key.verify(&signed, TAURI_APPIMAGE).unwrap();
    assert_eq!(
        key.check_comment(TAURI_APPIMAGE_SIG, Platform::WindowsX64)
            .err(),
        Some(SigError::Version)
    );
}

#[test]
fn a_signature_made_here_as_tauri_signer_does_verifies() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let installer = b"an installer".to_vec();

    let signed = key
        .check_comment(
            &signer.sign_installer(&installer, "1.4.2"),
            Platform::WindowsX64,
        )
        .unwrap();

    assert_eq!(signed.version(), v("1.4.2"));
    key.verify(&signed, &installer).unwrap();
    // The minisign text itself, not in base64, is taken too.
    let plain = signer.minisig(&installer, &comment("1.4.2"));
    assert!(key.check_comment(&plain, Platform::WindowsX64).is_ok());
}

/// Design test 36.
#[test]
fn an_installer_with_a_bad_signature_is_refused() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let installer = b"the real installer".to_vec();
    let good = signer.minisig(&installer, &comment("0.2.0"));

    // Another key, with another id, or with ours.
    let other = TestSigner::new();
    assert_eq!(
        key.check_comment(
            &other.sign_installer(&installer, "0.2.0"),
            Platform::WindowsX64
        )
        .err(),
        Some(SigError::KeyId)
    );
    let impostor = TestSigner {
        key: other.key.clone(),
        id: signer.id,
    };
    assert_eq!(
        key.check_comment(
            &impostor.sign_installer(&installer, "0.2.0"),
            Platform::WindowsX64
        )
        .err(),
        Some(SigError::Comment),
        "the trusted comment is checked before anything is downloaded"
    );

    // The trusted comment changed after signing: "0.2.0" made "9.9.9".
    let forged = good.replace("Trino Chat_0.2.0_", "Trino Chat_9.9.9_");
    assert_eq!(
        key.check_comment(&forged, Platform::WindowsX64).err(),
        Some(SigError::Comment)
    );

    // A good comment, and an installer that is not the one signed.
    let signed = key.check_comment(&good, Platform::WindowsX64).unwrap();
    assert_eq!(
        key.verify(&signed, b"another installer"),
        Err(SigError::Installer)
    );

    // The old minisign form, which signs the file itself, is not what
    // `tauri signer` makes: refused.
    let legacy = signer.minisig_raw(b"Ed", &installer, &comment("0.2.0"));
    assert_eq!(
        key.check_comment(&legacy, Platform::WindowsX64).err(),
        Some(SigError::Algorithm)
    );

    // Not a signature at all.
    for bad in ["", "garbage", &B64.encode("untrusted comment: x\nAAAA\n")] {
        assert_eq!(
            key.check_comment(bad, Platform::WindowsX64).err(),
            Some(SigError::Encoding),
            "{bad}"
        );
    }
}

#[test]
fn the_signed_version_is_the_installers_name_and_its_version_field() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let sign = |comment: &str| signer.sign(b"x", comment);
    let windows = Platform::WindowsX64;

    for (name, version) in [
        ("Trino Chat_0.2.0_x64-setup.exe", "0.2.0"),
        ("Trino.Chat_0.10.3_x64-setup.exe", "0.10.3"),
        ("TrinoChat_2.0.0_x64-setup.exe", "2.0.0"),
    ] {
        let signed = key
            .check_comment(&sign(&format!("timestamp:1\tfile:{name}")), windows)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(signed.version(), v(version), "{name}");
    }
    // A version field, as a signing script may add, must agree.
    let both = sign("timestamp:1\tfile:Trino Chat_0.2.0_x64-setup.exe\tversion:0.2.0");
    assert_eq!(
        key.check_comment(&both, windows).unwrap().version(),
        v("0.2.0")
    );
    let disagree = sign("timestamp:1\tfile:Trino Chat_0.2.0_x64-setup.exe\tversion:0.3.0");
    assert_eq!(
        key.check_comment(&disagree, windows).err(),
        Some(SigError::Version)
    );

    // Not Trino's installer for this platform, or no name at all.
    for comment in [
        "timestamp:1\tfile:Other App_0.2.0_x64-setup.exe",
        "timestamp:1\tfile:Trino Chat_0.2.0_x64-setup.msi",
        "timestamp:1\tfile:Trino Chat_0.2_x64-setup.exe",
        "timestamp:1\tfile:Trino Chat_0.2.0-beta.1_x64-setup.exe",
        "timestamp:1\tfile:../Trino Chat_0.2.0_x64-setup.exe",
        "timestamp:1\tfile:Trino Chat_0.2.0_amd64.AppImage",
        "timestamp:1",
        "timestamp:1\tversion:0.2.0",
        "file:Trino Chat_0.2.0_x64-setup.exe",
    ] {
        assert!(
            key.check_comment(&sign(comment), windows).is_err(),
            "{comment}"
        );
    }
    // Linux's AppImage, for Linux.
    let linux = sign("timestamp:1\tfile:Trino Chat_0.2.0_amd64.AppImage");
    assert_eq!(
        key.check_comment(&linux, Platform::LinuxX64)
            .unwrap()
            .version(),
        v("0.2.0")
    );
    assert!(key.check_comment(&linux, windows).is_err());
}

// ---- The mirrors ----

const TEST_MIRRORS: [&str; 2] = [
    "https://trinochat.org/updates/latest.json",
    "https://mirror.trino.invalid/latest.json",
];

/// Like GitHub's: the mirror's host and its download host.
const TEST_REDIRECTS: RedirectPolicy = RedirectPolicy::to(&[
    HostRule::Exact("mirror.trino.invalid"),
    HostRule::Exact("assets.cdn.trino.invalid"),
]);

const TEST_SOURCE: Source = Source {
    manifests: &TEST_MIRRORS,
    redirects: TEST_REDIRECTS,
    installer_hosts: &[
        HostRule::Exact("trinochat.org"),
        HostRule::Exact("mirror.trino.invalid"),
    ],
};

fn tor_only(tor: Option<Arc<Mock>>) -> Arc<Net> {
    Net::with_transports(tor.map(|t| t as Arc<dyn Transport>), Arc::new(Forbidden))
}

fn client(net: Arc<Net>) -> HttpClient {
    HttpClient::with_tls(net, mock_http::test_tls())
}

fn ok(body: &[u8]) -> Reply {
    mock_http::response("200 OK", "", body)
}

/// latest.json as Tauri's updater and the release script write it.
fn manifest(version: &str, url: &str, signature: &str) -> Vec<u8> {
    serde_json::json!({
        "version": version,
        "notes": "NOTAS SIN FIRMA: instala esto ya",
        "pub_date": "2026-11-05T00:00:00Z",
        "platforms": {
            "windows-x86_64": { "url": url, "signature": signature },
            "linux-x86_64": { "url": "https://trinochat.org/x.AppImage", "signature": "AAAA" }
        }
    })
    .to_string()
    .into_bytes()
}

fn installer_url(version: &str) -> String {
    format!("https://trinochat.org/updates/Trino.Chat_{version}_x64-setup.exe")
}

async fn check_on(net: Arc<Net>, key: &UpdateKey, installed: &str) -> Result<Check, UpdateError> {
    let session = net.session();
    let client = client(net);
    within(update::check(
        &client,
        &session,
        &TEST_SOURCE,
        key,
        Platform::WindowsX64,
        v(installed),
    ))
    .await
}

/// Design test 39 (R-06).
#[tokio::test]
async fn every_mirror_is_asked_and_the_highest_version_wins() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let tor = Mock::new();
    // trinochat.org: an old release, validly signed.
    let old = signer.sign_installer(b"0.2.0", "0.2.0");
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&manifest("0.2.0", &installer_url("0.2.0"), &old))],
    );
    // The other mirror: a newer one.
    let new = signer.sign_installer(b"0.3.0", "0.3.0");
    let url = "https://mirror.trino.invalid/Trino.Chat_0.3.0_x64-setup.exe";
    mock_http::serve(
        &tor,
        "https://mirror.trino.invalid",
        vec![ok(&manifest("0.3.0", url, &new))],
    );

    let check = check_on(tor_only(Some(Arc::clone(&tor))), &key, "0.1.0")
        .await
        .unwrap();

    let offer = check.newer.as_ref().expect("an update");
    assert_eq!(offer.version, v("0.3.0"));
    assert_eq!(offer.url, url);
    assert_eq!(check.offered, Some(v("0.3.0")));
    assert_eq!((check.answered, check.refused), (2, 0));

    // Each mirror on a circuit of its own, of the updater's kind.
    let connections = tor.connections();
    assert_eq!(connections.len(), 2);
    assert!(connections
        .iter()
        .all(|(_, iso)| iso.kind() == IsoKind::UPDATE));
    assert_ne!(connections[0].1, connections[1].1);
}

#[tokio::test]
async fn a_version_no_signature_vouches_for_never_wins() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let tor = Mock::new();
    let good = signer.sign_installer(b"0.2.0", "0.2.0");
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&manifest("0.2.0", &installer_url("0.2.0"), &good))],
    );
    // A mirror announcing 9.9.9 with the 0.2.0 signature: the signed
    // version is not the one announced (design test 37's first half).
    let url = "https://mirror.trino.invalid/Trino.Chat_9.9.9_x64-setup.exe";
    mock_http::serve(
        &tor,
        "https://mirror.trino.invalid",
        vec![ok(&manifest("9.9.9", url, &good))],
    );

    let check = check_on(tor_only(Some(tor)), &key, "0.1.0").await.unwrap();

    assert_eq!(check.newer.map(|offer| offer.version), Some(v("0.2.0")));
    assert_eq!(check.offered, Some(v("0.2.0")));
    assert_eq!((check.answered, check.refused), (2, 1));
}

/// Design test 38.
#[tokio::test]
async fn the_same_or_an_older_version_is_never_installed() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    for (offered, installed) in [("0.2.0", "0.2.0"), ("0.2.0", "0.3.0")] {
        let tor = Mock::new();
        let signature = signer.sign_installer(b"x", offered);
        mock_http::serve(
            &tor,
            "https://trinochat.org",
            vec![ok(&manifest(offered, &installer_url(offered), &signature))],
        );
        let check = check_on(tor_only(Some(tor)), &key, installed)
            .await
            .unwrap();
        assert_eq!(check.newer, None, "{offered} over {installed}");
        assert_eq!(check.offered, Some(v(offered)));
    }
}

/// Design test 54 (R-06): latest.json is not signed, so its notes are
/// never taken.
#[tokio::test]
async fn latest_json_notes_are_never_shown() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let tor = Mock::new();
    let signature = signer.sign_installer(b"x", "0.2.0");
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![ok(&manifest("0.2.0", &installer_url("0.2.0"), &signature))],
    );

    let check = check_on(tor_only(Some(tor)), &key, "0.1.0").await.unwrap();

    let shown = format!("{check:?}");
    assert!(check.newer.is_some());
    assert!(!shown.contains("NOTAS"), "{shown}");
}

#[tokio::test]
async fn an_installer_outside_the_mirrors_hosts_is_never_offered() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let tor = Mock::new();
    let signature = signer.sign_installer(b"x", "0.2.0");
    for url in [
        "https://evil.trino.invalid/Trino.Chat_0.2.0_x64-setup.exe",
        "http://trinochat.org/Trino.Chat_0.2.0_x64-setup.exe",
    ] {
        mock_http::serve(
            &tor,
            "https://trinochat.org",
            vec![ok(&manifest("0.2.0", url, &signature))],
        );
        let check = check_on(tor_only(Some(Arc::clone(&tor))), &key, "0.1.0")
            .await
            .unwrap();
        assert_eq!(check.newer, None, "{url}");
        assert_eq!(check.refused, 1, "{url}");
    }
}

/// Design test 56 (R-05), the production policy: https only, to GitHub's
/// release hosts by their exact names.
#[test]
fn the_updater_follows_only_https_redirects_to_github_hosts() {
    for host in [
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
    ] {
        assert!(GITHUB_REDIRECTS.allows_host(host), "{host}");
    }
    for host in [
        "evil.example",
        "github.com.evil.example",
        "evilgithub.com",
        "gist.github.com",
        "raw.githubusercontent.com",
        "trinochat.org",
    ] {
        assert!(!GITHUB_REDIRECTS.allows_host(host), "{host}");
    }
    assert_eq!(update::Source::TRINO.redirects, GITHUB_REDIRECTS);
    assert_eq!(update::Source::TRINO.manifests, &MANIFEST_MIRRORS);
    assert_eq!(
        MANIFEST_MIRRORS,
        [
            "https://trinochat.org/updates/latest.json",
            "https://github.com/trinochat/releases/releases/latest/download/latest.json",
        ]
    );
}

/// Design test 56, the mechanics: a mirror's redirects are followed only to
/// its policy's hosts, over https, at most three times, on the same
/// circuit.
#[tokio::test]
async fn a_mirror_is_followed_only_where_its_policy_allows() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let signature = signer.sign_installer(b"x", "0.2.0");
    let body = manifest("0.2.0", &installer_url("0.2.0"), &signature);
    let to = |location: &str| {
        mock_http::response("302 Found", &format!("Location: {location}\r\n"), b"")
    };
    let only_github = Source {
        manifests: &TEST_MIRRORS[1..],
        ..TEST_SOURCE
    };
    let (key, source) = (&key, &only_github);
    let ask = |tor: &Arc<Mock>| {
        let net = tor_only(Some(Arc::clone(tor)));
        let session = net.session();
        let client = client(net);
        async move {
            within(update::check(
                &client,
                &session,
                source,
                key,
                Platform::WindowsX64,
                v("0.1.0"),
            ))
            .await
        }
    };

    // As GitHub does: twice to itself, then to its download host.
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://mirror.trino.invalid",
        vec![
            to("/download/v0.2.0/latest.json"),
            to("https://assets.cdn.trino.invalid/latest.json"),
        ],
    );
    mock_http::serve(&tor, "https://assets.cdn.trino.invalid", vec![ok(&body)]);
    let check = ask(&tor).await.unwrap();
    assert_eq!(check.newer.map(|offer| offer.version), Some(v("0.2.0")));
    let tokens: Vec<Iso> = tor.connections().into_iter().map(|(_, iso)| iso).collect();
    assert_eq!(tokens.len(), 3);
    assert!(tokens.windows(2).all(|pair| pair[0] == pair[1]));

    // Anywhere else, over http, or a fourth hop: that mirror gives nothing.
    for replies in [
        vec![to("https://evil.trino.invalid/latest.json")],
        vec![to("http://assets.cdn.trino.invalid/latest.json")],
        vec![to("/1"), to("/2"), to("/3"), to("/4")],
    ] {
        let tor = Mock::new();
        mock_http::serve(&tor, "https://mirror.trino.invalid", replies);
        mock_http::serve(&tor, "https://assets.cdn.trino.invalid", vec![ok(&body)]);
        assert_eq!(ask(&tor).await.err(), Some(UpdateError::NoAnswer));
        assert!(tor
            .connections()
            .iter()
            .all(|(target, _)| target.host != "evil.trino.invalid"));
    }
}

/// Design test 42: the updater asks nothing without Tor, and nothing
/// direct while Tor is not ready.
#[tokio::test]
#[allow(clippy::disallowed_methods)] // the session's permit is under test
async fn no_check_runs_without_tor() {
    let key = TestSigner::new().update_key();

    // Tor not ready: nothing direct (Forbidden panics if touched).
    assert_eq!(
        check_on(tor_only(None), &key, "0.1.0").await.err(),
        Some(UpdateError::TorNotReady)
    );

    // "Conectar sin Tor": nothing asked at all, not even directly.
    let (tor, direct) = (Mock::new(), Mock::new());
    let net = Net::with_transports(
        Some(Arc::clone(&tor) as Arc<dyn Transport>),
        Arc::clone(&direct) as Arc<dyn Transport>,
    );
    net.allow_direct(DirectPermit::for_session()).unwrap();
    assert_eq!(
        check_on(net, &key, "0.1.0").await.err(),
        Some(UpdateError::WithoutTor)
    );
    assert!(tor.connections().is_empty());
    assert!(direct.connections().is_empty());
}

// ---- The download ----

#[tokio::test]
async fn the_installer_is_verified_before_it_is_kept_and_held_until_launched() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let scratch = Scratch::new("download");
    let installer = b"MZ the installer of 0.2.0".to_vec();
    let signature = signer.sign_installer(&installer, "0.2.0");
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![
            ok(&manifest("0.2.0", &installer_url("0.2.0"), &signature)),
            ok(&installer),
        ],
    );
    let net = tor_only(Some(Arc::clone(&tor)));
    let session = net.session();
    let client = client(net);
    let check = within(update::check(
        &client,
        &session,
        &TEST_SOURCE,
        &key,
        Platform::WindowsX64,
        v("0.1.0"),
    ))
    .await
    .unwrap();
    let offer = check.newer.unwrap();

    let held: HeldInstaller = within(update::download(
        &client,
        &session,
        &TEST_SOURCE,
        &key,
        &offer,
        scratch.path(),
    ))
    .await
    .unwrap();

    // Kept under the name it was signed with, its bytes those signed.
    assert_eq!(held.version(), v("0.2.0"));
    assert_eq!(
        held.path(),
        scratch.path().join("Trino Chat_0.2.0_x64-setup.exe")
    );
    assert_eq!(std::fs::read(held.path()).unwrap(), installer);
    // The manifest, then the installer, both from trinochat.org through
    // Tor (the other mirror was asked too, and did not answer), every one
    // on the updater's kind of circuit.
    let connections = tor.connections();
    let to_trino: Vec<_> = connections
        .iter()
        .filter(|(target, _)| target.host == "trinochat.org")
        .collect();
    assert_eq!(to_trino.len(), 2);
    assert_eq!(connections.len(), 3);
    assert!(connections
        .iter()
        .all(|(_, iso)| iso.kind() == IsoKind::UPDATE));
    // While it is held, nobody can change it before it runs (Windows).
    #[cfg(windows)]
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .open(held.path())
        .is_err());
    drop(held);
}

#[tokio::test]
async fn an_installer_that_is_not_the_one_signed_is_never_kept() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let scratch = Scratch::new("tampered");
    let signature = signer.sign_installer(b"the real one", "0.2.0");
    let tor = Mock::new();
    mock_http::serve(
        &tor,
        "https://trinochat.org",
        vec![
            ok(&manifest("0.2.0", &installer_url("0.2.0"), &signature)),
            ok(b"a swapped one"),
        ],
    );
    let net = tor_only(Some(tor));
    let session = net.session();
    let client = client(net);
    let offer = within(update::check(
        &client,
        &session,
        &TEST_SOURCE,
        &key,
        Platform::WindowsX64,
        v("0.1.0"),
    ))
    .await
    .unwrap()
    .newer
    .unwrap();

    let result = within(update::download(
        &client,
        &session,
        &TEST_SOURCE,
        &key,
        &offer,
        scratch.path(),
    ))
    .await;

    assert_eq!(result.err(), Some(UpdateError::Signature));
    assert_eq!(std::fs::read_dir(scratch.path()).unwrap().count(), 0);
}

#[test]
fn an_installer_on_disk_is_checked_again_when_it_is_held() {
    let signer = TestSigner::new();
    let key = signer.update_key();
    let scratch = Scratch::new("held");
    let path = scratch.path().join("Trino Chat_0.2.0_x64-setup.exe");
    std::fs::write(&path, b"what was signed").unwrap();
    let signed = key
        .check_comment(
            &signer.sign_installer(b"what was signed", "0.2.0"),
            Platform::WindowsX64,
        )
        .unwrap();
    assert!(key.hold_verified(&signed, &path).is_ok());

    std::fs::write(&path, b"changed on disk").unwrap();
    assert_eq!(
        key.hold_verified(&signed, &path).err(),
        Some(SigError::Installer)
    );
}

// ---- Design test 59: the updater's own permit (R-07) ----

fn obsolete_net(scratch: &Scratch, direct: &Arc<Mock>) -> Arc<Net> {
    let fake = FakeTor::new(Mock::new());
    fake.fail_next(LaunchError::Obsolete);
    let net = Net::with_backend(
        NetConfig {
            tor_home: scratch.path().join("tor"),
            pt: None,
        },
        fake as Arc<dyn TorBackend>,
        Arc::clone(direct) as Arc<dyn Transport>,
    );
    net.start();
    net
}

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the updater's permit is under test
async fn the_updater_permit_reaches_only_its_hosts_and_never_a_websocket() {
    let scratch = Scratch::new("permit");
    let direct = Mock::new();
    let signer = TestSigner::new();
    let key = signer.update_key();

    // Only while Arti is obsolete.
    let ready = tor_only(Some(Mock::new()));
    assert_eq!(
        HttpClient::for_update_with_tls(ready, DirectPermit::for_updater(), mock_http::test_tls())
            .err(),
        Some(HttpError::NotPermitted)
    );
    let net = obsolete_net(&scratch, &direct);
    assert!(matches!(net.status_now(), NetStatus::Obsolete { .. }));
    // The session's permit is not the updater's.
    assert_eq!(
        HttpClient::for_update_with_tls(
            Arc::clone(&net),
            DirectPermit::for_session(),
            mock_http::test_tls()
        )
        .err(),
        Some(HttpError::NotPermitted)
    );
    let client = HttpClient::for_update_with_tls(
        Arc::clone(&net),
        DirectPermit::for_updater(),
        mock_http::test_tls(),
    )
    .unwrap();

    // trinochat.org's manifest, direct, with the same signature check.
    let signature = signer.sign_installer(b"x", "0.2.0");
    mock_http::serve(
        &direct,
        "https://trinochat.org",
        vec![ok(&manifest("0.2.0", &installer_url("0.2.0"), &signature))],
    );
    let session = net.session();
    let only_trino = Source {
        manifests: &TEST_MIRRORS[..1],
        ..TEST_SOURCE
    };
    let check = within(update::check(
        &client,
        &session,
        &only_trino,
        &key,
        Platform::WindowsX64,
        v("0.1.0"),
    ))
    .await
    .unwrap();
    assert_eq!(check.newer.map(|offer| offer.version), Some(v("0.2.0")));

    // Any other host, or http://, is refused before any connection.
    let iso = session.iso(IsoKind::UPDATE, "x");
    for url in [
        "https://mirror.trino.invalid/latest.json",
        "http://trinochat.org/updates/latest.json",
    ] {
        let sent =
            within(client.send(Request::get(url).unwrap(), &iso, update::MANIFEST_DEADLINES)).await;
        assert_eq!(sent.err(), Some(HttpError::NotPermitted), "{url}");
    }
    // A WebSocket never goes direct: the permit does not reach `ws_connect`.
    assert_eq!(
        within(ws_connect(&net, "wss://trinochat.org/", &iso))
            .await
            .err(),
        Some(NetError::TorNotReady)
    );
    assert_eq!(direct.connections().len(), 1);
    assert_eq!(net.mode(), Mode::Tor, "the mode did not change");
}

#[tokio::test]
#[allow(clippy::disallowed_methods)]
async fn the_updater_permit_never_waits_for_tor() {
    // Arti is obsolete: there is no Tor to wait for, and the direct
    // request goes at once.
    let scratch = Scratch::new("permit-wait");
    let direct = Mock::new();
    let net = obsolete_net(&scratch, &direct);
    let client = HttpClient::for_update_with_tls(
        Arc::clone(&net),
        DirectPermit::for_updater(),
        mock_http::test_tls(),
    )
    .unwrap();
    mock_http::serve(&direct, "https://trinochat.org", vec![ok(b"{}")]);
    let iso = net.session().iso(IsoKind::UPDATE, "x");
    let started = std::time::Instant::now();
    let mut response = within(client.send(
        Request::get("https://trinochat.org/updates/latest.json").unwrap(),
        &iso,
        update::MANIFEST_DEADLINES,
    ))
    .await
    .unwrap();
    assert_eq!(response.read_capped(10).await.unwrap(), b"{}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

// ---- Design test 40: the daily check and its switch (§6.3) ----

const DAY: u64 = 24 * 60 * 60;
/// 14 Oct 2026, 12:00 UTC.
const NOW: u64 = 1_792_065_600;

fn today() -> u64 {
    NOW - NOW % DAY
}

fn seeded(seed: u64) -> rand::rngs::StdRng {
    use rand::SeedableRng;
    rand::rngs::StdRng::seed_from_u64(seed)
}

fn distinct(times: &[u64]) -> usize {
    times
        .iter()
        .collect::<std::collections::BTreeSet<_>>()
        .len()
}

#[test]
fn the_daily_check_runs_once_at_a_random_time_and_obeys_the_switch() {
    // On by default (decision 4), and never checked.
    let fresh = UpdateSettings::default();
    assert!(fresh.daily);
    assert_eq!(fresh.checked_day, None);

    // Not checked today: some time in what is left of today.
    let times: Vec<u64> = (0..32)
        .map(|seed| fresh.next_check(NOW, &mut seeded(seed)).unwrap())
        .collect();
    assert!(times.iter().all(|&at| at >= NOW && at < today() + DAY));
    assert!(distinct(&times) > 16, "drawn at random: {times:?}");

    // Checked today: once a day, so some time tomorrow.
    let mut checked = fresh;
    checked.checked(NOW);
    assert_eq!(checked.checked_day, Some(today()));
    let tomorrow: Vec<u64> = (0..32)
        .map(|seed| checked.next_check(NOW + 60, &mut seeded(seed)).unwrap())
        .collect();
    assert!(tomorrow
        .iter()
        .all(|&at| at >= today() + DAY && at < today() + 2 * DAY));
    assert!(distinct(&tomorrow) > 16, "drawn at random: {tomorrow:?}");
    // Checked yesterday: due again today.
    let at = checked.next_check(NOW + DAY, &mut seeded(1)).unwrap();
    assert!(at >= NOW + DAY && at < today() + 2 * DAY);

    // The switch off: no daily check at all ("Buscar ahora" stays).
    let off = UpdateSettings {
        daily: false,
        ..checked
    };
    assert_eq!(off.next_check(NOW, &mut seeded(1)), None);

    // A check that gave nothing is tried again in an hour or so, never at
    // once.
    for seed in 0..32 {
        let again = update::retry_at(NOW, &mut seeded(seed));
        assert!((NOW + 30 * 60..=NOW + 90 * 60).contains(&again), "{again}");
    }
}

#[test]
fn the_switch_and_the_last_day_are_kept_in_tor_and_never_a_time_of_day() {
    let scratch = Scratch::new("settings");
    let home = scratch.path();
    // Nothing kept, or something unreadable: on, never checked.
    assert_eq!(UpdateSettings::load(home), UpdateSettings::default());
    std::fs::write(UpdateSettings::path(home), b"{ not json").unwrap();
    assert_eq!(UpdateSettings::load(home), UpdateSettings::default());

    UpdateSettings::set_daily(home, false).unwrap();
    UpdateSettings::record_check(home, NOW).unwrap();
    let kept = UpdateSettings::load(home);
    assert!(!kept.daily);
    assert_eq!(kept.checked_day, Some(today()));
    let text = std::fs::read_to_string(UpdateSettings::path(home)).unwrap();
    assert!(!text.contains(&NOW.to_string()), "{text}");
    assert_eq!(UpdateSettings::path(home), home.join(update::UPDATE_FILE));
    assert_eq!(update::UPDATE_FILE, "update.json");

    UpdateSettings::set_daily(home, true).unwrap();
    assert_eq!(
        UpdateSettings::load(home),
        UpdateSettings {
            daily: true,
            checked_day: Some(today())
        }
    );
}

// ---- The daily check: the news and the mirrors together (§6.4, §7) ----

const NEWS_URL: &str = "https://news.trino.invalid/feed.json";
const ONLY_MIRROR: [&str; 1] = ["https://mirror.trino.invalid/latest.json"];

fn mirrors<'a>(key: &'a UpdateKey, source: &'a Source) -> Mirrors<'a> {
    Mirrors {
        source,
        key,
        signer: news::Signer::trino_updates(),
        feeds: std::slice::from_ref(&NEWS_URL),
    }
}

/// Design test 43, with the mirrors' answer: the news say 0.3.0 is out,
/// and no mirror offers more than 0.2.0.
#[tokio::test]
async fn the_daily_check_asks_the_news_and_the_mirrors_and_warns_of_a_freeze() {
    let scratch = Scratch::new("daily");
    let signer = TestSigner::new();
    let key = signer.update_key();
    let source = Source {
        manifests: &ONLY_MIRROR,
        ..TEST_SOURCE
    };
    let tor_home = scratch.path().join("tor");
    let seen = news::Seen {
        seq: 7,
        latest: Some(v("0.3.0")),
        valid_until: Some(NOW + 30 * DAY),
        fresh_at: Some(today()),
        since: Some(today()),
    };
    seen.save(&tor_home).unwrap();
    let tor = Mock::new();
    let signature = signer.sign_installer(b"x", "0.2.0");
    let url = "https://mirror.trino.invalid/Trino.Chat_0.2.0_x64-setup.exe";
    mock_http::serve(
        &tor,
        "https://mirror.trino.invalid",
        vec![ok(&manifest("0.2.0", url, &signature))],
    );
    let fake = FakeTor::new(Arc::clone(&tor));
    let net = Net::with_backend(
        NetConfig {
            tor_home: tor_home.clone(),
            pt: None,
        },
        Arc::clone(&fake) as Arc<dyn TorBackend>,
        Arc::new(Forbidden),
    );
    let client = client(Arc::clone(&net));

    // No Tor yet: nothing direct, and no day recorded.
    let early = within(update::daily(
        &client,
        &mirrors(&key, &source),
        Platform::WindowsX64,
        v("0.1.0"),
        NOW,
    ))
    .await;
    assert_eq!(early.check.err(), Some(UpdateError::TorNotReady));
    assert_eq!(UpdateSettings::load(&tor_home).checked_day, None);

    net.start();
    fake.ready();
    within(net.ready(Duration::from_secs(5))).await.unwrap();
    let daily = within(update::daily(
        &client,
        &mirrors(&key, &source),
        Platform::WindowsX64,
        v("0.1.0"),
        NOW,
    ))
    .await;

    let check = daily.check.unwrap();
    assert_eq!(check.offered, Some(v("0.2.0")));
    assert_eq!(check.newer.map(|offer| offer.version), Some(v("0.2.0")));
    // Nobody serves the news here: the bundled copy, and the freeze the
    // mirrors' answer shows.
    assert_eq!(daily.news.status, news::NewsStatus::Bundled);
    assert_eq!(
        daily.news.freeze,
        Some(news::Freeze::NotOffered {
            latest: "0.3.0".to_string()
        })
    );
    // The day checked, kept beside seen.json.
    assert_eq!(UpdateSettings::load(&tor_home).checked_day, Some(today()));
    // The news and the manifest, each through Tor on its own kind.
    let kinds: Vec<IsoKind> = tor
        .connections()
        .into_iter()
        .map(|(_, iso)| iso.kind())
        .collect();
    assert!(kinds.contains(&IsoKind::NEWS), "{kinds:?}");
    assert!(kinds.contains(&IsoKind::UPDATE), "{kinds:?}");
    net.stop();
}

#[tokio::test]
#[allow(clippy::disallowed_methods)] // the updater's permit is under test
async fn the_news_never_go_through_the_updaters_permit() {
    // The permit is for the manifests and the installer only (§2.8): the
    // news wait for Tor.
    let scratch = Scratch::new("permit-news");
    let direct = Mock::new();
    let net = obsolete_net(&scratch, &direct);
    let client = HttpClient::for_update_with_tls(
        Arc::clone(&net),
        DirectPermit::for_updater(),
        mock_http::test_tls(),
    )
    .unwrap();
    mock_http::serve(&direct, "https://trinochat.org", vec![ok(b"{}")]);
    let session = net.session();

    let news = within(news::check(
        &client,
        &session,
        news::Signer::trino_updates(),
        &news::FEED_MIRRORS,
        None,
        NOW,
    ))
    .await;

    assert_eq!(news.status, news::NewsStatus::Bundled);
    assert!(direct.connections().is_empty());
}

// ---- Linux: the running AppImage replaced in place (TOR-13) ----

/// The trusted comment `tauri signer sign` writes for Trino's AppImage of
/// `version`, named as tauri-bundler names it.
fn appimage_comment(version: &str) -> String {
    format!("timestamp:1792102211\tfile:Trino Chat_{version}_amd64.AppImage")
}

fn appimage_url(version: &str) -> String {
    format!("https://trinochat.org/updates/Trino.Chat_{version}_amd64.AppImage")
}

/// latest.json with a Linux entry.
fn linux_manifest(version: &str, signature: &str) -> Vec<u8> {
    serde_json::json!({
        "version": version,
        "platforms": {
            "linux-x86_64": { "url": appimage_url(version), "signature": signature }
        }
    })
    .to_string()
    .into_bytes()
}

/// The name a staged AppImage of 0.2.0 has beside the running one.
const STAGED_020: &str = ".Trino Chat_0.2.0_amd64.AppImage.part";

/// What the running AppImage holds in these tests.
const RUNNING: &[u8] = b"the AppImage running now, 0.1.0";

/// A running AppImage, kept as the person keeps it (any name, any folder),
/// and a release 0.2.0 signed by a key of its own, offered through a Tor
/// that serves the manifest, then what the test says as the AppImage.
struct AppImageCase {
    scratch: Scratch,
    appimage: PathBuf,
    key: UpdateKey,
    signed: Vec<u8>,
    tor: Arc<Mock>,
    net: Arc<Net>,
}

impl AppImageCase {
    async fn new(name: &str, served: &[u8]) -> (AppImageCase, update::Offer) {
        let signer = TestSigner::new();
        let key = signer.update_key();
        let scratch = Scratch::new(name);
        let apps = scratch.path().join("Apps");
        std::fs::create_dir_all(&apps).unwrap();
        let appimage = apps.join("trino.AppImage");
        std::fs::write(&appimage, RUNNING).unwrap();
        let signed = b"the AppImage of 0.2.0".to_vec();
        let signature = signer.sign(&signed, &appimage_comment("0.2.0"));
        let tor = Mock::new();
        mock_http::serve(
            &tor,
            "https://trinochat.org",
            vec![ok(&linux_manifest("0.2.0", &signature)), ok(served)],
        );
        let net = tor_only(Some(Arc::clone(&tor)));
        let session = net.session();
        let offer = within(update::check(
            &client(Arc::clone(&net)),
            &session,
            &TEST_SOURCE,
            &key,
            Platform::LinuxX64,
            v("0.1.0"),
        ))
        .await
        .unwrap()
        .newer
        .expect("0.2.0 is offered");
        let case = AppImageCase {
            scratch,
            appimage,
            key,
            signed,
            tor,
            net,
        };
        (case, offer)
    }

    fn apps(&self) -> PathBuf {
        self.scratch.path().join("Apps")
    }

    async fn stage(&self, offer: &update::Offer) -> Result<StagedAppImage, AppImageError> {
        let session = self.net.session();
        within(update::download_appimage(
            &client(Arc::clone(&self.net)),
            &session,
            &TEST_SOURCE,
            &self.key,
            offer,
            &self.appimage,
        ))
        .await
    }

    fn old(&self) -> Vec<u8> {
        std::fs::read(&self.appimage).unwrap()
    }

    /// What is in the AppImage's folder, sorted.
    fn folder(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.apps())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// How many connections went to trinochat.org.
    fn to_trino(&self) -> usize {
        self.tor
            .connections()
            .iter()
            .filter(|(target, _)| target.host == "trinochat.org")
            .count()
    }
}

#[test]
fn the_running_appimage_is_the_one_its_runtime_names_and_runs_from_its_mount() {
    let scratch = Scratch::new("running");
    let appimage = scratch.path().join("Apps").join("Trino Chat.AppImage");
    let mounted = scratch
        .path()
        .join(".mount_TrinoCa1b2c3")
        .join("usr")
        .join("bin")
        .join("trino-gui");
    let installed = scratch.path().join("usr").join("bin").join("trino-gui");
    let os = std::ffi::OsStr::new;

    assert_eq!(
        update::running_appimage(Some(appimage.as_os_str()), Some(&mounted)),
        Some(appimage.clone())
    );
    // A .deb or an .rpm: no APPIMAGE.
    assert_eq!(update::running_appimage(None, Some(&installed)), None);
    // APPIMAGE set by hand for a program that does not run from an
    // AppImage's mount: nothing is replaced.
    assert_eq!(
        update::running_appimage(Some(appimage.as_os_str()), Some(&installed)),
        None
    );
    assert_eq!(
        update::running_appimage(Some(appimage.as_os_str()), None),
        None
    );
    // Not a full path, or empty.
    assert_eq!(
        update::running_appimage(Some(os("Trino Chat.AppImage")), Some(&mounted)),
        None
    );
    assert_eq!(update::running_appimage(Some(os("")), Some(&mounted)), None);
}

#[test]
fn the_new_appimage_keeps_the_old_mode_and_runs_wherever_it_can_be_read() {
    for (old, new) in [
        (0o755, 0o755),
        (0o700, 0o700),
        (0o750, 0o750),
        (0o644, 0o755),
        (0o600, 0o700),
        (0o640, 0o750),
        (0o444, 0o555),
        // Never set-user, set-group or sticky.
        (0o4755, 0o755),
        (0o2755, 0o755),
        (0o1755, 0o755),
        // A regular file's type bits (S_IFREG) are not a mode to give.
        (0o100644, 0o755),
    ] {
        assert_eq!(update::executable_mode(old), new, "{old:o}");
    }
}

#[tokio::test]
async fn an_appimage_is_staged_beside_the_running_one_and_replaces_it_only_when_asked() {
    let (case, offer) = AppImageCase::new("appimage", b"the AppImage of 0.2.0").await;

    let staged = case.stage(&offer).await.unwrap();

    // Beside it, so the rename stays on one filesystem; checked and
    // written, and nothing replaced yet.
    assert_eq!(staged.version(), v("0.2.0"));
    let apps = std::fs::canonicalize(case.apps()).unwrap();
    assert_eq!(staged.staged(), apps.join(STAGED_020));
    assert_eq!(std::fs::read(staged.staged()).unwrap(), case.signed);
    assert_eq!(case.old(), RUNNING);
    assert_eq!(case.folder(), [STAGED_020, "trino.AppImage"]);
    assert_eq!(case.to_trino(), 2, "the manifest and the AppImage");

    let replaced = staged.replace(&case.key).unwrap();

    // The name the person gave it, the bytes signed, nothing left over.
    assert_eq!(replaced, apps.join("trino.AppImage"));
    assert_eq!(case.old(), case.signed);
    assert_eq!(case.folder(), ["trino.AppImage"]);
}

#[tokio::test]
async fn a_refused_signature_leaves_the_old_appimage_untouched() {
    // Swapped on the way: refused before a byte is written.
    let (case, offer) = AppImageCase::new("appimage-swapped", b"a swapped AppImage").await;

    let error = case.stage(&offer).await.unwrap_err();

    assert_eq!(error, AppImageError::Update(UpdateError::Signature));
    assert_eq!(case.old(), RUNNING);
    assert_eq!(case.folder(), ["trino.AppImage"]);
}

#[tokio::test]
async fn a_staged_appimage_changed_before_the_yes_is_refused_and_the_old_one_stays() {
    let (case, offer) = AppImageCase::new("appimage-changed", b"the AppImage of 0.2.0").await;
    let staged = case.stage(&offer).await.unwrap();
    let path = staged.staged().to_path_buf();

    // Windows: held, nobody can change it while it waits.
    #[cfg(windows)]
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_err());
    // Elsewhere it can be changed, and the yes checks it again first.
    #[cfg(not(windows))]
    {
        std::fs::write(&path, b"changed while it waited").unwrap();
        assert_eq!(
            staged.replace(&case.key).unwrap_err(),
            UpdateError::Signature
        );
        assert_eq!(case.old(), RUNNING);
        assert_eq!(case.folder(), ["trino.AppImage"]);
    }
}

#[tokio::test]
async fn a_crash_between_the_write_and_the_rename_leaves_the_old_appimage_untouched() {
    let (case, offer) = AppImageCase::new("appimage-crash", b"the AppImage of 0.2.0").await;
    std::fs::write(case.apps().join("notes.txt"), b"mine").unwrap();
    std::fs::write(
        case.apps().join(".Other App_0.2.0_amd64.AppImage.part"),
        b"not Trino's",
    )
    .unwrap();
    let staged = case.stage(&offer).await.unwrap();

    // Trino dies once the staged file is written and synced, before the
    // rename: the system closes its files, and nothing of Trino's runs
    // after that, not even a drop.
    staged.crash();

    assert_eq!(case.old(), RUNNING);
    assert!(case.folder().contains(&STAGED_020.to_string()));

    // The next time Trino opens, its staged file goes, and nothing else.
    update::remove_appimage_leftovers(&case.appimage);
    assert_eq!(
        case.folder(),
        [
            ".Other App_0.2.0_amd64.AppImage.part",
            "notes.txt",
            "trino.AppImage"
        ]
    );
    assert_eq!(case.old(), RUNNING);
}

#[tokio::test]
async fn a_staged_appimage_never_installed_is_removed() {
    let (case, offer) = AppImageCase::new("appimage-dropped", b"the AppImage of 0.2.0").await;
    let staged = case.stage(&offer).await.unwrap();

    drop(staged);

    assert_eq!(case.folder(), ["trino.AppImage"]);
    assert_eq!(case.old(), RUNNING);
}

#[tokio::test]
async fn an_appimage_that_cannot_be_replaced_is_not_downloaded_beside_it() {
    // Gone since Trino opened.
    let (case, offer) = AppImageCase::new("appimage-gone", b"the AppImage of 0.2.0").await;
    std::fs::remove_file(&case.appimage).unwrap();
    assert_eq!(
        case.stage(&offer).await.unwrap_err(),
        AppImageError::NotInPlace(NotInPlace::Missing)
    );
    assert_eq!(case.to_trino(), 1, "only the manifest: nothing downloaded");
    assert!(case.folder().is_empty());

    // A folder where the staged file cannot be made: here, a folder sits
    // where it would go.
    let (case, offer) = AppImageCase::new("appimage-blocked", b"the AppImage of 0.2.0").await;
    std::fs::create_dir(case.apps().join(STAGED_020)).unwrap();
    assert_eq!(
        case.stage(&offer).await.unwrap_err(),
        AppImageError::NotInPlace(NotInPlace::NotWritable)
    );
    assert_eq!(case.to_trino(), 1, "only the manifest: nothing downloaded");
    assert_eq!(case.old(), RUNNING);
}

/// A folder the person cannot write, as a system folder is: never sudo,
/// only the fallback.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn an_appimage_in_a_folder_trino_cannot_write_is_not_replaced() {
    use std::os::unix::fs::PermissionsExt;
    let (case, offer) = AppImageCase::new("appimage-readonly", b"the AppImage of 0.2.0").await;
    let apps = case.apps();
    std::fs::set_permissions(&apps, std::fs::Permissions::from_mode(0o555)).unwrap();
    let root = std::fs::File::create(apps.join("probe")).is_ok();

    let result = case.stage(&offer).await;

    std::fs::set_permissions(&apps, std::fs::Permissions::from_mode(0o755)).unwrap();
    if root {
        // root writes anywhere: the case cannot be made here.
        eprintln!("running as root: a read-only folder is still writable");
        return;
    }
    assert_eq!(
        result.unwrap_err(),
        AppImageError::NotInPlace(NotInPlace::NotWritable)
    );
    assert_eq!(case.to_trino(), 1, "only the manifest: nothing downloaded");
    assert_eq!(case.old(), RUNNING);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_new_appimage_keeps_the_mode_of_the_old_one() {
    use std::os::unix::fs::PermissionsExt;
    let (case, offer) = AppImageCase::new("appimage-mode", b"the AppImage of 0.2.0").await;
    std::fs::set_permissions(&case.appimage, std::fs::Permissions::from_mode(0o750)).unwrap();
    let staged = case.stage(&offer).await.unwrap();
    // Staged for its owner only, until it replaces the AppImage.
    let staged_mode = std::fs::metadata(staged.staged())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(staged_mode & 0o777, 0o600);

    staged.replace(&case.key).unwrap();

    let mode = std::fs::metadata(&case.appimage)
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o7777, 0o750);
    assert_eq!(case.old(), case.signed);
}
