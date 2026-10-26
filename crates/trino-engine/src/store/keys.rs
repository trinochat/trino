//! The keys of the store (design §3, with David's decision 2 of 12 Oct 2026).
//!
//! The data key (DK) is 32 random bytes, not derived from the identity: the
//! emergency key and the recovery need a key that lives only inside the vault
//! and can be destroyed or rotated without changing who you are (design
//! §3.2). It lives **inside the vault**, as its app data, together with the
//! `id_vault` that names this account's store on this device. trino-core
//! seals the app data only in a version 2 vault, which older Trino versions
//! refuse instead of re-sealing it without the key (core `vault.rs`).
//!
//! So there is no `keys.bin` or `keys.bak` (design §4.3). A copy outside the
//! vault would have to be wrapped with a key derived from the identity, which
//! is what decision 2 moved away from, and it would outlive the vault that
//! "Borrar todo" destroys first. Nor does the store need one to survive: the
//! vault already holds the identity, so losing `vault.bin` loses the account
//! whether or not the DK had a second copy.
//!
//! Each kind of file gets its own key, `HKDF-SHA256(DK, salt = id_vault,
//! info = "trino-store-v1/<kind>")`, distinct from the identity-derived
//! `trino-history-key-v1` and `trino-profiles-key-v1` that the store replaces.

use crate::crypto::random_array;
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

/// The bytes of `id_vault`.
pub const ID_VAULT_LEN: usize = 16;
/// The key generation of the store's first DK. It rotates once as the vault
/// moves to version 3 (design §3.3; clave de emergencia CE-3,
/// `rotate.rs`): an account created from then on stays at this one.
pub const FIRST_KEY_GEN: u32 = 1;

/// Start of the record the vault carries as its app data.
const RECORD_MAGIC: &[u8; 6] = b"TRKEY\0";
const RECORD_VERSION: u8 = 1;
/// Magic, version, a reserved byte, `key_gen`, `id_vault` and the DK.
pub const RECORD_LEN: usize = 6 + 1 + 1 + 4 + ID_VAULT_LEN + 32;

/// What each kind of key is for: the `info` of its HKDF.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyLabel {
    Account,
    Prefs,
    History,
    Sessions,
    Profiles,
    Stickers,
    StickerName,
    Index,
    Legacy,
    Requests,
}

impl KeyLabel {
    #[cfg_attr(not(test), allow(dead_code))]
    pub const ALL: [KeyLabel; 10] = [
        KeyLabel::Account,
        KeyLabel::Prefs,
        KeyLabel::History,
        KeyLabel::Sessions,
        KeyLabel::Profiles,
        KeyLabel::Stickers,
        KeyLabel::StickerName,
        KeyLabel::Index,
        KeyLabel::Legacy,
        KeyLabel::Requests,
    ];

    pub fn info(self) -> &'static [u8] {
        match self {
            KeyLabel::Account => b"trino-store-v1/account",
            KeyLabel::Prefs => b"trino-store-v1/prefs",
            KeyLabel::History => b"trino-store-v1/history",
            KeyLabel::Sessions => b"trino-store-v1/sessions",
            KeyLabel::Profiles => b"trino-store-v1/profiles",
            KeyLabel::Stickers => b"trino-store-v1/stickers",
            KeyLabel::StickerName => b"trino-store-v1/sticker-name",
            KeyLabel::Index => b"trino-store-v1/index",
            KeyLabel::Legacy => b"trino-store-v1/legacy",
            KeyLabel::Requests => b"trino-store-v1/requests",
        }
    }
}

/// The record in the vault's app data is not one this version wrote.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeysError {
    #[error("the vault's app data is not a store key record")]
    NotAKeyRecord,
    #[error("unsupported store key record version: {0}")]
    UnsupportedVersion(u8),
}

