//! The account's preferences in the store (cifrado local CL-2a, design §5.3
//! and §12.5): notes, verified marks, timers, muted groups, recent stickers,
//! the consent record and the other settings of the account, sealed in
//! `prefs.bin` instead of the WebView's localStorage.
//!
//! - The unlock answer carries them (`UnsealResponse::prefs`), so the
//!   frontend has them before the chats show, and says where their one
//!   import stands (`UnsealResponse::prefs_import`).
//! - `prefs_save` keeps the frontend's copy, every change batched.
//! - `prefs_import` takes, once, what this device kept for the account
//!   before the store, and only what is this account's: the entries of its
//!   contacts and groups, its own consent record, and the general settings.
//!   The file and the note that the import is done go out in one index
//!   write, so the frontend removes its copy only when the store has both.
//! - An account that has not moved to the store yet (`Storage::Legacy`) has
//!   nowhere sealed to keep them: both commands refuse with a clear error,
//!   and the frontend keeps them where earlier versions did until a later
//!   unlock moves the account.
//! - A few entries are the backend's own (`BACKEND_PREFS`): the private
//!   bridge lines (Tor design §2.5, bridges_cmds.rs). They are sealed in
//!   the same `prefs.bin`, but the frontend never gets them, and what it
//!   saves never changes or drops them.
//! - A few are retired (`RETIRED_PREFS`): the news' old `minSeq`, which the
//!   unlock takes into tor/seen.json (news_cmds.rs). The frontend never
//!   gets them, and the next save drops them.
//!
//! The engine's since M4-0c; the three commands stay in the app's
//! prefs_cmds.rs.

use crate::command_error::CommandError;
use crate::contacts::sealed;
use crate::session::dbg_log;
use crate::state::InnerState;
use crate::store::session::{PrefsImport, NOT_MOVED};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use zeroize::Zeroizing;

/// The key of the private lines in `prefs.bin` (bridges.rs).
pub const NET_BRIDGES: &str = "net.bridges";

/// The entry of `prefs.bin` that holds "No volver a preguntar" (the app's
/// links_cmds.rs).
pub const LINKS_NO_ASK: &str = "net.linksNoAsk";

/// The preference where the WebView kept the highest `seq` before (the
/// app's news_cmds.rs).
pub const OLD_MIN_SEQ: &str = "trino:announcements:minSeq";

/// The account's old `minSeq`, if `prefs` (the store's preferences, every
/// entry) has one that is a number.
pub fn old_min_seq(prefs: Option<&serde_json::Value>) -> Option<u64> {
    prefs?.get(OLD_MIN_SEQ)?.as_str()?.trim().parse().ok()
}

/// The most the preferences may take, serialized: far more than the notes
/// and settings of any account, and a bound on what the frontend can make
/// the store seal.
pub const MAX_PREFS_BYTES: usize = 1024 * 1024;

/// Settings of the screen before unlocking, kept in the WebView with the
/// appearance and never imported (design §2 and §5.3): Terminal's scan
/// lines, the text size of before the accessibility settings, and keeping
/// the window out of captures (SC-1), applied as the app starts.
pub const DEVICE_PREFS: [&str; 3] = [
    "trino.pref.scanLines",
    "trino.pref.textSize",
    "trino.pref.blockCaptures",
];

/// The entries of `prefs.bin` only the backend writes: never handed to the
/// frontend, never taken from it. The private bridge lines, and "No volver
/// a preguntar" before opening a link (links_cmds.rs).
pub const BACKEND_PREFS: [&str; 2] = [NET_BRIDGES, LINKS_NO_ASK];

/// Entries no one uses any more: the unlock takes what they held
/// elsewhere, the frontend never gets them, and the next save drops them.
/// The news' old `minSeq`, now in tor/seen.json (Tor design §7).
pub const RETIRED_PREFS: [&str; 1] = [OLD_MIN_SEQ];

/// `prefs` without the backend's own entries or the retired ones, as the
/// frontend gets them.
pub fn for_frontend(prefs: Option<serde_json::Value>) -> Option<serde_json::Value> {
    prefs.map(|mut prefs| {
        if let Some(entries) = prefs.as_object_mut() {
            for key in BACKEND_PREFS.iter().chain(&RETIRED_PREFS) {
                entries.remove(*key);
            }
        }
        prefs
    })
}

