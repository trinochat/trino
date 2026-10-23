//! The emergency path (clave de emergencia CE-4, design §6).
//!
//! The emergency key, typed at the unlock screen with the account's code
//! if it has TOTP, opens the vault's emergency slot (step E0, the same
//! derivation, checks and errors as the passphrase: `vault_file`). With a
//! session open, `account::unseal_in` drops it (E1). Then, here:
//!
//! | Step | What | A cut here leaves |
//! |---|---|---|
//! | E2 | In memory: a new identity, data key and `id_vault`; the empty account's vault (trino-core's `into_empty_account`), with the same salt, parameters and KEK, and what it inherits through the shared block | nothing changed |
//! | E3 | The empty account's store in `store.new/`: its index (noting the vault, its migration and prefs import done, and the name `store/` will go aside under), `account.bin` and `prefs.bin` | the account whole: `store.new/` opens with nothing, and the next unlock removes it in silence (`migrate::settle`) |
//! | E4 | The vault, in two phases (`vault_file::write_with`). **Here the keys of before go** | before its second phase, the account whole; after, the empty account |
//! | E5 | `store/` aside under the name noted in E3, `store.new/` in its place; the vault's temporaries and the files of earlier versions destroyed | the empty account: the next unlock finishes the move (`settle`) |
//! | E6 | The empty account opened as any account (`account::unlock_v3`) | the empty account |
//!
//! From E4 on, the empty account is the one and nothing fails the path:
//! what does not go now goes at the next unlock. Before E4, a failure is
//! the error a real unlock would give it (design §5.3).
//!
//! The path writes no line of the log of its own, nor a notice: its notes
//! are those of a real unlock (RC-03). The store of before is removed in
//! the background after the session opens (B2, `store::cleanup`), and
//! `tor/` is not touched (CE-D8).

use crate::account::{display_handle, DataFiles, Unlocked};
use crate::alert::SharedAlert;
use crate::command_error::CommandError;
use crate::identity::create_identity;
use crate::state::default_relays;
use crate::store::disk::Disk;
use crate::store::envelope::Slot;
use crate::store::files::{Store, StoreError};
use crate::store::index::Legacy;
use crate::store::keys::StoreKeys;
use crate::store::migrate::{destroy_legacy, NEW_STORE_DIR};
use crate::store::session::{other_store_name, vault_header, AccountFile, STORE_DIR};
use crate::vault_file::SharedApp;
use crate::vault_v3::{EmergencyVault, NewAccount, OpenVault};
use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use zeroize::Zeroizing;

/// Steps E2 to E6, once `vault` opened with the emergency key and its code
/// (E0) and no session is open (E1): what `open_session` takes, as from a
/// real unlock, and the warning to a trusted contact to send in B1, if the
/// account chose one and its contact accepted (CE-6). It lives in memory
/// only: nothing on the disk keeps it from here on.
pub fn run<D: Disk + Clone>(
    disk: &D,
    files: &DataFiles,
    vault: EmergencyVault,
    now: i64,
) -> Result<(Unlocked, Option<SharedAlert>), CommandError> {
    let (vault, alert) = take_place(disk, files, vault, now)?;
    // E6: as any account opens; it writes nothing, as the shared block,
    // the TOTP hint and the prekey are as the unlock wants them.
    let unlocked = crate::account::unlock_v3(files, vault, Vec::new(), now)?;
    Ok((unlocked, alert))
}

/// Steps E2 to E5: the empty account takes the place of the account on
/// this device. Its vault, as it is now on the disk, and the warning the
/// account of before would send.
pub(crate) fn take_place<D: Disk + Clone>(
    disk: &D,
    files: &DataFiles,
    vault: EmergencyVault,
    now: i64,
) -> Result<(OpenVault, Option<SharedAlert>), CommandError> {
    // E2, in memory.
    let inherited = SharedApp::from_bytes(vault.shared_app());
    let identity = create_identity();
    let nostr_pub = hex::encode(identity.nostr.pub_bytes);
    let account = AccountFile {
        handle: display_handle(inherited.as_ref().map_or("", |shared| &shared.name)),
        nostr_pub,
        relays: inherited
            .as_ref()
            .map(|shared| shared.relays.clone())
            .filter(|relays| !relays.is_empty())
            .unwrap_or_else(default_relays),
        created_at: inherited.as_ref().map_or(now, |shared| shared.created_at),
        ..AccountFile::default()
    };
    let prefs = inherited
        .as_ref()
        .map(|shared| shared.prefs_for(&account.nostr_pub))
        .unwrap_or_default();
    // B1 (CE-6): what the network action needs is taken from `inherited`
    // here, before the vault of before goes; with no action chosen, none.
    // The empty account's block has none.
    let alert = inherited.as_ref().and_then(|shared| shared.alert.clone());
    let shared = SharedApp::new(&account.handle, account.created_at, &prefs, &account.relays);
    let keys = StoreKeys::generate();
    let record = keys.to_vault_app();
    let new_vault = vault.into_empty_account(&NewAccount {
        identity: &identity,
        app: Some(&record),
        shared_app: &shared.to_bytes(),
        id_vault: *keys.id_vault(),
    })?;
    let aside = other_store_name();

    // E3.
    let io = |error: io::Error| CommandError::io(&error);
    let header = vault_header(new_vault.bytes(), identity.signed_prekey.id);
    write_new_store(disk, &files.home, keys, &account, &prefs, header, &aside).map_err(io)?;

    // E4: the vault of before, and every key in it, goes. If its second
    // phase cannot happen and the vault is untouched, the write is undone
    // and the account is as it was, but for a store.new/ that nothing
    // opens and the next unlock removes.
    crate::vault_file::write_with(disk, &files.vault, new_vault.bytes()).map_err(io)?;

    // E5. What fails here, the next unlock finishes (`settle`): never an
    // error, never a notice.
    let _ = move_in(disk, &files.home, &aside);
    destroy_small(disk, files);
    Ok((new_vault, alert))
}

/// E3: the empty account's store in `home/store.new/`, under `keys`, as a
/// new account's store with its preferences, noted as imported and with
/// nothing to migrate (design §6.4, RC-05), and with the name `store/`
/// goes aside under in E5 (RC-11). On the disk once the vault's first phase
/// is: its write goes through to the disk, and NTFS writes in order.
fn write_new_store<D: Disk + Clone>(
    disk: &D,
    home: &Path,
    keys: StoreKeys,
    account: &AccountFile,
    prefs: &BTreeMap<String, String>,
    vault: Option<crate::store::index::VaultHeader>,
    aside: &str,
) -> io::Result<()> {
    let to_io = |error: StoreError| match error {
        StoreError::Io(error) => error,
        other => io::Error::other(other.to_string()),
    };
    let dir = home.join(NEW_STORE_DIR);
    // A store.new/ left by a cut of an earlier try: nothing opens it.
    disk.remove_dir_all(&dir)?;
    let mut store = Store::create(&dir, keys, disk.clone()).map_err(to_io)?;
    store
        .write(&Slot::Account, &json(account)?)
        .map_err(to_io)?;
    if !prefs.is_empty() {
        store.write(&Slot::Prefs, &json(prefs)?).map_err(to_io)?;
    }
    let legacy = Legacy {
        migrated: true,
        cleanup_pending: false,
        prefs_imported: true,
    };
    store
        .note_new_store(vault, legacy, vec![aside.to_string()])
        .map_err(to_io)?;
    if store.is_behind() {
        return Err(io::Error::other(
            "the new store's index could not be written",
        ));
    }
    Ok(())
}

