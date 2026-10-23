//! Settings › Cuenta y seguridad › Clave de emergencia (CE-5, design §8):
//! configure or change the emergency key, test it without erasing, remove
//! it, and read what happens on the network, behind the passphrase.
//!
//! Nothing here says whether a key is set (CE-D6): configuring writes its
//! slot over whatever was there, removing fills it with random bytes
//! whether a key was there or not, and both answer the same either way.
//! Only "Probar" tells, and only to whoever types the key itself.
//!
//! Like the other settings (security_cmds.rs), each command that writes
//! holds `session_gate`, opens the vault again with the passphrase (and the
//! code, with TOTP on), and writes it in two phases noted in the store. The
//! emergency key is never taken for the passphrase here: typed as the
//! passphrase, it opens nothing (`wrong_passphrase`), as in every setting.

use crate::command_error::CommandError;
use crate::commands::submitted_code;
use crate::passphrase::{check_emergency_key, validate_passphrase};
use crate::security_cmds::{noting, open_any, require_session, run_blocking, write_v3, Resealed};
use crate::state::{vault_path, AppState};
use serde::Serialize;
use std::path::Path;
use tauri::State;
use trino_core::vault_v3::OpenVault;
use trino_engine::vault_file::OpenedVault;
use zeroize::Zeroizing;

/// What Trino does on the network when the emergency key is used (design
/// §7, CE-D11): today only nothing. Sent as `{"action": "none"}`.
///
/// CE-6 adds `Alert`, the warning to a trusted contact: its registration
/// (`alert_key`, `alert_id`, the contact's relays and the optional message
/// of up to 280 characters) lives in the shared block (design §7.2 step 4),
/// and needs the contact to accept first (`alert-reg`, `alert-ack`), so it
/// cannot be saved before CE-6 exists. Absent from the block means none,
/// so an account that never chose looks like one that chose "Ninguna".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum EmergencyNetwork {
    None,
}

/// Configure or change the emergency key (design §8.2): `key` must pass the
/// passphrase policy and be neither `current` nor like it; then `current`
/// opens the vault, with a valid `totp_code` when TOTP is on, and the key's
/// slot is written over whatever was there.
#[tauri::command]
pub async fn set_emergency_key(
    state: State<'_, AppState>,
    current: String,
    key: String,
    totp_code: Option<String>,
) -> Result<(), CommandError> {
    let current = Zeroizing::new(current);
    let key = Zeroizing::new(key);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    let noted = noting(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let mut session = noted.vault.lock();
        let code = totp_code.as_deref().map(String::as_str);
        set_key(&vault, &current, &key, code, |bytes| {
            noted.write(&vault, bytes)
        })?
        .keep_in(&mut session, &vault);
        Ok(())
    })
    .await
}

/// "Probar sin borrar" (design §8.4, RC-16): whether `candidate` is the
/// emergency key of the open session's vault. One derivation; it writes
/// nothing, counts nothing, and never raises the KDF's parameters. Without
/// a version 3 vault in the session there is no key to match.
#[tauri::command]
pub async fn test_emergency_key(
    state: State<'_, AppState>,
    candidate: String,
) -> Result<bool, CommandError> {
    let candidate = Zeroizing::new(candidate);
    let _gate = state.session_gate.lock().await;
    let cell = {
        let inner = state.inner.lock().await;
        require_session(&inner)?;
        inner.vault.clone()
    };
    run_blocking(move || match cell.lock().as_ref() {
        Some(session) => is_key(&session.vault, &candidate),
        None => Ok(false),
    })
    .await
}

/// "Quitar" (design §8.5): with the passphrase (and the code, with TOTP
/// on), the emergency slot is filled with random bytes. The same answer
/// and the same write whether there was a key or not.
#[tauri::command]
pub async fn remove_emergency_key(
    state: State<'_, AppState>,
    current: String,
    totp_code: Option<String>,
) -> Result<(), CommandError> {
    let current = Zeroizing::new(current);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    let noted = noting(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let mut session = noted.vault.lock();
        let code = totp_code.as_deref().map(String::as_str);
        remove_key(&vault, &current, code, |bytes| noted.write(&vault, bytes))?
            .keep_in(&mut session, &vault);
        Ok(())
    })
    .await
}

