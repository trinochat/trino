//! The encrypted store's files (trino-engine store/): what a person with
//! the data folder can put there.
//!
//! - Raw bytes as a file of every kind: `envelope::open` must refuse them
//!   without a panic.
//! - The same bytes as a *decrypted* plaintext, sealed under the right key
//!   and header, so the layout check after the AEAD (`unpad`) gets them:
//!   it must only take what `seal` lays out, and give back its content.
//! - Raw bytes as `index.bin`'s JSON and as the vault's key record.
//! - `seal` then `open` gives back the same content and counter.
#![no_main]

use libfuzzer_sys::fuzz_target;
use std::sync::LazyLock;
use trino_engine::crypto::{aes_gcm_decrypt, aes_gcm_encrypt};
use trino_engine::store::envelope::{self, Slot, AAD_HEADER_LEN, HEADER_LEN};
use trino_engine::store::index::Index;
use trino_engine::store::keys::{KeyLabel, StoreKeys, VaultKeys};

/// Fixed keys, built from the record the vault carries (`from_parts` is
/// for tests only).
fn keys() -> StoreKeys {
    let mut record = b"TRKEY\0\x01\x00".to_vec();
    record.extend_from_slice(&1u32.to_le_bytes());
    record.extend_from_slice(&[7; 16]);
    record.extend_from_slice(&[0x5a; 32]);
    StoreKeys::from_vault_app(&record).unwrap()
}

fn slots() -> Vec<Slot> {
    let mut slots = Slot::FIXED.to_vec();
    slots.push(Slot::Index);
    slots.push(Slot::Sticker(hex::encode([3u8; 16])));
    slots.push(Slot::Legacy("config.json".into()));
    slots
}

/// Each slot's header and kind key, found by sealing once and trying every
/// label: the engine keeps the slot-to-label map private.
static SLOTS: LazyLock<Vec<(Slot, [u8; AAD_HEADER_LEN], [u8; 32])>> = LazyLock::new(|| {
    let keys = keys();
    slots()
        .into_iter()
        .map(|slot| {
            let file = envelope::seal(&keys, &slot, 1, b"probe").unwrap();
            let header: [u8; AAD_HEADER_LEN] = file[..AAD_HEADER_LEN].try_into().unwrap();
            let mut aad = header.to_vec();
            aad.extend_from_slice(slot.logical_name().as_bytes());
            let key = KeyLabel::ALL
                .iter()
                .map(|label| *keys.kind_key(*label))
                .find(|key| {
                    aes_gcm_decrypt(
                        key,
                        &file[HEADER_LEN..],
                        &file[AAD_HEADER_LEN..HEADER_LEN],
                        Some(&aad),
                    )
                    .is_ok()
                })
                .expect("one label opens the slot");
            (slot, header, key)
        })
        .collect()
});

fuzz_target!(|data: &[u8]| {
    let keys = keys();
    let (selector, rest) = data.split_first().unwrap_or((&0, &[]));
    let (slot, header, key) = &SLOTS[*selector as usize % SLOTS.len()];

    // Raw bytes in the file's place.
    let _ = envelope::open(&keys, slot, rest);

    // The bytes as the plaintext the AEAD gives back.
    let mut aad = header.to_vec();
    aad.extend_from_slice(slot.logical_name().as_bytes());
    let (ciphertext, nonce) = aes_gcm_encrypt(key, rest, Some(&aad)).unwrap();
    let mut file = header.to_vec();
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&ciphertext);
    if let Ok(opened) = envelope::open(&keys, slot, &file) {
        // Only `seal`'s layout: the same bytes come back from sealing it.
        assert_eq!(rest.len(), envelope::padded_len(opened.content.len()));
        assert_eq!(&rest[..8], &opened.seq.to_le_bytes());
        assert_eq!(&rest[12..12 + opened.content.len()], &opened.content[..]);
        assert!(rest[12 + opened.content.len()..].iter().all(|&b| b == 0));
    }

    // Round trip.
    if rest.len() <= 70_000 {
        let seq = u64::from_le_bytes(
            data.iter()
                .copied()
                .chain([0; 8])
                .take(8)
                .collect::<Vec<_>>()
                .try_into()
                .unwrap(),
        );
        let sealed = envelope::seal(&keys, slot, seq, rest).unwrap();
        let opened = envelope::open(&keys, slot, &sealed).unwrap();
        assert_eq!(opened.seq, seq);
        assert_eq!(&opened.content[..], rest);
    }

    // index.bin's JSON and the vault's key record.
    if let Some(index) = Index::from_json(rest) {
        assert_eq!(Index::from_json(&index.to_json()), Some(index));
    }
    if let Ok(record) = StoreKeys::from_vault_app(rest) {
        assert_eq!(&record.to_vault_app()[..], rest);
    }
    let _ = VaultKeys::from_vault_app(Some(rest));
    let _ = Slot::from_logical_name(&String::from_utf8_lossy(rest));
});
