//! This device under P1 and device linking (P1-8; `diseno-vinculacion.md`
//! §2.2, §13.1 and §21.4): its identity v2 and its account's list.
//!
//! - **The identity v2** lives in the version 3 vault, next to today's
//!   identity. The first unlock of this version makes it from today's
//!   (§13.1 steps 1 and 2, `migrate_from_v1`): `ik_sign` becomes the
//!   account key `A`, `ik_dh` this device's `dev_dh`, with a new `dev_sign`
//!   and a new post-quantum prekey. Both prekeys then rotate every 30 days
//!   and are kept 45 (DN-06).
//! - **The list** is signed by `A` and kept in the account file: it is
//!   public (it travels to every contact) and signed, so the store only
//!   has to keep it. The first one is `gen 1, seq 1` with this device as
//!   the primary; it is signed once, never again, so no contact ever sees
//!   two first lists (that would be a fork, §3.5).
//!
//! Until device linking (VI-8 onwards) the account has this one device,
//! so its bundle is this device's prekeys after the list.

use crate::identity::{Identity, KeyPair};
use crate::state::InnerState;
use crate::vault::VaultError;
use crate::vault_v3::OpenVault;
use trino_core::device::{DeviceBundle, DeviceList};
use trino_core::identity_v2::IdentityV2;
use trino_core::kem::drbg;

/// This device: its identity v2 and its account's list.
#[derive(Clone)]
pub struct OwnDevice {
    pub identity: IdentityV2,
    pub list: DeviceList,
}

impl std::fmt::Debug for OwnDevice {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnDevice")
            .field("id", &self.identity.device.id)
            .finish_non_exhaustive()
    }
}

impl OwnDevice {
    /// The account key `A` of the list.
    pub fn account(&self) -> [u8; 32] {
        self.list.body.account
    }

    /// This device's X25519 key.
    pub fn dev_dh(&self) -> &KeyPair {
        &self.identity.device.dev_dh
    }

    /// The list with this device's prekeys, both of them (the full
    /// `DeviceList` of §21.4).
    pub fn full_bundle(&self) -> DeviceBundle {
        DeviceBundle {
            pq_spks: Some(vec![self.identity.device.signed_pq_spk()]),
            ..self.compact_bundle()
        }
    }

    /// The list with this device's classical prekey only (the compact
    /// `DeviceList`, for the handshake and its first reply).
    pub fn compact_bundle(&self) -> DeviceBundle {
        DeviceBundle {
            list: self.list.clone(),
            spks: vec![self.identity.device.signed_spk()],
            pq_spks: None,
        }
    }
}

/// Makes sure the vault holds an identity v2: from today's the first time,
/// with its prekeys rotated when due after that. True when the vault
/// changed and has to be written again.
pub fn ensure_in_vault(vault: &mut OpenVault, v1: &Identity, now: i64) -> Result<bool, VaultError> {
    let mut rng = drbg();
    let mut identity = match vault.identity_v2() {
        Some(held) => held.clone(),
        None => IdentityV2::migrate_from_v1(v1, now, &mut rng),
    };
    let new = vault.identity_v2().is_none();
    let rotated = identity
        .device
        .rotate_prekeys_if_due_with_rng(now, &mut rng);
    if !(new || rotated) {
        return Ok(false);
    }
    vault.set_identity_v2(Some(identity))?;
    Ok(true)
}

/// A new account's device, made from its identity of today, with its
/// first list (a new account, or the empty one of the emergency key): both
/// are written with the account, so its first unlock writes nothing more.
pub fn first_of(v1: &Identity, now: i64) -> Option<(IdentityV2, String)> {
    let identity = IdentityV2::migrate_from_v1(v1, now, &mut drbg());
    let (list, _) = list_for(&identity, None, now)?;
    Some((identity, hex::encode(list.encode())))
}

