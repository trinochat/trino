//! The updater's signatures (Tor design §6.1, §6.2; spike S7): minisign,
//! as `tauri signer generate` and `tauri signer sign` make them.
//!
//! - **The key** is the updater's own, distinct from the GnuPG release key
//!   and from "Trino Updates". Its public half is built into the program
//!   (`TRINO_UPDATER_KEY`); its private half stays with whoever signs the
//!   releases (docs/updater.md). Tauri hands a public key out as the
//!   minisign .pub file in base64; the file itself and its bare line are
//!   taken too.
//! - **A signature** is what `tauri signer sign` writes in the .sig file
//!   and in latest.json: the minisign text in base64. Only the form that
//!   signs a BLAKE2b-512 of the file ("ED", what `tauri signer` makes) is
//!   taken.
//! - **The signed version, before the download.** A minisign signature
//!   carries a trusted comment, which `tauri signer sign` fills with
//!   `timestamp:<seconds>\tfile:<name>`, and a global signature over the
//!   file's signature and that comment. So the comment is checked on its
//!   own, before anything is downloaded, and the version comes from it:
//!   the installer's signed name (`Trino Chat_<version>_x64-setup.exe`) and,
//!   if a signing script adds one, a `version:` field that must agree.
//!   A mirror cannot pass an old installer off as a new one, nor announce
//!   a version no signature vouches for.
//! - **The installer** is checked whole with minisign-verify against the
//!   same signature, and once more from disk while it is held open, right
//!   before it runs (`HeldInstaller`).

use super::Platform;
use crate::news::Version;
use base64::Engine;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use thiserror::Error;

/// The updater's public key, made by David with `tauri signer generate`
/// (password-protected; the private half never leaves him), in the form
/// Tauri prints it: the minisign .pub file in base64. Changing it is
/// changing who can ship Trino: a release signed with the old key must
/// carry the new one first (Tor design §6.2).
pub const TRINO_UPDATER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDJBNjg2MUZDNzAxQjc1RDcKUldUWGRSdHcvR0ZvS3NFLzU0ZGRlS0pQeXRvV2JoSVhVeE9kVkpMRVV5bkQ1bFBNcHhva1lNa2YK";

/// Its key id, as minisign and `tauri signer` print it.
pub const TRINO_UPDATER_KEY_ID: &str = "2A6861FC701B75D7";

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The first line of a minisign file.
const UNTRUSTED: &str = "untrusted comment:";
/// The prefix of a signature's third line.
const TRUSTED: &str = "trusted comment: ";

/// Why a key or a signature is not taken. Short and fixed: never what a
/// mirror sent.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SigError {
    /// Not a minisign public key in any form Tauri writes.
    #[error("not an updater key")]
    Key,
    /// Not a minisign signature.
    #[error("not a signature")]
    Encoding,
    /// A minisign signature of a kind `tauri signer` does not make.
    #[error("not the kind of signature Trino's releases have")]
    Algorithm,
    /// Made by another key.
    #[error("signed by another key")]
    KeyId,
    /// The trusted comment is not the one signed.
    #[error("the signature does not check out")]
    Comment,
    /// The trusted comment lacks what a release's has.
    #[error("the signature does not say what it signs")]
    Fields,
    /// The signed name is not Trino's installer for this platform, or the
    /// version in it is not the one announced.
    #[error("the signature is for another version")]
    Version,
    /// The installer is not the one signed.
    #[error("the installer is not the one signed")]
    Installer,
    /// The installer could not be read.
    #[error("the installer could not be read")]
    Io,
}

/// A minisign public key the updater trusts.
pub struct UpdateKey {
    key: minisign_verify::PublicKey,
    id: [u8; 8],
    raw: ed25519_dalek::VerifyingKey,
}