/// What `prefs_import` did.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct PrefsImported {
    /// The entries that are this account's, as they were sent: the
    /// frontend adds them under its copy, and removes them from the WebView
    /// once `saved`.
    pub taken: BTreeMap<String, String>,
    /// Whether the store has them, with the note that the import is done.
    /// False while something waits for the user's choice, or the index
    /// cannot be written now: the next unlock imports again.
    pub saved: bool,
    /// How many notes it took, for the one note after the migration
    /// (design §11.5).
    pub notes: usize,
}

/// Whether the entry `key` = `value` this device kept before the store is
/// this account's (design §5.3 and §5.6): an entry of one of its contacts
/// or groups, its own consent record, or one of the general settings.
pub fn is_this_accounts(
    key: &str,
    value: &str,
    contacts: &BTreeSet<String>,
    groups: &BTreeSet<String>,
    nostr_pub: &str,
) -> bool {
    let contact = |handle: &str| contacts.contains(handle);
    let group = |gid: &str| groups.contains(gid);
    if let Some(handle) = key
        .strip_prefix("note:")
        .or_else(|| key.strip_prefix("verified:"))
    {
        return contact(handle);
    }
    if let Some(convo) = key.strip_prefix("ttl:") {
        // A conversation's key: the contact's name, or `grp:<gid>`.
        return convo.strip_prefix("grp:").map_or(contact(convo), group);
    }
    if let Some(gid) = key.strip_prefix("trino.pref.groupMuted:") {
        return group(gid);
    }
    if key == "trino.consent" {
        // One record per device, of the identity that accepted.
        return serde_json::from_str::<serde_json::Value>(value)
            .ok()
            .and_then(|record| record["publicKey"].as_str().map(str::to_owned))
            .is_some_and(|key| key.eq_ignore_ascii_case(nostr_pub));
    }
    is_general(key)
}

/// The settings that are the account's, not a contact's or a group's
/// (design §5.3): every one but the screen before unlocking's.
pub fn is_general(key: &str) -> bool {
    matches!(
        key,
        "sticker-recents" | "autolock" | "trino:announcements:minSeq"
    ) || key.starts_with("updates.")
        || (key.starts_with("trino.pref.") && !DEVICE_PREFS.contains(&key))
}

/// The session's `prefs.bin` now, every entry, and where its import
/// stands: none and `Unavailable` with no session.
pub fn stored_prefs(inner: &InnerState) -> (Option<serde_json::Value>, PrefsImport) {
    match inner.storage.prefs_now() {
        Some((prefs, state)) => (
            prefs.and_then(|json| serde_json::from_slice(&json).ok()),
            state,
        ),
        None => (None, PrefsImport::Unavailable),
    }
}

/// The session's preferences now, as the frontend gets them (without the
/// backend's own), and where their import stands: none and `Unavailable`
/// with no session.
pub fn prefs_of(inner: &InnerState) -> (Option<serde_json::Value>, PrefsImport) {
    let (prefs, state) = stored_prefs(inner);
    (for_frontend(prefs), state)
}

/// The session's preferences as a map, every entry, the backend's own
/// included: an entry that is not text, or a `prefs.bin` that is not a map,
/// gives nothing.
pub fn current_map(inner: &InnerState) -> BTreeMap<String, String> {
    let (prefs, _) = stored_prefs(inner);
    prefs
        .and_then(|value| serde_json::from_value::<BTreeMap<String, serde_json::Value>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|text| (key, text.to_owned())))
        .collect()
}

/// The open session's store, or why there is none to keep preferences in.
pub fn check_store(inner: &InnerState) -> Result<(), CommandError> {
    inner.identity.as_ref().ok_or_else(sealed)?;
    match inner.storage.prefs_now() {
        None => Err(sealed()),
        Some((_, PrefsImport::Unavailable)) => Err(CommandError::internal(NOT_MOVED)),
        Some(_) => Ok(()),
    }
}

/// `prefs` as `prefs.bin` keeps them, if they are within their limit.
pub fn sealable(prefs: &BTreeMap<String, String>) -> Result<Zeroizing<Vec<u8>>, CommandError> {
    let json = Zeroizing::new(
        serde_json::to_vec(prefs).map_err(|e| CommandError::internal(e.to_string()))?,
    );
    if json.len() > MAX_PREFS_BYTES {
        return Err(CommandError::internal(
            "the preferences are over their limit",
        ));
    }
    Ok(json)
}

