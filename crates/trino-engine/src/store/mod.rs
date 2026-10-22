//! The encrypted store: everything Trino keeps about the account on this
//! device, in `~/.trino/store/` (cifrado local, design §4).
//!
//! - `keys`: the data key (DK) and the `id_vault`, which live inside the vault
//!   as its app data, and the per-kind keys derived from them.
//! - `envelope`: one file, AES-256-GCM under its kind's key, behind a header
//!   that names the kind, the key generation and the vault, with the write
//!   counter (`seq`) and padding inside the encryption.
//! - `index`: the `seq` of every file, so a rolled-back, missing or planted
//!   file shows.
//! - `files`: writing in the order that keeps a cut harmless, and reading at
//!   unlock by the rules of design §4.6, with `report` saying what was found.
//! - `disk`: the file operations, which tests make fail.
//! - `session`: the store of the open session, or the files of an account
//!   not moved to it yet, as the commands use them (`storage_cmds.rs`).
//! - `migrate`: moving an account of an earlier version into the store, so
//!   that a cut at any step loses nothing (design §5).
//! - `rotate`: the data key rotated once, as the vault moves to version 3
//!   (clave de emergencia CE-3), under the same rule.

pub mod cleanup;
pub mod disk;
pub mod envelope;
pub mod files;
pub mod index;
pub mod keys;
pub mod migrate;
pub mod report;
pub mod rotate;
pub mod session;
