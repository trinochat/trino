//! Where the open session keeps its data (cifrado local CL-1b, design §12.3
//! and §13): the store wired to unlocking, creating an account, locking,
//! wiping, saving and the stickers.
//!
//! An account whose vault carries the key to `store/` (every account created
//! from this version on) opens from the store. One whose vault carries none
//! yet, created by an earlier version, keeps its files of before until the
//! migration (CL-1c) moves it: `Storage::Legacy` reads and writes them as
//! earlier versions did.
//!
//! A child module of `commands`, so it reaches the helpers there.

use super::*;
use crate::store::session::{
    legacy_open, vault_header, LegacyFiles, OpenedStore, Storage, StorageCell, OTHER_STORE_PREFIX,
};
use std::collections::BTreeSet;
use std::io::Write as _;

/// What unlocking found on disk for the session, before it opens.
pub(crate) struct LoadedSession {
    pub(super) storage: Storage,
    /// The account: `None` when there is none to use (missing, waiting for
    /// the user's choice or unreadable), and the session starts as "anon".
    pub(super) account: Option<AccountFile>,
    pub(super) history: Found,
    pub(super) sessions: Found,
    pub(super) profiles: Found,
    /// The account's preferences, for the unlock answer (CL-2a).
    pub(super) prefs: Option<serde_json::Value>,
    /// What changed on disk, for the one dialog at unlock.
    pub(super) report: IntegrityReport,
}

/// Read what the session of `identity` needs from `files`: from the store
/// when the vault carries its key (`app`), or from the files of earlier
/// versions when it does not. `vault` is the vault as it is on disk, for the
/// check of its header (design §4.9).
pub(super) fn load_session(
    files: &DataFiles,
    identity: &Identity,
    app: Option<&[u8]>,
    vault: Option<&[u8]>,
) -> Result<LoadedSession, CommandError> {
    harden_dir(&files.home); // tighten perms on existing installs too
    match app {
        Some(record) => load_store(files, identity, record, vault),
        None => load_legacy(files, identity),
    }
}

fn load_store(
    files: &DataFiles,
    identity: &Identity,
    record: &[u8],
    vault: Option<&[u8]>,
) -> Result<LoadedSession, CommandError> {
    let header = vault.and_then(|bytes| vault_header(bytes, identity.signed_prekey.id));
    let OpenedStore {
        mut session,
        account,
        history,
        sessions,
        profiles,
    } = SessionStore::open(&files.home, record, header).map_err(|e| CommandError::io(&e))?;
    // What opens but does not read (a newer version's, say) is held: never
    // written over this session.
    let account = match account {
        Found::Ready(json) => {
            let account = serde_json::from_slice::<AccountFile>(&json).ok();
            if account.is_none() {
                session.hold(&Slot::Account);
            }
            account
        }
        Found::Absent | Found::Held => None,
    };
    let prefs = match session
        .prefs()
        .map(serde_json::from_slice::<serde_json::Value>)
    {
        Some(Ok(prefs)) => Some(prefs),
        Some(Err(_)) => {
            session.hold(&Slot::Prefs);
            None
        }
        None => None,
    };
    let report = session.report();
    Ok(LoadedSession {
        storage: Storage::Store(Box::new(session)),
        account,
        history,
        sessions,
        profiles,
        prefs,
        report,
    })
}

/// An account of an earlier version, read as `open_session` read it before:
/// without config.json there is no session.
fn load_legacy(files: &DataFiles, identity: &Identity) -> Result<LoadedSession, CommandError> {
    let cfg_bytes = std::fs::read(&files.config).map_err(|e| CommandError::io(&e))?;
    let cfg: ConfigFile = serde_json::from_slice(&cfg_bytes)
        .map_err(|e| CommandError::internal(format!("config.json: {e}")))?;
    let friends = match std::fs::read(&files.friends) {
        Ok(bytes) => serde_json::from_slice::<FriendsFile>(&bytes)
            .map_err(|e| CommandError::internal(format!("friends.json: {e}")))?,
        Err(_) => FriendsFile {
            handle: cfg.handle.clone(),
            friends: vec![],
            blocked: vec![],
        },
    };
    let account = AccountFile {
        handle: cfg.handle,
        nostr_pub: cfg.nostr_pub,
        relays: cfg.relays,
        created_at: cfg.created_at,
        avatar: cfg.avatar,
        friends: friends.friends,
        blocked: friends.blocked,
        groups: read_list(&files.groups),
        group_invites: read_list(&files.group_invites),
    };

    let mut legacy = legacy_files(files, identity);
    let mut report = IntegrityReport::default();
    // A history that does not open is never replaced by an empty one (H2).
    let history = legacy_sealed(&files.history, &legacy.history_key);
    if matches!(history, Found::Held) {
        legacy.held.insert(Slot::History);
        report.note("history", What::Altered, Action::KeepForLater);
    }
    // Sessions that do not open are made again with each contact, as
    // before; only ones that cannot be read now are kept as they are.
    let sessions = match legacy_sealed(&files.ratchets, &legacy.history_key) {
        Found::Held if std::fs::read(&files.ratchets).is_ok() => Found::Absent,
        Found::Held => {
            legacy.held.insert(Slot::Sessions);
            Found::Held
        }
        found => found,
    };
    let profiles = profile::legacy_found(&files.profiles, identity);
    Ok(LoadedSession {
        storage: Storage::Legacy(Box::new(legacy)),
        account: Some(account),
        history,
        sessions,
        profiles,
        prefs: None,
        report,
    })
}