/// `prefs` with the backend's own entries as `current` has them, whatever
/// the frontend sent for them, and without the retired ones.
pub fn with_backend_entries(
    prefs: &BTreeMap<String, String>,
    current: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut kept = prefs.clone();
    for key in BACKEND_PREFS {
        match current.get(key) {
            Some(value) => kept.insert(key.to_string(), value.clone()),
            None => kept.remove(key),
        };
    }
    for key in RETIRED_PREFS {
        kept.remove(key);
    }
    kept
}

/// `prefs_save` on the session in `inner`.
pub fn save_in(inner: &InnerState, prefs: &BTreeMap<String, String>) -> Result<(), CommandError> {
    check_store(inner)?;
    let prefs = with_backend_entries(prefs, &current_map(inner));
    let json = sealable(&prefs)?;
    inner
        .storage
        .write_prefs(&json)
        .map_err(|e| CommandError::io(&e))?;
    // A security setting goes to the vault's shared block too (design §3.5).
    crate::vault_file::sync_shared(inner);
    Ok(())
}

/// Set the backend's own entry `key` to `value` (or drop it) in the
/// session's `prefs.bin`, keeping every other entry.
pub fn set_backend_pref(
    inner: &InnerState,
    key: &str,
    value: Option<&str>,
) -> Result<(), CommandError> {
    debug_assert!(BACKEND_PREFS.contains(&key));
    check_store(inner)?;
    let mut prefs = current_map(inner);
    match value {
        Some(value) => prefs.insert(key.to_string(), value.to_string()),
        None => prefs.remove(key),
    };
    let json = sealable(&prefs)?;
    inner
        .storage
        .write_prefs(&json)
        .map_err(|e| CommandError::io(&e))?;
    // The bridges go to the vault's shared block too (design §6.5, RC-06).
    crate::vault_file::sync_shared(inner);
    Ok(())
}

/// `prefs_import` on the session in `inner`.
pub fn import_in(
    inner: &InnerState,
    entries: BTreeMap<String, String>,
) -> Result<PrefsImported, CommandError> {
    check_store(inner)?;
    if let Some((_, PrefsImport::Done)) = inner.storage.prefs_now() {
        // Once only: what appears later is not read (design §5.3, point 4).
        return Ok(PrefsImported {
            saved: true,
            ..PrefsImported::default()
        });
    }
    let contacts: BTreeSet<String> = inner.friends.keys().cloned().collect();
    let groups: BTreeSet<String> = inner.groups.keys().cloned().collect();
    let nostr_pub = inner
        .identity
        .as_ref()
        .map(|identity| hex::encode(identity.nostr.pub_bytes))
        .unwrap_or_default();
    let taken: BTreeMap<String, String> = entries
        .into_iter()
        .filter(|(key, value)| is_this_accounts(key, value, &contacts, &groups, &nostr_pub))
        .collect();
    // What the store has already wins: it is newer than the WebView's.
    let mut merged = taken.clone();
    merged.extend(current_map(inner));
    let json = sealable(&merged)?;
    let notes = taken.keys().filter(|key| key.starts_with("note:")).count();
    let saved = match inner.storage.import_prefs(&json) {
        Ok(saved) => saved,
        Err(_) => {
            dbg_log("the preferences could not be imported now: the next unlock tries again");
            false
        }
    };
    Ok(PrefsImported {
        taken,
        saved,
        notes,
    })
}

