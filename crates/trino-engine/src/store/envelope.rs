//! One file of the store (design §4.2 and §4.4).
//!
//! ```text
//!  6  "TRDAT\0"
//!  1  format version: 1
//!  1  kind: 1 account, 2 prefs, 3 history, 4 sessions, 5 profiles,
//!     6 sticker, 7 index, 8 a file of an earlier version kept aside
//!  4  key_gen (u32 LE)
//! 16  id_vault
//! 12  nonce
//!  …  AES-256-GCM(kind key, seq ‖ length ‖ content ‖ zeros), with its tag
//! ```
//!
//! The associated data is the first 28 bytes plus the file's logical name
//! (`account`, `sticker:<name>`…), and GCM binds the nonce: a byte changed
//! anywhere, a file put in the place of another kind or another sticker, or
//! a file of another account are all refused. `seq`, the store's write
//! counter (u64 LE), is inside the encryption, so it is authenticated and the
//! header does not tell how many times Trino wrote. The zeros pad the
//! plaintext to the next step of 4, 8, 16, 32 or 64 KiB, and to a multiple
//! of 64 KiB above that, so a file's size gives only a range.

use super::keys::{KeyLabel, StoreKeys, ID_VAULT_LEN};
use crate::crypto::{aes_gcm_decrypt, aes_gcm_encrypt, NONCE_SIZE};
use zeroize::Zeroizing;

const MAGIC: &[u8; 6] = b"TRDAT\0";
const FORMAT_VERSION: u8 = 1;
/// Magic, version, kind, key_gen and id_vault: the part of the header in the
/// associated data.
pub const AAD_HEADER_LEN: usize = 6 + 1 + 1 + 4 + ID_VAULT_LEN;
/// The whole header, with the nonce.
pub const HEADER_LEN: usize = AAD_HEADER_LEN + NONCE_SIZE;
pub const TAG_LEN: usize = 16;
/// `seq` and the content's length, before the content.
const PREFIX_LEN: usize = 8 + 4;
const KIB: usize = 1024;
const PAD_STEPS: [usize; 5] = [4 * KIB, 8 * KIB, 16 * KIB, 32 * KIB, 64 * KIB];

/// Which file: its kind, and for a sticker its name on disk.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Slot {
    Account,
    Prefs,
    History,
    Sessions,
    Profiles,
    /// A sticker, by its name on disk (`StoreKeys::sticker_disk_name`).
    Sticker(String),
    Index,
    /// A file of an earlier version that the migration could not read, kept
    /// sealed in `aside/` by its name (`config.json`…) so it never lies
    /// there in clear (design §5.2). Never listed in the index.
    Legacy(String),
}

impl Slot {
    /// The data files with a fixed name, in the order they are checked.
    pub const FIXED: [Slot; 5] = [
        Slot::Account,
        Slot::Prefs,
        Slot::History,
        Slot::Sessions,
        Slot::Profiles,
    ];

    fn kind_byte(&self) -> u8 {
        match self {
            Slot::Account => 1,
            Slot::Prefs => 2,
            Slot::History => 3,
            Slot::Sessions => 4,
            Slot::Profiles => 5,
            Slot::Sticker(_) => 6,
            Slot::Index => 7,
            Slot::Legacy(_) => 8,
        }
    }

    fn key_label(&self) -> KeyLabel {
        match self {
            Slot::Account => KeyLabel::Account,
            Slot::Prefs => KeyLabel::Prefs,
            Slot::History => KeyLabel::History,
            Slot::Sessions => KeyLabel::Sessions,
            Slot::Profiles => KeyLabel::Profiles,
            Slot::Sticker(_) => KeyLabel::Stickers,
            Slot::Index => KeyLabel::Index,
            Slot::Legacy(_) => KeyLabel::Legacy,
        }
    }

    /// The name the associated data and the index use.
    pub fn logical_name(&self) -> String {
        match self {
            Slot::Account => "account".into(),
            Slot::Prefs => "prefs".into(),
            Slot::History => "history".into(),
            Slot::Sessions => "sessions".into(),
            Slot::Profiles => "profiles".into(),
            Slot::Sticker(name) => format!("sticker:{name}"),
            Slot::Index => "index".into(),
            Slot::Legacy(name) => format!("legacy:{name}"),
        }
    }