/// A list an earlier version kept in a `.json` file; none if it does not
/// read, as before.
fn read_list<T: serde::de::DeserializeOwned>(path: &Path) -> Vec<T> {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// A file an earlier version sealed with `key`: absent, ready, or held when
/// it is there and does not open (or cannot be read now).
fn legacy_sealed(path: &Path, key: &[u8; 32]) -> Found {
    match std::fs::read(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Found::Absent,
        Err(_) => Found::Held,
        Ok(blob) => legacy_open(key, &blob).map_or(Found::Held, Found::Ready),
    }
}

/// The legacy files of `files`, with the keys earlier versions derived from
/// `identity` for them.
pub(crate) fn legacy_files(files: &DataFiles, identity: &Identity) -> LegacyFiles {
    LegacyFiles {
        config: files.config.clone(),
        friends: files.friends.clone(),
        groups: files.groups.clone(),
        group_invites: files.group_invites.clone(),
        history: files.history.clone(),
        ratchets: files.ratchets.clone(),
        profiles: files.profiles.clone(),
        stickers: files.stickers.clone(),
        history_key: Zeroizing::new(derive_history_key(identity)),
        profiles_key: profile::profiles_key(identity).expect("HKDF-SHA256 always gives 32 bytes"),
        held: BTreeSet::new(),
    }
}

/// Fill the session that `open_session` is opening with what was loaded;
/// its storage is in `inner.storage` already. A part that does not read is
/// held, never written over.
pub(super) fn apply_loaded(
    inner: &mut InnerState,
    account: Option<AccountFile>,
    history: Found,
    sessions: Found,
    profiles: Found,
    now: i64,
) {
    // Design §6.1: with no account to use, the session opens as "anon"
    // with the default relays, and the user can name it in the settings.
    let account = account.unwrap_or_else(|| AccountFile {
        handle: display_handle(""),
        nostr_pub: inner
            .identity
            .as_ref()
            .map(|identity| hex::encode(identity.nostr.pub_bytes))
            .unwrap_or_default(),
        relays: default_relays(),
        created_at: now,
        ..AccountFile::default()
    });
    inner.handle = Some(account.handle);
    inner.avatar = sanitized_inline_raster(account.avatar);
    inner.relay_urls = account.relays;
    inner.created_at = account.created_at;
    inner.friends.clear();
    for mut friend in account.friends {
        friend.avatar = sanitized_inline_raster(friend.avatar.take());
        inner.friends.insert(friend.handle.clone(), friend);
    }
    inner.blocked = account.blocked.into_iter().collect();
    inner.groups.clear();
    for roster in account.groups {
        let roster = sanitize_roster(roster);
        inner.groups.insert(roster.group_id.clone(), roster);
    }
    inner.group_invites.clear();
    for mut invite in account.group_invites {
        invite.roster = sanitize_roster(invite.roster);
        inner
            .group_invites
            .insert(invite.roster.group_id.clone(), invite);
    }
    inner.history.clear();
    load_history(inner, history);
    load_ratchets(inner, sessions);
    // -- W8 (K12) --
    profile::load_found(inner, profiles, now);
}

/// The account as `account.bin` keeps it: the profile, the contacts, the
/// blocked contacts, the groups and the invitations.
pub(crate) fn account_of(inner: &InnerState) -> AccountFile {
    let mut friends: Vec<FriendRecord> = inner.friends.values().cloned().collect();
    friends.sort_by(|a, b| a.handle.cmp(&b.handle));
    let mut blocked: Vec<String> = inner.blocked.iter().cloned().collect();
    blocked.sort();
    let mut groups: Vec<GroupRoster> = inner.groups.values().cloned().collect();
    groups.sort_by(|a, b| a.group_id.cmp(&b.group_id));
    let mut group_invites: Vec<GroupInvite> = inner.group_invites.values().cloned().collect();
    group_invites.sort_by_key(|invite| invite.received_at);
    AccountFile {
        handle: inner.handle.clone().unwrap_or_default(),
        nostr_pub: inner
            .identity
            .as_ref()
            .map(|identity| hex::encode(identity.nostr.pub_bytes))
            .unwrap_or_default(),
        relays: inner.relay_urls.clone(),
        created_at: inner.created_at,
        avatar: inner.avatar.clone(),
        friends,
        blocked,
        groups,
        group_invites,
    }
}

/// Save the account, in one write: contacts, groups and invitations change
/// together (design §4.1). With no session, nothing is written.
pub(crate) fn persist_account(inner: &InnerState) -> Result<(), String> {
    inner
        .storage
        .write_account(&account_of(inner))
        .map_err(|e| e.to_string())
}

/// What the unlock screen gets. Before unlocking it reads nothing in clear
/// but the vault's header, and says no name (H1, David's decision 1): the
/// screen greets "Hola de nuevo".
pub(super) fn status_of(inner: &InnerState, home: &Path, vault: &Path) -> StatusResponse {
    let identity = inner.identity.as_ref();
    StatusResponse {
        has_vault: vault.exists(),
        is_unsealed: identity.is_some(),
        handle: identity.and(inner.handle.clone()),
        nostr_pub: identity.map(|identity| hex::encode(identity.nostr.pub_bytes)),
        home_dir: home.to_string_lossy().to_string(),
        totp_enabled: totp_hint(vault),
    }
}

/// Wipe the names in memory where it is cheap: this identity's, its
/// contacts' and its groups' (design §7.2). The maps are left empty.
pub(super) fn zeroize_names(inner: &mut InnerState) {
    fn zeroize_roster(roster: &mut GroupRoster) {
        roster.name.zeroize();
        for member in &mut roster.members {
            member.handle.zeroize();
        }
    }
    if let Some(handle) = inner.handle.as_mut() {
        handle.zeroize();
    }
    for (mut name, mut friend) in inner.friends.drain() {
        name.zeroize();
        friend.handle.zeroize();
    }
    for (_, mut roster) in inner.groups.drain() {
        zeroize_roster(&mut roster);
    }
    for (_, mut invite) in inner.group_invites.drain() {
        zeroize_roster(&mut invite.roster);
        invite.from_handle.zeroize();
    }
    for mut key in inner.blocked.drain() {
        key.zeroize();
    }
}

/// Whether the TOTP flag of a version 1 vault, which nothing authenticates,
/// says otherwise than what the vault holds (design §4.9). A version 2
/// vault authenticates it.
pub(super) fn totp_flag_disagrees(vault: &[u8], totp_on: bool) -> bool {
    let Ok(sealed) = decode_vault(vault) else {
        return false;
    };
    sealed.version == 1 && vault_requires_totp(vault).is_ok_and(|flag| flag != totp_on)
}

/// Write `bytes` as the vault at `vault`, noting its header in the store's
/// index as pending first and as the vault's after (design §4.9), so a cut
/// in between is not taken for another vault at the next unlock.
pub(crate) fn write_vault_noted(
    mut storage: Option<&mut Storage>,
    vault: &Path,
    bytes: &[u8],
    spk: u32,
) -> std::io::Result<()> {
    let header = vault_header(bytes, spk);
    if let (Some(storage), Some(header)) = (storage.as_mut(), header.as_ref()) {
        storage.note_vault_pending(header);
    }
    fsutil::atomic_write(vault, bytes)?;
    if let (Some(storage), Some(header)) = (storage.as_mut(), header.as_ref()) {
        storage.note_vault_written(header);
    }
    Ok(())
}

/// `write_vault_noted` with the open session's storage.
pub(crate) fn write_vault_noted_in(
    cell: &StorageCell,
    vault: &Path,
    bytes: &[u8],
    spk: u32,
) -> std::io::Result<()> {
    cell.with(|storage| write_vault_noted(Some(storage), vault, bytes, spk))
        .unwrap_or_else(|| write_vault_noted(None, vault, bytes, spk))
}

/// What `wipe` does on disk.
pub(super) trait WipeOps {
    /// Overwrite the file at `path`, sync it and remove it.
    fn destroy(&mut self, path: &Path) -> std::io::Result<()>;
    fn remove_dir(&mut self, path: &Path) -> std::io::Result<()>;
}

/// The real disk.
pub(super) struct RealWipe;

impl WipeOps for RealWipe {
    fn destroy(&mut self, path: &Path) -> std::io::Result<()> {
        destroy_file(path)
    }

    fn remove_dir(&mut self, path: &Path) -> std::io::Result<()> {
        match std::fs::remove_dir_all(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            done => done,
        }
    }
}

/// Overwrite the file at `path` with random bytes of its length, sync it and
/// remove it. A file that is not there is no error. On an SSD the old bytes
/// may stay elsewhere (design §5.4); on a hard disk, and for the small files
/// NTFS keeps in its table, this is what removes them.
pub(super) fn destroy_file(path: &Path) -> std::io::Result<()> {
    let mut file = match std::fs::OpenOptions::new().write(true).open(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        file => file?,
    };
    let mut left = file.metadata()?.len();
    let mut chunk = vec![0u8; 64 * 1024];
    while left > 0 {
        let size = chunk.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        for block in chunk[..size].chunks_mut(32) {
            let random: [u8; 32] = crate::crypto::random_array();
            block.copy_from_slice(&random[..block.len()]);
        }
        file.write_all(&chunk[..size])?;
        left -= size as u64;
    }
    file.sync_all()?;
    drop(file);
    std::fs::remove_file(path)
}

/// Destroy `path` and the temporaries a cut save of it left.
fn destroy_with_leftovers(ops: &mut dyn WipeOps, path: &Path, failures: &mut Vec<String>) {
    let leftovers = fsutil::leftover_temp_files(path);
    for path in std::iter::once(path).chain(leftovers.iter().map(PathBuf::as_path)) {
        if let Err(error) = ops.destroy(path) {
            failures.push(format!("{}: {}", path.display(), error));
        }
    }
}

fn remove_dir_with(ops: &mut dyn WipeOps, path: &Path, failures: &mut Vec<String>) {
    if let Err(error) = ops.remove_dir(path) {
        failures.push(format!("{}: {}", path.display(), error));
    }
}

/// Everything of the account in `home`, in the order of design §5.7: the
/// vault first, since nothing in `store/` opens without the data key it
/// carries; then `store/`, any store set aside, and what earlier versions
/// left. The failures, if any.
pub(super) fn wipe_home(home: &Path, ops: &mut dyn WipeOps) -> Vec<String> {
    let mut failures = Vec::new();
    destroy_with_leftovers(ops, &home.join("vault.bin"), &mut failures);
    remove_dir_with(ops, &home.join(STORE_DIR), &mut failures);
    let mut others: Vec<PathBuf> = std::fs::read_dir(home)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(OTHER_STORE_PREFIX)
                })
                .map(|entry| entry.path())
                .collect()
        })
        .unwrap_or_default();
    others.sort();
    for other in others {
        remove_dir_with(ops, &other, &mut failures);
    }
    for name in [
        "config.json",
        "friends.json",
        "groups.json",
        "group_invites.json",
        "history.bin",
        "ratchets.bin",
        profile::PROFILES_FILE,
        profile::DAMAGED_PROFILES_FILE,
        crate::diag::LOG_FILE,
        crate::diag::LEGACY_LOG_FILE,
    ] {
        destroy_with_leftovers(ops, &home.join(name), &mut failures);
    }
    remove_dir_with(ops, &home.join("stickers"), &mut failures);
    failures
}

