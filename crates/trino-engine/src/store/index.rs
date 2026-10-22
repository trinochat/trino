//! `index.bin`: the write counter of every file (design §4.5).
//!
//! It is sealed like any other file (kind 7), and its envelope's `seq` is the
//! index's own `seq`. Each data file is listed by its logical name with the
//! `seq` it was written with, so the store can tell an older copy, a missing
//! file or one that was planted (design §4.6).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

const INDEX_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Index {
    pub v: u32,
    /// The highest `seq` the index knows of.
    pub seq: u64,
    /// Each data file by its logical name, with the `seq` it was written
    /// with.
    pub files: BTreeMap<String, u64>,
    /// Files being removed: noted before the removal and dropped after it,
    /// so a cut in between is finished in silence instead of reported.
    #[serde(default)]
    pub deleting: Vec<String>,
    /// The vault header last seen, and one being written (design §4.9;
    /// CL-1b fills them).
    #[serde(default)]
    pub vault: Option<VaultHeader>,
    #[serde(default)]
    pub vault_pending: Option<VaultHeader>,
    /// The migration from the legacy files (CL-1c, CL-2a).
    #[serde(default)]
    pub legacy: Legacy,
    /// Whole stores to remove, next to this one in the data folder: the
    /// `deleting` of stores (clave de emergencia, design §6.1 E5). The
    /// store this one took the place of goes aside under the name noted
    /// here before it moves, so only that one is ever removed, never a
    /// store set aside for another reason (RC-11).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deleting_stores: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultHeader {
    pub version: u8,
    pub flags: u8,
    /// The salt, in hex; for a version 3 vault, whose salt never changes, a
    /// digest of the whole vault (`session::vault_header`).
    pub salt: String,
    /// The id of the signed prekey the vault held.
    pub spk: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Legacy {
    #[serde(default)]
    pub migrated: bool,
    #[serde(default)]
    pub cleanup_pending: bool,
    #[serde(default)]
    pub prefs_imported: bool,
}

impl Index {
    /// An empty index at `seq`.
    pub fn new(seq: u64) -> Self {
        Index {
            v: INDEX_VERSION,
            seq,
            ..Index::default()
        }
    }

    pub fn to_json(&self) -> Zeroizing<Vec<u8>> {
        Zeroizing::new(serde_json::to_vec(self).expect("the index always serializes"))
    }

    /// The index in `json`, if it is one this version wrote.
    pub fn from_json(json: &[u8]) -> Option<Index> {
        serde_json::from_slice::<Index>(json)
            .ok()
            .filter(|index| index.v == INDEX_VERSION)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_round_trips_and_another_version_is_refused() {
        let mut index = Index::new(12);
        index.files.insert("account".into(), 11);
        index.deleting.push("sticker:00".into());
        index.legacy.migrated = true;
        assert_eq!(Index::from_json(&index.to_json()), Some(index.clone()));
        // An index with no store to remove is written as before.
        assert!(!String::from_utf8_lossy(&index.to_json()).contains("deleting_stores"));
        index.deleting_stores.push("store-aside-1".into());
        assert_eq!(Index::from_json(&index.to_json()), Some(index.clone()));

        let mut newer = index;
        newer.v = 2;
        assert_eq!(Index::from_json(&newer.to_json()), None);
        assert_eq!(Index::from_json(b"not json"), None);
    }
}