/// "Qué pasa en la red" (design §8.1, §8.5): what is chosen, only once the
/// passphrase (and the code, with TOTP on) opened the vault. Writes nothing.
#[tauri::command]
pub async fn emergency_network(
    state: State<'_, AppState>,
    passphrase: String,
    totp_code: Option<String>,
) -> Result<EmergencyNetwork, CommandError> {
    let passphrase = Zeroizing::new(passphrase);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    require_session(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let code = totp_code.as_deref().map(String::as_str);
        network_of(&vault, &passphrase, code)
    })
    .await
}

/// Write the emergency slot of the vault at `vault` with `key`, once the
/// rules passed and `current` opened it, and save it with `write`.
///
/// The rules (design §8.3) come first, before any derivation: the policy of
/// every passphrase, then neither `current` nor like it. The core refuses
/// a key that opens another slot (`choose_another`).
fn set_key(
    vault: &Path,
    current: &str,
    key: &str,
    code: Option<&str>,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    validate_passphrase(key)?;
    check_emergency_key(current, key)?;
    match open_any(vault, current, submitted_code(code))? {
        OpenedVault::V3(mut fresh) => {
            fresh.set_emergency_key(current, key)?;
            write_v3(fresh, write)
        }
        // Every unlock moves a vault to version 3 (CE-3); one that could
        // not move yet has no emergency slot to write.
        OpenedVault::Old(_) => Err(CommandError::internal(
            "the vault has not moved to version 3 yet",
        )),
    }
}

