// blossom.rs — encrypted file transfer via Blossom blob servers.
//
// Files are NEVER sent through the relay (events are tiny). Instead:
//   1. encrypt the file with a fresh random AES-256-GCM key,
//   2. upload the CIPHERTEXT to a Blossom server (BUD-01/02), addressed by its
//      sha256, authorised with a signed kind-24242 nostr event,
//   3. send only { url, key, sha256, name, mime, size } through the E2E chat.
// The Blossom host only ever sees ciphertext. Every request goes through
// net.rs: deadlines, no redirects, answers read up to a size.

use crate::crypto::{aes_gcm_decrypt, aes_gcm_encrypt, random_array, sha256, CryptoError};
use crate::identity::Identity;
use crate::net::{self, Deadlines};
use crate::nostr::build_and_sign_event;
use base64::Engine;
use serde::Serialize;
use std::time::Duration;
use thiserror::Error;

// Default public Blossom servers (tried in order). The host only stores ciphertext.
pub const DEFAULT_BLOSSOM: &[&str] = &["https://blossom.primal.net", "https://blossom.band"];

/// How far back an authorization is dated. A server rejects one from its
/// future (BUD-11: `created_at` must be in the past), so a clock that runs
/// a little ahead of the server's must not make every upload fail.
const AUTH_CLOCK_MARGIN_SECS: i64 = 60;
/// How long an authorization stays valid, from now.
const AUTH_LIFETIME_SECS: i64 = 3_600;
/// However small a blob, its transfer gets two minutes.
const TRANSFER_FLOOR: Duration = Duration::from_secs(120);
/// And as long again as the blob takes at 32 KiB/s, about 256 kbit/s: a
/// fixed two minutes failed every large file below 1.75 Mbit/s.
const SLOWEST_BYTES_PER_SEC: u64 = 32 * 1024;
/// How long a download may receive nothing, so a server that stalls does
/// not hold it for the whole deadline of the largest blob.
const DOWNLOAD_IDLE: Duration = Duration::from_secs(30);
/// The largest blob there can be: the largest attachment
/// (`MAX_ATTACHMENT_BYTES` in commands.rs), its 12-byte nonce and its
/// 16-byte tag. A download past it is refused.
pub const MAX_BLOB_BYTES: usize = 25 * 1024 * 1024 + 12 + 16;
/// The descriptor a server answers an upload with is small JSON.
const MAX_DESCRIPTOR_BYTES: usize = 16 * 1024;
/// The longest URL a file can have once uploaded. The announcement of a
/// file is sized with one this long before the upload (commands.rs), so a
/// file that cannot be announced is never uploaded.
pub const MAX_URL_BYTES: usize = 256;
/// How much of a server's `X-Reason` is kept.
const MAX_REASON_CHARS: usize = 80;

#[derive(Debug, Error)]
pub enum BlossomError {
    #[error("crypto: {0}")]
    Crypto(#[from] CryptoError),
    #[error("http: {0}")]
    Http(String),
    /// Every server failed: why, for each one, in the order they were tried.
    #[error("all blossom servers failed")]
    AllFailed { servers: Vec<ServerFailure> },
    #[error("hash mismatch — downloaded blob is corrupt or tampered")]
    HashMismatch,
    #[error("bad key/blob")]
    BadInput,
}

/// Why one server did not take or give a blob: `timeout`, `connect`,
/// `network`, `http <status>` (with the server's `X-Reason`, BUD-01, when it
/// gives one), `hash mismatch`, or an answer past its size. Never a URL.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ServerFailure {
    pub server: String,
    pub reason: String,
}

pub struct EncryptedFile {
    pub blob: Vec<u8>,      // nonce(12) || aes-gcm(ciphertext||tag)
    pub key_hex: String,    // 32-byte AES key
    pub sha256_hex: String, // sha256 of `blob` (Blossom address)
}