/// The list of `identity`'s account: the one kept (`stored`, hex), or the
/// first one if none was ever signed, issued at `now`. `None` if the one
/// kept is not this device's account's or does not name this device: it
/// is never signed again over it. The flag says the list is new.
pub fn list_for(
    identity: &IdentityV2,
    stored: Option<&str>,
    now: i64,
) -> Option<(DeviceList, bool)> {
    let account = identity.account.as_ref()?.a.pub_bytes;
    let Some(stored) = stored else {
        let first = identity
            .first_list(u64::try_from(now).ok()?, [0; 32], &mut drbg())
            .ok()?;
        return Some((first, true));
    };
    let list = DeviceList::decode(&hex::decode(stored).ok()?).ok()?;
    list.verify().ok()?;
    let mine = list.body.account == account
        && list
            .entry_by_dh(&identity.device.dev_dh.pub_bytes)
            .is_some_and(|entry| entry.dev_sign == identity.device.dev_sign.pub_bytes);
    mine.then_some((list, false))
}

/// What the unlock does with this device: its identity v2 from the open
/// vault, and its list. True when a first list was signed, so the account
/// file has to be written.
pub fn open(inner: &mut InnerState, stored: Option<&str>, now: i64) -> bool {
    let identity = inner
        .vault
        .lock()
        .as_ref()
        .and_then(|open| open.vault.identity_v2().cloned());
    inner.device = None;
    let Some(identity) = identity else {
        return false;
    };
    match list_for(&identity, stored, now) {
        Some((list, new)) => {
            inner.device = Some(OwnDevice { identity, list });
            new
        }
        None => {
            crate::session::dbg_log("the device list kept is not this device's");
            false
        }
    }
}

