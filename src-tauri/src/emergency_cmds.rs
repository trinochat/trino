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
//!
//! The warning to a trusted contact (CE-6, trino-engine's alert.rs): "Qué
//! pasa en la red" shows what was chosen once the passphrase opened it, and
//! for `SECTION_OPEN_SECS` after, saving needs no passphrase again, so the
//! person can pick a contact and write the message without the code of the
//! authenticator running out. A lock closes it. The contact's side, the
//! question and the warnings that came, is the chats' (`emergency_alerts`,
//! `answer_emergency_alert`).

use crate::command_error::{CommandError, ErrorCode};
use crate::commands::submitted_code;
use crate::passphrase::{check_emergency_key, validate_passphrase};
use crate::security_cmds::{noting, open_any, require_session, run_blocking, write_v3, Resealed};
use crate::state::{vault_path, AppState, InnerState};
use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::State;
use trino_core::vault_v3::OpenVault;
use trino_engine::alert::{self, AlertState, ContactAlerts};
use trino_engine::vault_file::OpenedVault;
use trino_engine::Engine;
use zeroize::Zeroizing;

/// What Trino does on the network when the emergency key is used (design
/// §7, CE-D11): nothing (`{"action":"none"}`), the default, or the warning
/// to a trusted contact, with where its answer stands
/// (`{"action":"alert","contact":…,"state":"waiting"|"accepted"|"declined",
/// "message":…}`). What the emergency path sends lives in the vault's
/// shared block once the contact accepted; who the contact is, in the
/// store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum EmergencyNetwork {
    None,
    Alert {
        contact: String,
        state: AlertState,
        message: String,
    },
}

/// "Qué pasa en la red", open: what is chosen, and the contacts the
/// warning can go to (those whose Trino reads it).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NetworkView {
    #[serde(flatten)]
    pub choice: EmergencyNetwork,
    pub candidates: Vec<String>,
}

/// What "Guardar" saves: nothing, or the warning to `contact`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case", tag = "action")]
pub enum NetworkChoice {
    None,
    Alert { contact: String, message: String },
}

/// How long "Qué pasa en la red" stays open after the passphrase opened it.
pub const SECTION_OPEN_SECS: i64 = 10 * 60;

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
/// and the same write whether there was a key or not. The warning to a
/// trusted contact goes with it, and its contact is told (`withdraw`).
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
    .await?;
    withdraw(&state.engine).await;
    Ok(())
}

/// "Qué pasa en la red" (design §8.1, §8.5): what is chosen, only once the
/// passphrase (and the code, with TOTP on) opened the vault, which opens
/// the section for `SECTION_OPEN_SECS`. Writes nothing.
#[tauri::command]
pub async fn emergency_network(
    state: State<'_, AppState>,
    passphrase: String,
    totp_code: Option<String>,
) -> Result<NetworkView, CommandError> {
    let passphrase = Zeroizing::new(passphrase);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    require_session(&*state.inner.lock().await)?;
    let vault = vault_path();
    run_blocking(move || {
        let code = totp_code.as_deref().map(String::as_str);
        network_of(&vault, &passphrase, code)
    })
    .await?;
    let mut inner = state.inner.lock().await;
    open_section(&mut inner, trino_engine::session::unix_now());
    Ok(view_of(&inner))
}

/// "Guardar" in "Qué pasa en la red": nothing, or the warning to a contact
/// with its message (design §7.2). A contact the warning cannot go to is
/// `not_found`. With the section closed (never opened, more than
/// `SECTION_OPEN_SECS` ago, or a lock since), `wrong_passphrase`: the
/// password is asked again.
#[tauri::command]
pub async fn save_emergency_network(
    state: State<'_, AppState>,
    choice: NetworkChoice,
) -> Result<NetworkView, CommandError> {
    {
        let inner = state.inner.lock().await;
        require_session(&inner)?;
        section_is_open(&inner, trino_engine::session::unix_now())?;
    }
    save(&state.engine, choice).await?;
    Ok(view_of(&*state.inner.lock().await))
}

/// "Qué pasa en la red" again, while the passphrase keeps it open (CE-6b):
/// the view follows the contact's answer (`emergency-alert`) without
/// asking for the passphrase again. Closed, `wrong_passphrase`, and
/// nothing shows. Writes nothing.
#[tauri::command]
pub async fn refresh_emergency_network(
    state: State<'_, AppState>,
) -> Result<NetworkView, CommandError> {
    let inner = state.inner.lock().await;
    require_session(&inner)?;
    refreshed(&inner, trino_engine::session::unix_now())
}

/// The chats (design §7.2, §11.6): the questions of contacts waiting for
/// an answer, and the warnings that came. Not behind the passphrase: they
/// are this account's own chats.
#[tauri::command]
pub async fn emergency_alerts(state: State<'_, AppState>) -> Result<ContactAlerts, CommandError> {
    let inner = state.inner.lock().await;
    require_session(&inner)?;
    Ok(alert::contact_view(&inner))
}

