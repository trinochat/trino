//! The passphrase policy for new identities.
//!
//! The passphrase is all that stands between a copy of vault.bin and the
//! identity inside it. PBKDF2 makes every guess slow, but it cannot save a
//! passphrase that an attacker tries among the first. So `forge` refuses
//! passphrases that are short, and the most obvious choices:
//!
//! - one character, or one block of up to four, typed over and over
//!   ("aaaaaaaaaa", "1212121212"), or hardly anything but spaces;
//! - a straight run up or down the digits, the alphabet or the letter rows of
//!   a keyboard ("1234567890", "zyxwvutsrq", "qwertyuiop");
//! - a short list of passwords that are well known to be common.
//!
//! These checks ignore case and spaces. They are a heuristic, not a measure of
//! strength: they catch the obvious, and anything else passes, however easy it
//! may be to guess.

use thiserror::Error;
use zeroize::Zeroizing;

/// Fewest characters a new passphrase may have, counted as Unicode scalar
/// values (what `str::chars` yields), not bytes or UTF-16 units.
pub const MIN_PASSPHRASE_CHARS: usize = 10;

/// Longest block that, typed over and over, makes a passphrase trivial.
const MAX_REPEATED_BLOCK: usize = 4;

/// What a straight run is read along, forwards or backwards. Each one wraps
/// around, so "1234567890", the top row of a keyboard, is a run as well.
const SEQUENCES: [&str; 5] = [
    "0123456789",
    "abcdefghijklmnopqrstuvwxyz",
    // The letter rows of a keyboard, top to bottom, on the layouts of the
    // app's languages: English (US), Spanish and Portuguese (Brazil).
    "qwertyuiopasdfghjklzxcvbnm",
    "qwertyuiopasdfghjklñzxcvbnm",
    "qwertyuiopasdfghjklçzxcvbnm",
];

/// A few passwords that are well known to be common, written in lower case
/// and without spaces. Hand-picked, not taken from a study or a ranking: the
/// list is short on purpose, and holds only what the rules above miss. It also
/// has the app's own name, one of the context-specific words NIST SP 800-63B
/// asks verifiers to check.
const COMMON_PASSPHRASES: &[&str] = &[
    "password12",
    "password123",
    "password1234",
    "qwerty1234",
    "qwerty12345",
    "qwerty123456",
    "1q2w3e4r5t",
    "1q2w3e4r5t6y",
    "1qaz2wsx3edc",
    "123456789a",
    "a123456789",
    "1234554321",
    "1234512345",
    "1122334455",
    "welcome123",
    "admin12345",
    "letmein123",
    "contraseña",
    "contrasena",
    "contraseña1",
    "contrasena1",
    "contraseña123",
    "contrasena123",
    "senha12345",
    "senha123456",
    "trinochat1",
    "trinochat123",
    "trino12345",
    "trino123456",
];

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum PassphraseError {
    #[error("the passphrase needs at least {min} characters")]
    TooShort { min: usize },
    #[error("the passphrase is too common or too simple")]
    TooCommon,
}

/// Check a new passphrase against the policy described at the top of this
/// module. Opening an existing vault never goes through it.
pub fn validate_passphrase(passphrase: &str) -> Result<(), PassphraseError> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(PassphraseError::TooShort {
            min: MIN_PASSPHRASE_CHARS,
        });
    }
    let chars = normalize(passphrase);
    if is_repeated_block(&chars) || is_straight_run(&chars) || is_listed(&chars) {
        return Err(PassphraseError::TooCommon);
    }
    Ok(())
}

/// The passphrase as the checks after the length see it: in lower case and
/// without spaces, so neither can hide a common password. Both copies made
/// here are wiped when dropped: the first-run screens check every edit.
fn normalize(passphrase: &str) -> Zeroizing<Vec<char>> {
    let lower = Zeroizing::new(passphrase.to_lowercase());
    // Sized up front, so the copy is never moved and left behind.
    let mut chars = Zeroizing::new(Vec::with_capacity(lower.chars().count()));
    chars.extend(lower.chars().filter(|c| !c.is_whitespace()));
    chars
}

/// One block of up to `MAX_REPEATED_BLOCK` characters typed over and over,
/// or not even one longer block once the spaces are gone, as in "%  &  #   ".
fn is_repeated_block(chars: &[char]) -> bool {
    chars.len() <= MAX_REPEATED_BLOCK
        || (1..=MAX_REPEATED_BLOCK)
            .any(|block| (block..chars.len()).all(|i| chars[i] == chars[i - block]))
}

fn is_straight_run(chars: &[char]) -> bool {
    SEQUENCES.iter().any(|sequence| {
        let forwards: Vec<char> = sequence.chars().collect();
        let backwards: Vec<char> = forwards.iter().rev().copied().collect();
        runs_along(chars, &forwards) || runs_along(chars, &backwards)
    })
}

