//! The news feed as a mirror serves it (trino-net news/): the JSON envelope
//! and the armored OpenPGP signature in it, parsed by rPGP, checked against
//! a fixed test key and against "Trino Updates".
//!
//! Nothing may panic, and nothing a mirror makes up may verify.
#![no_main]

use libfuzzer_sys::fuzz_target;
use pgp::composed::{ArmorOptions, KeyType, SecretKeyParamsBuilder};
use pgp::types::KeyDetails;
use rand::SeedableRng;
use std::sync::LazyLock;
use trino_net::news::{self, Signer};

static TEST_SIGNER: LazyLock<Signer> = LazyLock::new(|| {
    let mut params = SecretKeyParamsBuilder::default();
    params
        .key_type(KeyType::Ed25519Legacy)
        .can_certify(true)
        .can_sign(true)
        .primary_user_id("Trino News Fuzz <fuzz@trino.invalid>".into());
    let secret = params
        .build()
        .unwrap()
        .generate(rand_chacha::ChaCha20Rng::seed_from_u64(5))
        .unwrap();
    let public = secret.to_public_key();
    let armored = public.to_armored_string(ArmorOptions::default()).unwrap();
    Signer::from_armored(&armored, &format!("{:X}", public.fingerprint())).unwrap()
});

fuzz_target!(|data: &[u8]| {
    assert!(
        news::verify(&TEST_SIGNER, data).is_err(),
        "a made-up feed verified"
    );
    assert!(
        news::verify(Signer::trino_updates(), data).is_err(),
        "a made-up feed verified"
    );
});
