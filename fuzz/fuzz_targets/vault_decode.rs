//! The vault file (trino-core vault.rs, through the engine): what is read
//! from `vault.bin` before any key is derived. The PBKDF2 behind
//! `unseal_vault` (600,000 iterations) is too slow to fuzz; what it opens
//! is authenticated first.
//!
//! - `decode_vault`, `vault_requires_totp`, and the engine's readers of the
//!   raw header (`vault_header`, `totp_flag_disagrees`) must not panic.
//! - `encode_vault(decode_vault(x))` is `x`.
#![no_main]

use libfuzzer_sys::fuzz_target;
use trino_engine::storage::totp_flag_disagrees;
use trino_engine::store::session::vault_header;
use trino_engine::vault::{decode_vault, encode_vault, vault_requires_totp};

fuzz_target!(|data: &[u8]| {
    if let Ok(sealed) = decode_vault(data) {
        assert_eq!(encode_vault(&sealed), data);
    }
    let _ = vault_requires_totp(data);
    let _ = vault_header(data, 1);
    let _ = totp_flag_disagrees(data, true);
    let _ = totp_flag_disagrees(data, false);
});
