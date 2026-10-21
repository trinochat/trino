//! The updater's trusted comment, past its signature (trino-net
//! update/sig.rs). A test minisign key signs whatever comment the input
//! holds, as `tauri signer sign` would sign a release's, so the parsing that
//! runs only on signed comments (`Parts`, `Fields`, the installer's name and
//! version) gets the input too.
//!
//! Checked: nothing panics; a comment taken names, in its `file:` field,
//! the installer it returns, and `check_comment` agrees with minisign-verify
//! on what the trusted comment is (it refuses when they differ).
#![no_main]

use arbitrary::Arbitrary;
use base64::Engine;
use ed25519_dalek::{Signer as _, SigningKey};
use libfuzzer_sys::fuzz_target;
use std::sync::LazyLock;
use trino_net::update::{Platform, UpdateKey};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;
const KEY_ID: [u8; 8] = [1, 2, 3, 4, 5, 6, 7, 8];

static SIGNING: LazyLock<SigningKey> = LazyLock::new(|| SigningKey::from_bytes(&[42; 32]));

/// The test key as Tauri's bare minisign line: "Ed", the id, the key.
static KEY: LazyLock<UpdateKey> = LazyLock::new(|| {
    let mut line = b"Ed".to_vec();
    line.extend_from_slice(&KEY_ID);
    line.extend_from_slice(SIGNING.verifying_key().as_bytes());
    UpdateKey::from_tauri(&B64.encode(line)).unwrap()
});

#[derive(Arbitrary, Debug)]
struct Input {
    untrusted: String,
    algorithm: [u8; 2],
    right_id: bool,
    file_signature: [u8; 32],
    comment: String,
    tail: String,
    tauri_base64: bool,
    linux: bool,
}

fuzz_target!(|input: Input| {
    let mut first = input.algorithm.to_vec();
    first.extend_from_slice(if input.right_id { &KEY_ID } else { &[9; 8] });
    first.extend_from_slice(&input.file_signature);
    first.extend_from_slice(&input.file_signature);
    let mut signed = first[10..].to_vec();
    signed.extend_from_slice(input.comment.as_bytes());
    let global = SIGNING.sign(&signed);

    let text = format!(
        "untrusted comment: {}\n{}\ntrusted comment: {}\n{}\n{}",
        input.untrusted,
        B64.encode(&first),
        input.comment,
        B64.encode(global.to_bytes()),
        input.tail,
    );
    let signature = if input.tauri_base64 {
        B64.encode(&text)
    } else {
        text
    };
    let platform = if input.linux {
        Platform::LinuxX64
    } else {
        Platform::WindowsX64
    };

    if let Ok(taken) = KEY.check_comment(&signature, platform) {
        assert!(
            input
                .comment
                .split('\t')
                .any(|field| field == format!("file:{}", taken.file())),
            "the installer is not the one the comment names"
        );
        assert_eq!(&input.algorithm, b"ED");
    }
});