/// Fill the emergency slot of the vault at `vault` with random bytes, once
/// `current` opened it, and save it with `write`. A vault of version 2 has
/// no such slot: nothing to remove, and the same answer.
fn remove_key(
    vault: &Path,
    current: &str,
    code: Option<&str>,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Result<Resealed, CommandError> {
    match open_any(vault, current, submitted_code(code))? {
        OpenedVault::V3(mut fresh) => {
            fresh.remove_emergency_key(current)?;
            write_v3(fresh, write)
        }
        OpenedVault::Old(_) => Ok(Resealed::nothing()),
    }
}

/// Whether `candidate` is the emergency key of `vault`, which it only reads.
fn is_key(vault: &OpenVault, candidate: &str) -> Result<bool, CommandError> {
    Ok(vault.is_emergency_key(candidate)?)
}

/// The network choice of the vault at `vault`, once `passphrase` opened it.
fn network_of(
    vault: &Path,
    passphrase: &str,
    code: Option<&str>,
) -> Result<EmergencyNetwork, CommandError> {
    open_any(vault, passphrase, submitted_code(code))?;
    // CE-6: read the alert's registration from the opened vault's shared
    // block here (design §7.2 step 4). Until then nothing can be chosen
    // but "Ninguna", so the block never holds one.
    Ok(EmergencyNetwork::None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_error::ErrorCode;
    use crate::fsutil::{self, scratch::ScratchDir};
    use crate::identity::create_identity;
    use crate::totp::{generate_totp_secret, totp_now};
    use std::path::PathBuf;
    use trino_core::vault_v3::{create_vault_v3, unseal_vault_v3, NewAccount, Unlocked};

    const PASSPHRASE: &str = "correct horse battery staple";
    const KEY: &str = "lluvia sobre el puente viejo";
    const OTHER_KEY: &str = "una tarde de marzo en la plaza";

    /// A version 3 vault in `scratch`, sealed with `PASSPHRASE` and, if
    /// given, a TOTP secret. The test KDF keeps each derivation cheap.
    fn vault_v3(scratch: &ScratchDir, secret: Option<&[u8]>) -> PathBuf {
        let vault = scratch.path().join("vault.bin");
        let created = create_vault_v3(
            &NewAccount {
                identity: &create_identity(),
                app: Some(b"the key to the local data"),
                shared_app: br#"{"v":1,"name":"ana","createdAt":1}"#,
                id_vault: [7; 16],
            },
            secret,
            PASSPHRASE,
        )
        .unwrap();
        fsutil::atomic_write(&vault, created.bytes()).unwrap();
        vault
    }

    fn save_to(vault: &Path) -> impl FnOnce(&[u8]) -> std::io::Result<()> + '_ {
        move |bytes| fsutil::atomic_write(vault, bytes)
    }

    fn bytes_of(vault: &Path) -> Vec<u8> {
        std::fs::read(vault).unwrap()
    }

    /// What typing `passphrase` on the unlock screen opens: "real",
    /// "emergency", or the error's code.
    fn unlock_as(vault: &Path, passphrase: &str, code: Option<&str>) -> String {
        match unseal_vault_v3(&bytes_of(vault), passphrase, code) {
            Ok(Unlocked::Real(_)) => "real".into(),
            Ok(Unlocked::Emergency(_)) => "emergency".into(),
            Err(error) => format!("{:?}", CommandError::from(error).code),
        }
    }

    fn open_v3(vault: &Path) -> Box<OpenVault> {
        match unseal_vault_v3(&bytes_of(vault), PASSPHRASE, None) {
            Ok(Unlocked::Real(opened)) => opened,
            _ => panic!("the passphrase does not open the vault"),
        }
    }

    #[test]
    fn a_key_set_in_the_settings_opens_the_emergency_path_and_the_passphrase_still_opens_the_account(
    ) {
        let scratch = ScratchDir::new("ce5-set");
        let vault = vault_v3(&scratch, None);
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        assert_eq!(unlock_as(&vault, KEY, None), "emergency");
        assert_eq!(unlock_as(&vault, PASSPHRASE, None), "real");
        assert_eq!(unlock_as(&vault, OTHER_KEY, None), "WrongPassphrase");
    }

    #[test]
    fn a_new_key_replaces_the_one_before() {
        let scratch = ScratchDir::new("ce5-change");
        let vault = vault_v3(&scratch, None);
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        set_key(&vault, PASSPHRASE, OTHER_KEY, None, save_to(&vault)).unwrap();
        assert_eq!(unlock_as(&vault, OTHER_KEY, None), "emergency");
        assert_eq!(unlock_as(&vault, KEY, None), "WrongPassphrase");
    }

    /// The rules of §8.3 come before the vault is opened: each refusal
    /// comes back even with a wrong passphrase, and nothing is written.
    #[test]
    fn the_key_rules_are_checked_before_the_vault_is_opened() {
        let scratch = ScratchDir::new("ce5-rules");
        let vault = vault_v3(&scratch, None);
        let before = bytes_of(&vault);
        let refused = |key: &str| {
            set_key(&vault, PASSPHRASE, key, None, |_| panic!("written"))
                .map(drop)
                .unwrap_err()
                .code
        };
        assert_eq!(refused("corta"), ErrorCode::PassphraseTooShort);
        assert_eq!(refused("1234567890"), ErrorCode::PassphraseTooCommon);
        assert_eq!(refused(PASSPHRASE), ErrorCode::SameAsPassphrase);
        assert_eq!(
            refused("Correct Horse Battery Staple"),
            ErrorCode::LikePassphrase
        );
        assert_eq!(
            refused("correct horse battery staples!"),
            ErrorCode::LikePassphrase
        );
        assert_eq!(
            refused("my correct horse battery staple"),
            ErrorCode::LikePassphrase
        );
        let with_wrong_passphrase = set_key(
            &vault,
            "not the passphrase at all",
            "1234567890",
            None,
            |_| panic!("written"),
        )
        .map(drop)
        .unwrap_err();
        assert_eq!(with_wrong_passphrase.code, ErrorCode::PassphraseTooCommon);
        assert_eq!(bytes_of(&vault), before);
    }

    #[test]
    fn a_wrong_passphrase_or_a_missing_code_sets_nothing() {
        let scratch = ScratchDir::new("ce5-wrong");
        let secret = generate_totp_secret();
        let vault = vault_v3(&scratch, Some(&secret));
        let before = bytes_of(&vault);
        let wrong = set_key(&vault, "not the passphrase at all", KEY, None, |_| {
            panic!("written")
        })
        .map(drop)
        .unwrap_err();
        assert_eq!(wrong.code, ErrorCode::WrongPassphrase);
        let no_code = set_key(&vault, PASSPHRASE, KEY, None, |_| panic!("written"))
            .map(drop)
            .unwrap_err();
        assert_eq!(no_code.code, ErrorCode::TotpRequired);
        assert_eq!(bytes_of(&vault), before);

        // With the code, the key goes in, and asks for the same code.
        let code = totp_now(&secret);
        set_key(&vault, PASSPHRASE, KEY, Some(&code), save_to(&vault)).unwrap();
        assert_eq!(unlock_as(&vault, KEY, None), "TotpRequired");
        assert_eq!(
            unlock_as(&vault, KEY, Some(&totp_now(&secret))),
            "emergency"
        );
    }

    /// The pending of CE-3: a new passphrase that is the emergency key gets
    /// a code of its own, "choose another", and not "too common".
    #[test]
    fn a_new_passphrase_that_is_the_emergency_key_is_refused_with_choose_another() {
        let scratch = ScratchDir::new("ce5-choose");
        let vault = vault_v3(&scratch, None);
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        let before = bytes_of(&vault);
        let mut opened = open_v3(&vault);
        let error = CommandError::from(opened.change_passphrase(KEY).unwrap_err());
        assert_eq!(error.code, ErrorCode::ChooseAnother);
        assert_eq!(bytes_of(&vault), before);
    }

    /// RC-16: the test of the key answers whether it matches, and writes
    /// nothing: not the vault in memory, not the file.
    #[test]
    fn testing_the_key_never_writes_the_vault() {
        let scratch = ScratchDir::new("ce5-test");
        let vault = vault_v3(&scratch, None);
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        let on_disk = bytes_of(&vault);
        let opened = open_v3(&vault);
        let in_memory = opened.bytes().to_vec();
        assert!(is_key(&opened, KEY).unwrap());
        assert!(!is_key(&opened, OTHER_KEY).unwrap());
        assert!(!is_key(&opened, PASSPHRASE).unwrap());
        assert_eq!(opened.bytes(), in_memory.as_slice());
        assert_eq!(bytes_of(&vault), on_disk);
    }

    /// "Quitar" answers the same with a key or without one, and writes
    /// either way; after it, the key opens nothing.
    #[test]
    fn removing_answers_the_same_with_or_without_a_key() {
        let scratch = ScratchDir::new("ce5-remove");
        let vault = vault_v3(&scratch, None);
        let mut writes = 0;
        remove_key(&vault, PASSPHRASE, None, |bytes| {
            writes += 1;
            fsutil::atomic_write(&vault, bytes)
        })
        .unwrap();
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        remove_key(&vault, PASSPHRASE, None, |bytes| {
            writes += 1;
            fsutil::atomic_write(&vault, bytes)
        })
        .unwrap();
        assert_eq!(writes, 2);
        assert_eq!(unlock_as(&vault, KEY, None), "WrongPassphrase");
        assert_eq!(unlock_as(&vault, PASSPHRASE, None), "real");
        let wrong = remove_key(&vault, OTHER_KEY, None, |_| panic!("written"))
            .map(drop)
            .unwrap_err();
        assert_eq!(wrong.code, ErrorCode::WrongPassphrase);
    }

    /// "Qué pasa en la red" shows nothing without the passphrase, and the
    /// emergency key does not open it.
    #[test]
    fn the_network_section_needs_the_passphrase() {
        let scratch = ScratchDir::new("ce5-network");
        let vault = vault_v3(&scratch, None);
        set_key(&vault, PASSPHRASE, KEY, None, save_to(&vault)).unwrap();
        let before = bytes_of(&vault);
        for typed in [OTHER_KEY, KEY] {
            let error = network_of(&vault, typed, None).unwrap_err();
            assert_eq!(error.code, ErrorCode::WrongPassphrase, "{typed}");
        }
        assert_eq!(
            network_of(&vault, PASSPHRASE, None).unwrap(),
            EmergencyNetwork::None
        );
        assert_eq!(
            serde_json::to_value(EmergencyNetwork::None).unwrap(),
            serde_json::json!({ "action": "none" })
        );
        assert_eq!(bytes_of(&vault), before);
    }
}