/// Encrypt file bytes with a fresh random key. The nonce is prepended to the blob.
pub fn encrypt_file(plaintext: &[u8]) -> Result<EncryptedFile, BlossomError> {
    let key = random_array::<32>();
    let (ct, nonce) = aes_gcm_encrypt(&key, plaintext, None)?;
    let mut blob = Vec::with_capacity(nonce.len() + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    let sha = sha256(&blob);
    Ok(EncryptedFile {
        key_hex: hex::encode(key),
        sha256_hex: hex::encode(sha),
        blob,
    })
}

/// Decrypt a downloaded blob (nonce || ciphertext) with the hex key.
pub fn decrypt_file(blob: &[u8], key_hex: &str) -> Result<Vec<u8>, BlossomError> {
    if blob.len() < 12 {
        return Err(BlossomError::BadInput);
    }
    let key = hex::decode(key_hex).map_err(|_| BlossomError::BadInput)?;
    let (nonce, ct) = blob.split_at(12);
    Ok(aes_gcm_decrypt(&key, ct, nonce, None)?)
}

/// The `Authorization` token of a request: a kind-24242 event (BUD-01),
/// base64url without padding as BUD-11 asks, dated a minute back so a server
/// whose clock runs behind ours still takes it.
fn build_auth(identity: &Identity, verb: &str, sha256_hex: &str) -> Result<String, BlossomError> {
    let now = chrono::Utc::now().timestamp();
    let tags = vec![
        vec!["t".to_string(), verb.to_string()],
        vec!["x".to_string(), sha256_hex.to_string()],
        vec![
            "expiration".to_string(),
            (now + AUTH_LIFETIME_SECS).to_string(),
        ],
    ];
    let event = build_and_sign_event(
        &identity.nostr.priv_bytes,
        &identity.nostr.pub_bytes,
        24242,
        &format!("{} blob", verb),
        tags,
        Some(now - AUTH_CLOCK_MARGIN_SECS),
    )
    .map_err(|e| BlossomError::Http(e.to_string()))?;
    let json = serde_json::to_string(&event).map_err(|e| BlossomError::Http(e.to_string()))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json))
}

/// The deadlines of a transfer of `bytes`: `TRANSFER_FLOOR`, plus what it
/// takes at `SLOWEST_BYTES_PER_SEC`. 25 MiB get 920 s.
fn transfer_deadlines(bytes: usize) -> Deadlines {
    let at_the_slowest = Duration::from_secs(bytes as u64 / SLOWEST_BYTES_PER_SEC);
    Deadlines {
        connect: Duration::from_secs(10),
        total: TRANSFER_FLOOR + at_the_slowest,
        idle: None,
    }
}

/// A download's size is only known once it arrives: the deadlines of the
/// largest blob, and `DOWNLOAD_IDLE` between two reads.
fn download_deadlines() -> Deadlines {
    Deadlines {
        idle: Some(DOWNLOAD_IDLE),
        ..transfer_deadlines(MAX_BLOB_BYTES)
    }
}

/// Upload ciphertext to the first Blossom server that accepts it. Returns the URL.
pub async fn upload(
    identity: &Identity,
    blob: &[u8],
    sha256_hex: &str,
) -> Result<String, BlossomError> {
    let deadlines = transfer_deadlines(blob.len());
    upload_to(DEFAULT_BLOSSOM, deadlines, identity, blob, sha256_hex).await
}

/// `upload` to `servers`, in order, each with `deadlines`. When all fail,
/// the error says why for each one (K2): nothing is swallowed.
async fn upload_to(
    servers: &[&str],
    deadlines: Deadlines,
    identity: &Identity,
    blob: &[u8],
    sha256_hex: &str,
) -> Result<String, BlossomError> {
    let auth = build_auth(identity, "upload", sha256_hex)?;
    let client = net::client(deadlines).map_err(|e| BlossomError::Http(e.to_string()))?;
    let mut failures = Vec::new();
    for server in servers {
        match put_blob(&client, server, &auth, blob, sha256_hex).await {
            Ok(url) => return Ok(url),
            Err(reason) => failures.push(ServerFailure {
                server: server.to_string(),
                reason,
            }),
        }
    }
    Err(BlossomError::AllFailed { servers: failures })
}