/// The DK, its generation and the `id_vault`. The DK is wiped when dropped,
/// and never printed.
pub struct StoreKeys {
    key_gen: u32,
    id_vault: [u8; ID_VAULT_LEN],
    dk: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for StoreKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreKeys")
            .field("key_gen", &self.key_gen)
            .field("id_vault", &hex::encode(self.id_vault))
            .finish_non_exhaustive()
    }
}

/// Where the keys of an opened vault come from: unlocking takes the vault's,
/// or makes new ones for the migration (CL-1c, `commands::unlock_files`).
#[derive(Debug)]
pub enum VaultKeys {
    /// The vault carries them: the account already has its store.
    InVault(StoreKeys),
    /// The vault carries no app data (version 1, or a version 2 vault sealed
    /// before the store existed), so these are new. Nothing sealed with them
    /// may be relied on until the vault carries them (`to_vault_app`): the
    /// migration (CL-1c) writes `store.new/` under them, verifies it, seals
    /// them into the vault and only then puts `store.new/` in place of
    /// `store/`. A cut before the vault holds them leaves the legacy files
    /// untouched and `store.new/` unreadable, to be discarded.
    New(StoreKeys),
}

impl VaultKeys {
    /// The keys of a vault whose app data is `app`, or new ones if it has
    /// none. App data that is not a key record is an error, never a reason
    /// to make new keys: that would orphan everything already in the store.
    pub fn from_vault_app(app: Option<&[u8]>) -> Result<Self, KeysError> {
        match app {
            Some(record) => StoreKeys::from_vault_app(record).map(VaultKeys::InVault),
            None => Ok(VaultKeys::New(StoreKeys::generate())),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn keys(&self) -> &StoreKeys {
        match self {
            VaultKeys::InVault(keys) | VaultKeys::New(keys) => keys,
        }
    }
}

impl StoreKeys {
    /// A new DK and `id_vault`, at the first key generation.
    pub fn generate() -> Self {
        StoreKeys {
            key_gen: FIRST_KEY_GEN,
            id_vault: random_array(),
            dk: Zeroizing::new(random_array()),
        }
    }

    /// The keys of the next generation (design §3.3): a new DK under the
    /// same `id_vault`, one generation up.
    pub fn next_generation(&self) -> Self {
        StoreKeys {
            key_gen: self.key_gen + 1,
            id_vault: self.id_vault,
            dk: Zeroizing::new(random_array()),
        }
    }

    #[cfg(any(test, feature = "test-util"))]
    pub fn from_parts(key_gen: u32, id_vault: [u8; ID_VAULT_LEN], dk: [u8; 32]) -> Self {
        StoreKeys {
            key_gen,
            id_vault,
            dk: Zeroizing::new(dk),
        }
    }

    pub fn key_gen(&self) -> u32 {
        self.key_gen
    }

    pub fn id_vault(&self) -> &[u8; ID_VAULT_LEN] {
        &self.id_vault
    }

    /// The record the vault carries as its app data: `TRKEY\0`, version 1, a
    /// reserved zero, `key_gen` (u32 LE), `id_vault` and the DK.
    pub fn to_vault_app(&self) -> Zeroizing<Vec<u8>> {
        let mut record = Zeroizing::new(Vec::with_capacity(RECORD_LEN));
        record.extend_from_slice(RECORD_MAGIC);
        record.push(RECORD_VERSION);
        record.push(0);
        record.extend_from_slice(&self.key_gen.to_le_bytes());
        record.extend_from_slice(&self.id_vault);
        record.extend_from_slice(&*self.dk);
        record
    }

    /// The keys from a record written by `to_vault_app`.
    pub fn from_vault_app(record: &[u8]) -> Result<Self, KeysError> {
        if record.len() < 8 || &record[..6] != RECORD_MAGIC {
            return Err(KeysError::NotAKeyRecord);
        }
        if record[6] != RECORD_VERSION {
            return Err(KeysError::UnsupportedVersion(record[6]));
        }
        if record[7] != 0 || record.len() != RECORD_LEN {
            return Err(KeysError::NotAKeyRecord);
        }
        let (key_gen, rest) = record[8..].split_at(4);
        let (id_vault, dk) = rest.split_at(ID_VAULT_LEN);
        let mut keys = StoreKeys {
            key_gen: u32::from_le_bytes(key_gen.try_into().expect("4 bytes")),
            id_vault: id_vault.try_into().expect("16 bytes"),
            dk: Zeroizing::new([0; 32]),
        };
        keys.dk.copy_from_slice(dk);
        Ok(keys)
    }

    /// The key for one kind of file.
    pub fn kind_key(&self, label: KeyLabel) -> Zeroizing<[u8; 32]> {
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(&self.id_vault), &*self.dk)
            .expand(label.info(), &mut *key)
            .expect("32 bytes is a valid HKDF-SHA256 length");
        key
    }

    /// The name a sticker's file has on disk: the first 16 bytes of
    /// HMAC-SHA256 of the image under the sticker-name key, in hex. The same
    /// image gets the same name, so it is stored once, and nobody without
    /// the DK can tell from the name which image it is (design H4).
    pub fn sticker_disk_name(&self, image: &[u8]) -> String {
        let key = self.kind_key(KeyLabel::StickerName);
        let mut mac =
            <Hmac<Sha256> as Mac>::new_from_slice(&*key).expect("HMAC takes a key of any size");
        mac.update(image);
        hex::encode(&mac.finalize().into_bytes()[..16])
    }
}

/// Keys for tests: the engine's, and the app's through `test-util`.
#[cfg(any(test, feature = "test-util"))]
pub mod testing {
    use super::*;

