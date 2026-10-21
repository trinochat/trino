//! A message as the ratchet decrypts it (trino-core envelope.rs and the
//! engine's handling of each kind): any contact chooses these bytes.
//!
//! - `profile::receive`, then `decode_envelope`, then per kind: the file
//!   reference's cleaning (`sanitize_file_ref`), the call signal's check,
//!   and a roster's validation and ingestion.
//! - A roster the admin really signed, with a name and photo chosen by the
//!   input, through `ingest_incoming_roster` and `group_info`.
//! - A known kind that decodes encodes back to itself.
#![no_main]

use arbitrary::Arbitrary;
use libfuzzer_sys::fuzz_target;
use std::sync::LazyLock;
use trino_engine::call_signal::validate_call_signal;
use trino_engine::envelope::{decode_envelope, encode_envelope, Envelope};
use trino_engine::group::{
    create_group, set_group_photo, validate_roster, verify_roster, FileRef, GroupRoster,
    MemberBundle,
};
use trino_engine::groups::{group_info, ingest_incoming_roster, shown_group_name};
use trino_engine::identity::{create_identity, public_bundle_for, Identity};
use trino_engine::profile::{receive, Profiles};
use trino_engine::session::{sanitize_file_ref, shown_file_name};
use trino_engine::state::InnerState;

const NOW: i64 = 1_792_000_000;

static ADMIN: LazyLock<Identity> = LazyLock::new(create_identity);
static ME: LazyLock<Identity> = LazyLock::new(create_identity);

#[derive(Arbitrary, Debug)]
struct Photo {
    url: String,
    key: String,
    sha256: String,
    mime: String,
    name: String,
    size: u64,
    thumb: Option<String>,
}

#[derive(Arbitrary, Debug)]
struct Input<'a> {
    plain: &'a [u8],
    created_at: i64,
    group_name: String,
    photo: Option<Photo>,
}

fn me_ik() -> String {
    hex::encode(ME.ik_sign.pub_bytes)
}

fn take_roster(roster: GroupRoster, sender_ik: &str) {
    let _ = validate_roster(&roster);
    let _ = verify_roster(&roster);
    let _ = group_info(&roster, &me_ik());
    let _ = shown_group_name(&roster.name);
    let mut inner = InnerState::default();
    let _ = ingest_incoming_roster(&mut inner, roster, "admin", sender_ik, &me_ik(), NOW);
}

fuzz_target!(|input: Input| {
    let mut profiles = Profiles::default();
    let _ = receive(&mut profiles, "friend", input.plain, input.created_at);

    let envelope = decode_envelope(input.plain);
    match &envelope {
        Envelope::File { file, .. } => {
            let clean = sanitize_file_ref(file.clone());
            assert_eq!(
                clean.name,
                shown_file_name(&clean.name),
                "cleaning is idempotent"
            );
        }
        Envelope::Call { call } => {
            let _ = validate_call_signal(call);
        }
        Envelope::Roster { roster } => take_roster(roster.clone(), &roster.admin_pub),
        Envelope::Text { .. } | Envelope::Group { .. } => {}
    }
    if !matches!(envelope, Envelope::Text { .. }) {
        assert_eq!(decode_envelope(&encode_envelope(&envelope)), envelope);
    }

    // A roster the admin signed, with a name and photo of the input's.
    let admin_bundle = MemberBundle::from_public_bundle("admin", &public_bundle_for(&ADMIN));
    let Ok(mut roster) = create_group(&ADMIN, admin_bundle, &input.group_name) else {
        return;
    };
    if let Some(photo) = input.photo {
        let photo = FileRef {
            url: photo.url,
            key: photo.key,
            sha256: photo.sha256,
            mime: photo.mime,
            name: photo.name,
            size: photo.size,
            thumb: photo.thumb,
        };
        match set_group_photo(&roster, &ADMIN, Some(photo)) {
            Ok(with_photo) => roster = with_photo,
            Err(_) => return,
        }
    }
    let admin_ik = roster.admin_pub.clone();
    take_roster(roster, &admin_ik);
});