/// The list as the account file keeps it.
pub fn stored_list(device: &OwnDevice) -> String {
    hex::encode(device.list.encode())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::identity::create_identity;
    use trino_core::device::Chain;
    use trino_core::identity_v2::SPK_ROTATION_SECS;

    const NOW: i64 = 1_793_000_000;

    /// A device of an account migrated from `v1`, with its first list.
    pub(crate) fn own_device_of(v1: &Identity, now: i64) -> OwnDevice {
        let identity = IdentityV2::migrate_from_v1(v1, now, &mut drbg());
        let (list, _) = list_for(&identity, None, now).unwrap();
        OwnDevice { identity, list }
    }

    fn vault_of(v1: &Identity) -> OpenVault {
        crate::vault_v3::create_vault_v3(
            &crate::vault_v3::NewAccount {
                identity: v1,
                app: None,
                shared_app: b"{}",
                id_vault: [7; 16],
            },
            None,
            "a passphrase long enough",
        )
        .unwrap()
    }

    #[test]
    fn the_first_unlock_makes_device_0_from_today_identity() {
        let v1 = create_identity();
        let mut vault = vault_of(&v1);
        assert!(vault.identity_v2().is_none());

        assert!(ensure_in_vault(&mut vault, &v1, NOW).unwrap());

        let v2 = vault.identity_v2().unwrap();
        assert_eq!(v2.device.dev_dh.pub_bytes, v1.ik_dh.pub_bytes);
        let account = v2.account.as_ref().unwrap();
        assert_eq!(account.a.pub_bytes, v1.ik_sign.pub_bytes);
        assert_eq!(account.nostr.pub_bytes, v1.nostr.pub_bytes);
        // The same signed prekey, now signed by dev_sign with its domain.
        assert_eq!(
            v2.device.spk.keypair.pub_bytes,
            v1.signed_prekey.keypair.pub_bytes
        );
        v2.device
            .signed_spk()
            .verify(&v2.device.dev_sign.pub_bytes)
            .unwrap();
        // Sealed in the vault's bytes, not only in memory.
        let id = v2.device.id;
        match crate::vault_v3::unseal_vault_v3(vault.bytes(), "a passphrase long enough", None) {
            Ok(crate::vault_v3::Unlocked::Real(reopened)) => {
                assert_eq!(reopened.identity_v2().unwrap().device.id, id)
            }
            _ => panic!("the vault does not open with its passphrase"),
        }

        // The next unlock finds it there and changes nothing.
        assert!(!ensure_in_vault(&mut vault, &v1, NOW + 60).unwrap());
        assert_eq!(vault.identity_v2().unwrap().device.id, id);
    }

    #[test]
    fn the_prekeys_rotate_when_due() {
        let v1 = create_identity();
        let mut vault = vault_of(&v1);
        ensure_in_vault(&mut vault, &v1, NOW).unwrap();
        let before = vault.identity_v2().unwrap().device.pq.current.id;
        let spk_created = vault.identity_v2().unwrap().device.spk.created_at;

        assert!(ensure_in_vault(&mut vault, &v1, spk_created + SPK_ROTATION_SECS).unwrap());

        let after = vault.identity_v2().unwrap();
        assert_ne!(after.device.pq.current.id, before);
        assert_eq!(
            after.device.retired_spks.len(),
            1 + v1.retired_signed_prekeys.len()
        );
    }

    #[test]
    fn the_first_list_is_signed_once_and_then_kept() {
        let v1 = create_identity();
        let identity = IdentityV2::migrate_from_v1(&v1, NOW, &mut drbg());
        let (first, new) = list_for(&identity, None, NOW).unwrap();
        assert!(new);
        assert_eq!((first.body.gen, first.body.seq), (1, 1));
        assert_eq!(first.body.account, v1.ik_sign.pub_bytes);
        assert_eq!(first.body.issued, NOW as u64);
        let entry = &first.body.entries[0];
        assert!(entry.is_primary());
        assert_eq!(entry.dev_dh, v1.ik_dh.pub_bytes);
        // A contact pinned to ik_sign takes it (§13.2).
        Chain::first(first.clone(), &v1.ik_sign.pub_bytes, NOW as u64, |_| false).unwrap();

        let device = OwnDevice {
            identity: identity.clone(),
            list: first.clone(),
        };
        let kept = stored_list(&device);
        let (again, new) = list_for(&identity, Some(&kept), NOW + 99).unwrap();
        assert!(!new);
        assert_eq!(again, first);
    }

    #[test]
    fn a_kept_list_that_is_not_this_device_s_is_never_signed_over() {
        let v1 = create_identity();
        let identity = IdentityV2::migrate_from_v1(&v1, NOW, &mut drbg());
        let other = own_device_of(&create_identity(), NOW);
        assert!(list_for(&identity, Some(&stored_list(&other)), NOW).is_none());
        assert!(list_for(&identity, Some("zz"), NOW).is_none());
        // The same account, but a list without this device.
        let sibling = IdentityV2 {
            device: trino_core::identity_v2::DeviceIdentity::generate_with_rng(NOW, &mut drbg()),
            account: identity.account.clone(),
        };
        let (theirs, _) = list_for(&sibling, None, NOW).unwrap();
        let hex_list = hex::encode(theirs.encode());
        assert!(list_for(&identity, Some(&hex_list), NOW).is_none());
    }

    #[test]
    fn the_bundles_carry_this_device_s_prekeys_signed() {
        let device = own_device_of(&create_identity(), NOW);
        let full = device.full_bundle();
        full.verify().unwrap();
        assert_eq!(full.list, device.list);
        assert_eq!(full.spks, vec![device.identity.device.signed_spk()]);
        let pq = full.pq_spks.as_ref().unwrap();
        assert_eq!(pq[0].id, device.identity.device.pq.current.id);
        assert_eq!(full.encode_full().unwrap().len(), 367 + 1561);

        let compact = device.compact_bundle();
        compact.verify().unwrap();
        assert!(compact.pq_spks.is_none());
        assert_eq!(compact.encode_compact().len(), 367 + 309);
    }

    #[test]
    fn opening_takes_the_vault_s_identity_and_keeps_the_list() {
        let v1 = create_identity();
        let mut vault = vault_of(&v1);
        ensure_in_vault(&mut vault, &v1, NOW).unwrap();
        let mut inner = InnerState {
            identity: Some(v1.clone()),
            ..Default::default()
        };
        inner.vault.set(crate::vault_file::SessionVault {
            path: std::path::PathBuf::from("unused"),
            vault: Box::new(vault),
        });

        assert!(open(&mut inner, None, NOW));
        let device = inner.device.clone().unwrap();
        assert_eq!(device.dev_dh().pub_bytes, v1.ik_dh.pub_bytes);
        assert_eq!(device.account(), v1.ik_sign.pub_bytes);

        // The account file gives it back on the next unlock.
        let kept = stored_list(&device);
        inner.device = None;
        assert!(!open(&mut inner, Some(&kept), NOW + 5));
        assert_eq!(inner.device.as_ref().unwrap().list, device.list);

        // Without an identity v2 in the vault there is no device.
        let mut bare = InnerState {
            identity: Some(v1),
            ..Default::default()
        };
        assert!(!open(&mut bare, None, NOW));
        assert!(bare.device.is_none());
    }
}