impl UpdateKey {
    /// The key Trino's releases are signed with (`TRINO_UPDATER_KEY`).
    pub fn trino() -> &'static UpdateKey {
        static KEY: LazyLock<UpdateKey> = LazyLock::new(|| {
            UpdateKey::from_tauri(TRINO_UPDATER_KEY).expect("the built-in updater key")
        });
        &KEY
    }

    /// A public key as Tauri prints it (the .pub file in base64), as the
    /// .pub file, or as its bare line.
    pub fn from_tauri(text: &str) -> Result<UpdateKey, SigError> {
        let text = text.trim();
        let pub_file = if text.starts_with(UNTRUSTED) {
            text.to_string()
        } else if let Some(line) = decode(text).filter(|bytes| bytes.len() == 42) {
            return UpdateKey::from_line_bytes(&line);
        } else {
            decode(text)
                .and_then(|bytes| String::from_utf8(bytes).ok())
                .filter(|text| text.starts_with(UNTRUSTED))
                .ok_or(SigError::Key)?
        };
        let line = pub_file.lines().nth(1).ok_or(SigError::Key)?;
        let bytes = decode(line.trim()).ok_or(SigError::Key)?;
        UpdateKey::from_line_bytes(&bytes)
    }

    /// "Ed", the id and the Ed25519 key: 42 bytes.
    fn from_line_bytes(bytes: &[u8]) -> Result<UpdateKey, SigError> {
        if bytes.len() != 42 || &bytes[..2] != b"Ed" {
            return Err(SigError::Key);
        }
        let key = minisign_verify::PublicKey::from_base64(&B64.encode(bytes))
            .map_err(|_| SigError::Key)?;
        let mut id = [0u8; 8];
        id.copy_from_slice(&bytes[2..10]);
        let mut point = [0u8; 32];
        point.copy_from_slice(&bytes[10..]);
        let raw = ed25519_dalek::VerifyingKey::from_bytes(&point).map_err(|_| SigError::Key)?;
        Ok(UpdateKey { key, id, raw })
    }

    /// The key id as minisign prints it: its 8 bytes, last first, in hex.
    pub fn key_id(&self) -> String {
        self.id.iter().rev().map(|b| format!("{b:02X}")).collect()
    }

    /// The bare minisign line of the key.
    pub fn minisign_line(&self) -> String {
        let mut bytes = b"Ed".to_vec();
        bytes.extend_from_slice(&self.id);
        bytes.extend_from_slice(self.raw.as_bytes());
        B64.encode(bytes)
    }

    /// Check `signature` (as latest.json carries it) for its trusted
    /// comment only, as made by this key, and read from the comment the
    /// version it signs for `platform`. Nothing is downloaded for this.
    pub fn check_comment(
        &self,
        signature: &str,
        platform: Platform,
    ) -> Result<SignedComment, SigError> {
        let text = signature_text(signature)?;
        let parts = Parts::parse(&text)?;
        if &parts.first[..2] != b"ED" {
            return Err(SigError::Algorithm);
        }
        if parts.first[2..10] != self.id {
            return Err(SigError::KeyId);
        }
        let mut signed = parts.first[10..].to_vec();
        signed.extend_from_slice(parts.comment.as_bytes());
        let global = ed25519_dalek::Signature::from_bytes(&parts.global);
        self.raw
            .verify_strict(&signed, &global)
            .map_err(|_| SigError::Comment)?;
        // The library reads it the same way, or it is not taken.
        let decoded = minisign_verify::Signature::decode(&text).map_err(|_| SigError::Encoding)?;
        if decoded.trusted_comment() != parts.comment {
            return Err(SigError::Encoding);
        }
        let fields = Fields::parse(&parts.comment)?;
        let version = platform.version_in(fields.file).ok_or(SigError::Version)?;
        if fields.version.is_some_and(|signed| signed != version) {
            return Err(SigError::Version);
        }
        Ok(SignedComment {
            version,
            file: fields.file.to_string(),
            timestamp: fields.timestamp,
            text,
        })
    }

    /// Whether `installer` is the file `signed` was made for, by this key.
    pub fn verify(&self, signed: &SignedComment, installer: &[u8]) -> Result<(), SigError> {
        let signature = signed.decoded()?;
        self.key
            .verify(installer, &signature, false)
            .map_err(|_| SigError::Installer)
    }

    /// Open the installer at `path`, so that nobody can change it while it
    /// is held (Windows), and check it once more, through that handle,
    /// against `signed`: what runs is what was signed.
    pub fn hold_verified(
        &self,
        signed: &SignedComment,
        path: &Path,
    ) -> Result<HeldInstaller, SigError> {
        let signature = signed.decoded()?;
        let mut file = crate::tor::pt::hold(path).map_err(|_| SigError::Io)?;
        let mut verifier = self
            .key
            .verify_stream(&signature)
            .map_err(|_| SigError::Algorithm)?;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|_| SigError::Io)?;
            if read == 0 {
                break;
            }
            verifier.update(&buffer[..read]);
        }
        verifier.finalize().map_err(|_| SigError::Installer)?;
        Ok(HeldInstaller {
            _file: file,
            path: path.to_path_buf(),
            version: signed.version,
        })
    }
}

