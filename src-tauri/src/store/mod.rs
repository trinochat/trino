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
//!
//! Nothing here is wired to the commands yet: CL-1b does that.
#![allow(dead_code)]

pub(crate) mod disk;
pub(crate) mod envelope;
pub(crate) mod files;
pub(crate) mod index;
pub(crate) mod keys;
pub(crate) mod report;