/// "Aceptar" or "No, gracias" to the question of `handle` (CE-D4).
#[tauri::command]
pub async fn answer_emergency_alert(
    state: State<'_, AppState>,
    handle: String,
    accept: bool,
) -> Result<(), CommandError> {
    require_session(&*state.inner.lock().await)?;
    alert::answer(&state.engine, &handle, accept).await
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

/// Whether `passphrase` (and `code`) open the vault at `vault`, which only
/// reads it.
fn network_of(vault: &Path, passphrase: &str, code: Option<&str>) -> Result<(), CommandError> {
    open_any(vault, passphrase, submitted_code(code))?;
    Ok(())
}

/// Open "Qué pasa en la red" from `now` on.
fn open_section(inner: &mut InnerState, now: i64) {
    inner.alert_settings_until = now + SECTION_OPEN_SECS;
}

/// `wrong_passphrase` unless the section is open at `now`.
fn section_is_open(inner: &InnerState, now: i64) -> Result<(), CommandError> {
    if now < inner.alert_settings_until {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::WrongPassphrase,
            "the network section is closed: the passphrase opens it",
        ))
    }
}

/// What the section shows at `now`, if it is open.
fn refreshed(inner: &InnerState, now: i64) -> Result<NetworkView, CommandError> {
    section_is_open(inner, now)?;
    Ok(view_of(inner))
}

/// What the section shows.
fn view_of(inner: &InnerState) -> NetworkView {
    let choice = match alert::own_view(inner) {
        Some(own) => EmergencyNetwork::Alert {
            contact: own.contact,
            state: own.state,
            message: own.message,
        },
        None => EmergencyNetwork::None,
    };
    NetworkView {
        choice,
        candidates: alert::candidates(inner),
    }
}

/// Save `choice` (`alert::choose`).
async fn save(engine: &Engine, choice: NetworkChoice) -> Result<(), CommandError> {
    match choice {
        NetworkChoice::None => alert::choose(engine, None, "").await,
        NetworkChoice::Alert { contact, message } => {
            alert::choose(engine, Some(&contact), &message).await
        }
    }
}