/// PUT `blob` on `server`: the URL it is at, or why not.
async fn put_blob(
    client: &reqwest::Client,
    server: &str,
    auth: &str,
    blob: &[u8],
    sha256_hex: &str,
) -> Result<String, String> {
    let base = server.trim_end_matches('/');
    let mut response = client
        .put(format!("{base}/upload"))
        .header(reqwest::header::AUTHORIZATION, format!("Nostr {auth}"))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(blob.to_vec())
        .send()
        .await
        .map_err(|e| net::reason(&e).to_string())?;
    if !response.status().is_success() {
        return Err(http_failure(&response));
    }
    // The blob is stored: the descriptor only says where. Without a `url`
    // in it that an announcement can carry, the canonical address.
    let url = net::read_capped(&mut response, MAX_DESCRIPTOR_BYTES)
        .await
        .ok()
        .and_then(|body| serde_json::from_slice::<serde_json::Value>(&body).ok())
        .and_then(|descriptor| descriptor.get("url")?.as_str().map(str::to_string))
        .filter(|url| announceable(url));
    Ok(url.unwrap_or_else(|| format!("{base}/{sha256_hex}")))
}

/// Whether `url`, from a server's descriptor, can go into a file's
/// announcement as it is: at most `MAX_URL_BYTES`, all printable ASCII that
/// JSON writes unescaped, so the announcement is no larger than it was
/// sized before the upload.
fn announceable(url: &str) -> bool {
    !url.is_empty()
        && url.len() <= MAX_URL_BYTES
        && url
            .bytes()
            .all(|b| b.is_ascii_graphic() && b != b'"' && b != b'\\')
}

/// `http <status>`, followed by the server's `X-Reason` when it gives one,
/// as `reason_text` cleans it.
fn http_failure(response: &reqwest::Response) -> String {
    let status = response.status().as_u16();
    let reason: String = response
        .headers()
        .get("x-reason")
        .and_then(|value| value.to_str().ok())
        .map(reason_text)
        .unwrap_or_default();
    match reason.trim() {
        "" => format!("http {status}"),
        reason => format!("http {status}: {reason}"),
    }
}

/// What the UI may show of a server's `X-Reason`: printable ASCII only, so
/// no control, format or bidi character can hide or reorder the error, and
/// at most `MAX_REASON_CHARS`. `HeaderValue::to_str` already refuses a
/// header with bytes past ASCII; this holds whatever reads the header.
fn reason_text(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(MAX_REASON_CHARS)
        .collect()
}

/// A sha256 in lower-case hex, the only thing that goes into a download URL:
/// it comes from the peer's `FileRef`.
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Download a blob by hash and verify its sha256 before returning it.
///
/// SECURITY: the sender-supplied `_url` is IGNORED. Trusting it would let a
/// malicious peer point us at their own server and log our IP (a zero-click
/// deanonymization). Blossom is content-addressed, so we refetch the blob by
/// hash from OUR OWN known servers only — never a host the peer chose.
pub async fn download(_url: &str, sha256_hex: &str) -> Result<Vec<u8>, BlossomError> {
    let deadlines = download_deadlines();
    download_from(DEFAULT_BLOSSOM, deadlines, MAX_BLOB_BYTES, sha256_hex).await
}

