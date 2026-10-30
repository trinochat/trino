//! The padding of the list a relay is asked for (design P1 §3.6, R-11).
//!
//! The list of an epoch is filled up to a multiple of 16 with values that
//! look like the real ones: x-only points of secret keys nobody keeps. A
//! relay that sees the list cannot tell how many contacts are behind it,
//! nor which values are real.
//!
//! The padding is one set per epoch, the same on every relay and in every
//! reconnection, and it survives a restart: a relay that saw two lists
//! with different padding would keep their intersection, the real values.
//! So the padding is a sequence drawn from a random seed of the epoch, and
//! the list takes its first `used` values. `used` only grows inside an
//! epoch: when a value comes or goes, the list takes more padding to reach
//! the next multiple of 16, and no padding value ever leaves it, which
//! would mark it as padding.

use crate::crypto::hkdf_expand;
use rand::{CryptoRng, RngCore};
use secp256k1::{SecretKey, SECP256K1};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::{Zeroize, ZeroizeOnDrop};

/// The list's length is a multiple of this.
pub const PAD_MULTIPLE: usize = 16;

const PAD_INFO: &[u8] = b"trino/p1/v1/pad";

/// The padding of one epoch.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct Padding {
    #[zeroize(skip)]
    pub epoch: u32,
    seed: [u8; 32],
    used: u32,
}

impl std::fmt::Debug for Padding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Padding {{ epoch: {}, used: {} }}",
            self.epoch, self.used
        )
    }
}

impl Padding {
    pub fn new<R: RngCore + CryptoRng>(epoch: u32, rng: &mut R) -> Self {
        let mut seed = [0u8; 32];
        rng.fill_bytes(&mut seed);
        Padding {
            epoch,
            seed,
            used: 0,
        }
    }

    /// `real` and the padding, sorted: the list for the relays. Its length
    /// is a multiple of `PAD_MULTIPLE`, and every padding value it ever
    /// held this epoch is still in it.
    pub fn fill(&mut self, real: &[[u8; 32]]) -> Vec<[u8; 32]> {
        let mut used = self.used as usize;
        if real.is_empty() && used == 0 {
            return Vec::new();
        }
        while (real.len() + used) % PAD_MULTIPLE != 0 {
            used += 1;
        }
        self.used = u32::try_from(used).unwrap_or(u32::MAX);
        let mut list = real.to_vec();
        list.extend((0..self.used).map(|i| pad_value(&self.seed, i)));
        list.sort_unstable();
        list
    }

    /// How many padding values the list holds.
    pub fn used(&self) -> u32 {
        self.used
    }
}

/// The padding of the epochs whose connections may be open: today's, and
/// yesterday's for the hours its connection stays (§3.6).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PadBook {
    epochs: BTreeMap<u32, Padding>,
}

impl PadBook {
    /// Epoch `e`'s padding, drawn now if it has none yet.
    pub fn of<R: RngCore + CryptoRng>(&mut self, e: u32, rng: &mut R) -> &mut Padding {
        self.epochs.entry(e).or_insert_with(|| Padding::new(e, rng))
    }

    /// Drops the padding of epochs before `today − 1`.
    pub fn purge(&mut self, today: u32) {
        self.epochs = self.epochs.split_off(&today.saturating_sub(1));
    }

    pub fn epochs(&self) -> Vec<u32> {
        self.epochs.keys().copied().collect()
    }
}