/// `prefs_get` on the session in `inner`.
pub fn get_in(inner: &InnerState) -> Result<Option<serde_json::Value>, CommandError> {
    inner.identity.as_ref().ok_or_else(sealed)?;
    if inner.storage.prefs_now().is_none() {
        return Err(sealed());
    }
    // Without the backend's own entries.
    Ok(prefs_of(inner).0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::{create_account, open_session, DataFiles};
    use crate::command_error::ErrorCode;
    use crate::fsutil;
    use crate::fsutil::scratch::ScratchDir;
    use crate::group::GroupRoster;
    use crate::identity::Identity;
    use crate::identity::{create_identity, public_bundle_for};
    use crate::state::FriendRecord;
    use crate::storage::load_session;
    use crate::storage::{apply_loaded, legacy_files};
    use crate::store::session::Storage;
    use crate::store::session::STORE_DIR;
    use std::path::Path;

    const NOW: i64 = 1_760_000_000;
    const PASSPHRASE: &str = "correct horse battery staple";

    /// A new account in `home`, as `forge` creates it.
    fn new_account(home: &Path) -> (DataFiles, Identity, Zeroizing<Vec<u8>>) {
        let files = DataFiles::in_home(home.to_path_buf());
        let (identity, app) =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap();
        (files, identity, app)
    }

    /// The account in `files` unlocked, as `open_session` fills the session.
    fn unlocked(files: &DataFiles, me: &Identity, app: &[u8]) -> InnerState {
        let loaded = load_session(files, me, Some(app), None).unwrap();
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
        inner
    }

    fn roster(gid: &str) -> GroupRoster {
        GroupRoster {
            group_id: gid.into(),
            name: format!("grupo {gid}"),
            photo: None,
            admin_pub: "00".into(),
            members: vec![],
            epoch: 1,
            signature: String::new(),
        }
    }

    /// The account with Bob as its contact and g1 as its group.
    fn with_bob_and_g1(inner: &mut InnerState) {
        let bob = create_identity();
        inner.friends.insert(
            "Bob".into(),
            FriendRecord {
                handle: "Bob".into(),
                bundle: public_bundle_for(&bob),
                added_at: 0,
                avatar: None,
                previous_fingerprint: None,
                key_changed_at: None,
                via_group: None,
            },
        );
        inner.groups.insert("g1".into(), roster("g1"));
    }

    fn map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

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

    /// What the next unlock finds in `prefs.bin`.
    fn prefs_on_disk(files: &DataFiles, me: &Identity, app: &[u8]) -> Option<serde_json::Value> {
        load_session(files, me, Some(app), None).unwrap().prefs
    }

    fn index_seq(inner: &InnerState) -> u64 {
        inner.storage.index_seq().unwrap()
    }

    #[test]
    fn saved_prefs_are_sealed_and_the_next_unlock_carries_them() {
        let scratch = ScratchDir::new("prefs-save");
        let (files, me, app) = new_account(scratch.path());
        let inner = unlocked(&files, &me, &app);
        let prefs = map(&[("note:Bob", "Vecino del 3"), ("ttl:Bob", "30")]);

        save_in(&inner, &prefs).unwrap();

        assert_eq!(
            prefs_on_disk(&files, &me, &app),
            Some(serde_json::json!({ "note:Bob": "Vecino del 3", "ttl:Bob": "30" }))
        );
        let raw = std::fs::read(files.home.join(STORE_DIR).join("prefs.bin")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("Vecino"));
        // The session has them too, for an unlock of the open session.
        assert_eq!(
            get_in(&inner).unwrap(),
            Some(serde_json::json!({ "note:Bob": "Vecino del 3", "ttl:Bob": "30" }))
        );
    }

    #[test]
    fn prefs_over_their_limit_are_refused_and_nothing_is_written() {
        let scratch = ScratchDir::new("prefs-limit");
        let (files, me, app) = new_account(scratch.path());
        let inner = unlocked(&files, &me, &app);
        let long = "x".repeat(MAX_PREFS_BYTES);

        let refused = save_in(&inner, &map(&[("note:Bob", &long)]));
        let refused_import = import_in(&inner, map(&[("autolock", &long)]));

        assert!(refused.is_err());
        assert!(refused_import.is_err());
        assert_eq!(prefs_on_disk(&files, &me, &app), None);
        assert_eq!(
            inner.storage.prefs_now().map(|(_, state)| state),
            Some(PrefsImport::Pending)
        );
    }

    #[test]
    fn with_no_session_nothing_is_kept_or_given() {
        let inner = InnerState::default();

        let saved = save_in(&inner, &map(&[("autolock", "1")]));
        let imported = import_in(&inner, map(&[("autolock", "1")]));
        let got = get_in(&inner);

        assert_eq!(saved.unwrap_err().code, ErrorCode::NoVault);
        assert_eq!(imported.unwrap_err().code, ErrorCode::NoVault);
        assert_eq!(got.unwrap_err().code, ErrorCode::NoVault);
    }

    /// Part 1's error path: an account an earlier version created, whose
    /// migration stopped before its commit, works on its files of before
    /// and has nowhere sealed to keep its preferences.
    #[test]
    fn an_account_not_moved_yet_gets_a_clear_error_and_no_import() {
        let scratch = ScratchDir::new("prefs-legacy");
        let files = DataFiles::in_home(scratch.path().to_path_buf());
        let me = create_identity();
        let inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };
        inner.storage.set(Storage::Legacy(Box::new(
            legacy_files(&files, &me).unwrap(),
        )));

        let saved = save_in(&inner, &map(&[("autolock", "1")])).unwrap_err();
        let imported = import_in(&inner, map(&[("autolock", "1")])).unwrap_err();

        assert_eq!(saved.message, NOT_MOVED);
        assert_eq!(imported.message, NOT_MOVED);
        assert_eq!(
            inner.storage.prefs_now().map(|(_, state)| state),
            Some(PrefsImport::Unavailable)
        );
        assert_eq!(get_in(&inner).unwrap(), None);
        assert!(!files.home.join(STORE_DIR).exists());
    }

    /// Design §12.5, tests 66 and 42: only this account's entries, and the
    /// consent record only when it names this account's key.
    #[test]
    fn the_import_takes_only_this_accounts_contacts_and_groups() {
        let scratch = ScratchDir::new("prefs-import-filter");
        let (files, me, app) = new_account(scratch.path());
        let mut inner = unlocked(&files, &me, &app);
        with_bob_and_g1(&mut inner);
        let mine = hex::encode(me.nostr.pub_bytes);
        let entries = map(&[
            // Bob's and g1's.
            ("note:Bob", "Vecino del 3"),
            ("verified:Bob", "call:f1f2"),
            ("ttl:Bob", "30"),
            ("ttl:grp:g1", "3600"),
            ("trino.pref.groupMuted:g1", "1"),
            // Of contacts and groups of another account (TRINO_HOME), or
            // left by ones removed.
            ("note:Zoe", "otra cuenta"),
            ("verified:Zoe", "qr:0a0b"),
            ("ttl:Zoe", "60"),
            ("ttl:grp:g2", "60"),
            ("trino.pref.groupMuted:g2", "1"),
            // The general settings.
            ("autolock", "1"),
            ("updates.muted", "1"),
            ("updates.lastRead", "2026-10-01"),
            ("sticker-recents", "[\"s1\"]"),
            ("trino:announcements:minSeq", "7"),
            ("trino.pref.notifPreview", "none"),
            ("trino.pref.callsSeenAt", "1760000000"),
            // What the screen before unlocking uses: never taken.
            ("trino.pref.scanLines", "0"),
            ("trino.pref.textSize", "large"),
            ("trino.pref.blockCaptures", "0"),
            ("lang", "es"),
            ("trino.appearance", "{}"),
            ("trino.accessibility", "{}"),
            ("trino.dev.allowLanCandidates", "1"),
            ("something.else", "x"),
        ]);
        let consent_of_mine = consent(&mine);

        let imported = import_in(
            &inner,
            entries
                .into_iter()
                .chain([("trino.consent".to_string(), consent_of_mine.clone())])
                .collect(),
        )
        .unwrap();

        let expected = map(&[
            ("note:Bob", "Vecino del 3"),
            ("verified:Bob", "call:f1f2"),
            ("ttl:Bob", "30"),
            ("ttl:grp:g1", "3600"),
            ("trino.pref.groupMuted:g1", "1"),
            ("autolock", "1"),
            ("updates.muted", "1"),
            ("updates.lastRead", "2026-10-01"),
            ("sticker-recents", "[\"s1\"]"),
            ("trino:announcements:minSeq", "7"),
            ("trino.pref.notifPreview", "none"),
            ("trino.pref.callsSeenAt", "1760000000"),
            ("trino.consent", &consent_of_mine),
        ]);
        assert_eq!(imported.taken, expected);
        assert!(imported.saved);
        assert_eq!(imported.notes, 1);
        assert_eq!(
            prefs_on_disk(&files, &me, &app),
            Some(serde_json::to_value(&expected).unwrap())
        );

        // Another account's consent record is not this account's.
        let theirs = consent(&"ab".repeat(32));
        assert!(!is_this_accounts(
            "trino.consent",
            &theirs,
            &BTreeSet::new(),
            &BTreeSet::new(),
            &mine
        ));
        assert!(!is_this_accounts(
            "trino.consent",
            "not json",
            &BTreeSet::new(),
            &BTreeSet::new(),
            &mine
        ));
    }

    /// Tor design §7 and test 57: the WebView's old `minSeq` went to
    /// tor/seen.json. The unlock still finds it in the store and takes it
    /// (news_cmds.rs); the frontend never gets it, and the next save drops
    /// it whatever the frontend sends.
    #[test]
    fn the_old_min_seq_is_taken_at_unlock_then_retired() {
        let scratch = ScratchDir::new("prefs-min-seq");
        let (files, me, app) = new_account(scratch.path());
        let inner = unlocked(&files, &me, &app);
        import_in(
            &inner,
            map(&[("trino:announcements:minSeq", "7"), ("autolock", "1")]),
        )
        .unwrap();

        // The unlock sees it, the frontend does not.
        let stored = prefs_on_disk(&files, &me, &app);
        assert_eq!(old_min_seq(stored.as_ref()), Some(7));
        let inner = unlocked(&files, &me, &app);
        let (frontend, _) = prefs_of(&inner);
        assert_eq!(
            frontend,
            Some(serde_json::json!({ "autolock": "1" })),
            "the frontend got the old minSeq"
        );

        // The next save drops it, even if the frontend sends it.
        save_in(
            &inner,
            &map(&[("trino:announcements:minSeq", "9"), ("autolock", "0")]),
        )
        .unwrap();
        assert_eq!(
            prefs_on_disk(&files, &me, &app),
            Some(serde_json::json!({ "autolock": "0" }))
        );
    }

    /// Design §5.3: `prefs.bin` and `prefs_imported` in one step, and once.
    #[test]
    fn the_import_is_written_once_in_one_step_and_never_again() {
        let scratch = ScratchDir::new("prefs-import-once");
        let (files, me, app) = new_account(scratch.path());
        let inner = unlocked(&files, &me, &app);
        let before = index_seq(&inner);

        let first = import_in(&inner, map(&[("autolock", "1")])).unwrap();

        assert!(first.saved);
        assert_eq!(index_seq(&inner), before + 1, "one index write");
        assert_eq!(
            inner.storage.prefs_now().map(|(_, state)| state),
            Some(PrefsImport::Done)
        );
        // The next unlock knows it.
        let again = unlocked(&files, &me, &app);
        assert_eq!(
            again.storage.prefs_now().map(|(_, state)| state),
            Some(PrefsImport::Done)
        );
        drop(again);

        // Sent again (keys planted, or a cut before the WebView let go of
        // them): nothing is taken or written.
        let seq = index_seq(&inner);
        let second = import_in(&inner, map(&[("autolock", "15"), ("updates.muted", "1")])).unwrap();

        assert_eq!(
            second,
            PrefsImported {
                saved: true,
                ..PrefsImported::default()
            }
        );
        assert_eq!(index_seq(&inner), seq);
        assert_eq!(
            prefs_on_disk(&files, &me, &app),
            Some(serde_json::json!({ "autolock": "1" }))
        );
    }

    #[test]
    fn what_the_store_has_wins_over_the_import() {
        let scratch = ScratchDir::new("prefs-import-merge");
        let (files, me, app) = new_account(scratch.path());
        let mut inner = unlocked(&files, &me, &app);
        with_bob_and_g1(&mut inner);
        save_in(&inner, &map(&[("note:Bob", "nueva")])).unwrap();

        let imported = import_in(&inner, map(&[("note:Bob", "vieja"), ("ttl:Bob", "30")])).unwrap();

        assert!(imported.saved);
        assert_eq!(
            prefs_on_disk(&files, &me, &app),
            Some(serde_json::json!({ "note:Bob": "nueva", "ttl:Bob": "30" }))
        );
    }

    /// While `prefs.bin` waits for the user's choice (an older copy, design
    /// §6.1), the import is not saved and not noted: the frontend keeps its
    /// copy, and the next unlock imports again.
    #[test]
    fn an_import_that_cannot_be_saved_now_says_so_and_is_not_noted() {
        let scratch = ScratchDir::new("prefs-import-pending");
        let (files, me, app) = new_account(scratch.path());
        let prefs_path = files.home.join(STORE_DIR).join("prefs.bin");
        {
            let inner = unlocked(&files, &me, &app);
            save_in(&inner, &map(&[("autolock", "5")])).unwrap();
            let older = std::fs::read(&prefs_path).unwrap();
            save_in(&inner, &map(&[("autolock", "10")])).unwrap();
            drop(inner);
            std::fs::write(&prefs_path, older).unwrap();
        }
        let inner = unlocked(&files, &me, &app);
        let before = std::fs::read(&prefs_path).unwrap();

        let imported = import_in(&inner, map(&[("updates.muted", "1")])).unwrap();

        assert!(!imported.saved);
        assert_eq!(imported.taken, map(&[("updates.muted", "1")]));
        assert_eq!(std::fs::read(&prefs_path).unwrap(), before);
        assert_eq!(
            inner.storage.prefs_now().map(|(_, state)| state),
            Some(PrefsImport::Pending)
        );
        assert!(save_in(&inner, &map(&[("autolock", "1")])).is_err());
    }

    /// Clave de emergencia RC-06: the private bridges, which only the
    /// backend writes, go to the vault's shared block too, with the
    /// account's relays (RC-04), so an empty account inherits them as they
    /// are now.
    #[test]
    fn a_backend_pref_goes_to_the_shared_block_too() {
        use crate::vault_file::{SessionVault, SharedApp};
        let scratch = ScratchDir::new("prefs-backend-shared");
        let files = DataFiles::in_home(scratch.path().to_path_buf());
        let (me, app, vault) = crate::account::create_account_vault(
            &files,
            "ana",
            PASSPHRASE,
            None,
            crate::vault_file::write,
        )
        .unwrap();
        let inner = unlocked(&files, &me, &app);
        inner.vault.set(SessionVault {
            path: files.vault.clone(),
            vault: Box::new(vault),
        });
        let line = "obfs4 192.0.2.1:443 cert=x iat-mode=0";

        set_backend_pref(&inner, NET_BRIDGES, Some(line)).unwrap();

        let shared = SharedApp::from_bytes(&inner.vault.shared_app().unwrap()).unwrap();
        assert_eq!(shared.prefs[NET_BRIDGES], line);
        assert_eq!(shared.relays, inner.relay_urls);
        let on_disk = match crate::vault_file::open(&files.vault, PASSPHRASE, None).unwrap() {
            crate::vault_file::OpenedVault::V3(vault) => vault.shared_app().to_vec(),
            crate::vault_file::OpenedVault::Old(_) => panic!("a vault of version 2"),
        };
        assert_eq!(SharedApp::from_bytes(&on_disk), Some(shared));
    }

    /// Design §12.3 test 60 and §5.3: the answer of the unlock that opens
    /// the session says where the import stands, and an unlock of the
    /// session already open still carries the preferences.
    #[tokio::test]
    async fn the_unlock_answer_says_where_the_import_stands() {
        let scratch = ScratchDir::new("prefs-unlock-answer");
        let (files, me, app) = new_account(scratch.path());
        let inner = tokio::sync::Mutex::new(InnerState::default());

        let first = open_session(
            &inner,
            me.clone(),
            None,
            Some(load_session(&files, &me, Some(&app), None).unwrap()),
            |_| {},
        )
        .await
        .unwrap();

        assert_eq!(first.prefs_import, PrefsImport::Pending);
        assert_eq!(first.prefs, None);
        import_in(&*inner.lock().await, map(&[("autolock", "1")])).unwrap();

        // A reload of the WebView with the session open unlocks again.
        let again = open_session(&inner, me.clone(), None, None, |_| {})
            .await
            .unwrap();

        assert!(!again.relay_connection_started);
        assert_eq!(again.prefs_import, PrefsImport::Done);
        assert_eq!(again.prefs, Some(serde_json::json!({ "autolock": "1" })));

        // Locked and unlocked: from the store.
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let next = open_session(
            &inner,
            me.clone(),
            None,
            Some(load_session(&files, &me, Some(&app), None).unwrap()),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(next.prefs_import, PrefsImport::Done);
        assert_eq!(next.prefs, Some(serde_json::json!({ "autolock": "1" })));
        let json = serde_json::to_value(&next).unwrap();
        assert_eq!(json["prefs_import"], "done");
        assert!(json["custom_data_dir"].is_boolean());
    }
}