    /// The slot a logical name stands for, if it is one of the index's: a
    /// file kept aside is not.
    pub fn from_logical_name(name: &str) -> Option<Slot> {
        match name {
            "account" => Some(Slot::Account),
            "prefs" => Some(Slot::Prefs),
            "history" => Some(Slot::History),
            "sessions" => Some(Slot::Sessions),
            "profiles" => Some(Slot::Profiles),
            "index" => Some(Slot::Index),
            _ => name
                .strip_prefix("sticker:")
                .filter(|disk_name| is_sticker_disk_name(disk_name))
                .map(|disk_name| Slot::Sticker(disk_name.to_string())),
        }
    }

    /// The kind, as the copies set aside are grouped (at most three each).
    pub fn kind_name(&self) -> &'static str {
        match self {
            Slot::Account => "account",
            Slot::Prefs => "prefs",
            Slot::History => "history",
            Slot::Sessions => "sessions",
            Slot::Profiles => "profiles",
            Slot::Sticker(_) => "sticker",
            Slot::Index => "index",
            Slot::Legacy(_) => "legacy",
        }
    }

    /// Where the file lives, relative to `store/`.
    pub fn relative_path(&self) -> std::path::PathBuf {
        match self {
            Slot::Sticker(name) => std::path::Path::new("stickers").join(format!("{name}.bin")),
            Slot::Legacy(name) => std::path::Path::new("aside").join(format!("legacy.{name}.bin")),
            other => format!("{}.bin", other.kind_name()).into(),
        }
    }
}

/// A sticker's name on disk: 32 lowercase hex digits.
pub fn is_sticker_disk_name(name: &str) -> bool {
    name.len() == 32
        && name
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Why a file was refused.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EnvelopeError {
    #[error("not a store file")]
    NotAStoreFile,
    #[error("unsupported store file version: {0}")]
    UnsupportedVersion(u8),
    /// A well-formed header that names another vault: another account's
    /// file, or one left behind by a wipe that was cut short.
    #[error("the file belongs to another vault")]
    OtherVault,
    /// The header names another kind of file than the place it is in.
    #[error("the file is of another kind than its place")]
    WrongPlace,
    #[error("the file is of key generation {0}, not this one")]
    WrongKeyGen(u32),
    /// Decryption or the plaintext's layout failed: changed, damaged or
    /// planted.
    #[error("the file was changed or damaged")]
    Tampered,
    #[error("the content is too large for one file")]
    TooLarge,
}

impl EnvelopeError {
    /// Any refusal but `OtherVault` means the file was changed, damaged or
    /// planted.
    pub fn is_other_vault(&self) -> bool {
        matches!(self, EnvelopeError::OtherVault)
    }
}

/// What an opened file holds.
pub struct Opened {
    pub seq: u64,
    pub content: Zeroizing<Vec<u8>>,
}

/// Only the counter and the size: the content is never printed.
impl std::fmt::Debug for Opened {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Opened")
            .field("seq", &self.seq)
            .field("content_len", &self.content.len())
            .finish()
    }
}

/// The plaintext size for `content_len` bytes of content: the next step.
pub fn padded_len(content_len: usize) -> usize {
    let plain = PREFIX_LEN + content_len;
    match PAD_STEPS.iter().find(|&&step| plain <= step) {
        Some(&step) => step,
        None => plain.div_ceil(64 * KIB) * 64 * KIB,
    }
}

/// Seal `content` as the file in `slot`, written with counter `seq`.
pub fn seal(
    keys: &StoreKeys,
    slot: &Slot,
    seq: u64,
    content: &[u8],
) -> Result<Vec<u8>, EnvelopeError> {
    let length = u32::try_from(content.len()).map_err(|_| EnvelopeError::TooLarge)?;
    let mut plain = Zeroizing::new(Vec::with_capacity(padded_len(content.len())));
    plain.extend_from_slice(&seq.to_le_bytes());
    plain.extend_from_slice(&length.to_le_bytes());
    plain.extend_from_slice(content);
    plain.resize(padded_len(content.len()), 0);

    let header = aad_header(slot, keys.key_gen(), keys.id_vault());
    let key = keys.kind_key(slot.key_label());
    let (ciphertext, nonce) = aes_gcm_encrypt(&*key, &plain, Some(&aad(&header, slot)))
        .map_err(|_| EnvelopeError::TooLarge)?;

    let mut file = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    file.extend_from_slice(&header);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&ciphertext);
    Ok(file)
}

