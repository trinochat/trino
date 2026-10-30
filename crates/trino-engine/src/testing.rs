//! What tests share: the engine's own, and the app's through the
//! `test-util` feature.

use std::path::Path;
use std::sync::Arc;
use trino_net::mock::{FakeTor, Forbidden, Mock};
use trino_net::{Net, NetConfig, TorBackend};

/// A `Net` whose Tor is a `FakeTor` with its folder at `tor_home`, and
/// whose direct transport fails the test if touched.
pub fn fake_tor(tor_home: &Path) -> (Arc<Net>, Arc<FakeTor>, Arc<Mock>) {
    let mock = Mock::new();
    let fake = FakeTor::new(Arc::clone(&mock));
    let net = Net::with_backend(
        NetConfig {
            tor_home: tor_home.to_path_buf(),
            pt: None,
        },
        Arc::clone(&fake) as Arc<dyn TorBackend>,
        Arc::new(Forbidden),
    );
    (net, fake, mock)
}

/// This device of `identity` (its identity v2 and first list), as the
/// first unlock of P1 makes it.
pub fn own_device(identity: &crate::identity::Identity, now: i64) -> crate::device::OwnDevice {
    let v2 = trino_core::identity_v2::IdentityV2::migrate_from_v1(
        identity,
        now,
        &mut trino_core::kem::drbg(),
    );
    let (list, _) = crate::device::list_for(&v2, None, now).expect("a first list");
    crate::device::OwnDevice { identity: v2, list }
}

/// `contact` as `handle` in `inner` (whose identity is `me`), with a P1
/// session open, as `connect_node` and the handshake's replies leave it.
/// Gives the contact's own side, where this one is the contact "me".
pub fn p1_session(
    inner: &mut crate::state::InnerState,
    me: &crate::identity::Identity,
    contact: &crate::identity::Identity,
    handle: &str,
) -> crate::state::InnerState {
    use crate::p1::Opened;
    let now = chrono::Utc::now().timestamp();
    if inner.device.is_none() {
        inner.device = Some(own_device(me, now));
    }
    let record = |id: &crate::identity::Identity, name: &str| crate::state::FriendRecord {
        handle: name.to_string(),
        bundle: crate::identity::public_bundle_for(id),
        added_at: 0,
        avatar: None,
        previous_fingerprint: None,
        key_changed_at: None,
        via_group: None,
        accepted_at: Some(0),
        devices: None,
    };
    let mut theirs = crate::state::InnerState {
        identity: Some(contact.clone()),
        device: Some(own_device(contact, now)),
        ..Default::default()
    };
    theirs.friends.insert("me".to_string(), record(me, "me"));
    let mine = inner.device.as_ref().expect("a device").full_bundle();
    crate::device::take_bundle(&mut theirs, "me", mine, now as u64).expect("my list");
    inner
        .friends
        .insert(handle.to_string(), record(contact, handle));
    let hers = theirs.device.as_ref().expect("a device").full_bundle();
    crate::device::take_bundle(inner, handle, hers, now as u64).expect("her list");
    let replies = |opened: Opened| match opened {
        Opened::Contact { replies, .. } => replies,
        other => panic!("not admitted: {other:?}"),
    };
    let hello = crate::p1::initiate(inner, handle, now).expect("a handshake");
    for reply in replies(crate::p1::open(&mut theirs, &hello, now)) {
        for back in replies(crate::p1::open(inner, &reply, now)) {
            replies(crate::p1::open(&mut theirs, &back, now));
        }
    }
    theirs
}