/// The `i`-th padding value of `seed`: `x-only(k · G)` for
/// `k = HKDF(seed, "trino/p1/v1/pad" ‖ i u32 ‖ ctr)`, the first `ctr` whose
/// `k` is a valid secret key (the second try happens with probability
/// about 2^-128). `k` is dropped at once.
fn pad_value(seed: &[u8; 32], i: u32) -> [u8; 32] {
    (0..=u8::MAX)
        .find_map(|ctr| {
            let mut info = PAD_INFO.to_vec();
            info.extend_from_slice(&i.to_be_bytes());
            info.push(ctr);
            let k = hkdf_expand(seed, &[], &info, 32).ok()?;
            let secret = SecretKey::from_slice(&k).ok()?;
            Some(secret.x_only_public_key(SECP256K1).0.serialize())
        })
        .expect("256 HKDF outputs are never all outside the secp256k1 scalar range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::StdRng;
    use rand::SeedableRng;
    use secp256k1::XOnlyPublicKey;
    use std::collections::HashSet;

    const E: u32 = 20_370;

    fn reals(n: u8) -> Vec<[u8; 32]> {
        // Real mailboxes are valid points too; any distinct values do here.
        (0..n).map(|i| [i.wrapping_add(1); 32]).collect()
    }

    fn rng() -> StdRng {
        StdRng::seed_from_u64(7)
    }

    #[test]
    fn the_list_is_a_multiple_of_16_and_its_padding_is_valid_points() {
        let mut pad = Padding::new(E, &mut rng());
        for n in [1u8, 5, 15, 16, 17, 40] {
            let real = reals(n);
            let list = pad.fill(&real);
            assert_eq!(list.len() % PAD_MULTIPLE, 0, "{n}");
            assert!(list.len() >= real.len() + 1 || real.len() % PAD_MULTIPLE == 0);
            for value in list.iter().filter(|value| !real.contains(value)) {
                XOnlyPublicKey::from_slice(value).expect("a valid x-only point");
            }
            let mut sorted = list.clone();
            sorted.sort_unstable();
            assert_eq!(list, sorted, "sorted: the padding is not at the end");
        }
    }

    #[test]
    fn with_nothing_to_listen_to_there_is_no_list() {
        let mut pad = Padding::new(E, &mut rng());
        assert!(pad.fill(&[]).is_empty());
        assert_eq!(pad.used(), 0);
    }

    #[test]
    fn the_same_epoch_gives_the_same_list_on_every_relay_and_after_a_restart() {
        let mut book = PadBook::default();
        let real = reals(5);
        let first = book.of(E, &mut rng()).fill(&real);
        let again = book.of(E, &mut StdRng::seed_from_u64(99)).fill(&real);
        assert_eq!(first, again, "drawn once per epoch");

        let saved = serde_json::to_vec(&book).unwrap();
        let mut back: PadBook = serde_json::from_slice(&saved).unwrap();
        assert_eq!(back.of(E, &mut StdRng::seed_from_u64(5)).fill(&real), first);
    }

    #[test]
    fn no_padding_value_ever_leaves_the_list_inside_an_epoch() {
        let mut pad = Padding::new(E, &mut rng());
        let mut seen_padding = HashSet::new();
        // Contacts come and go: 5, 6, 4, 20, 3.
        for n in [5u8, 6, 4, 20, 3] {
            let real = reals(n);
            let list = pad.fill(&real);
            assert_eq!(list.len() % PAD_MULTIPLE, 0);
            let padding: HashSet<_> = list.iter().filter(|v| !real.contains(v)).copied().collect();
            assert!(
                seen_padding.is_subset(&padding),
                "a padding value left at {n}"
            );
            seen_padding = padding;
        }
    }

    #[test]
    fn two_epochs_have_different_padding() {
        let mut book = PadBook::default();
        let mut r = rng();
        let real = reals(3);
        let today: HashSet<_> = book.of(E, &mut r).fill(&real).into_iter().collect();
        let tomorrow: HashSet<_> = book.of(E + 1, &mut r).fill(&real).into_iter().collect();
        let common: HashSet<_> = today.intersection(&tomorrow).collect();
        assert_eq!(common.len(), real.len(), "only the real values repeat here");
    }

    #[test]
    fn padding_older_than_yesterday_is_dropped() {
        let mut book = PadBook::default();
        let mut r = rng();
        for e in [E - 2, E - 1, E] {
            book.of(e, &mut r);
        }
        book.purge(E);
        assert_eq!(book.epochs(), [E - 1, E]);
    }

    #[test]
    fn the_seed_never_shows_in_debug() {
        let pad = Padding::new(E, &mut rng());
        assert_eq!(
            format!("{pad:?}"),
            format!("Padding {{ epoch: {E}, used: 0 }}")
        );
    }
}