/// The header up to the nonce.
fn aad_header(slot: &Slot, key_gen: u32, id_vault: &[u8; ID_VAULT_LEN]) -> [u8; AAD_HEADER_LEN] {
    let mut header = [0u8; AAD_HEADER_LEN];
    header[..6].copy_from_slice(MAGIC);
    header[6] = FORMAT_VERSION;
    header[7] = slot.kind_byte();
    header[8..12].copy_from_slice(&key_gen.to_le_bytes());
    header[12..].copy_from_slice(id_vault);
    header
}

/// The associated data: the header up to the nonce, then the logical name.
fn aad(header: &[u8; AAD_HEADER_LEN], slot: &Slot) -> Vec<u8> {
    let mut aad = header.to_vec();
    aad.extend_from_slice(slot.logical_name().as_bytes());
    aad
}

/// The key generation and the `id_vault` the header of `bytes` names, if
/// it is a file of the store. Nothing authenticates them here: only to
/// tell a store a rotation left behind (`rotate::generation_in`).
pub fn generation_of(bytes: &[u8]) -> Option<(u32, [u8; ID_VAULT_LEN])> {
    if bytes.len() < AAD_HEADER_LEN || &bytes[..6] != MAGIC || bytes[6] != FORMAT_VERSION {
        return None;
    }
    let key_gen = u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes"));
    let id_vault = bytes[12..AAD_HEADER_LEN].try_into().expect("16 bytes");
    Some((key_gen, id_vault))
}

/// Open `bytes` as the file in `slot`.
pub fn open(keys: &StoreKeys, slot: &Slot, bytes: &[u8]) -> Result<Opened, EnvelopeError> {
    if bytes.len() < AAD_HEADER_LEN || &bytes[..6] != MAGIC {
        return Err(EnvelopeError::NotAStoreFile);
    }
    if bytes[6] != FORMAT_VERSION {
        return Err(EnvelopeError::UnsupportedVersion(bytes[6]));
    }
    // A header of another vault means another account's file, whatever else
    // it says; the AEAD below would refuse it anyway.
    if &bytes[12..AAD_HEADER_LEN] != keys.id_vault() {
        return Err(EnvelopeError::OtherVault);
    }
    if bytes[7] != slot.kind_byte() {
        return Err(EnvelopeError::WrongPlace);
    }
    let key_gen = u32::from_le_bytes(bytes[8..12].try_into().expect("4 bytes"));
    if key_gen != keys.key_gen() {
        return Err(EnvelopeError::WrongKeyGen(key_gen));
    }
    if bytes.len() < HEADER_LEN + TAG_LEN {
        return Err(EnvelopeError::Tampered);
    }

    let header: [u8; AAD_HEADER_LEN] = bytes[..AAD_HEADER_LEN].try_into().expect("28 bytes");
    let nonce = &bytes[AAD_HEADER_LEN..HEADER_LEN];
    let key = keys.kind_key(slot.key_label());
    let plain = Zeroizing::new(
        aes_gcm_decrypt(
            &*key,
            &bytes[HEADER_LEN..],
            nonce,
            Some(&aad(&header, slot)),
        )
        .map_err(|_| EnvelopeError::Tampered)?,
    );
    unpad(&plain)
}