/// "Quitar" (design §8.5): with the key gone, so is the warning, and its
/// contact is told that it no longer holds. As well as it can be: the key
/// is removed either way.
async fn withdraw(engine: &Engine) {
    if alert::choose(engine, None, "").await.is_err() {
        trino_engine::session::dbg_log("the warning could not be withdrawn");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        network_of(&vault, PASSPHRASE, None).unwrap();
        assert_eq!(bytes_of(&vault), before);
    }

    // ---- CE-6: the warning to a trusted contact ----

    fn bob(inner: &mut InnerState, reads_it: bool) -> String {
        let id = create_identity();
        let nostr = hex::encode(id.nostr.pub_bytes);
        inner.friends.insert(
            "Bob".into(),
            trino_engine::state::FriendRecord {
                handle: "Bob".into(),
                bundle: trino_engine::identity::public_bundle_for(&id),
                added_at: 0,
                avatar: None,
                previous_fingerprint: None,
                key_changed_at: None,
                via_group: None,
                accepted_at: Some(0),
                devices: None,
            },
        );
        inner.profiles.contacts.insert(
            "Bob".into(),
            trino_engine::profile::ContactProfile {
                caps: 1,
                alert: u64::from(reads_it),
                ..Default::default()
            },
        );
        nostr
    }

    /// The section shows what is chosen, where its answer stands, and the
    /// contacts the warning can go to.
    #[test]
    fn the_network_section_shows_the_choice_and_who_it_can_go_to() {
        let mut inner = InnerState::default();
        assert_eq!(
            serde_json::to_value(view_of(&inner)).unwrap(),
            serde_json::json!({ "action": "none", "candidates": [] })
        );
        let nostr = bob(&mut inner, true);
        assert_eq!(view_of(&inner).candidates, ["Bob"]);
        inner.alerts.choose(&nostr, "Si no te escribo, ya sabes.");
        assert_eq!(
            serde_json::to_value(view_of(&inner)).unwrap(),
            serde_json::json!({
                "action": "alert",
                "contact": "Bob",
                "state": "waiting",
                "message": "Si no te escribo, ya sabes.",
                "candidates": ["Bob"],
            })
        );
        // A contact whose Trino stopped reading it still shows as chosen,
        // but is not offered again.
        inner.profiles.contacts.get_mut("Bob").unwrap().alert = 0;
        let view = view_of(&inner);
        assert!(view.candidates.is_empty());
        assert!(matches!(view.choice, EmergencyNetwork::Alert { .. }));
    }

    /// "Guardar" needs the section opened with the passphrase, for ten
    /// minutes at most, and a lock closes it.
    #[test]
    fn saving_needs_the_section_opened_with_the_passphrase() {
        let mut inner = InnerState::default();
        let code = |result: Result<(), CommandError>| result.map_err(|error| error.code);
        assert_eq!(
            code(section_is_open(&inner, 1_000)),
            Err(ErrorCode::WrongPassphrase)
        );
        open_section(&mut inner, 1_000);
        assert_eq!(code(section_is_open(&inner, 1_000)), Ok(()));
        assert_eq!(
            code(section_is_open(&inner, 1_000 + SECTION_OPEN_SECS - 1)),
            Ok(())
        );
        assert_eq!(
            code(section_is_open(&inner, 1_000 + SECTION_OPEN_SECS)),
            Err(ErrorCode::WrongPassphrase)
        );
        open_section(&mut inner, 2_000);
        trino_engine::session::forget_session(&mut inner, &Default::default());
        assert_eq!(
            code(section_is_open(&inner, 2_000)),
            Err(ErrorCode::WrongPassphrase)
        );
    }

    /// CE-6b: while the passphrase keeps the section open, it reads again
    /// without it, and shows the contact's answer as it comes; closed (time
    /// or a lock), nothing.
    #[test]
    fn the_open_section_reads_the_answer_again_and_a_closed_one_shows_nothing() {
        let mut inner = InnerState::default();
        let nostr = bob(&mut inner, true);
        inner.alerts.choose(&nostr, "hola");
        let state = |view: NetworkView| match view.choice {
            EmergencyNetwork::Alert { state, .. } => state,
            EmergencyNetwork::None => panic!("nothing chosen"),
        };
        let code = |result: Result<NetworkView, CommandError>| result.map(drop).unwrap_err().code;
        assert_eq!(code(refreshed(&inner, 1_000)), ErrorCode::WrongPassphrase);

        open_section(&mut inner, 1_000);
        assert_eq!(
            state(refreshed(&inner, 1_000).unwrap()),
            AlertState::Waiting
        );
        let id = inner.alerts.mine.as_ref().unwrap().id.clone();
        inner.alerts.on_wire(
            &nostr,
            alert::Wire::Ack {
                id,
                ok: true,
                relays: vec!["wss://bob.example".into()],
            },
        );
        let view = refreshed(&inner, 1_000 + SECTION_OPEN_SECS - 1).unwrap();
        assert_eq!(view.candidates, ["Bob"]);
        assert_eq!(state(view), AlertState::Accepted);

        assert_eq!(
            code(refreshed(&inner, 1_000 + SECTION_OPEN_SECS)),
            ErrorCode::WrongPassphrase
        );
        open_section(&mut inner, 2_000);
        trino_engine::session::forget_session(&mut inner, &Default::default());
        assert_eq!(code(refreshed(&inner, 2_000)), ErrorCode::WrongPassphrase);
    }

    #[test]
    fn a_choice_reads_none_or_a_contact_with_its_message() {
        let none: NetworkChoice = serde_json::from_str(r#"{"action":"none"}"#).unwrap();
        assert_eq!(none, NetworkChoice::None);
        let alert: NetworkChoice =
            serde_json::from_str(r#"{"action":"alert","contact":"Bob","message":"hola"}"#).unwrap();
        assert_eq!(
            alert,
            NetworkChoice::Alert {
                contact: "Bob".into(),
                message: "hola".into()
            }
        );
        assert!(serde_json::from_str::<NetworkChoice>(r#"{"action":"relays"}"#).is_err());
    }

    /// Saving goes through the engine: a contact that does not read the
    /// warning is refused, and "Ninguna" leaves nothing chosen.
    #[tokio::test]
    async fn saving_refuses_a_contact_the_warning_cannot_go_to() {
        let engine = Engine::default();
        {
            let mut inner = engine.inner.lock().await;
            inner.identity = Some(create_identity());
            bob(&mut inner, false);
        }
        let choice = NetworkChoice::Alert {
            contact: "Bob".into(),
            message: String::new(),
        };
        assert_eq!(
            save(&engine, choice).await.unwrap_err().code,
            ErrorCode::NotFound
        );
        save(&engine, NetworkChoice::None).await.unwrap();
        assert!(engine.inner.lock().await.alerts.is_empty());
    }

    /// "Quitar" withdraws the warning once the key is gone, and only then:
    /// a wrong passphrase withdraws nothing.
    #[test]
    fn removing_the_key_withdraws_the_warning_after_the_key_is_gone() {
        let source = include_str!("emergency_cmds.rs").replace("\r\n", "\n");
        let command = &source[source.find("pub async fn remove_emergency_key").unwrap()..];
        let command = &command[..command.find("\n}\n").unwrap()];
        let removed = command.find("remove_key(").expect("the key is removed");
        let withdrawn = command
            .find("withdraw(&state.engine)")
            .expect("the warning is withdrawn");
        assert!(removed < withdrawn);
        assert!(
            command[removed..withdrawn].contains(".await?;"),
            "only once it worked"
        );
    }

    #[tokio::test]
    async fn withdrawing_clears_the_warning() {
        let engine = Engine::default();
        {
            let mut inner = engine.inner.lock().await;
            inner.identity = Some(create_identity());
            let nostr = bob(&mut inner, true);
            inner.alerts.choose(&nostr, "hola");
        }
        withdraw(&engine).await;
        assert!(engine.inner.lock().await.alerts.mine.is_none());
    }
}