/// `value` as E3 writes it.
fn json<T: serde::Serialize>(value: &T) -> io::Result<Zeroizing<Vec<u8>>> {
    serde_json::to_vec(value)
        .map(Zeroizing::new)
        .map_err(io::Error::other)
}

/// E5: `store/` aside under `aside`, then `store.new/` in its place, each
/// move on the disk when it returns. An account with no `store/` only
/// moves the new one in.
fn move_in(disk: &impl Disk, home: &Path, aside: &str) -> io::Result<()> {
    let store = home.join(STORE_DIR);
    if store.exists() {
        disk.rename_durable(&store, &home.join(aside))?;
    }
    disk.rename_durable(&home.join(NEW_STORE_DIR), &store)
}

/// E5: the small files of before, which hold something in clear or its
/// remains, destroyed (overwritten, synced and removed) now, so the next
/// start does not offer to import them: the temporaries a cut left of the
/// vault, and the files of earlier versions (`destroy_legacy`), usually
/// none. Not the development log, whose lines are fixed text: removing it
/// only after this path would tell of it (RC-03).
fn destroy_small(disk: &impl Disk, files: &DataFiles) {
    let next = crate::vault_file::next_path(&files.vault);
    for path in crate::fsutil::leftover_temp_files(&files.vault)
        .into_iter()
        .chain(crate::fsutil::leftover_temp_files(&next))
    {
        let _ = disk.destroy(&path);
    }
    let _ = destroy_legacy(disk, &files.home);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{
        create_account_vault, open_session, unlock_files, unlock_or_emergency, unseal_in, Unlocking,
    };
    use crate::command_error::ErrorCode;
    use crate::fsutil::scratch::ScratchDir;
    use crate::group::GroupRoster;
    use crate::identity::Identity;
    use crate::session::tests::friend;
    use crate::state::{HistItem, InnerState};
    use crate::storage::{apply_loaded, import_sticker_into, load_session, persist_account};
    use crate::store::cleanup::Cleanup;
    use crate::store::disk::cut::{CutDisk, Step};
    use crate::store::migrate::NEW_STORE_DIR;
    use crate::store::session::{Found, Storage, StorageCell, OTHER_STORE_PREFIX, STORE_DIR};
    use crate::totp::{generate_totp_secret, totp_code, totp_now};
    use crate::vault_file::next_path;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    const NOW: i64 = 1_760_000_000;
    const PASSPHRASE: &str = "correct horse battery staple";
    const EMERGENCY: &str = "una clave de emergencia distinta";
    const RELAY: &str = "wss://mio.example";
    const BRIDGE: &str = concat!(
        "obfs4 192.0.2.10:443 0123456789ABCDEF0123456789ABCDEF01234567 ",
        "cert=YXJlIGZyZXF1ZW50bHkgZnVsbCBvZiBsaXR0bGUgbWVzc2FnZXMgeW91IGNhbiBmaW5kLg iat-mode=0"
    );

    fn consent(public_key: &str) -> String {
        serde_json::json!({
            "format": 1,
            "acceptedAt": "2026-10-12T15:00:00.000Z",
            "publicKey": public_key,
            "lang": "es",
            "age": { "minimum": 18, "version": 1 },
            "privacyPolicy": { "version": 1, "url": "https://trinochat.org/privacidad/" },
        })
        .to_string()
    }

    /// Ana's account, as she has used it, and what it takes to open it.
    struct Ana {
        files: DataFiles,
        me: Identity,
        secret: Option<Vec<u8>>,
        created_at: i64,
    }

    impl Ana {
        /// Ana's account in `home`, with an emergency key: a contact, a
        /// group, a conversation, a sticker, her own relay, her settings,
        /// her consent and her private bridges.
        fn new(home: &Path, with_totp: bool) -> Ana {
            let files = DataFiles::in_home(home.to_path_buf());
            let secret = with_totp.then(generate_totp_secret);
            let (me, app, mut vault) = create_account_vault(
                &files,
                "Ana",
                PASSPHRASE,
                secret.as_deref(),
                crate::vault_file::write,
            )
            .unwrap();
            vault.set_emergency_key(PASSPHRASE, EMERGENCY).unwrap();
            crate::vault_file::write(&files.vault, vault.bytes()).unwrap();

            let loaded = load_session(&files, &me, Some(&app), None).unwrap();
            let created_at = loaded.account.as_ref().unwrap().created_at;
            let mut inner = InnerState {
                identity: Some(me.clone()),
                ..InnerState::default()
            };
            inner.storage.set(loaded.storage);
            apply_loaded(
                &mut inner,
                loaded.account,
                loaded.history,
                loaded.sessions,
                loaded.profiles,
                NOW,
            );
            let bob = crate::identity::create_identity();
            inner.friends.insert("Bob".into(), friend(&bob, "Bob"));
            inner.groups.insert(
                "g1".into(),
                GroupRoster {
                    group_id: "g1".into(),
                    name: "Grupo".into(),
                    photo: None,
                    admin_pub: "00".into(),
                    members: vec![],
                    epoch: 1,
                    signature: String::new(),
                },
            );
            inner.relay_urls = vec![RELAY.into()];
            persist_account(&inner).unwrap();
            inner.history.insert(
                "Bob".into(),
                vec![HistItem {
                    side: "them".into(),
                    from: None,
                    text: Some("hola Ana".into()),
                    file: None,
                    call: None,
                    ts: 1,
                }],
            );
            crate::session::write_history(&inner).unwrap();
            let prefs: BTreeMap<&str, String> = [
                ("autolock", "15".to_string()),
                ("trino.pref.reinforced", "1".into()),
                ("updates.lastRead", "2026-10-01".into()),
                ("note:Bob", "vecino".into()),
                ("trino.pref.groupMuted:g1", "1".into()),
                ("trino.consent", consent(&hex::encode(me.nostr.pub_bytes))),
                ("net.bridges", BRIDGE.into()),
            ]
            .into_iter()
            .collect();
            assert!(inner
                .storage
                .import_prefs(&serde_json::to_vec(&prefs).unwrap())
                .unwrap());
            import_sticker_into(&inner.storage, b"STICKER IMAGE", "image/png").unwrap();
            drop(inner);
            let ana = Ana {
                files,
                me,
                secret,
                created_at,
            };
            // The next unlock carries the name, the relays and the settings
            // into the shared block, as any unlock does.
            let (_, _, loaded) = ana.unlock(PASSPHRASE).unwrap();
            assert!(loaded.unwrap().report.is_empty());
            ana
        }

        fn code(&self) -> Option<String> {
            self.secret.as_deref().map(totp_now)
        }

        /// Unlock with `passphrase` and a code computed just before; should
        /// the derivation take it past its window, a fresh one gets one more
        /// try (a refused code writes nothing).
        fn unlock(&self, passphrase: &str) -> Result<Unlocked, CommandError> {
            let attempt = || {
                let code = self.code();
                unlock_files(&self.files, passphrase, code.as_deref(), false, NOW)
            };
            match attempt() {
                Err(error) if error.code == ErrorCode::InvalidTotp => attempt(),
                done => done,
            }
        }

        /// Step E0 alone: the emergency key opened, nothing written.
        fn emergency_vault(&self) -> EmergencyVault {
            let attempt = || {
                let code = self.code();
                unlock_or_emergency(&self.files, EMERGENCY, code.as_deref(), false, NOW)
            };
            let opened = match attempt() {
                Err(error) if error.code == ErrorCode::InvalidTotp => attempt(),
                done => done,
            };
            match opened {
                Ok(Unlocking::Emergency(vault)) => *vault,
                Ok(Unlocking::Real(_)) => panic!("the emergency key opened the account"),
                Err(error) => panic!("{error}"),
            }
        }

        fn home(&self) -> &Path {
            &self.files.home
        }
    }

    /// A six-digit code that is valid for `secret` at none of the steps the
    /// check accepts right now.
    fn wrong_code(secret: &[u8]) -> String {
        let now = chrono::Utc::now().timestamp();
        let valid: Vec<String> = [-60, -30, 0, 30, 60]
            .iter()
            .map(|offset| totp_code(secret, (now + offset) as u64, 6, 30))
            .collect();
        ["000000", "111111", "222222", "333333", "444444", "555555"]
            .into_iter()
            .find(|code| !valid.iter().any(|v| v == code))
            .unwrap()
            .to_string()
    }

    /// Every file under `dir`, with what it holds.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.insert(path.clone(), std::fs::read(&path).unwrap());
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(dir, &mut out);
        out
    }

    fn stickers_of(storage: &Storage) -> usize {
        match storage {
            Storage::Store(store) => store.stickers().len(),
            Storage::Legacy(_) => panic!("legacy"),
        }
    }

    fn prefs_imported(storage: &Storage) -> bool {
        match storage {
            Storage::Store(store) => store.prefs_imported(),
            Storage::Legacy(_) => panic!("legacy"),
        }
    }

    /// Design §12.2, tests 25 and 26, and §12.4b, tests 52 and 53 (RC-04,
    /// RC-05, RC-06): the emergency key opens a new, empty account with
    /// Ana's name, date, 2FA, relays, settings, consent and bridges, and
    /// nothing that names anyone.
    #[test]
    fn the_emergency_key_opens_an_empty_account_that_keeps_what_names_nobody() {
        let scratch = ScratchDir::new("emergency-inherits");
        let ana = Ana::new(scratch.path(), true);

        let (identity, totp_secret, loaded) = ana.unlock(EMERGENCY).unwrap();

        let loaded = loaded.unwrap();
        assert_ne!(identity.ik_sign.pub_bytes, ana.me.ik_sign.pub_bytes);
        assert_ne!(identity.nostr.pub_bytes, ana.me.nostr.pub_bytes);
        let new_key = hex::encode(identity.nostr.pub_bytes);
        let account = loaded.account.as_ref().unwrap();
        assert_eq!(account.handle, "Ana");
        assert_eq!(account.created_at, ana.created_at);
        assert_eq!(account.nostr_pub, new_key);
        assert_eq!(account.relays, [RELAY]);
        assert!(account.friends.is_empty() && account.blocked.is_empty());
        assert!(account.groups.is_empty() && account.group_invites.is_empty());
        assert_eq!(account.avatar, None);
        assert!(matches!(loaded.history, Found::Absent));
        assert!(matches!(loaded.sessions, Found::Absent));
        assert!(matches!(loaded.profiles, Found::Absent));
        assert_eq!(stickers_of(&loaded.storage), 0);
        assert_eq!(
            totp_secret.as_deref().map(Vec::as_slice),
            ana.secret.as_deref()
        );
        let prefs = loaded.prefs.as_ref().unwrap();
        assert_eq!(prefs["autolock"], "15");
        assert_eq!(prefs["trino.pref.reinforced"], "1");
        assert_eq!(prefs["updates.lastRead"], "2026-10-01");
        assert!(prefs.get("note:Bob").is_none());
        assert!(prefs.get("trino.pref.groupMuted:g1").is_none());
        let record: serde_json::Value =
            serde_json::from_str(prefs["trino.consent"].as_str().unwrap()).unwrap();
        assert_eq!(record["publicKey"], new_key.as_str());
        assert_eq!(record["acceptedAt"], "2026-10-12T15:00:00.000Z");
        // RC-06: Tor gets the bridges at unlock, as with the real account.
        assert!(crate::bridges::stored_in(loaded.prefs.as_ref()).is_some());
        // RC-05: nothing asks again, and nothing tells of the change.
        assert!(prefs_imported(&loaded.storage));
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert!(loaded.migration.is_none());
        let vault = &loaded.vault.as_ref().unwrap().vault;
        assert_eq!(vault.kit(), None);
        // The store of before is set aside, to go in the background (B2);
        // what is in use says nothing of what Ana had.
        for (path, bytes) in snapshot(&ana.home().join(STORE_DIR)) {
            let text = String::from_utf8_lossy(&bytes);
            assert!(
                !text.contains("Bob") && !text.contains("hola Ana"),
                "{path:?}"
            );
        }
    }

    /// Ana's warning to a trusted contact, accepted by her contact: kept in
    /// her store and, with the next seal, in the vault's shared block.
    fn with_warning(ana: &Ana) -> crate::alert::SharedAlert {
        let (identity, _, loaded) = ana.unlock(PASSPHRASE).unwrap();
        let loaded = loaded.unwrap();
        let mut inner = InnerState {
            identity: Some(identity),
            ..InnerState::default()
        };
        inner.storage.set(loaded.storage);
        if let Some(vault) = loaded.vault {
            inner.vault.set(vault);
        }
        apply_loaded(
            &mut inner,
            loaded.account,
            loaded.history,
            loaded.sessions,
            loaded.profiles,
            NOW,
        );
        inner.alerts.mine = Some(crate::alert::OwnAlert {
            contact: "bb".repeat(32),
            id: "cd".repeat(16),
            key: "ab".repeat(32),
            state: crate::alert::AlertState::Accepted,
            relays: vec!["wss://bob.example".into()],
            message: "Si no te escribo, ya sabes.".into(),
        });
        persist_account(&inner).unwrap();
        inner.alerts.shared().unwrap()
    }

    /// B1 (CE-6, design §6.1 E2 and §7.2): the warning is taken from the
    /// block before the vault of before goes, and only into memory: the
    /// empty account keeps no warning, in its block or its store.
    #[test]
    fn the_emergency_path_takes_the_warning_and_the_empty_account_keeps_none() {
        let scratch = ScratchDir::new("emergency-warning");
        let ana = Ana::new(scratch.path(), true);
        let warning = with_warning(&ana);

        let disk = crate::store::disk::RealDisk;
        let (vault, taken) = take_place(&disk, &ana.files, ana.emergency_vault(), NOW).unwrap();

        assert_eq!(taken, Some(warning.clone()));
        let block = SharedApp::from_bytes(vault.shared_app()).unwrap();
        assert_eq!(block.alert, None);
        // Nothing in the data folder holds the registration's key or id.
        for (path, bytes) in snapshot(ana.home()) {
            for secret in [&warning.k, &warning.id] {
                let text = String::from_utf8_lossy(&bytes);
                assert!(!text.contains(secret.as_str()), "{path:?}");
            }
        }
        let (_, _, loaded) = ana.unlock(EMERGENCY).unwrap();
        let account = loaded.unwrap().account.unwrap();
        assert!(account.alerts.is_empty());
    }

    /// The emergency key typed through `unseal_in`, on an engine whose
    /// network is a fake Tor that is ready: the connections it asked for
    /// within a while, by the kind of their token.
    async fn kinds_after_the_emergency_key(
        ana: &Ana,
        tor: &std::sync::Arc<trino_net::mock::Mock>,
        net: std::sync::Arc<trino_net::Net>,
    ) -> Vec<&'static str> {
        let engine = crate::Engine::with_net(net);
        unseal_in(
            &engine,
            ana.files.clone(),
            |_| {},
            || {},
            EMERGENCY.into(),
            ana.code(),
        )
        .await
        .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        tor.connections()
            .into_iter()
            .map(|(_, iso)| iso.kind().name())
            .collect()
    }

    /// Design §12.3, test 36, and B1 (§6.1, §7.2): with no warning chosen
    /// nothing goes to the network; with one, it goes to the contact's
    /// relay after the answer, through its own tokens.
    #[tokio::test]
    async fn the_emergency_path_sends_the_warning_only_when_there_is_one() {
        use crate::nostr::test_relay::{wait_until, Answer, TestRelay};
        let scratch = ScratchDir::new("emergency-b1");
        let (net, fake, tor) = crate::testing::fake_tor(&scratch.path().join("tor"));
        net.start();
        fake.ready();
        net.ready(std::time::Duration::from_secs(10)).await.unwrap();

        let without = Ana::new(&scratch.path().join("sin"), false);
        let kinds =
            kinds_after_the_emergency_key(&without, &tor, std::sync::Arc::clone(&net)).await;
        assert!(kinds.is_empty(), "{kinds:?}");

        let relay = TestRelay::start_on(&tor, Answer::Accept, false);
        let with = Ana::new(&scratch.path().join("con"), false);
        let mut warning = with_warning(&with);
        // Her contact's relay, reached through this test's Tor.
        warning.relays = vec![relay.url.clone()];
        set_warning_relays(&with, &relay.url);
        let kinds = kinds_after_the_emergency_key(&with, &tor, std::sync::Arc::clone(&net)).await;
        wait_until("the warning", || relay.events().len() == 1).await;
        assert!(
            kinds
                .iter()
                .all(|kind| *kind == crate::alert::ALERT_ISO.name()),
            "{kinds:?}"
        );
        let opened = crate::alert::open(
            &[0xab; 32],
            &[0xcd; 16],
            &relay.events()[0],
            crate::session::unix_now(),
        );
        assert_eq!(opened.unwrap().message, warning.msg);
        net.stop();
    }

    /// CE-8, David's manual test, end to end with the engines and one
    /// simulated relay: Ana (her real store and vault, opened by `unseal_in`
    /// with her relays connected) asks Bob, whose session listens; the
    /// question and the answer go through the relay; Ana locks as the app
    /// does, types the emergency key, and Bob's chat gets the warning.
    #[tokio::test]
    async fn the_warning_reaches_the_contact_end_to_end() {
        use crate::alert::{self, AlertState};
        use crate::events::RecordingSink;
        use crate::nostr::test_relay::{self, wait_until, Answer, TestRelay};
        use crate::session::tests::{add_session_read_by, sending_state};
        use std::sync::Arc;

        let scratch = ScratchDir::new("emergency-e2e");
        let relay = TestRelay::serving(Answer::Accept).await;
        let ana = Ana::new(scratch.path(), false);
        let engine = crate::Engine::with_net(test_relay::net());
        let ana_sink = RecordingSink::new();
        let connect = |engine: &crate::Engine, sink: Arc<RecordingSink>| {
            let (inner, url) = (Arc::clone(&engine.inner), relay.url.clone());
            move |start: crate::account::RelayStart| {
                tokio::spawn(crate::session::connect_relays(
                    sink,
                    Arc::new(|_| {}),
                    inner,
                    test_relay::connector(),
                    crate::nostr::ready_gate(test_relay::net()),
                    test_relay::net(),
                    vec![url],
                    start.nostr_pub,
                    start.handle,
                ));
            }
        };
        unseal_in(
            &engine,
            ana.files.clone(),
            connect(&engine, ana_sink.clone()),
            || {},
            PASSPHRASE.into(),
            None,
        )
        .await
        .unwrap();

        // Bob, a contact whose Trino reads the warning, with his session
        // open and listening on the same relay.
        let bob = crate::identity::create_identity();
        let bob_engine = sending_state(&bob, vec![]).await;
        let bob_sink = RecordingSink::new();
        {
            let mut a = engine.inner.lock().await;
            let mut b = bob_engine.inner.lock().await;
            let me = a.identity.clone().unwrap();
            let (ratchet, ad) = add_session_read_by(&mut a, &me, &bob, "Bob");
            a.profiles.contacts.insert(
                "Bob".into(),
                crate::profile::ContactProfile {
                    caps: 1,
                    alert: alert::ALERT_V,
                    ..Default::default()
                },
            );
            persist_account(&a).unwrap();
            b.handle = Some("Bob".into());
            b.relay_urls = vec![relay.url.clone()];
            b.friends.insert("Ana".into(), friend(&me, "Ana"));
            b.ratchets.insert("Ana".into(), ratchet);
            b.associated_data.insert("Ana".into(), ad);
        }
        crate::session::connect_relays(
            bob_sink.clone(),
            Arc::new(|_| {}),
            Arc::clone(&bob_engine.inner),
            test_relay::connector(),
            crate::nostr::ready_gate(test_relay::net()),
            test_relay::net(),
            vec![relay.url.clone()],
            hex::encode(bob.nostr.pub_bytes),
            "Bob".into(),
        )
        .await;
        wait_until("both sessions on the relay", || relay.reqs().len() >= 2).await;

        // Ana asks; Bob's Trino asks him, and he accepts.
        alert::choose(&engine, Some("Bob"), "ya sabes")
            .await
            .unwrap();
        let asked = || bob_sink.names().contains(&alert::ALERT_EVENT.to_string());
        wait_until("Bob's question", asked).await;
        alert::answer(&bob_engine, "Ana", true).await.unwrap();
        let answered = || ana_sink.names().contains(&alert::ALERT_EVENT.to_string());
        wait_until("Ana's answer", answered).await;
        assert_eq!(
            alert::own_view(&*engine.inner.lock().await).unwrap().state,
            AlertState::Accepted
        );

        // Ana locks as the app does, and types her emergency key.
        {
            let _gate = engine.session_gate.lock().await;
            let mut inner = engine.inner.lock().await;
            inner.storage.flush_for_lock();
            crate::session::forget_session(&mut inner, &engine.turn);
        }
        unseal_in(
            &engine,
            ana.files.clone(),
            connect(&engine, RecordingSink::new()),
            || {},
            EMERGENCY.into(),
            None,
        )
        .await
        .unwrap();

        let warned = || {
            bob_sink
                .events()
                .iter()
                .any(|(name, json)| name == alert::ALERT_EVENT && json.contains("warned"))
        };
        wait_until("the warning in Bob's chat", warned).await;
        let view = alert::contact_view(&*bob_engine.inner.lock().await);
        assert_eq!(view.warnings[0].message, "ya sabes");
    }

    /// Point the accepted warning of Ana's store, and of her vault's block,
    /// at `relay`.
    fn set_warning_relays(ana: &Ana, relay: &str) {
        let (identity, _, loaded) = ana.unlock(PASSPHRASE).unwrap();
        let loaded = loaded.unwrap();
        let mut inner = InnerState {
            identity: Some(identity),
            ..InnerState::default()
        };
        inner.storage.set(loaded.storage);
        if let Some(vault) = loaded.vault {
            inner.vault.set(vault);
        }
        apply_loaded(
            &mut inner,
            loaded.account,
            loaded.history,
            loaded.sessions,
            loaded.profiles,
            NOW,
        );
        inner.alerts.mine.as_mut().unwrap().relays = vec![relay.to_string()];
        persist_account(&inner).unwrap();
    }

    /// Design §12.2, tests 33 and 34, and §4 (K2FA): the emergency key asks
    /// for the same code; without it, or with a wrong one, it answers as the
    /// passphrase does and nothing on the disk changes, however many times.
    #[test]
    fn the_emergency_key_with_no_code_or_a_wrong_one_changes_nothing() {
        let scratch = ScratchDir::new("emergency-wrong-code");
        let ana = Ana::new(scratch.path(), true);
        let secret = ana.secret.clone().unwrap();
        let before = snapshot(ana.home());
        let fails = |passphrase: &str, code: Option<&str>| {
            unlock_files(&ana.files, passphrase, code, false, NOW)
                .map(drop)
                .unwrap_err()
                .code
        };

        for _ in 0..3 {
            assert_eq!(fails(EMERGENCY, None), ErrorCode::TotpRequired);
            assert_eq!(fails(PASSPHRASE, None), ErrorCode::TotpRequired);
            let wrong = wrong_code(&secret);
            assert_eq!(fails(EMERGENCY, Some(&wrong)), ErrorCode::InvalidTotp);
            assert_eq!(fails(PASSPHRASE, Some(&wrong)), ErrorCode::InvalidTotp);
            let code = totp_now(&secret);
            assert_eq!(
                fails("otra frase cualquiera", Some(&code)),
                ErrorCode::WrongPassphrase
            );
        }

        assert_eq!(snapshot(ana.home()), before, "a failed unlock wrote");
    }

    /// Design §12.2, test 27, and the CE-D12 addendum (§3.8.5, test 63):
    /// afterwards, the emergency key and Ana's passphrase both open the same
    /// empty account, with the same 2FA; any other passphrase opens nothing.
    #[test]
    fn either_key_opens_the_same_empty_account_afterwards() {
        let scratch = ScratchDir::new("emergency-again");
        let ana = Ana::new(scratch.path(), true);
        let (empty, _, loaded) = ana.unlock(EMERGENCY).unwrap();
        drop(loaded);

        for passphrase in [EMERGENCY, PASSPHRASE] {
            let (again, _, loaded) = ana.unlock(passphrase).unwrap();
            assert_eq!(again.ik_sign.pub_bytes, empty.ik_sign.pub_bytes);
            let loaded = loaded.unwrap();
            assert!(loaded.report.is_empty(), "{:?}", loaded.report);
            assert_eq!(loaded.account.unwrap().handle, "Ana");
            let missing = unlock_files(&ana.files, passphrase, None, false, NOW)
                .map(drop)
                .unwrap_err();
            assert_eq!(missing.code, ErrorCode::TotpRequired);
        }
        let code = ana.code();
        let wrong = unlock_files(
            &ana.files,
            "otra frase cualquiera",
            code.as_deref(),
            false,
            NOW,
        )
        .map(drop)
        .unwrap_err();
        assert_eq!(wrong.code, ErrorCode::WrongPassphrase);
    }

    /// The settings never take the emergency key: it works only at the
    /// unlock screen (design §10), and there it is a wrong passphrase.
    #[test]
    fn the_settings_take_the_emergency_key_for_a_wrong_passphrase() {
        let scratch = ScratchDir::new("emergency-settings");
        let ana = Ana::new(scratch.path(), false);
        let before = snapshot(ana.home());

        let error = crate::account::open_vault(&ana.files.vault, EMERGENCY, None)
            .map(drop)
            .unwrap_err();

        assert_eq!(error.code, ErrorCode::WrongPassphrase);
        assert_eq!(snapshot(ana.home()), before);
    }

    /// The steps of the path on the disk, in order.
    fn steps_of(disk: &CutDisk) -> Vec<Step> {
        disk.steps.borrow().clone()
    }

    fn touches(step: &Step, dir: &Path) -> bool {
        match step {
            Step::Write(path)
            | Step::WriteDurable(path)
            | Step::Remove(path)
            | Step::Overwrite(path)
            | Step::Destroy(path)
            | Step::RemoveDir(path) => path.starts_with(dir),
            Step::Rename(from, to) | Step::RenameDurable(from, to) => {
                from.starts_with(dir) || to.starts_with(dir)
            }
        }
    }

    /// Design §12.2, test 21, and §6.1: the empty account's store is
    /// written in store.new/ first; the vault changes next, in two phases;
    /// only then does store/ go aside and store.new/ take its place. The
    /// first change on the disk that touches anything of Ana's is the
    /// vault's.
    #[test]
    fn the_emergency_path_writes_store_new_before_the_vault_and_moves_it_after() {
        let scratch = ScratchDir::new("emergency-order");
        let ana = Ana::new(scratch.path(), false);
        let home = ana.home().to_path_buf();
        let (store, new) = (home.join(STORE_DIR), home.join(NEW_STORE_DIR));
        let disk = CutDisk::whole();

        take_place(&disk, &ana.files, ana.emergency_vault(), NOW).unwrap();

        let steps = steps_of(&disk);
        let at = |wanted: &Step| steps.iter().position(|step| step == wanted).unwrap();
        let vault = ana.files.vault.clone();
        let next = at(&Step::WriteDurable(next_path(&vault)));
        let overwrite = at(&Step::Overwrite(vault.clone()));
        let destroyed = at(&Step::Destroy(next_path(&vault)));
        let aside = steps
            .iter()
            .find_map(|step| match step {
                Step::RenameDurable(from, to) if *from == store => Some(to.clone()),
                _ => None,
            })
            .expect("store/ went aside");
        let moved_aside = at(&Step::RenameDurable(store.clone(), aside.clone()));
        let moved_in = at(&Step::RenameDurable(new.clone(), store.clone()));
        assert!(next < overwrite && overwrite < destroyed);
        assert!(destroyed < moved_aside && moved_aside < moved_in);
        assert!(
            steps[..next].iter().all(|step| touches(step, &new)),
            "{steps:?}"
        );
        assert!(steps[..next]
            .iter()
            .any(|step| matches!(step, Step::Write(_))));
        assert!(!steps[..overwrite].iter().any(|step| touches(step, &store)));
        let name = aside.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(OTHER_STORE_PREFIX), "{name}");
        assert!(!new.exists());
        assert!(aside.exists() && store.exists());
    }

    /// What the account in `home` is after a cut and the next unlock with
    /// `passphrase`: whose it is, and that it shows no notice.
    fn check_after_cut(ana: &Ana, passphrase: &str, context: &str) -> Identity {
        let (identity, _, loaded) = ana
            .unlock(passphrase)
            .unwrap_or_else(|error| panic!("{passphrase}: {error}"));
        let loaded = loaded.unwrap();
        // Design §12.2, test 23 (CL tests 71 and 72): no "Algunos archivos
        // de Trino cambiaron", no "No encontramos tus datos".
        assert!(loaded.report.is_empty(), "{context}: {:?}", loaded.report);
        assert!(loaded.migration.is_none());
        let account = loaded.account.unwrap();
        assert_eq!(account.handle, "Ana");
        let real = identity.ik_sign.pub_bytes == ana.me.ik_sign.pub_bytes;
        // Design §12.2, test 24: before the vault step, Ana's account is
        // whole.
        assert_eq!(account.friends.len(), usize::from(real), "real: {real}");
        assert!(!ana.home().join(NEW_STORE_DIR).exists());
        identity
    }

    /// Design §12.2, tests 22, 23 and 24: a cut at any step of the path, with
    /// what the disk had not made durable lost or not, never leaves the
    /// computer without a vault. Before the vault step, Ana's passphrase
    /// opens her account whole and the emergency key runs the path again;
    /// after it, both open the empty account. No notice either way.
    #[test]
    fn a_cut_at_every_step_of_the_emergency_path_never_leaves_no_vault() {
        let total = {
            let scratch = ScratchDir::new("emergency-cut-count");
            let ana = Ana::new(scratch.path(), false);
            let disk = CutDisk::whole();
            take_place(&disk, &ana.files, ana.emergency_vault(), NOW).unwrap();
            steps_of(&disk).len()
        };
        for at in 0..=total {
            for lose in [false, true] {
                for passphrase in [PASSPHRASE, EMERGENCY] {
                    let scratch = ScratchDir::new("emergency-cut");
                    let ana = Ana::new(scratch.path(), false);
                    let disk = CutDisk::cut_at(at);

                    let done = take_place(&disk, &ana.files, ana.emergency_vault(), NOW);
                    let committed =
                        steps_of(&disk).contains(&Step::Overwrite(ana.files.vault.clone()));
                    // Once the vault is written, nothing fails the path; the
                    // power is off, and nothing more happens either way.
                    assert_eq!(done.is_ok(), committed, "cut at {at}");
                    if lose {
                        disk.lose_last(disk.unflushed());
                    }

                    assert!(ana.files.vault.exists());
                    let context = format!("cut at {at}, lost {lose}, {passphrase}");
                    let identity = check_after_cut(&ana, passphrase, &context);
                    let real = identity.ik_sign.pub_bytes == ana.me.ik_sign.pub_bytes;
                    assert_eq!(
                        real,
                        !committed && passphrase == PASSPHRASE,
                        "cut at {at}, lost {lose}, {passphrase}"
                    );
                    // And the other key, after.
                    let other = if passphrase == PASSPHRASE {
                        EMERGENCY
                    } else {
                        PASSPHRASE
                    };
                    let after = check_after_cut(&ana, other, &format!("{context}, then"));
                    if !real {
                        assert_eq!(after.ik_sign.pub_bytes, identity.ik_sign.pub_bytes);
                    }
                }
            }
        }
    }

    /// A vault the vault step tore (design §3.6): the empty account waits
    /// whole in vault.bin.next, and either key opens it from there.
    #[test]
    fn a_vault_torn_in_the_vault_step_opens_the_empty_account_with_either_key() {
        for passphrase in [PASSPHRASE, EMERGENCY] {
            for first_half_new in [true, false] {
                let scratch = ScratchDir::new("emergency-torn");
                let ana = Ana::new(scratch.path(), false);
                let old = std::fs::read(&ana.files.vault).unwrap();
                let overwrite = {
                    let probe = ScratchDir::new("emergency-torn-probe");
                    let other = Ana::new(probe.path(), false);
                    let disk = CutDisk::whole();
                    take_place(&disk, &other.files, other.emergency_vault(), NOW).unwrap();
                    let vault = other.files.vault.clone();
                    steps_of(&disk)
                        .iter()
                        .position(|step| *step == Step::Overwrite(vault.clone()))
                        .unwrap()
                };
                let disk = CutDisk::cut_at(overwrite);
                assert!(take_place(&disk, &ana.files, ana.emergency_vault(), NOW).is_err());
                let new = std::fs::read(next_path(&ana.files.vault)).unwrap();
                let torn = if first_half_new {
                    [&new[..4096], &old[4096..]].concat()
                } else {
                    [&old[..4096], &new[4096..]].concat()
                };
                std::fs::write(&ana.files.vault, &torn).unwrap();

                let identity = check_after_cut(&ana, passphrase, "torn");

                assert_ne!(identity.ik_sign.pub_bytes, ana.me.ik_sign.pub_bytes);
                assert_eq!(std::fs::read(&ana.files.vault).unwrap(), new);
                assert!(!next_path(&ana.files.vault).exists());
            }
        }
    }

    /// Design §12.2, test 30, and CE-D8: tor/ is the device's, and the path
    /// does not touch it.
    #[test]
    fn the_emergency_path_leaves_tor_untouched() {
        let scratch = ScratchDir::new("emergency-tor");
        let ana = Ana::new(scratch.path(), false);
        let tor = ana.home().join(crate::state::TOR_DIR);
        std::fs::create_dir_all(tor.join("state")).unwrap();
        std::fs::write(tor.join("settings.json"), b"{\"transport\":\"direct\"}").unwrap();
        std::fs::write(tor.join("state").join("guard"), b"the guard").unwrap();
        let before = snapshot(&tor);

        drop(ana.unlock(EMERGENCY).unwrap());

        assert_eq!(snapshot(&tor), before);
    }

    /// Design §12.4b, test 51 (RC-03): a development build's log gets the
    /// same lines from the emergency path as from a real unlock, in the
    /// same order, and none of its own.
    #[test]
    fn the_emergency_path_leaves_the_same_dev_log_notes_as_a_real_unlock() {
        let scratch = ScratchDir::new("emergency-notes");
        let ana = Ana::new(scratch.path(), false);

        let (real, real_lines) = crate::diag::capture::lines(|| ana.unlock(PASSPHRASE));
        drop(real.unwrap());
        let (empty, emergency_lines) = crate::diag::capture::lines(|| ana.unlock(EMERGENCY));
        let (identity, _, _) = empty.unwrap();
        assert_ne!(identity.ik_sign.pub_bytes, ana.me.ik_sign.pub_bytes);
        let (again, again_lines) = crate::diag::capture::lines(|| ana.unlock(PASSPHRASE));
        drop(again.unwrap());

        assert_eq!(emergency_lines, real_lines);
        assert_eq!(again_lines, real_lines);
        let path = include_str!("emergency.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for call in ["note(", "note_with(", "dbg_log("] {
            assert!(!path.contains(call), "the path logs with {call}");
        }
    }

    /// Design §12.2, test 29, and step E1: with Ana's session open, the
    /// emergency key drops it and opens the empty account's, and the answer
    /// has the very form of a real unlock's: relays started, the
    /// preferences, their import done, no notice and no note.
    #[tokio::test]
    async fn the_emergency_path_answers_like_unseal_and_drops_an_open_session() {
        let scratch = ScratchDir::new("emergency-unseal");
        let ana = Ana::new(scratch.path(), false);
        let engine = crate::Engine::default();
        let mut starts = Vec::new();

        let real = unseal_in(
            &engine,
            ana.files.clone(),
            |start| starts.push((start.relays, start.bridges.is_some())),
            || {},
            PASSPHRASE.into(),
            None,
        )
        .await
        .unwrap();
        let empty = unseal_in(
            &engine,
            ana.files.clone(),
            |start| starts.push((start.relays, start.bridges.is_some())),
            || {},
            EMERGENCY.into(),
            None,
        )
        .await
        .unwrap();

        assert_ne!(empty.fingerprint, real.fingerprint);
        assert_eq!(empty.handle, real.handle);
        assert!(real.relay_connection_started && empty.relay_connection_started);
        let form = |response: &crate::account::UnsealResponse| {
            let json = serde_json::to_value(response).unwrap();
            let mut keys: Vec<String> = json.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            (keys, json["prefs_import"].clone())
        };
        assert_eq!(form(&empty), form(&real));
        assert_eq!(form(&empty).1, "done");
        let start = (vec![RELAY.to_string()], true);
        assert_eq!(starts, [start.clone(), start]);
        let inner = engine.inner.lock().await;
        let open = inner.identity.as_ref().unwrap();
        assert_ne!(open.ik_sign.pub_bytes, ana.me.ik_sign.pub_bytes);
        assert!(inner.friends.is_empty() && inner.history.is_empty());
    }

    /// `open_session` takes what the emergency path loaded as it takes what
    /// a real unlock did.
    #[tokio::test]
    async fn open_session_takes_the_empty_account_as_any_other() {
        let scratch = ScratchDir::new("emergency-open-session");
        let ana = Ana::new(scratch.path(), false);
        let (identity, totp_secret, loaded) = ana.unlock(EMERGENCY).unwrap();
        let inner = tokio::sync::Mutex::new(InnerState::default());

        let opened = open_session(&inner, identity, totp_secret, loaded, |_| {})
            .await
            .unwrap();

        assert!(opened.integrity.is_none() && opened.migration.is_none());
        assert_eq!(opened.handle, "Ana");
        assert_eq!(inner.lock().await.relay_urls, [RELAY]);
    }

    fn aside_stores(home: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(home)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(OTHER_STORE_PREFIX))
            .collect();
        names.sort();
        names
    }

    /// Design §12.4b, test 56 (RC-11), and §12.2, test 31: the store of
    /// before is noted by its name, and only it goes, in the background; a
    /// store CL set aside stays. The small files of before (a temporary of
    /// the vault, a file of an earlier version) are destroyed before the
    /// account opens, so nothing offers them.
    #[test]
    fn the_old_store_goes_by_its_noted_name_and_other_aside_stores_stay() {
        let scratch = ScratchDir::new("emergency-cleanup");
        let ana = Ana::new(scratch.path(), false);
        let home = ana.home().to_path_buf();
        let kept_by_cl = home.join("store-aside-000000000000000000000001");
        std::fs::create_dir_all(&kept_by_cl).unwrap();
        std::fs::write(kept_by_cl.join("index.bin"), b"a store of before").unwrap();
        let plain = home.join("config.json");
        std::fs::write(&plain, br#"{"handle":"Ana","relays":[]}"#).unwrap();
        let temporary = home.join(".vault.bin.tmp-1-2-3");
        std::fs::write(&temporary, b"half a vault").unwrap();

        let (_, _, loaded) = ana.unlock(EMERGENCY).unwrap();

        let loaded = loaded.unwrap();
        assert!(loaded.report.is_empty(), "{:?}", loaded.report);
        assert!(!plain.exists() && !temporary.exists());
        let noted = loaded.deleting_stores.clone();
        assert_eq!(noted.len(), 1);
        assert!(home.join(&noted[0]).is_dir());
        assert_eq!(aside_stores(&home).len(), 2);
        let cell = StorageCell::default();
        cell.set(loaded.storage);

        Cleanup {
            home: home.clone(),
            stores: noted.clone(),
        }
        .run(&cell);

        assert!(!home.join(&noted[0]).exists());
        assert_eq!(
            aside_stores(&home),
            ["store-aside-000000000000000000000001"]
        );
        drop(cell);
        let (_, _, again) = ana.unlock(PASSPHRASE).unwrap();
        assert!(again.unwrap().deleting_stores.is_empty(), "still noted");
    }

    /// Design §12.2, test 32: while a file of the old store cannot go, the
    /// note stays, and the next unlock tries again.
    #[test]
    fn the_old_store_stays_noted_until_it_is_gone() {
        let scratch = ScratchDir::new("emergency-cleanup-held");
        let ana = Ana::new(scratch.path(), false);
        let home = ana.home().to_path_buf();
        let (_, _, loaded) = ana.unlock(EMERGENCY).unwrap();
        let loaded = loaded.unwrap();
        let noted = loaded.deleting_stores.clone();
        assert_eq!(noted.len(), 1);
        let cell = StorageCell::default();
        cell.set(loaded.storage);

        Cleanup {
            home: home.clone(),
            stores: noted.clone(),
        }
        .run_with(
            &cell,
            &mut |_| Err(std::io::Error::other("held")),
            &mut || {},
        );
        drop(cell);

        assert!(home.join(&noted[0]).exists());
        let (_, _, again) = ana.unlock(EMERGENCY).unwrap();
        assert_eq!(again.unwrap().deleting_stores, noted);
    }

    /// Steps B2 and B3, after the answer: the old store goes in the
    /// background, and the host clears what the WebView kept (traces), only
    /// after the emergency path. B1, the network action, hooks here too
    /// (CE-6); with none chosen nothing goes out.
    #[tokio::test]
    async fn after_the_answer_the_old_store_goes_and_the_host_clears_its_traces() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let scratch = ScratchDir::new("emergency-background");
        let ana = Ana::new(scratch.path(), false);
        let engine = crate::Engine::default();
        let cleared = std::sync::Arc::new(AtomicUsize::new(0));
        let unseal = |passphrase: &str| {
            let cleared = std::sync::Arc::clone(&cleared);
            unseal_in(
                &engine,
                ana.files.clone(),
                |_| {},
                move || {
                    cleared.fetch_add(1, Ordering::SeqCst);
                },
                passphrase.to_string(),
                None,
            )
        };

        unseal(PASSPHRASE).await.unwrap();
        assert_eq!(cleared.load(Ordering::SeqCst), 0);
        unseal(EMERGENCY).await.unwrap();
        assert_eq!(cleared.load(Ordering::SeqCst), 1);

        let home = ana.home().to_path_buf();
        let gone = tokio::time::timeout(std::time::Duration::from_secs(20), async {
            while !aside_stores(&home).is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await;
        assert!(gone.is_ok(), "the old store is still there");
    }

    // ---- Design §6.3 and §12.5: the time of the two paths (CE-8) ----

    /// Ana's account with `messages` messages in its history, as she would
    /// have it after a while.
    fn with_history(ana: &Ana, messages: usize) {
        let (identity, _, loaded) = ana.unlock(PASSPHRASE).unwrap();
        let loaded = loaded.unwrap();
        let mut inner = InnerState {
            identity: Some(identity),
            ..InnerState::default()
        };
        inner.storage.set(loaded.storage);
        let items = (0..messages)
            .map(|i| HistItem {
                side: if i % 2 == 0 { "them" } else { "me" }.into(),
                from: None,
                text: Some(format!(
                    "mensaje número {i}, con algo de texto como cualquiera"
                )),
                file: None,
                call: None,
                ts: i as i64,
            })
            .collect();
        inner.history.insert("Bob".into(), items);
        crate::session::write_history(&inner).unwrap();
    }

    /// The median and the 90th percentile of `times`, in milliseconds.
    fn median_and_p90(times: &mut [std::time::Duration]) -> (f64, f64) {
        times.sort();
        let ms = |at: usize| times[at.min(times.len() - 1)].as_secs_f64() * 1000.0;
        (ms(times.len() / 2), ms(times.len() * 9 / 10))
    }

    /// Design §6.3 and §12.5 (CE-D9: measure first; nothing is evened out
    /// yet): how long each path takes to open the account, a real unlock
    /// against the emergency path, with a small and a large history.
    ///
    /// Not part of the suite. Run it with
    /// `cargo test -p trino-engine --lib -- --ignored measure_the_two_paths --nocapture`,
    /// with `TMP` (or `TMPDIR`) on the disk to measure: an SSD, a hard disk,
    /// and `TRINO_MEASURE_RUNS` for the runs of each path (15 if unset).
    /// The tests' KDF is cheap, and the same in both paths, as Argon2id is
    /// (one derivation each, with the same parameters): what this compares
    /// is what comes after it, in the test profile (`test-kdf` refuses a
    /// release build), so the times are higher than a release's and only
    /// the difference counts. Built in release without `test-kdf` (CE-8
    /// does it in a copy of the tree), it measures Argon2id too.
    #[test]
    #[ignore = "a measurement for CE-8, not a check"]
    fn measure_the_two_paths() {
        let runs: usize = std::env::var("TRINO_MEASURE_RUNS")
            .ok()
            .and_then(|runs| runs.parse().ok())
            .filter(|&runs| runs > 0)
            .unwrap_or(15);
        println!(
            "design §6.3: {runs} runs each, in {}",
            std::env::temp_dir().display()
        );
        for messages in [10, 5_000] {
            let (mut real, mut emergency) = (Vec::new(), Vec::new());
            for _ in 0..runs {
                let scratch = ScratchDir::new("emergency-measure");
                let ana = Ana::new(scratch.path(), false);
                with_history(&ana, messages);

                let started = std::time::Instant::now();
                drop(ana.unlock(PASSPHRASE).unwrap());
                real.push(started.elapsed());
                let started = std::time::Instant::now();
                drop(ana.unlock(EMERGENCY).unwrap());
                emergency.push(started.elapsed());
            }
            let (real_median, real_p90) = median_and_p90(&mut real);
            let (emergency_median, emergency_p90) = median_and_p90(&mut emergency);
            println!(
                "history of {messages:>5} messages: real {real_median:7.1} ms (p90 {real_p90:7.1}), \
                 emergency {emergency_median:7.1} ms (p90 {emergency_p90:7.1}), \
                 difference of the medians {:+7.1} ms",
                emergency_median - real_median
            );
        }
    }
}