/// `seq` and the content from a decrypted plaintext, which must be laid out
/// exactly as `seal` lays it out.
fn unpad(plain: &[u8]) -> Result<Opened, EnvelopeError> {
    if plain.len() < PREFIX_LEN {
        return Err(EnvelopeError::Tampered);
    }
    let seq = u64::from_le_bytes(plain[..8].try_into().expect("8 bytes"));
    let length = u32::from_le_bytes(plain[8..PREFIX_LEN].try_into().expect("4 bytes")) as usize;
    let rest = &plain[PREFIX_LEN..];
    if length > rest.len() || plain.len() != padded_len(length) {
        return Err(EnvelopeError::Tampered);
    }
    let (content, padding) = rest.split_at(length);
    if padding.iter().any(|&byte| byte != 0) {
        return Err(EnvelopeError::Tampered);
    }
    Ok(Opened {
        seq,
        content: Zeroizing::new(content.to_vec()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::keys::testing::keys;

    fn sticker(byte: u8) -> Slot {
        Slot::Sticker(hex::encode([byte; 16]))
    }

    /// Design §12.1, test 1.
    #[test]
    fn a_sealed_file_opens_to_the_same_bytes() {
        let keys = keys(1);
        for (slot, content) in [
            (Slot::Account, b"{\"handle\":\"ana\"}".to_vec()),
            (Slot::History, Vec::new()),
            (sticker(3), vec![0xab; 70 * KIB]),
            (Slot::Index, b"{}".to_vec()),
        ] {
            let sealed = seal(&keys, &slot, 42, &content).unwrap();
            let opened = open(&keys, &slot, &sealed).unwrap();
            assert_eq!(opened.seq, 42, "{slot:?}");
            assert_eq!(*opened.content, content, "{slot:?}");
        }
    }

    #[test]
    fn the_header_says_what_the_file_is() {
        let keys = keys(1);
        let sealed = seal(&keys, &Slot::Sessions, 7, b"x").unwrap();
        assert_eq!(&sealed[..6], b"TRDAT\0");
        assert_eq!(sealed[6], 1, "format version");
        assert_eq!(sealed[7], 4, "kind: sessions");
        assert_eq!(&sealed[8..12], &1u32.to_le_bytes(), "key_gen");
        assert_eq!(&sealed[12..28], keys.id_vault());
    }

    /// Design §12.1, test 2.
    #[test]
    fn changing_any_header_byte_or_the_body_is_refused() {
        let keys = keys(1);
        let slot = Slot::Account;
        let sealed = seal(&keys, &slot, 9, b"{\"friends\":[]}").unwrap();

        let mut positions: Vec<usize> = (0..HEADER_LEN).collect();
        // The body: the first bytes (seq and length inside), the middle, and
        // the whole tag.
        positions.extend(HEADER_LEN..HEADER_LEN + 16);
        positions.push(sealed.len() / 2);
        positions.extend(sealed.len() - TAG_LEN..sealed.len());
        for at in positions {
            for bit in [0x01, 0x80] {
                let mut changed = sealed.clone();
                changed[at] ^= bit;
                let error = open(&keys, &slot, &changed).err();
                assert!(error.is_some(), "byte {at} bit {bit:#x} was accepted");
                let id_vault = AAD_HEADER_LEN - ID_VAULT_LEN..AAD_HEADER_LEN;
                if !id_vault.contains(&at) {
                    assert!(
                        !error.unwrap().is_other_vault(),
                        "byte {at} passed for another vault's"
                    );
                }
            }
        }
        for len in [
            0,
            5,
            AAD_HEADER_LEN,
            HEADER_LEN,
            HEADER_LEN + TAG_LEN,
            sealed.len() - 1,
        ] {
            assert!(open(&keys, &slot, &sealed[..len]).is_err(), "cut to {len}");
        }
        let mut longer = sealed.clone();
        longer.push(0);
        assert!(open(&keys, &slot, &longer).is_err(), "one byte longer");
        let mut newer = sealed.clone();
        newer[6] = 2;
        assert_eq!(
            open(&keys, &slot, &newer).err(),
            Some(EnvelopeError::UnsupportedVersion(2))
        );
    }

    /// Design §12.1, test 3 (H3).
    #[test]
    fn a_file_in_the_place_of_another_kind_is_refused() {
        let keys = keys(1);
        let history = seal(&keys, &Slot::History, 3, b"[]").unwrap();
        assert_eq!(
            open(&keys, &Slot::Sessions, &history).err(),
            Some(EnvelopeError::WrongPlace)
        );
        // Relabelled as sessions: the associated data and the key differ.
        let mut relabelled = history.clone();
        relabelled[7] = 4;
        assert_eq!(
            open(&keys, &Slot::Sessions, &relabelled).err(),
            Some(EnvelopeError::Tampered)
        );
    }

    /// Design §12.1, test 4.
    #[test]
    fn a_renamed_sticker_is_refused() {
        let keys = keys(1);
        let sealed = seal(&keys, &sticker(1), 3, b"image").unwrap();
        assert_eq!(
            open(&keys, &sticker(2), &sealed).err(),
            Some(EnvelopeError::Tampered)
        );
    }

    /// Design §12.1, test 5.
    #[test]
    fn a_file_of_another_vault_is_an_orphan() {
        let sealed = seal(&keys(1), &Slot::Prefs, 3, b"{}").unwrap();
        let error = open(&keys(2), &Slot::Prefs, &sealed).unwrap_err();
        assert_eq!(error, EnvelopeError::OtherVault);
        assert!(error.is_other_vault());
    }

    #[test]
    fn a_file_of_another_key_generation_is_refused() {
        let keys = keys(1);
        let rotated = StoreKeys::from_parts(2, *keys.id_vault(), [9; 32]);
        let sealed = seal(&rotated, &Slot::Account, 3, b"{}").unwrap();
        assert_eq!(
            open(&keys, &Slot::Account, &sealed).err(),
            Some(EnvelopeError::WrongKeyGen(2))
        );
    }

    /// Design §12.1, test 8.
    #[test]
    fn sizes_round_up_to_the_steps() {
        let plain = |content: usize| content + PREFIX_LEN;
        assert_eq!(padded_len(0), 4 * KIB);
        assert_eq!(padded_len(4 * KIB - PREFIX_LEN), 4 * KIB);
        assert_eq!(padded_len(4 * KIB - PREFIX_LEN + 1), 8 * KIB);
        assert_eq!(padded_len(plain(9 * KIB)), 16 * KIB);
        assert_eq!(padded_len(plain(20 * KIB)), 32 * KIB);
        assert_eq!(padded_len(plain(40 * KIB)), 64 * KIB);
        assert_eq!(padded_len(64 * KIB - PREFIX_LEN), 64 * KIB);
        assert_eq!(padded_len(64 * KIB - PREFIX_LEN + 1), 128 * KIB);
        assert_eq!(padded_len(plain(200 * KIB)), 256 * KIB);

        let keys = keys(1);
        let file_len = |content: usize| {
            seal(&keys, &Slot::Account, 1, &vec![b'a'; content])
                .unwrap()
                .len()
        };
        assert_eq!(file_len(0), HEADER_LEN + 4 * KIB + TAG_LEN);
        assert_eq!(file_len(1), file_len(3000), "one contact or thirty");
        assert_eq!(file_len(5000), HEADER_LEN + 8 * KIB + TAG_LEN);
    }

    /// Design §12.1, test 51.
    #[test]
    fn no_header_byte_tells_how_many_writes_there_were() {
        let keys = keys(1);
        let first = seal(&keys, &Slot::History, 1, b"[]").unwrap();
        let later = seal(&keys, &Slot::History, 1_000_000, b"[]").unwrap();
        assert_eq!(first.len(), later.len());
        assert_eq!(first[..AAD_HEADER_LEN], later[..AAD_HEADER_LEN]);
        assert_eq!(open(&keys, &Slot::History, &later).unwrap().seq, 1_000_000);
    }

    #[test]
    fn two_seals_of_the_same_content_differ() {
        // A fresh random nonce each time: nothing repeats under one key.
        let keys = keys(1);
        let a = seal(&keys, &Slot::Account, 1, b"{}").unwrap();
        let b = seal(&keys, &Slot::Account, 1, b"{}").unwrap();
        assert_ne!(a[AAD_HEADER_LEN..HEADER_LEN], b[AAD_HEADER_LEN..HEADER_LEN]);
        assert_ne!(a[HEADER_LEN..], b[HEADER_LEN..]);
    }

    #[test]
    fn logical_names_and_paths() {
        let name = hex::encode([0xab; 16]);
        let slot = Slot::Sticker(name.clone());
        assert_eq!(slot.logical_name(), format!("sticker:{name}"));
        assert_eq!(
            Slot::from_logical_name(&slot.logical_name()),
            Some(slot.clone())
        );
        assert_eq!(
            slot.relative_path(),
            std::path::Path::new("stickers").join(format!("{name}.bin"))
        );
        assert_eq!(
            Slot::Account.relative_path(),
            std::path::Path::new("account.bin")
        );
        assert_eq!(
            Slot::Index.relative_path(),
            std::path::Path::new("index.bin")
        );
        for slot in Slot::FIXED.iter().chain([&Slot::Index]) {
            assert_eq!(
                Slot::from_logical_name(&slot.logical_name()).as_ref(),
                Some(slot)
            );
        }
        let kept = Slot::Legacy("friends.json".into());
        assert_eq!(kept.logical_name(), "legacy:friends.json");
        assert_eq!(
            kept.relative_path(),
            std::path::Path::new("aside").join("legacy.friends.json.bin")
        );
        assert_eq!(Slot::from_logical_name(&kept.logical_name()), None);
        for bad in [
            "sticker:../x",
            "sticker:ABAB",
            "sticker:",
            "stickers",
            "keys",
        ] {
            assert_eq!(Slot::from_logical_name(bad), None, "{bad}");
        }
    }
}
