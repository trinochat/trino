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
pub use trino_core::{call_signal, crypto, envelope, group, identity, ratchet, totp, vault, x3dh};

pub mod call_log;
pub mod fsutil;
pub mod passphrase;
pub mod state;
