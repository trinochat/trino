//! Trino's engine (M4-0): the session's state and the logic around it,
//! apart from any UI.
//!
//! - No Tauri (tests/no_tauri.rs): the desktop app (src-tauri) holds an
//!   `Engine` and its commands are thin wrappers around it; the mobile apps
//!   will reach the same engine through FFI.
//! - The protocol and cryptography are trino-core's, and every connection
//!   trino-net's, both taken as they are.
//! - It moves here from src-tauri a piece at a time, without changing what
//!   the app does: the app's tests are the safety net.

// The protocol and cryptography are trino-core's, re-exported as the app
// does, so `crate::crypto::…` reads the same in the code moved here.
pub use trino_core::{
    call_signal, crypto, envelope, group, identity, kdf, ratchet, totp, vault, vault_v3, x3dh,
};

pub mod account;
pub mod age;
pub mod alert;
pub mod block;
pub mod blossom;
pub mod bridges;
pub mod call_log;
pub mod command_error;
pub mod connection;
pub mod contacts;
pub mod device;
pub mod diag;
pub mod emergency;
mod engine;
pub mod events;
pub mod fsutil;
pub mod group_contacts;
pub mod groups;
pub mod lock;
pub mod mailboxes;
pub mod nostr;
pub mod p1;
pub mod passphrase;
pub mod prefs;
pub mod profile;
pub mod relay_caps;
pub mod report;
pub mod requests;
pub mod send;
pub mod session;
pub mod state;
pub mod storage;
pub mod store;
#[cfg(any(test, feature = "test-util"))]
pub mod testing;
pub mod totp_enrollment;
pub mod turn;
pub mod vault_file;

pub use engine::Engine;