/// Whether `chars` reads straight along `sequence` from some point on,
/// wrapping around at its end.
fn runs_along(chars: &[char], sequence: &[char]) -> bool {
    let Some(first) = chars.first() else {
        return false;
    };
    (0..sequence.len())
        .filter(|&start| sequence[start] == *first)
        .any(|start| {
            chars
                .iter()
                .enumerate()
                .all(|(i, c)| *c == sequence[(start + i) % sequence.len()])
        })
}

/// Why an emergency key is refused against the passphrase it sits beside
/// (clave de emergencia, design §8.3).
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum EmergencyKeyError {
    #[error("the key is the passphrase")]
    SameAsPassphrase,
    #[error("the key is too like the passphrase")]
    LikePassphrase,
}

/// Check an emergency key against `passphrase`, the one it must never be
/// typed for by mistake (design §8.3, the lesson of the Panic Button, S22).
/// The key must pass `validate_passphrase` as well; this checks only how
/// close the two are.
///
/// Refused as the same when the two are equal, and as too like it when,
/// with case and spaces ignored, one holds the other or they are at most
/// `MAX_KEY_EDITS` edits apart (insertions, deletions or changes of one
/// character).
pub fn check_emergency_key(passphrase: &str, key: &str) -> Result<(), EmergencyKeyError> {
    if passphrase == key {
        return Err(EmergencyKeyError::SameAsPassphrase);
    }
    let real = normalize(passphrase);
    let other = normalize(key);
    if holds(&real, &other) || holds(&other, &real) || within_edits(&real, &other, MAX_KEY_EDITS) {
        return Err(EmergencyKeyError::LikePassphrase);
    }
    Ok(())
}

/// How many edits apart an emergency key and the passphrase must be, at
/// least, beyond this (design §8.3).
const MAX_KEY_EDITS: usize = 2;

/// Whether `outer` holds `inner` as a run of characters.
fn holds(outer: &[char], inner: &[char]) -> bool {
    inner.is_empty() || outer.windows(inner.len()).any(|window| window == inner)
}

/// Whether `a` and `b` are at most `max` edits apart (Levenshtein, by
/// characters). Lengths further apart than that are, without counting.
fn within_edits(a: &[char], b: &[char], max: usize) -> bool {
    if a.len().abs_diff(b.len()) > max {
        return false;
    }
    let mut before: Vec<usize> = (0..=b.len()).collect();
    let mut row = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let change = before[j] + usize::from(ca != cb);
            row[j + 1] = change.min(before[j + 1] + 1).min(row[j] + 1);
        }
        std::mem::swap(&mut before, &mut row);
    }
    before[b.len()] <= max
}