fn sticker_info(id: String, mime: String, data_b64: &str) -> StickerInfo {
    let data_url = format!("data:{mime};base64,{data_b64}");
    StickerInfo { id, mime, data_url }
}

/// Keep a sticker. It needs the open session (H4).
pub(super) fn import_sticker_into(
    cell: &StorageCell,
    image: &[u8],
    mime: &str,
) -> Result<StickerInfo, String> {
    let id = hex::encode(&crate::crypto::sha256(image)[..8]);
    cell.with(|storage| match storage {
        Storage::Store(store) => store.put_sticker(&id, mime, image),
        Storage::Legacy(legacy) => {
            let name = format!("{id}.{}", sticker_ext_for_mime(mime));
            std::fs::create_dir_all(&legacy.stickers)
                .and_then(|()| fsutil::atomic_write(&legacy.stickers.join(name), image))
        }
    })
    .ok_or_else(|| "vault sealed".to_string())?
    .map_err(|e| e.to_string())?;
    let data = base64::engine::general_purpose::STANDARD.encode(image);
    Ok(sticker_info(id, mime.to_string(), &data))
}

/// The stickers of the open session.
pub(super) fn list_stickers_in(cell: &StorageCell) -> Result<Vec<StickerInfo>, String> {
    cell.with(|storage| match storage {
        Storage::Store(store) => store
            .stickers()
            .into_iter()
            .map(|sticker| sticker_info(sticker.id, sticker.mime, &sticker.data))
            .collect(),
        Storage::Legacy(legacy) => legacy_stickers(&legacy.stickers),
    })
    .ok_or_else(|| "vault sealed".to_string())
}