    pub fn keys(byte: u8) -> StoreKeys {
        StoreKeys::from_parts(FIRST_KEY_GEN, [byte; ID_VAULT_LEN], [byte ^ 0x5a; 32])
    }
}

#[cfg(test)]
mod tests {
    use super::testing::keys;
    use super::*;

    #[test]
    fn new_keys_are_random_and_at_the_first_generation() {
        let a = StoreKeys::generate();
        let b = StoreKeys::generate();
        assert_eq!(a.key_gen(), FIRST_KEY_GEN);
        assert_ne!(a.id_vault(), b.id_vault());
        assert_ne!(*a.dk, *b.dk);
        assert_ne!(*a.dk, [0; 32]);
    }

    #[test]
    fn the_key_record_round_trips_and_fits_in_the_vault() {
        let keys = StoreKeys::generate();
        let record = keys.to_vault_app();
        assert_eq!(record.len(), RECORD_LEN);
        assert!(record.len() <= crate::vault::MAX_APP_DATA_LEN);
        assert_eq!(&record[..6], RECORD_MAGIC);

        let back = StoreKeys::from_vault_app(&record).unwrap();
        assert_eq!(back.key_gen(), keys.key_gen());
        assert_eq!(back.id_vault(), keys.id_vault());
        assert_eq!(*back.dk, *keys.dk);
        assert_eq!(
            *back.kind_key(KeyLabel::Account),
            *keys.kind_key(KeyLabel::Account)
        );
    }

    #[test]
    fn a_damaged_key_record_is_refused() {
        let record = StoreKeys::generate().to_vault_app();
        let mut bad_magic = record.to_vec();
        bad_magic[0] ^= 1;
        let mut newer = record.to_vec();
        newer[6] = RECORD_VERSION + 1;
        let mut reserved = record.to_vec();
        reserved[7] = 1;

        assert_eq!(
            StoreKeys::from_vault_app(&bad_magic).unwrap_err(),
            KeysError::NotAKeyRecord
        );
        assert_eq!(
            StoreKeys::from_vault_app(&newer).unwrap_err(),
            KeysError::UnsupportedVersion(RECORD_VERSION + 1)
        );
        assert_eq!(
            StoreKeys::from_vault_app(&reserved).unwrap_err(),
            KeysError::NotAKeyRecord
        );
        for len in [0, RECORD_LEN - 1, RECORD_LEN + 1] {
            let mut cut = record.to_vec();
            cut.resize(len, 0);
            assert_eq!(
                StoreKeys::from_vault_app(&cut).unwrap_err(),
                KeysError::NotAKeyRecord,
                "{len} bytes"
            );
        }
    }