fn is_listed(chars: &[char]) -> bool {
    COMMON_PASSPHRASES
        .iter()
        .any(|common| common.chars().eq(chars.iter().copied()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const TOO_SHORT: Result<(), PassphraseError> = Err(PassphraseError::TooShort {
        min: MIN_PASSPHRASE_CHARS,
    });
    const TOO_COMMON: Result<(), PassphraseError> = Err(PassphraseError::TooCommon);

    fn assert_all(passphrases: &[&str], expected: Result<(), PassphraseError>) {
        for passphrase in passphrases {
            assert_eq!(validate_passphrase(passphrase), expected, "{passphrase:?}");
        }
    }

    #[test]
    fn the_minimum_is_ten_characters() {
        assert_eq!(MIN_PASSPHRASE_CHARS, 10);
        assert_all(&["", "k8#vQ2!mz"], TOO_SHORT);
        assert_eq!(validate_passphrase("k8#vQ2!mzw"), Ok(()));
    }

    #[test]
    fn the_length_counts_characters_not_bytes_or_utf16_units() {
        // Nine characters: 12 bytes in UTF-8 and ten UTF-16 units, so a check
        // on `String.length` in the UI would wrongly let it through.
        assert_eq!("mi🐦canta7".chars().count(), 9);
        assert_eq!(validate_passphrase("mi🐦canta7"), TOO_SHORT);
        // Ten characters, 12 bytes.
        assert_eq!(validate_passphrase("ñandúcorre"), Ok(()));
    }

    #[test]
    fn well_known_passwords_are_refused_in_any_case() {
        assert_all(
            &[
                "1234567890",
                "qwertyuiop",
                "password123",
                "contraseña123",
                "PASSWORD123",
                "Contraseña123",
                "CONTRASEÑA123",
                "QwErTyUiOp",
                "1q2w3e4r5t",
                "1qaz2wsx3edc",
                "senha12345",
                "TrinoChat123",
            ],
            TOO_COMMON,
        );
    }

    #[test]
    fn spaces_do_not_hide_a_common_password() {
        assert_all(
            &[
                "1234 5678 90",
                "password 123",
                " qwertyuiop ",
                "contraseña 123",
            ],
            TOO_COMMON,
        );
    }

    #[test]
    fn one_character_or_one_short_block_over_and_over_is_refused() {
        assert_all(
            &[
                "aaaaaaaaaa",
                "0000000000",
                "ññññññññññ",
                "          ",
                "1212121212",
                "abcabcabcabc",
                "holaholahola",
                "hola hola hola",
                "%  &  #   ",
            ],
            TOO_COMMON,
        );
    }

    #[test]
    fn straight_runs_up_or_down_are_refused() {
        assert_all(
            &[
                // Digits, wrapping from 9 to 0 as on the top row.
                "0123456789",
                "3456789012",
                "9876543210",
                "0987654321",
                // The alphabet.
                "abcdefghij",
                "klmnopqrst",
                "zyxwvutsrq",
                // Keyboard rows, also running on into the next row.
                "poiuytrewq",
                "asdfghjklñ",
                "asdfghjklç",
                "qwertyuiopasdf",
                "mnbvcxzlkjh",
            ],
            TOO_COMMON,
        );
    }

    #[test]
    fn ordinary_passphrases_pass() {
        assert_all(
            &[
                "correct horse battery staple",
                "Mi gato se llama Pelusa",
                "k8#vQ2!mzw",
                "mi🐦canta77",
                "el río suena a las 6",
            ],
            Ok(()),
        );
    }

    #[test]
    fn the_normalized_copy_is_wiped_when_dropped() {
        let normalized: Zeroizing<Vec<char>> = normalize("Correct Horse");
        assert_eq!(normalized.iter().collect::<String>(), "correcthorse");
    }

    #[test]
    fn a_check_compares_with_the_list_in_place() {
        // A String of the normalized passphrase would be one more copy of
        // it left in freed memory after every check.
        let code = include_str!("passphrase.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        let is_listed = code
            .split("fn is_listed(")
            .nth(1)
            .and_then(|rest| rest.split("\n}").next())
            .unwrap();
        assert!(!is_listed.contains("collect"), "a copy:{is_listed}");
    }

    #[test]
    fn the_list_holds_only_what_the_rules_miss() {
        let mut seen = HashSet::new();
        for entry in COMMON_PASSPHRASES {
            let chars: Vec<char> = entry.chars().collect();
            assert_eq!(
                *normalize(entry),
                chars,
                "{entry:?} is not written normalized"
            );
            assert!(
                chars.len() >= MIN_PASSPHRASE_CHARS,
                "{entry:?} is refused for its length anyway"
            );
            assert!(
                !is_repeated_block(&chars) && !is_straight_run(&chars),
                "{entry:?} is already caught by a rule"
            );
            assert!(seen.insert(entry), "{entry:?} is listed twice");
        }
    }

    // ---- The emergency key beside the passphrase (design §8.3) ----

    const REAL: &str = "Lluvia sobre el puente";

    #[test]
    fn an_emergency_key_that_is_the_passphrase_is_refused_as_the_same() {
        assert_eq!(
            check_emergency_key(REAL, REAL),
            Err(EmergencyKeyError::SameAsPassphrase)
        );
    }

    #[test]
    fn a_key_like_the_passphrase_is_refused() {
        for like in [
            // Only case or spaces apart.
            "lluvia sobre el puente",
            "LluviaSobreElPuente",
            "  LLUVIA SOBRE EL PUENTE ",
            // One holds the other.
            "Lluvia sobre el puente 2",
            "sobre el puente",
            "mi Lluvia sobre el puente de siempre",
            // Two edits or fewer away.
            "Lluvia sobre el puento",
            "Lluvia sobre el puentes!",
            "Llvia sobre l puente",
            "Lluvai sobre el puente",
        ] {
            assert_eq!(
                check_emergency_key(REAL, like),
                Err(EmergencyKeyError::LikePassphrase),
                "{like:?}"
            );
        }
    }

    #[test]
    fn a_key_three_edits_away_or_unlike_the_passphrase_passes() {
        for unlike in [
            "Lluvia sobre al puanto",
            "caballo correcto bateria",
            "el puente bajo la lluvia",
        ] {
            assert_eq!(check_emergency_key(REAL, unlike), Ok(()), "{unlike:?}");
        }
    }

    #[test]
    fn the_likeness_counts_characters_not_bytes() {
        // "ñ" for "n" is one edit, not two bytes' worth.
        assert_eq!(
            check_emergency_key("montaña rusa de noche", "montana rusa de nocha"),
            Err(EmergencyKeyError::LikePassphrase)
        );
    }
}