/// The stickers of an account not moved yet, as earlier versions keep them.
fn legacy_stickers(dir: &Path) -> Vec<StickerInfo> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        out.push(sticker_info(
            id,
            sticker_mime_for_ext(&ext).to_string(),
            &data,
        ));
    }
    out
}

/// Remove the sticker `id` of the open session.
pub(super) fn delete_sticker_in(cell: &StorageCell, id: &str) -> Result<(), String> {
    cell.with(|storage| match storage {
        Storage::Store(store) => store.remove_sticker(id).map_err(|e| e.to_string()),
        Storage::Legacy(legacy) => {
            if let Ok(entries) = std::fs::read_dir(&legacy.stickers) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.file_stem().and_then(|s| s.to_str()) == Some(id) {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
            Ok(())
        }
    })
    .ok_or_else(|| "vault sealed".to_string())?
}

/// The user's answer in the dialog for `file`, which waits for a choice:
/// with `use_it` the session takes what it holds, together with what
/// changed since unlocking; without, the session goes on with what it has.
/// What the session holds is saved once nothing waits any more (until
/// then the store takes no write, design §4.6), and what still waits is
/// returned.
pub(super) fn choose_in(
    inner: &mut InnerState,
    file: &str,
    use_it: bool,
) -> Result<IntegrityReport, CommandError> {
    let slot = Slot::from_logical_name(file)
        .ok_or_else(|| CommandError::internal("no such file in the store"))?;
    let content = inner
        .storage
        .with(|storage| match storage {
            Storage::Store(store) => store.choose(&slot, use_it),
            Storage::Legacy(_) => Err(std::io::Error::other("nothing waits for a choice")),
        })
        .ok_or_else(super::contacts_cmds::sealed)?
        .map_err(|e| CommandError::io(&e))?;
    let now = chrono::Utc::now().timestamp();
    match (&slot, content) {
        (Slot::Account, Some(json)) => {
            let account = serde_json::from_slice::<AccountFile>(&json)
                .map_err(|e| CommandError::internal(format!("account: {e}")))?;
            merge_account(inner, account);
        }
        (Slot::History, Some(json)) => {
            let history = serde_json::from_slice::<HashMap<String, Vec<HistItem>>>(&json)
                .map_err(|e| CommandError::internal(format!("history: {e}")))?;
            merge_history(inner, history);
        }
        (Slot::Profiles, content) => {
            let found = content.map_or(Found::Absent, Found::Ready);
            profile::load_found(inner, found, now);
        }
        _ => {}
    }
    // Each fails while something still waits, and the last choice saves
    // them all.
    let _ = persist_account(inner);
    let _ = write_history(inner);
    let _ = profile::try_save(inner);
    Ok(inner
        .storage
        .with(|storage| match storage {
            Storage::Store(store) => store.report(),
            Storage::Legacy(_) => IntegrityReport::default(),
        })
        .unwrap_or_default())
}

/// The account the user chose, under what the session added since
/// unlocking: its profile, and every contact, group and invitation the
/// session does not have.
fn merge_account(inner: &mut InnerState, account: AccountFile) {
    inner.handle = Some(account.handle);
    inner.avatar = sanitized_inline_raster(account.avatar);
    inner.relay_urls = account.relays;
    inner.created_at = account.created_at;
    for mut friend in account.friends {
        friend.avatar = sanitized_inline_raster(friend.avatar.take());
        inner.friends.entry(friend.handle.clone()).or_insert(friend);
    }
    inner.blocked.extend(account.blocked);
    for roster in account.groups {
        let roster = sanitize_roster(roster);
        inner
            .groups
            .entry(roster.group_id.clone())
            .or_insert(roster);
    }
    for mut invite in account.group_invites {
        invite.roster = sanitize_roster(invite.roster);
        inner
            .group_invites
            .entry(invite.roster.group_id.clone())
            .or_insert(invite);
    }
}

/// The history the user chose, with what arrived since unlocking after it.
fn merge_history(inner: &mut InnerState, chosen: HashMap<String, Vec<HistItem>>) {
    for (convo, mut items) in chosen {
        for item in &mut items {
            if let Some(file) = item.file.take() {
                item.file = Some(sanitize_file_ref(file));
            }
        }
        items.extend(inner.history.remove(&convo).unwrap_or_default());
        let excess = items.len().saturating_sub(HISTORY_CAP);
        items.drain(..excess);
        inner.history.insert(convo, items);
    }
}

/// "Usar esa copia" or "Seguir sin ella" in the dialog at unlock (design
/// §6.2), for one file that waits.
#[tauri::command]
pub async fn store_choose(
    state: State<'_, AppState>,
    file: String,
    use_it: bool,
) -> Result<IntegrityReport, CommandError> {
    choose_in(&mut *state.inner.lock().await, &file, use_it)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::store::session::tests::{reopen, store_cell};

    const NOW: i64 = 1_760_000_000;
    const PASSPHRASE: &str = "correct horse battery staple";

    fn data_files_in(home: PathBuf) -> DataFiles {
        DataFiles::in_home(home)
    }

    fn friend(id: &Identity, handle: &str) -> FriendRecord {
        FriendRecord {
            handle: handle.to_string(),
            bundle: public_bundle_for(id),
            added_at: 0,
            avatar: None,
            previous_fingerprint: None,
            key_changed_at: None,
            via_group: None,
        }
    }

    fn names_in(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// A new account in `files`, and what unlocking it loads.
    fn new_account(files: &DataFiles, handle: &str) -> (Identity, Zeroizing<Vec<u8>>) {
        let (identity, app) =
            create_account(files, handle, PASSPHRASE, None, fsutil::atomic_write).unwrap();
        (identity, app)
    }

    /// Design §12.3, test 19 (H1).
    #[test]
    fn status_reads_no_plain_file_and_has_no_handle_before_unlock() {
        let scratch = ScratchDir::new("status-no-name");
        let home = scratch.path();
        // An older version's config.json, or one someone planted.
        std::fs::write(
            home.join("config.json"),
            br#"{"handle":"Ana Planted","nostrPub":"00","relays":[],"createdAt":0}"#,
        )
        .unwrap();
        let vault = home.join("vault.bin");
        std::fs::write(
            &vault,
            encode_vault(&crate::vault::SealedVault {
                version: 2,
                flags: 1,
                salt: [7; 16],
                nonce: [9; 12],
                ciphertext: vec![1; 48],
            }),
        )
        .unwrap();

        let status = status_of(&InnerState::default(), home, &vault);

        assert!(status.has_vault);
        assert!(!status.is_unsealed);
        assert_eq!(status.handle, None, "a name before unlocking");
        assert_eq!(status.nostr_pub, None);
        assert_eq!(status.totp_enabled, Some(false));

        // Unlocked, the session's own name.
        let inner = InnerState {
            identity: Some(create_identity()),
            handle: Some("Ana".into()),
            ..InnerState::default()
        };
        assert_eq!(
            status_of(&inner, home, &vault).handle.as_deref(),
            Some("Ana")
        );
    }

    /// Design §12.3, test 27.
    #[test]
    fn a_new_account_never_writes_json() {
        let scratch = ScratchDir::new("forge-no-json");
        let files = data_files_in(scratch.path().join("home"));

        let (identity, app) = new_account(&files, "Ana Secreta");

        assert_eq!(names_in(&files.home), ["store", "vault.bin"]);
        assert_eq!(
            names_in(&files.home.join(STORE_DIR)),
            ["account.bin", "index.bin"]
        );
        // The vault carries the key to the store.
        let opened = open_vault(&files.vault, PASSPHRASE, None).unwrap();
        assert_eq!(
            opened.app.as_deref().map(Vec::as_slice),
            Some(app.as_slice())
        );
        let loaded = load_session(&files, &identity, Some(&app), None).unwrap();
        let account = loaded.account.expect("the account is in the store");
        assert_eq!(account.handle, "Ana Secreta");
        assert_eq!(account.nostr_pub, hex::encode(identity.nostr.pub_bytes));
        assert_eq!(account.relays, default_relays());
        assert!(loaded.report.is_empty());
        for name in names_in(&files.home.join(STORE_DIR)) {
            let raw = std::fs::read(files.home.join(STORE_DIR).join(&name)).unwrap();
            assert!(!String::from_utf8_lossy(&raw).contains("Ana Secreta"));
        }
    }

    #[test]
    fn a_new_account_writes_its_vault_after_its_store() {
        let scratch = ScratchDir::new("forge-order");
        let files = data_files_in(scratch.path().join("home"));
        let mut store_before_vault = None;

        create_account(&files, "ana", PASSPHRASE, None, |path, bytes| {
            store_before_vault = Some(files.home.join(STORE_DIR).join("account.bin").exists());
            fsutil::atomic_write(path, bytes)
        })
        .unwrap();

        // `status` reports an account once vault.bin exists: it must never
        // exist without the store it opens.
        assert_eq!(store_before_vault, Some(true));
    }

    #[test]
    fn a_new_account_that_cannot_be_finished_leaves_nothing_behind() {
        let scratch = ScratchDir::new("forge-rollback");
        let files = data_files_in(scratch.path().join("home"));

        let result = create_account(&files, "ana", PASSPHRASE, None, |_, _| {
            Err(std::io::Error::other("disk full"))
        });

        assert!(result.is_err());
        assert!(!files.vault.exists());
        assert!(
            !files.home.exists(),
            "the data dir this call created stayed"
        );
    }

    #[test]
    fn a_failed_new_account_keeps_what_was_already_there() {
        let scratch = ScratchDir::new("forge-keep");
        let files = data_files_in(scratch.path().to_path_buf());
        std::fs::write(&files.config, b"earlier attempt").unwrap();

        let result = create_account(&files, "ana", PASSPHRASE, None, |_, _| {
            Err(std::io::Error::other("disk full"))
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&files.config).unwrap(), b"earlier attempt");
        assert!(!files.home.join(STORE_DIR).exists());
        assert!(files.home.exists());
    }

    /// The whole round: a new account opens from its store, and what the
    /// session saves comes back at the next unlock, sealed.
    #[tokio::test]
    async fn a_session_opens_from_the_store_and_saves_back_to_it() {
        let scratch = ScratchDir::new("store-session");
        let files = data_files_in(scratch.path().join("home"));
        let (me, app) = new_account(&files, "ana");
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let loaded = load_session(&files, &me, Some(&app), None).unwrap();
        let mut starts = Vec::new();

        let opened = open_session(&inner, me.clone(), None, Some(loaded), |start| {
            starts.push(start)
        })
        .await
        .unwrap();

        assert_eq!(opened.handle, "ana");
        assert_eq!(starts[0].relays, default_relays());
        {
            let mut inner = inner.lock().await;
            let bob = create_identity();
            inner.friends.insert("bob".into(), friend(&bob, "bob"));
            inner.history.insert(
                "bob".into(),
                vec![HistItem {
                    side: "me".into(),
                    from: None,
                    text: Some("hola bob".into()),
                    file: None,
                    call: None,
                    ts: NOW,
                }],
            );
            persist_account(&inner).unwrap();
            save_history(&inner);
            save_ratchets(&inner);
        }

        let loaded = load_session(&files, &me, Some(&app), None).unwrap();
        let account = loaded.account.unwrap();
        assert_eq!(account.friends.len(), 1);
        assert_eq!(account.friends[0].handle, "bob");
        let Found::Ready(history) = loaded.history else {
            panic!("no history")
        };
        assert!(String::from_utf8_lossy(&history).contains("hola bob"));
        assert!(matches!(loaded.sessions, Found::Ready(_)));
        for name in names_in(&files.home.join(STORE_DIR)) {
            let path = files.home.join(STORE_DIR).join(&name);
            if path.is_file() {
                let raw = std::fs::read(path).unwrap();
                assert!(!String::from_utf8_lossy(&raw).contains("hola bob"));
            }
        }
        assert!(names_in(&files.home)
            .iter()
            .all(|name| !name.ends_with(".json")));
    }

    /// Design §12.3, test 60.
    #[tokio::test]
    async fn the_unlock_answer_carries_prefs() {
        let scratch = ScratchDir::new("store-prefs");
        let files = data_files_in(scratch.path().join("home"));
        let (me, app) = new_account(&files, "ana");
        {
            let loaded = load_session(&files, &me, Some(&app), None).unwrap();
            let cell = StorageCell::default();
            cell.set(loaded.storage);
            cell.write_prefs(br#"{"ttl:bob":60}"#).unwrap();
        }
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let loaded = load_session(&files, &me, Some(&app), None).unwrap();

        let opened = open_session(&inner, me, None, Some(loaded), |_| {})
            .await
            .unwrap();

        assert_eq!(opened.prefs, Some(serde_json::json!({ "ttl:bob": 60 })));
        assert_eq!(opened.integrity, None, "nothing changed");
    }

    #[tokio::test]
    async fn what_changed_on_disk_reaches_the_unlock_answer() {
        let scratch = ScratchDir::new("store-report");
        let files = data_files_in(scratch.path().join("home"));
        let (me, app) = new_account(&files, "ana");
        let account = files.home.join(STORE_DIR).join("account.bin");
        let mut bytes = std::fs::read(&account).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        std::fs::write(&account, &bytes).unwrap();
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let loaded = load_session(&files, &me, Some(&app), None).unwrap();

        let opened = open_session(&inner, me, None, Some(loaded), |_| {})
            .await
            .unwrap();

        // Design §6.1: an altered account is set aside and the session
        // opens without a profile, as "anon".
        assert_eq!(opened.handle, "anon");
        let report = opened.integrity.expect("the change is reported");
        let finding = report.find("account").unwrap();
        assert_eq!(
            (finding.what, finding.action),
            (What::Altered, Action::SetAside)
        );
    }

    #[test]
    fn an_account_that_does_not_parse_is_held_and_never_written() {
        let scratch = ScratchDir::new("store-account-held");
        let files = data_files_in(scratch.path().join("home"));
        let (me, app) = new_account(&files, "ana");
        {
            let loaded = load_session(&files, &me, Some(&app), None).unwrap();
            let cell = StorageCell::default();
            cell.set(loaded.storage);
            // A newer version's account, say: it opens, but does not read.
            cell.write_raw(&Slot::Account, b"{\"not\":\"an account\"}")
                .unwrap();
        }

        let loaded = load_session(&files, &me, Some(&app), None).unwrap();

        assert!(loaded.account.is_none());
        let finding = loaded.report.find("account").cloned().unwrap();
        assert_eq!(finding.action, Action::KeepForLater);
        let cell = StorageCell::default();
        cell.set(loaded.storage);
        assert!(cell.write_account(&AccountFile::default()).is_err());
    }

    /// Design §12.3, test 22 (H4).
    #[test]
    fn stickers_need_the_open_session() {
        let cell = StorageCell::default();
        assert!(import_sticker_into(&cell, b"\x89PNG", "image/png").is_err());
        assert!(list_stickers_in(&cell).is_err());
        assert!(delete_sticker_in(&cell, "00").is_err());
    }

    #[test]
    fn a_sticker_goes_to_the_store_and_keeps_its_id() {
        let scratch = ScratchDir::new("sticker-cmds");
        let cell = store_cell(scratch.path());
        let image = b"\x89PNG a sticker";
        let id = hex::encode(&crate::crypto::sha256(image)[..8]);

        let info = import_sticker_into(&cell, image, "image/png").unwrap();

        assert_eq!(info.id, id);
        let listed = list_stickers_in(&cell).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].data_url, info.data_url);
        assert!(listed[0].data_url.starts_with("data:image/png;base64,"));
        let stickers = scratch.path().join(STORE_DIR).join("stickers");
        assert_eq!(names_in(&stickers).len(), 1);
        assert!(!names_in(&stickers)[0].contains(&id));

        delete_sticker_in(&cell, &id).unwrap();
        assert!(list_stickers_in(&cell).unwrap().is_empty());
        assert!(names_in(&stickers).is_empty());
    }

    #[test]
    fn an_account_not_moved_yet_keeps_its_stickers_as_before() {
        let scratch = ScratchDir::new("sticker-legacy");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        let cell = StorageCell::default();
        cell.set(Storage::Legacy(Box::new(legacy_files(&files, &me))));
        let image = b"GIF89a a sticker";
        let id = hex::encode(&crate::crypto::sha256(image)[..8]);

        import_sticker_into(&cell, image, "image/gif").unwrap();

        let dir = scratch.path().join("stickers");
        assert_eq!(names_in(&dir), [format!("{id}.gif")]);
        assert_eq!(list_stickers_in(&cell).unwrap()[0].id, id);
        delete_sticker_in(&cell, &id).unwrap();
        assert!(names_in(&dir).is_empty());
    }

    /// Design §12.3, test 23. A version 2 vault authenticates the flag
    /// (trino-core): only a version 1 vault can say otherwise than it holds.
    #[test]
    fn the_totp_flag_that_disagrees_with_the_vault_is_reported_and_fixed() {
        let header = |version: u8, flags: u8| {
            encode_vault(&crate::vault::SealedVault {
                version,
                flags,
                salt: [7; 16],
                nonce: [9; 12],
                ciphertext: vec![1; 48],
            })
        };
        // Flag 1 says "no TOTP".
        assert!(totp_flag_disagrees(&header(1, 1), true));
        assert!(totp_flag_disagrees(&header(1, 0), false));
        assert!(!totp_flag_disagrees(&header(1, 0), true));
        assert!(!totp_flag_disagrees(&header(1, 1), false));
        assert!(!totp_flag_disagrees(&header(2, 1), true));
        assert!(!totp_flag_disagrees(b"not a vault", true));

        // Fixed by sealing again, even with no prekey due.
        let mut identity = create_identity();
        let soon = identity.signed_prekey.created_at + 60;
        let mut saved = None;
        let outcome = reseal_if_needed(
            &mut identity,
            None,
            None,
            PASSPHRASE,
            soon,
            true,
            |bytes, _spk| {
                saved = Some(bytes.to_vec());
                Ok(())
            },
        );
        assert_eq!(outcome, Some(Ok(())));
        assert!(!vault_requires_totp(&saved.unwrap()).unwrap());
    }

    /// Design §12.3, test 59.
    #[test]
    fn lock_wipes_contact_group_and_own_names() {
        let admin = create_identity();
        let bob = create_identity();
        let mut inner = InnerState {
            identity: Some(admin.clone()),
            handle: Some("Ana Secreta".into()),
            ..InnerState::default()
        };
        inner
            .friends
            .insert("Bob Secreto".into(), friend(&bob, "Bob Secreto"));
        let roster = group::create_group(
            &admin,
            MemberBundle::from_public_bundle("Ana Secreta", &public_bundle_for(&admin)),
            "Grupo Secreto",
        )
        .unwrap();
        inner.groups.insert(roster.group_id.clone(), roster.clone());
        inner.group_invites.insert(
            roster.group_id.clone(),
            GroupInvite {
                roster,
                from_handle: "Bob Secreto".into(),
                received_at: NOW,
            },
        );
        inner.blocked.insert("ab".repeat(32));

        zeroize_names(&mut inner);

        assert_eq!(inner.handle.as_deref().unwrap_or_default(), "");
        assert!(inner.friends.is_empty());
        assert!(inner.groups.is_empty());
        assert!(inner.group_invites.is_empty());
        assert!(inner.blocked.is_empty());
    }

    /// The real `clear_sensitive_state` wipes the names and drops the
    /// storage, with its data key.
    #[test]
    fn lock_drops_the_storage_and_the_names() {
        let scratch = ScratchDir::new("lock-storage");
        let mut inner = InnerState {
            identity: Some(create_identity()),
            handle: Some("Ana".into()),
            storage: store_cell(scratch.path()),
            ..InnerState::default()
        };

        clear_sensitive_state(&mut inner);

        assert!(!inner.storage.is_open());
        assert_eq!(inner.handle, None);
    }

    /// Records what a wipe does, and does it.
    #[derive(Default)]
    struct Recording(Vec<String>);

    impl WipeOps for Recording {
        fn destroy(&mut self, path: &Path) -> std::io::Result<()> {
            self.0.push(format!(
                "destroy {}",
                path.file_name().unwrap().to_string_lossy()
            ));
            RealWipe.destroy(path)
        }

        fn remove_dir(&mut self, path: &Path) -> std::io::Result<()> {
            self.0.push(format!(
                "remove {}",
                path.file_name().unwrap().to_string_lossy()
            ));
            RealWipe.remove_dir(path)
        }
    }

    /// Design §12.3, test 26, without keys.bin and keys.bak: the data key
    /// lives in the vault (decision 2), so the vault goes first.
    #[test]
    fn wipe_destroys_the_vault_first_then_store_and_leftovers() {
        let scratch = ScratchDir::new("wipe-order");
        let home = scratch.path();
        let files = data_files_in(home.to_path_buf());
        let (_, _) = new_account(&files, "ana");
        let other = home.join(format!("{OTHER_STORE_PREFIX}0001"));
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("index.bin"), b"x").unwrap();
        for legacy in [
            "config.json",
            "friends.json",
            "history.bin",
            "profiles.bin.damaged",
        ] {
            std::fs::write(home.join(legacy), b"old").unwrap();
        }
        std::fs::write(home.join(".history.bin.tmp-1-2-3"), b"cut").unwrap();
        std::fs::create_dir_all(home.join("stickers")).unwrap();
        std::fs::write(home.join("stickers").join("00.png"), b"img").unwrap();
        std::fs::write(home.join("notes.txt"), b"not trino's").unwrap();
        let mut ops = Recording::default();

        let failures = wipe_home(home, &mut ops);

        assert!(failures.is_empty(), "{failures:?}");
        assert_eq!(ops.0[0], "destroy vault.bin");
        assert_eq!(ops.0[1], "remove store");
        assert!(ops.0.contains(&format!("remove {OTHER_STORE_PREFIX}0001")));
        assert_eq!(names_in(home), ["notes.txt"]);
    }

    #[test]
    fn destroying_a_file_overwrites_it_before_removing_it() {
        let scratch = ScratchDir::new("destroy");
        let path = scratch.path().join("vault.bin");
        let original = vec![0x41u8; 4096];
        std::fs::write(&path, &original).unwrap();
        // A second name for the same data: what a disk keeps after removal.
        let link = scratch.path().join("link.bin");
        std::fs::hard_link(&path, &link).unwrap();

        destroy_file(&path).unwrap();

        assert!(!path.exists());
        let left = std::fs::read(&link).unwrap();
        assert_eq!(left.len(), original.len());
        assert_ne!(left, original, "removed without overwriting");
        destroy_file(&path).unwrap();
    }

    /// Design §12.3, test 28.
    #[test]
    fn accepting_an_invite_writes_one_file_not_three() {
        let scratch = ScratchDir::new("invite-one-write");
        let admin = create_identity();
        let me = create_identity();
        let mut inner = InnerState {
            identity: Some(me.clone()),
            storage: store_cell(scratch.path()),
            ..InnerState::default()
        };
        inner
            .friends
            .insert("admin".into(), friend(&admin, "admin"));
        let roster = group::add_member(
            &group::create_group(
                &admin,
                MemberBundle::from_public_bundle("admin", &public_bundle_for(&admin)),
                "amigos",
            )
            .unwrap(),
            &admin,
            MemberBundle::from_public_bundle("me", &public_bundle_for(&me)),
        )
        .unwrap();
        let gid = roster.group_id.clone();
        inner.group_invites.insert(
            gid.clone(),
            GroupInvite {
                roster,
                from_handle: "admin".into(),
                received_at: NOW,
            },
        );
        let before = inner.storage.index_seq().unwrap();

        accept_invite(&mut inner, &gid, NOW).unwrap();

        // One data file, then its index: one step of the counter.
        assert_eq!(inner.storage.index_seq().unwrap(), before + 1);
        let account: AccountFile = match reopen(scratch.path()).account {
            Found::Ready(bytes) => serde_json::from_slice(&bytes).unwrap(),
            _ => panic!("no account"),
        };
        assert_eq!(account.groups.len(), 1);
        assert!(account.group_invites.is_empty());
    }

    /// A store whose account waits for the user's choice opens as "anon";
    /// taking the older copy brings its contacts back, together with any
    /// added since, and saves them.
    #[test]
    fn an_account_chosen_in_the_dialog_joins_the_session() {
        let scratch = ScratchDir::new("choose-account");
        let files = data_files_in(scratch.path().to_path_buf());
        let (me, app) = new_account(&files, "ana");
        let account_path = files.home.join(STORE_DIR).join("account.bin");
        let older = std::fs::read(&account_path).unwrap();
        {
            let loaded = load_session(&files, &me, Some(&app), None).unwrap();
            let cell = StorageCell::default();
            cell.set(loaded.storage);
            let mut newer = AccountFile {
                handle: "ana nueva".into(),
                ..AccountFile::default()
            };
            newer.relays = default_relays();
            cell.write_account(&newer).unwrap();
        }
        std::fs::write(&account_path, &older).unwrap();
        let loaded = load_session(&files, &me, Some(&app), None).unwrap();
        assert!(loaded.account.is_none());
        let mut inner = InnerState {
            identity: Some(me.clone()),
            ..InnerState::default()
        };
        inner.storage.set(loaded.storage);
        apply_loaded(
            &mut inner,
            None,
            loaded.history,
            loaded.sessions,
            loaded.profiles,
            NOW,
        );
        assert_eq!(inner.handle.as_deref(), Some("anon"));
        let carol = create_identity();
        inner
            .friends
            .insert("carol".into(), friend(&carol, "carol"));

        let left = choose_in(&mut inner, "account", true).unwrap();

        assert!(left.find("account").is_none());
        assert_eq!(inner.handle.as_deref(), Some("ana"));
        assert!(inner.friends.contains_key("carol"), "a contact added since");
        let again = load_session(&files, &me, Some(&app), None).unwrap();
        assert!(again.report.is_empty());
        let account = again.account.unwrap();
        assert_eq!(account.handle, "ana");
        assert_eq!(account.friends.len(), 1);
    }

    /// A re-seal notes the vault's header first, so the next unlock takes
    /// the new vault in silence; a vault put in its place is reported.
    #[test]
    fn a_reseal_noted_in_the_store_is_not_reported_and_another_vault_is() {
        let scratch = ScratchDir::new("vault-noted");
        let files = data_files_in(scratch.path().to_path_buf());
        let (me, app) = new_account(&files, "ana");
        let first = std::fs::read(&files.vault).unwrap();
        let spk = me.signed_prekey.id;
        let mut loaded = load_session(&files, &me, Some(&app), Some(&first)).unwrap();
        assert!(loaded.report.is_empty());

        let opened = open_vault(&files.vault, PASSPHRASE, None).unwrap();
        let resealed = encode_vault(
            &seal_vault(
                &opened.identity,
                None,
                opened.app.as_deref().map(Vec::as_slice),
                PASSPHRASE,
            )
            .unwrap(),
        );
        write_vault_noted(Some(&mut loaded.storage), &files.vault, &resealed, spk).unwrap();
        drop(loaded);

        let again = load_session(&files, &me, Some(&app), Some(&resealed)).unwrap();
        assert!(again.report.is_empty(), "{:?}", again.report);
        drop(again);
        // The older vault.bin put back is not the one noted.
        let back = load_session(&files, &me, Some(&app), Some(&first)).unwrap();
        let finding = back.report.find("vault").cloned().unwrap();
        assert_eq!(finding.what, What::VaultChanged);
    }

    #[test]
    fn a_legacy_account_loads_from_its_files_and_holds_a_history_that_does_not_open() {
        let scratch = ScratchDir::new("legacy-load");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        let config = ConfigFile {
            handle: "ana".into(),
            nostr_pub: hex::encode(me.nostr.pub_bytes),
            relays: vec!["wss://relay.example".into()],
            created_at: NOW,
            avatar: None,
        };
        std::fs::write(&files.config, serde_json::to_vec(&config).unwrap()).unwrap();
        std::fs::write(&files.history, b"a damaged history").unwrap();

        let loaded = load_session(&files, &me, None, None).unwrap();

        let account = loaded.account.unwrap();
        assert_eq!(account.handle, "ana");
        assert_eq!(account.relays, ["wss://relay.example"]);
        assert!(matches!(loaded.history, Found::Held));
        assert!(matches!(loaded.sessions, Found::Absent));
        let cell = StorageCell::default();
        cell.set(loaded.storage);
        assert!(cell.write_history(b"{}").is_err());
        assert_eq!(std::fs::read(&files.history).unwrap(), b"a damaged history");
        assert!(!files.home.join(STORE_DIR).exists());
    }
}
