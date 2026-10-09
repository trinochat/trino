// blossom.rs — encrypted file transfer via Blossom blob servers.
//
// Files are NEVER sent through the relay (events are tiny). Instead:
//   1. encrypt the file with a fresh random AES-256-GCM key,
//   2. upload the CIPHERTEXT to a Blossom server (BUD-01/02), addressed by its
//      sha256, authorised with a signed kind-24242 nostr event,
//   3. send only { url, key, sha256, name, mime, size } through the E2E chat.
// The Blossom host only ever sees ciphertext.

use crate::crypto::{aes_gcm_decrypt, aes_gcm_encrypt, random_array, sha256, CryptoError};
use crate::identity::Identity;
use crate::nostr::build_and_sign_event;
use base64::Engine;
use thiserror::Error;

// Default public Blossom servers (tried in order). The host only stores ciphertext.
pub const DEFAULT_BLOSSOM: &[&str] = &["https://blossom.primal.net", "https://blossom.band"];

#[derive(Debug, Error)]
pub enum BlossomError {
    #[error("crypto: {0}")]
    Crypto(#[from] CryptoError),
    #[error("http: {0}")]
    Http(String),
    #[error("all blossom servers failed")]
    AllFailed,
    #[error("hash mismatch — downloaded blob is corrupt or tampered")]
    HashMismatch,
    #[error("bad key/blob")]
    BadInput,
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

fn build_auth(identity: &Identity, verb: &str, sha256_hex: &str) -> Result<String, BlossomError> {
    // Kind-24242 authorization event (BUD-01), base64'd into the Authorization header.
    let expiration = chrono::Utc::now().timestamp() + 3600;
    let tags = vec![
        vec!["t".to_string(), verb.to_string()],
        vec!["x".to_string(), sha256_hex.to_string()],
        vec!["expiration".to_string(), expiration.to_string()],
    ];
    let event = build_and_sign_event(
        &identity.nostr.priv_bytes,
        &identity.nostr.pub_bytes,
        24242,
        &format!("{} blob", verb),
        tags,
        None,
    )
    .map_err(|e| BlossomError::Http(e.to_string()))?;
    let json = serde_json::to_string(&event).map_err(|e| BlossomError::Http(e.to_string()))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(json))
}

/// Upload ciphertext to the first Blossom server that accepts it. Returns the URL.
pub async fn upload(
    identity: &Identity,
    blob: &[u8],
    sha256_hex: &str,
) -> Result<String, BlossomError> {
    let auth = build_auth(identity, "upload", sha256_hex)?;
    let client = reqwest::Client::new();
    for server in DEFAULT_BLOSSOM {
        let url = format!("{}/upload", server.trim_end_matches('/'));
        let res = client
            .put(&url)
            .header("Authorization", format!("Nostr {}", auth))
            .header("Content-Type", "application/octet-stream")
            .body(blob.to_vec())
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => {
                if let Ok(desc) = r.json::<serde_json::Value>().await {
                    if let Some(u) = desc.get("url").and_then(|v| v.as_str()) {
                        return Ok(u.to_string());
                    }
                }
                // Fallback: canonical address form if the descriptor lacks `url`.
                return Ok(format!("{}/{}", server.trim_end_matches('/'), sha256_hex));
            }
            _ => continue,
        }
    }
    Err(BlossomError::AllFailed)
}

/// Download a blob by hash and verify its sha256 before returning it.
///
/// SECURITY: the sender-supplied `_url` is IGNORED. Trusting it would let a
/// malicious peer point us at their own server and log our IP (a zero-click
/// deanonymization). Blossom is content-addressed, so we refetch the blob by
/// hash from OUR OWN known servers only — never a host the peer chose.
pub async fn download(_url: &str, sha256_hex: &str) -> Result<Vec<u8>, BlossomError> {
    for server in DEFAULT_BLOSSOM {
        let addr = format!("{}/{}", server.trim_end_matches('/'), sha256_hex);
        let Ok(res) = reqwest::get(&addr).await else {
            continue;
        };
        if !res.status().is_success() {
            continue;
        }
        let Ok(bytes) = res.bytes().await else {
            continue;
        };
        let bytes = bytes.to_vec();
        if hex::encode(sha256(&bytes)) == sha256_hex {
            return Ok(bytes);
        }
        // Hash mismatch from this server → try the next, don't trust it.
    }
    Err(BlossomError::AllFailed)
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
}