/// `download` from `servers`, in order, each with `deadlines` and at most
/// `max` bytes.
async fn download_from(
    servers: &[&str],
    deadlines: Deadlines,
    max: usize,
    sha256_hex: &str,
) -> Result<Vec<u8>, BlossomError> {
    if !is_sha256_hex(sha256_hex) {
        return Err(BlossomError::BadInput);
    }
    let client = net::client(deadlines).map_err(|e| BlossomError::Http(e.to_string()))?;
    let mut failures = Vec::new();
    for server in servers {
        match get_blob(&client, server, max, sha256_hex).await {
            Ok(bytes) => return Ok(bytes),
            Err(reason) => failures.push(ServerFailure {
                server: server.to_string(),
                reason,
            }),
        }
    }
    Err(BlossomError::AllFailed { servers: failures })
}

/// GET the blob `sha256_hex` from `server`, or why not.
async fn get_blob(
    client: &reqwest::Client,
    server: &str,
    max: usize,
    sha256_hex: &str,
) -> Result<Vec<u8>, String> {
    let address = format!("{}/{}", server.trim_end_matches('/'), sha256_hex);
    let mut response = client
        .get(&address)
        .send()
        .await
        .map_err(|e| net::reason(&e).to_string())?;
    if !response.status().is_success() {
        return Err(http_failure(&response));
    }
    let bytes = net::read_capped(&mut response, max)
        .await
        .map_err(|e| e.to_string())?;
    // A server that sends other bytes is not trusted: the next one is tried.
    if hex::encode(sha256(&bytes)) != sha256_hex {
        return Err("hash mismatch".to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let data = b"una foto secreta \xff\x00\x01 con bytes binarios";
        let enc = encrypt_file(data).unwrap();
        assert_eq!(enc.key_hex.len(), 64);
        assert_eq!(enc.sha256_hex.len(), 64);
        assert_ne!(&enc.blob[12..], &data[..]); // actually encrypted
        let dec = decrypt_file(&enc.blob, &enc.key_hex).unwrap();
        assert_eq!(dec, data);
    }

    #[test]
    fn wrong_key_fails() {
        let enc = encrypt_file(b"secreto").unwrap();
        let bad = "00".repeat(32);
        assert!(decrypt_file(&enc.blob, &bad).is_err());
    }

    #[test]
    fn tampered_blob_fails() {
        let mut enc = encrypt_file(b"secreto importante").unwrap();
        enc.blob[20] ^= 0xff;
        assert!(decrypt_file(&enc.blob, &enc.key_hex).is_err());
    }

    #[test]
    fn sha_addresses_ciphertext() {
        let enc = encrypt_file(b"hola").unwrap();
        assert_eq!(hex::encode(sha256(&enc.blob)), enc.sha256_hex);
    }

    // ---- K2: authorization, failures and deadlines ----

    use crate::identity::create_identity;
    use crate::net::mock::{self, Reply};
    use crate::nostr::{verify_event, NostrEvent};
    use std::time::Duration;

    const QUICK: Deadlines = Deadlines {
        connect: Duration::from_secs(2),
        total: Duration::from_millis(500),
        idle: None,
    };

    fn sha_of(blob: &[u8]) -> String {
        hex::encode(sha256(blob))
    }

    fn tag<'a>(event: &'a NostrEvent, name: &str) -> &'a str {
        event
            .tags
            .iter()
            .find(|t| t.first().map(String::as_str) == Some(name))
            .and_then(|t| t.get(1))
            .map(String::as_str)
            .unwrap_or_else(|| panic!("missing tag {name}"))
    }

    /// Fails the test instead of hanging when a transfer has no deadline.
    async fn within<T>(work: impl std::future::Future<Output = T>) -> T {
        tokio::time::timeout(Duration::from_secs(5), work)
            .await
            .expect("still waiting after 5 s: no deadline")
    }

    #[test]
    fn the_authorization_is_base64url_without_padding() {
        // BUD-11. A long event almost always has a '+' or a '/' in standard
        // base64, and some padding: try a few.
        let me = create_identity();
        for n in 0..8u8 {
            let sha = hex::encode([n; 32]);
            let token = build_auth(&me, "upload", &sha).unwrap();
            assert!(!token.contains(['+', '/', '=']), "{token}");
            let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(&token)
                .expect("base64url without padding");
            let event: NostrEvent = serde_json::from_slice(&json).unwrap();
            assert!(verify_event(&event));
            assert_eq!(event.kind, 24242);
            assert_eq!(tag(&event, "t"), "upload");
            assert_eq!(tag(&event, "x"), sha);
        }
    }

    #[test]
    fn the_authorization_is_dated_back_for_a_server_clock_behind_ours() {
        // A server rejects an authorization from its future (BUD-11).
        let me = create_identity();
        let now = chrono::Utc::now().timestamp();
        let token = build_auth(&me, "upload", &hex::encode([1u8; 32])).unwrap();
        let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(&token)
            .unwrap();
        let event: NostrEvent = serde_json::from_slice(&json).unwrap();

        assert!(
            (event.created_at - (now - AUTH_CLOCK_MARGIN_SECS)).abs() <= 5,
            "created_at {} is not a minute back from {now}",
            event.created_at
        );
        assert_eq!(AUTH_CLOCK_MARGIN_SECS, 60);
        let expiration: i64 = tag(&event, "expiration").parse().unwrap();
        assert!((expiration - (now + 3_600)).abs() <= 5, "{expiration}");
    }

    #[tokio::test]
    async fn an_upload_moves_on_to_the_next_server_when_one_fails() {
        let me = create_identity();
        let blob = b"ciphertext".to_vec();
        let sha = sha_of(&blob);
        let (failing, _) =
            mock::serve(|_| vec![mock::response("500 Internal Server Error", "", b"")]).await;
        let descriptor =
            |base: &str| format!(r#"{{"url":"{base}/{}","size":10}}"#, sha_of(b"ciphertext"));
        let (working, seen) = mock::serve(|base| {
            vec![mock::response(
                "200 OK",
                "Content-Type: application/json\r\n",
                descriptor(base).as_bytes(),
            )]
        })
        .await;

        let url = within(upload_to(&[&failing, &working], QUICK, &me, &blob, &sha))
            .await
            .unwrap();

        assert_eq!(url, format!("{working}/{sha}"));
        let seen = seen.lock().unwrap();
        let request = &seen[0];
        assert!(
            request.head.starts_with("PUT /upload HTTP/1.1\r\n"),
            "{}",
            request.head
        );
        assert_eq!(request.body, blob);
        let auth = mock::header(&request.head, "authorization").unwrap();
        let token = auth.strip_prefix("Nostr ").expect("the Nostr scheme");
        assert!(base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(token)
            .is_ok());
    }

    #[tokio::test]
    async fn a_url_too_long_or_odd_for_an_announcement_gives_way_to_the_canonical_one() {
        // The announcement of a file is sized before its upload, with a URL
        // of MAX_URL_BYTES (commands.rs): a server must not make it longer.
        let me = create_identity();
        let blob = b"ciphertext".to_vec();
        let sha = sha_of(&blob);
        let served = |url: String| {
            let descriptor = serde_json::json!({ "url": url, "size": 10 }).to_string();
            mock::serve(move |_| {
                vec![mock::response(
                    "200 OK",
                    "Content-Type: application/json\r\n",
                    descriptor.as_bytes(),
                )]
            })
        };
        for odd in [
            format!("https://cdn.example/{}", "a".repeat(MAX_URL_BYTES)),
            format!("https://cdn.example/{sha}\"quoted\""),
            format!("https://cdn.example/{sha}\\x"),
            format!("https://cdn.example/{sha}\u{202E}gnp"),
            format!("https://cdn.example/{sha} .png"),
            String::new(),
        ] {
            let (server, _) = served(odd.clone()).await;

            let url = within(upload_to(&[&server], QUICK, &me, &blob, &sha))
                .await
                .unwrap();

            assert_eq!(url, format!("{server}/{sha}"), "{odd:?}");
        }
        // A short, plain one is kept as the server gives it.
        let plain = format!("https://cdn.example/{sha}.png");
        let (server, _) = served(plain.clone()).await;
        let url = within(upload_to(&[&server], QUICK, &me, &blob, &sha))
            .await
            .unwrap();
        assert_eq!(url, plain);
    }

    #[test]
    fn every_canonical_url_fits_an_announcement() {
        let sha = "f".repeat(64);
        for server in DEFAULT_BLOSSOM {
            let canonical = format!("{server}/{sha}");
            assert!(announceable(&canonical), "{canonical}");
        }
    }

    #[tokio::test]
    async fn when_every_server_fails_the_error_says_why_for_each() {
        let me = create_identity();
        let blob = b"ciphertext".to_vec();
        let (refusing, _) = mock::serve(|_| {
            vec![mock::response(
                "413 Payload Too Large",
                "X-Reason: blob too big\r\n",
                b"",
            )]
        })
        .await;
        let (silent, _) = mock::serve(|_| vec![Reply::Never]).await;
        let (plain_error, _) =
            mock::serve(|_| vec![mock::response("503 Service Unavailable", "", b"")]).await;

        let error = within(upload_to(
            &[&refusing, &silent, &plain_error],
            QUICK,
            &me,
            &blob,
            &sha_of(&blob),
        ))
        .await
        .unwrap_err();

        let BlossomError::AllFailed { servers } = error else {
            panic!("expected AllFailed, got {error:?}");
        };
        let failure = |server: &str, reason: &str| ServerFailure {
            server: server.to_string(),
            reason: reason.to_string(),
        };
        assert_eq!(
            servers,
            [
                failure(&refusing, "http 413: blob too big"),
                failure(&silent, "timeout"),
                failure(&plain_error, "http 503"),
            ]
        );
    }

    #[tokio::test]
    async fn a_download_moves_on_from_a_silent_or_lying_server() {
        let blob = b"the encrypted file".to_vec();
        let sha = sha_of(&blob);
        let (silent, _) = mock::serve(|_| vec![Reply::Never]).await;
        let (lying, _) = mock::serve(|_| vec![mock::response("200 OK", "", b"other bytes")]).await;
        let (working, seen) = mock::serve(|_| vec![mock::response("200 OK", "", &blob)]).await;

        let got = within(download_from(
            &[&silent, &lying, &working],
            QUICK,
            1024,
            &sha,
        ))
        .await
        .unwrap();

        assert_eq!(got, blob);
        assert!(seen.lock().unwrap()[0]
            .head
            .starts_with(&format!("GET /{sha} HTTP/1.1\r\n")));
    }

    #[tokio::test]
    async fn a_download_larger_than_any_file_is_refused() {
        let blob = vec![7u8; 2048];
        let (big, _) = mock::serve(|_| vec![mock::until_close("200 OK", &blob)]).await;

        // Lengths only: a failure must not print every byte.
        let error = within(download_from(&[&big], QUICK, 1024, &sha_of(&blob)))
            .await
            .map(|got| got.len())
            .unwrap_err();

        let BlossomError::AllFailed { servers } = error else {
            panic!("expected AllFailed, got {error:?}");
        };
        assert_eq!(servers[0].reason, "the answer is larger than 1024 bytes");
    }

    #[tokio::test]
    async fn a_hash_that_is_not_one_never_goes_into_a_url() {
        // It comes from the peer's FileRef.
        let (server, seen) = mock::serve(|_| vec![mock::response("200 OK", "", b"x")]).await;
        for bad in ["../../etc/passwd", "ABCD", "", &"g".repeat(64)] {
            let error = download_from(&[&server], QUICK, 1024, bad)
                .await
                .unwrap_err();
            assert!(
                matches!(error, BlossomError::BadInput),
                "{bad:?}: {error:?}"
            );
        }
        assert!(seen.lock().unwrap().is_empty());
    }

    // ---- B2: deadlines that fit the blob, and what a reason may show ----

    #[test]
    fn a_transfer_gets_two_minutes_and_what_it_takes_at_256_kbit_s() {
        // The largest attachment: 120 s, plus 25 MiB at 32 KiB/s.
        assert_eq!(
            transfer_deadlines(25 * 1024 * 1024).total,
            Duration::from_secs(120 + 800)
        );
        assert_eq!(
            transfer_deadlines(MAX_BLOB_BYTES).total,
            Duration::from_secs(920)
        );
        // A small file gets the two minutes every transfer had.
        assert_eq!(transfer_deadlines(0).total, Duration::from_secs(120));
        // 20 MB on a 1 Mbit/s uplink takes 160 s.
        assert!(transfer_deadlines(20_000_000).total > Duration::from_secs(160));
        // reqwest's read deadline also counts while the blob is sent, so an
        // upload has none.
        assert_eq!(transfer_deadlines(1).idle, None);
        assert_eq!(transfer_deadlines(1).connect, Duration::from_secs(10));
        // A download may be the largest blob, and stalls for 30 s at most.
        assert_eq!(
            download_deadlines(),
            Deadlines {
                idle: Some(Duration::from_secs(30)),
                ..transfer_deadlines(MAX_BLOB_BYTES)
            }
        );
    }

    #[tokio::test]
    async fn a_download_gives_up_on_a_server_that_sends_nothing_for_too_long() {
        // A slow line needs a long total deadline; a server that stalls
        // must not hold the download for all of it.
        let blob = b"the encrypted file".to_vec();
        let sha = sha_of(&blob);
        let (silent, _) = mock::serve(|_| vec![Reply::Never]).await;
        let (working, _) = mock::serve(|_| vec![mock::response("200 OK", "", &blob)]).await;
        let patient = Deadlines {
            total: Duration::from_secs(60),
            idle: Some(Duration::from_millis(300)),
            ..QUICK
        };

        let got = within(download_from(&[&silent, &working], patient, 1024, &sha))
            .await
            .unwrap();

        assert_eq!(got, blob);
    }

    #[test]
    fn a_reason_shows_only_printable_ascii() {
        // Format and bidi characters would hide or reorder the error shown.
        assert_eq!(reason_text("blob\u{202E}gib oot"), "blobgib oot");
        assert_eq!(
            reason_text("a\u{200B}b\u{2066}c\u{2069}d\u{FEFF}e\u{AD}f"),
            "abcdef"
        );
        assert_eq!(reason_text("tab\there, line\nbreak"), "tabhere, linebreak");
        assert_eq!(reason_text("máximo 10 MB"), "mximo 10 MB");
        assert_eq!(reason_text(&"x".repeat(200)), "x".repeat(MAX_REASON_CHARS));
    }

    #[tokio::test]
    async fn a_reason_with_bytes_past_ascii_never_reaches_the_ui() {
        // HeaderValue::to_str refuses such a header whole.
        let me = create_identity();
        let blob = b"ciphertext".to_vec();
        let (server, _) = mock::serve(|_| {
            vec![mock::response(
                "413 Payload Too Large",
                "X-Reason: blob \u{202E}gib oot\r\n",
                b"",
            )]
        })
        .await;

        let error = within(upload_to(&[&server], QUICK, &me, &blob, &sha_of(&blob)))
            .await
            .unwrap_err();

        let BlossomError::AllFailed { servers } = error else {
            panic!("expected AllFailed, got {error:?}");
        };
        assert_eq!(servers[0].reason, "http 413");
    }

    #[test]
    fn the_largest_blob_is_the_largest_attachment_sealed() {
        // 25 MB of file, its 12-byte nonce and its 16-byte tag.
        assert_eq!(MAX_BLOB_BYTES, 25 * 1024 * 1024 + 12 + 16);
    }
}
