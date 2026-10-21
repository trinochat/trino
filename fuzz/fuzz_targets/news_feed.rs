//! The news feed's payload, past the signature (trino-net news/feed.rs):
//! what "Trino Updates" signs is trusted for its origin but still checked
//! field by field, so a mistake in the signing script cannot break the app.
//!
//! - The payload through the `fuzz_feed` hook: no panic, and what it takes
//!   is within the limits (`MAX_ANNOUNCEMENTS`, the field lengths, RFC
//!   3339 dates).
//! - The same payload signed with a test key and passed whole through
//!   `news::verify` gives the same answer.
#![no_main]

use libfuzzer_sys::fuzz_target;
use pgp::composed::{
    ArmorOptions, DetachedSignature, KeyType, SecretKeyParamsBuilder, SignedSecretKey,
};
use pgp::crypto::hash::HashAlgorithm;
use pgp::types::{KeyDetails, Password};
use rand::SeedableRng;
use std::sync::LazyLock;
use trino_net::news::{self, fuzz_feed, is_timestamp, Signer, MAX_ANNOUNCEMENTS};

static KEY: LazyLock<(SignedSecretKey, Signer)> = LazyLock::new(|| {
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
    let signer = Signer::from_armored(&armored, &format!("{:X}", public.fingerprint())).unwrap();
    (secret, signer)
});

fuzz_target!(|payload: &str| {
    let parsed = fuzz_feed(payload);
    if let Ok(feed) = &parsed {
        assert!(feed.announcements.len() <= MAX_ANNOUNCEMENTS);
        for post in &feed.announcements {
            assert!(!post.id.is_empty() && post.id.chars().count() <= 96);
            assert!(!post.title.is_empty() && post.title.chars().count() <= 120);
            assert!(post.body.chars().count() <= 5_000);
            assert!(is_timestamp(&post.published_at));
        }
    }

    let (secret, signer) = &*KEY;
    let signature = DetachedSignature::sign_binary_data(
        rand_chacha::ChaCha20Rng::seed_from_u64(7),
        &secret.primary_key,
        &Password::empty(),
        HashAlgorithm::Sha256,
        payload.as_bytes(),
    )
    .unwrap()
    .to_armored_string(ArmorOptions::default())
    .unwrap();
    let envelope =
        serde_json::to_vec(&serde_json::json!({ "payload": payload, "signature": signature }))
            .unwrap();
    let verified = news::verify(signer, &envelope);
    if envelope.len() <= news::MAX_FEED_BYTES {
        assert_eq!(verified.ok(), parsed.ok(), "verify and parse disagree");
    }
});