    #[test]
    fn a_vault_with_keys_gives_them_and_one_without_gets_new_ones() {
        let keys = StoreKeys::generate();
        let record = keys.to_vault_app();

        match VaultKeys::from_vault_app(Some(&record)).unwrap() {
            VaultKeys::InVault(found) => assert_eq!(found.id_vault(), keys.id_vault()),
            other => panic!("expected the vault's keys, got {other:?}"),
        }
        let first = VaultKeys::from_vault_app(None).unwrap();
        let second = VaultKeys::from_vault_app(None).unwrap();
        assert!(matches!(first, VaultKeys::New(_)));
        assert_ne!(first.keys().id_vault(), second.keys().id_vault());
    }

    #[test]
    fn app_data_that_is_not_a_key_record_never_gets_new_keys() {
        // New keys would orphan everything the store holds.
        let error = VaultKeys::from_vault_app(Some(b"something else")).unwrap_err();
        assert_eq!(error, KeysError::NotAKeyRecord);
    }

    /// Design §12.1, test 7.
    #[test]
    fn each_kind_has_its_own_key_and_none_is_the_old_history_key() {
        let keys = keys(1);
        let mut seen: Vec<[u8; 32]> = Vec::new();
        for label in KeyLabel::ALL {
            assert!(label.info().starts_with(b"trino-store-v1/"));
            assert_ne!(label.info(), b"trino-history-key-v1");
            assert_ne!(label.info(), b"trino-profiles-key-v1");
            let key = *keys.kind_key(label);
            assert!(!seen.contains(&key), "{label:?} repeats a key");
            assert_ne!(key, *keys.dk, "{label:?} is the DK itself");
            seen.push(key);
        }
        // The same DK under another id_vault gives other keys: the id_vault
        // is the HKDF salt.
        let other_vault = StoreKeys::from_parts(FIRST_KEY_GEN, [2; ID_VAULT_LEN], *keys.dk);
        assert_ne!(
            *other_vault.kind_key(KeyLabel::Account),
            *keys.kind_key(KeyLabel::Account)
        );
        // The old identity-derived history key, from the same input, is not
        // one of them either.
        let hk = Hkdf::<Sha256>::new(Some(&[0u8; 32]), &*keys.dk);
        let mut old = [0u8; 32];
        hk.expand(b"trino-history-key-v1", &mut old).unwrap();
        assert!(!seen.contains(&old));
    }

    /// Design §12.1, test 9 (H4).
    #[test]
    fn a_sticker_name_is_keyed_and_is_not_the_sha256() {
        let image = b"\x89PNG a sticker";
        let keys = keys(1);
        let name = keys.sticker_disk_name(image);

        assert_eq!(name.len(), 32);
        assert!(name
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        let sha = hex::encode(crate::crypto::sha256(image));
        // Today's file name is the sticker id, the first 8 bytes of the
        // SHA-256 (commands.rs); neither it nor a longer prefix shows.
        assert!(!sha.starts_with(&name[..16]));
        assert_ne!(name, sha[..32]);
        assert_eq!(name, keys.sticker_disk_name(image), "the same image");
        assert_ne!(name, keys.sticker_disk_name(b"another image"));
        assert_ne!(name, self::keys(2).sticker_disk_name(image), "another DK");
    }

    #[test]
    fn the_keys_are_never_printed() {
        let keys = keys(7);
        let printed = format!("{keys:?}");
        assert!(!printed.contains(&hex::encode(*keys.dk)));
        assert!(!printed.contains(&format!("{:?}", *keys.dk)));
    }
}