/// A signature whose trusted comment checked out: the version it signs,
/// for the platform it was checked for.
#[derive(Clone, PartialEq, Eq)]
pub struct SignedComment {
    version: Version,
    file: String,
    timestamp: u64,
    /// The minisign text, for the check of the installer.
    text: String,
}

impl SignedComment {
    pub fn version(&self) -> Version {
        self.version
    }

    /// The installer's name, as it was signed.
    pub fn file(&self) -> &str {
        &self.file
    }

    /// When it was signed, in seconds since 1970.
    pub fn timestamp(&self) -> u64 {
        self.timestamp
    }

    fn decoded(&self) -> Result<minisign_verify::Signature, SigError> {
        minisign_verify::Signature::decode(&self.text).map_err(|_| SigError::Encoding)
    }
}

impl std::fmt::Debug for SignedComment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignedComment")
            .field("version", &self.version)
            .field("file", &self.file)
            .field("timestamp", &self.timestamp)
            .finish()
    }
}

/// An installer checked against its signature and held open, so that it
/// cannot be changed, renamed or removed until it has been started and
/// this is dropped (Windows; R-24's way, as for lyrebird).
pub struct HeldInstaller {
    _file: File,
    path: PathBuf,
    version: Version,
}

impl HeldInstaller {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn version(&self) -> Version {
        self.version
    }

    /// The handle it is held through: its mode is set and it is synced
    /// through it (appimage.rs).
    #[cfg(target_os = "linux")]
    pub(crate) fn file(&self) -> &File {
        &self._file
    }
}

impl std::fmt::Debug for HeldInstaller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HeldInstaller")
            .field("version", &self.version)
            .finish()
    }
}

/// Standard base64, with or without padding mistakes refused.
fn decode(text: &str) -> Option<Vec<u8>> {
    B64.decode(text.trim()).ok()
}

/// The minisign text of a signature as Tauri writes it (base64), or as
/// minisign does (the text itself).
fn signature_text(signature: &str) -> Result<String, SigError> {
    let signature = signature.trim();
    if signature.starts_with(UNTRUSTED) {
        return Ok(signature.to_string());
    }
    decode(signature)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|text| text.starts_with(UNTRUSTED))
        .ok_or(SigError::Encoding)
}

/// The four lines of a minisign signature.
struct Parts {
    /// The algorithm (2 bytes), the key id (8) and the signature (64).
    first: [u8; 74],
    /// The trusted comment, without its prefix.
    comment: String,
    /// The global signature.
    global: [u8; 64],
}

impl Parts {
    fn parse(text: &str) -> Result<Parts, SigError> {
        let mut lines = text.lines();
        let _untrusted = lines.next().ok_or(SigError::Encoding)?;
        let first = lines
            .next()
            .and_then(decode)
            .and_then(|bytes| <[u8; 74]>::try_from(bytes).ok())
            .ok_or(SigError::Encoding)?;
        let comment = lines
            .next()
            .and_then(|line| line.strip_prefix(TRUSTED))
            .ok_or(SigError::Encoding)?
            .to_string();
        let global = lines
            .next()
            .and_then(decode)
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .ok_or(SigError::Encoding)?;
        Ok(Parts {
            first,
            comment,
            global,
        })
    }
}

/// What a release's trusted comment says: `key:value` fields, separated by
/// tabs. `timestamp` and `file` must be there, once; `version` may.
struct Fields<'a> {
    timestamp: u64,
    file: &'a str,
    version: Option<Version>,
}

impl<'a> Fields<'a> {
    fn parse(comment: &'a str) -> Result<Fields<'a>, SigError> {
        let (mut timestamp, mut file, mut version) = (None, None, None);
        for field in comment.split('\t') {
            let (name, value) = field.split_once(':').ok_or(SigError::Fields)?;
            let slot_taken = match name {
                "timestamp" => timestamp
                    .replace(value.parse::<u64>().map_err(|_| SigError::Fields)?)
                    .is_some(),
                "file" => file.replace(value).is_some(),
                "version" => version
                    .replace(value.parse::<Version>().map_err(|_| SigError::Version)?)
                    .is_some(),
                // Another field a signing tool may add: nothing to take.
                _ => false,
            };
            if slot_taken {
                return Err(SigError::Fields);
            }
        }
        match (timestamp, file) {
            (Some(timestamp), Some(file)) => Ok(Fields {
                timestamp,
                file,
                version,
            }),
            _ => Err(SigError::Fields),
        }
    }
}
