use crate::blossom;
use crate::call_signal::validate_call_signal;
use crate::command_error::{CommandError, ErrorCode};
use crate::connection::{ConnectionStatus, Debouncer, CONNECTION_CHANGED_EVENT, DEBOUNCE};
use crate::envelope::{decode_envelope, encode_envelope, Envelope};
use crate::fsutil;
use crate::group::{self, FileRef, GroupRoster, MemberBundle, RosterDecision};
use crate::identity::{
    create_identity, decode_array_32, public_bundle_for, verify_bundle_binding, Identity,
};
use crate::nostr::{
    build_and_sign_event, CatchUp, ClientOptions, NostrClient, NostrEvent, NostrFilter,
    StateHandler, TRINO_KIND,
};
use crate::passphrase::validate_passphrase;
use crate::ratchet::{
    init_initiator, init_responder, ratchet_decrypt, ratchet_encrypt, EncryptedMessage,
    MessageHeader, RatchetError, RatchetState,
};
use crate::state::{
    config_path, default_relays, friends_path, group_invites_path, groups_path, history_path,
    profiles_path, ratchets_path, trino_home, vault_path, AppState, ConfigFile, FriendRecord,
    FriendsFile, GroupInvite, HandshakeMark, HistItem, InnerState,
};
use crate::totp_enrollment::TotpBeginResponse;
use crate::turn::TurnCache;
use crate::vault::{decode_vault, encode_vault, seal_vault, unseal_vault, vault_requires_totp};
use crate::x3dh::{initiate, respond, InitialMessage, X3dhError};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use zeroize::{Zeroize, Zeroizing};

const MAX_INLINE_RASTER_BYTES: usize = 128 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;
const MAX_STICKER_BYTES: usize = 5 * 1024 * 1024;
const MAX_ICE_CONFIG_BYTES: usize = 16 * 1024;
/// How fresh an undecryptable event must be to be allowed to tear down a
/// session (see the auto-heal path). Wide enough to absorb clock skew between
/// peers, far tighter than the 24h catch-up window an attacker would replay
/// from. NOTE: if outgoing timestamps ever get jittered (NIP-17), this must be
/// >= that jitter or legitimate desyncs will stop healing.
const AUTO_HEAL_MAX_AGE_SECS: i64 = 600;
/// How far back the messaging subscription reaches for events sent while this
/// device was offline. Events older than this are lost (a known limitation).
const CATCH_UP_WINDOW_SECS: i64 = 86_400;
/// Clock skew between peers that we tolerate: how far in the future a
/// handshake may claim to be, and how much a re-subscription overlaps the time
/// the previous connection already covered.
const CLOCK_SKEW_SECS: i64 = 600;
/// Oldest handshake we accept. Equal to the catch-up window, because that is
/// how far back our subscription legitimately delivers: a peer who started a
/// session while we were offline must still get it accepted, or the messages
/// that follow it are lost. Anything older can only be a replay (relays are
/// free to ignore `since`). Replays inside the window are stopped by the
/// per-contact `HandshakeMark` instead.
const HANDSHAKE_MAX_AGE_SECS: i64 = CATCH_UP_WINDOW_SECS;
/// Bound on `HandshakeMark::ek_pubs`.
const MAX_SAME_SECOND_HANDSHAKES: usize = 8;

#[derive(Serialize)]
pub struct StatusResponse {
    pub has_vault: bool,
    pub is_unsealed: bool,
    pub handle: Option<String>,
    pub nostr_pub: Option<String>,
    pub home_dir: String,
    /// Whether unlocking will ask for a TOTP code, from the vault header
    /// (`totp_hint`): `None` with no vault, or one this version cannot read.
    pub totp_enabled: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct UnsealResponse {
    pub handle: String,
    pub fingerprint: String,
    pub nostr_pub: String,
    /// Whether this call started the relay connections: false when the
    /// session was open already, as the call that opened it started them.
    pub relay_connection_started: bool,
}

/// What `forge` returns: the session it opened, as `unseal` describes it, and
/// the new identity's bundle to share.
#[derive(Serialize)]
pub struct ForgeResponse {
    #[serde(flatten)]
    pub session: UnsealResponse,
    pub bundle_json: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CallIceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Serialize)]
pub struct CallConfigResponse {
    pub ice_servers: Vec<CallIceServer>,
}

// -- W8 -- Contacts (K7, K8), groups (K9, K10), "delete for me" (K11) and
// the shared profile (K12). Child modules, so they reach the helpers of this
// file (sessions, sending, persistence) without making them public.
#[path = "contacts_cmds.rs"]
pub(crate) mod contacts_cmds;
#[path = "groups_cmds.rs"]
pub(crate) mod groups_cmds;
#[path = "history_cmds.rs"]
pub(crate) mod history_cmds;
#[path = "profile.rs"]
pub(crate) mod profile;

#[derive(Serialize)]
pub struct NodeInfo {
    pub handle: String,
    pub fingerprint: String,
    pub has_session: bool,
    pub added_at: i64,
    /// The photo of the profile the contact shares (K12), or else the one
    /// in its contact code.
    pub avatar: Option<String>,
    pub blocked: bool,
    /// SHA-256 of the identity keys in full (K7); `None` if they do not decode.
    pub identity_digest: Option<String>,
    /// The fingerprint before the user replaced this contact's keys, and
    /// when, until the user acknowledges it (K8).
    pub previous_fingerprint: Option<String>,
    pub key_changed_at: Option<i64>,
    /// The name and "about" of the profile the contact shares (K12). That
    /// name never replaces `handle`, the one given here.
    pub profile_name: Option<String>,
    pub about: Option<String>,
    /// The contact's Trino announced that it reads profile messages, so
    /// this identity's profile reaches it (K12).
    pub profile_sync: bool,
}

#[derive(Serialize, Clone)]
pub struct IncomingMessageEvent {
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct HandshakeNeededEvent {
    pub from_pubkey: String,
}

#[derive(Serialize, Clone)]
pub struct IncomingGroupMessageEvent {
    pub gid: String,
    pub from_handle: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct GroupUpdatedEvent {
    pub gid: String,
}

/// A pending group invitation, as shown to the user (`group-invite` event and
/// `list_group_invites`).
#[derive(Serialize, Clone)]
pub struct GroupInviteInfo {
    pub gid: String,
    pub name: String,
    pub from_handle: String,
    pub member_count: usize,
    pub received_at: i64,
}

#[derive(Serialize, Clone)]
pub struct FileMessageEvent {
    pub from_handle: String,
    pub gid: Option<String>,
    pub file: FileRef,
    pub timestamp: i64,
}

#[derive(Serialize, Clone)]
pub struct CallSignalEvent {
    pub from_handle: String,
    pub payload: String,
}

#[derive(Serialize)]
pub struct GroupInfo {
    pub gid: String,
    pub name: String,
    pub epoch: u64,
    pub is_admin: bool,
    pub member_count: usize,
    pub members: Vec<String>,
    /// The admin removed me, or deleted the group (K10): the newest roster
    /// does not list me. The chat stays readable.
    pub ended: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct WirePayload {
    header: WireHeader,
    nonce: String,
    ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    handshake: Option<WireHandshake>,
}

#[derive(Serialize, Deserialize, Clone)]
struct WireHeader {
    #[serde(rename = "dhPub")]
    dh_pub: String,
    pn: u32,
    n: u32,
}

#[derive(Serialize, Deserialize, Clone)]
struct WireHandshake {
    #[serde(rename = "ikDhPub")]
    ik_dh_pub: String,
    #[serde(rename = "ekPub")]
    ek_pub: String,
    #[serde(rename = "spkId")]
    spk_id: u32,
    #[serde(rename = "opkId")]
    opk_id: Option<u32>,
}

/// Human-verifiable fingerprint bound to ALL three public keys (ik_sign, ik_dh,
/// nostr), so comparing it out-of-band actually detects a swapped DH/Nostr key.
fn fp(ik_sign: &[u8; 32], ik_dh: &[u8; 32], nostr: &[u8; 32]) -> String {
    let mut input = Vec::with_capacity(96);
    input.extend_from_slice(ik_sign);
    input.extend_from_slice(ik_dh);
    input.extend_from_slice(nostr);
    let h = crate::crypto::sha256(&input);
    let hex = hex::encode(&h[..8]);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join(".")
}

/// A line for the diagnostic log, so silent failures in the receive path
/// leave a trace after a live test. Fixed text only, and only debug builds
/// keep the log: see diag.rs (T3).
fn dbg_log(text: &'static str) {
    crate::diag::note(text);
}

/// The notes of `merge_group_members` name members and prefixes of their
/// keys: the log only gets how many there were.
fn log_skipped_members(notes: &[String]) {
    if !notes.is_empty() {
        crate::diag::note_with("  group members skipped", &[("count", &notes.len())]);
    }
}

fn checked_inline_raster(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some((meta, payload)) = value.split_once(',') else {
        return Err("inline image must be a base64 data URL".to_string());
    };
    if !matches!(
        meta,
        "data:image/jpeg;base64"
            | "data:image/png;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
    ) {
        return Err("only inline jpeg/png/gif/webp images are allowed".to_string());
    }
    if payload.is_empty()
        || payload.len() > MAX_INLINE_RASTER_BYTES.div_ceil(3) * 4 + 4
        || payload.trim() != payload
    {
        return Err("inline image is empty or too large".to_string());
    }
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "inline image has invalid base64".to_string())?;
    if decoded.len() > MAX_INLINE_RASTER_BYTES {
        return Err("inline image is too large".to_string());
    }
    Ok(Some(value))
}

fn sanitized_inline_raster(value: Option<String>) -> Option<String> {
    checked_inline_raster(value).ok().flatten()
}

fn sanitize_file_ref(mut file: FileRef) -> FileRef {
    file.thumb = sanitized_inline_raster(file.thumb);
    file
}

fn sanitize_roster(mut roster: GroupRoster) -> GroupRoster {
    roster.photo = roster.photo.map(sanitize_file_ref);
    roster
}

fn zeroize_file_ref(file: &mut FileRef) {
    file.key.zeroize();
    if let Some(thumb) = file.thumb.as_mut() {
        thumb.zeroize();
    }
}

/// What `lock_vault` and `wipe` drop from memory: the relay connections,
/// the secrets and the TURN credentials, with any fetch of them in flight.
fn forget_session(inner: &mut InnerState, turn: &TurnCache) {
    for relay in inner.relays.drain(..) {
        relay.close();
    }
    clear_sensitive_state(inner);
    turn.clear();
}

fn clear_sensitive_state(inner: &mut InnerState) {
    // Both callers already drop `relays`; the inspector's sockets are closed
    // here so locking or wiping can never leave a connection behind.
    for client in inner.inspector_relays.drain(..) {
        client.close();
    }
    if let Some(secret) = inner.totp_secret.as_mut() {
        secret.zeroize();
    }
    inner.totp_secret = None;
    inner.totp_enrollment.clear();
    if let Some(key) = inner.history_key.as_mut() {
        key.zeroize();
    }
    inner.history_key = None;

    for ratchet in inner.ratchets.values_mut() {
        ratchet.zeroize_secrets();
    }
    inner.ratchets.clear();
    for ad in inner.associated_data.values_mut() {
        ad.zeroize();
    }
    inner.associated_data.clear();

    for items in inner.history.values_mut() {
        for item in items {
            if let Some(text) = item.text.as_mut() {
                text.zeroize();
            }
            if let Some(file) = item.file.as_mut() {
                zeroize_file_ref(file);
            }
        }
    }
    inner.history.clear();

    for items in inner.outbox.values_mut() {
        for (id, envelope, _) in items {
            id.zeroize();
            envelope.zeroize();
        }
    }
    inner.outbox.clear();

    if let Some(avatar) = inner.avatar.as_mut() {
        avatar.zeroize();
    }
    for friend in inner.friends.values_mut() {
        if let Some(avatar) = friend.avatar.as_mut() {
            avatar.zeroize();
        }
    }
    for roster in inner.groups.values_mut() {
        if let Some(photo) = roster.photo.as_mut() {
            zeroize_file_ref(photo);
        }
    }
    for invite in inner.group_invites.values_mut() {
        if let Some(photo) = invite.roster.photo.as_mut() {
            zeroize_file_ref(photo);
        }
    }

    inner.identity = None;
    inner.handle = None;
    inner.avatar = None;
    inner.friends.clear();
    inner.groups.clear();
    inner.group_invites.clear();
    inner.blocked.clear();
    inner.current_peer = None;
    inner.resync_at.clear();
    inner.handshake_marks.clear();
    inner.clear_seen_ids();
    // -- W8 --
    inner.key_mismatch_at.clear();
    inner.profiles.forget();
}

fn remove_file_for_wipe(path: &std::path::Path, failures: &mut Vec<String>) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("{}: {}", path.display(), error));
        }
    }
}

/// Delete `paths` for a wipe, together with any temporary copy of them that
/// `fsutil::atomic_write` left behind because the app died while saving.
fn remove_data_files(paths: &[PathBuf], failures: &mut Vec<String>) {
    for path in paths {
        for leftover in fsutil::leftover_temp_files(path) {
            remove_file_for_wipe(&leftover, failures);
        }
        remove_file_for_wipe(path, failures);
    }
}

fn remove_dir_for_wipe(path: &std::path::Path, failures: &mut Vec<String>) {
    if let Err(error) = std::fs::remove_dir_all(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            failures.push(format!("{}: {}", path.display(), error));
        }
    }
}

#[tauri::command]
pub async fn status(state: State<'_, AppState>) -> Result<StatusResponse, String> {
    let inner = state.inner.lock().await;
    let has_vault = vault_path().exists();
    // While the vault is sealed the handle is not in memory yet, so the unlock
    // screen used to fall back to a placeholder and greet its own user as
    // "local identity". The handle already sits unencrypted in config.json on
    // this same device, so reading it here costs no secrecy — it is only ever
    // shown to whoever already has the machine open.
    let handle = inner.handle.clone().or_else(|| {
        std::fs::read(config_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ConfigFile>(&bytes).ok())
            .map(|cfg| cfg.handle)
            .filter(|h| !h.is_empty())
    });
    Ok(StatusResponse {
        has_vault,
        is_unsealed: inner.identity.is_some(),
        handle,
        nostr_pub: inner
            .identity
            .as_ref()
            .map(|i| hex::encode(i.nostr.pub_bytes)),
        home_dir: trino_home().to_string_lossy().to_string(),
        totp_enabled: totp_hint(&vault_path()),
    })
}

/// Where the data files of the identity are. Passed in rather than read from
/// `trino_home()` so tests can create and open an identity in a scratch
/// directory.
#[derive(Clone)]
struct DataFiles {
    home: PathBuf,
    vault: PathBuf,
    config: PathBuf,
    friends: PathBuf,
    groups: PathBuf,
    group_invites: PathBuf,
    history: PathBuf,
    ratchets: PathBuf,
}

impl DataFiles {
    fn in_trino_home() -> Self {
        DataFiles {
            home: trino_home(),
            vault: vault_path(),
            config: config_path(),
            friends: friends_path(),
            groups: groups_path(),
            group_invites: group_invites_path(),
            history: history_path(),
            ratchets: ratchets_path(),
        }
    }
}

/// Create the files of a new identity with `write`.
///
/// vault.bin goes LAST: `status` reports an identity as soon as it exists,
/// and `unseal` cannot open one without config.json, so an interruption
/// halfway must never leave a vault without the files it needs. If a step
/// fails, the files and the data dir that this call created are removed
/// again. Nothing that was there before is removed: a config.json or
/// friends.json left by an earlier attempt is overwritten, as it always was.
fn create_identity_files(
    files: &DataFiles,
    config: &[u8],
    friends: &[u8],
    vault: &[u8],
    mut write: impl FnMut(&Path, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let home_existed = files.home.exists();
    std::fs::create_dir_all(&files.home)?;
    harden_dir(&files.home);
    let mut created: Vec<&Path> = Vec::new();
    for (path, bytes) in [
        (&files.config, config),
        (&files.friends, friends),
        (&files.vault, vault),
    ] {
        let existed = path.exists();
        if let Err(error) = write(path, bytes) {
            for path in created {
                let _ = std::fs::remove_file(path);
            }
            if !home_existed {
                // Only succeeds while empty, so nothing else can go with it.
                let _ = std::fs::remove_dir(&files.home);
            }
            return Err(error);
        }
        if !existed {
            created.push(path);
        }
    }
    Ok(())
}

/// Whether opening the vault at `vault` will ask for a TOTP code, from its
/// header alone: `None` if there is no vault, or one this version cannot
/// read. Whoever can write the file can flip the answer, so it only decides
/// what the unlock screen shows; `unseal` still answers `totp_required`
/// whenever the sealed vault holds a secret.
fn totp_hint(vault: &Path) -> Option<bool> {
    let bytes = std::fs::read(vault).ok()?;
    vault_requires_totp(&bytes).ok()
}

/// The name an identity gets: what the user typed, trimmed, or "anon" if
/// that leaves nothing.
fn display_handle(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() { "anon" } else { trimmed }.to_string()
}

/// The TOTP code typed at unlock, if any. An empty or blank field is no code,
/// so a vault with TOTP answers `totp_required`, not `invalid_totp`.
pub(crate) fn submitted_code(code: Option<&str>) -> Option<&str> {
    code.map(str::trim).filter(|code| !code.is_empty())
}

/// Create a new identity in `files`, its vault sealed with `passphrase` and,
/// if given, `totp_secret`. Nothing is written if an identity exists there
/// already or if the passphrase fails the policy.
fn create_account(
    files: &DataFiles,
    handle: &str,
    passphrase: &str,
    totp_secret: Option<&[u8]>,
    write: impl FnMut(&Path, &[u8]) -> std::io::Result<()>,
) -> Result<Identity, CommandError> {
    if files.vault.exists() {
        return Err(CommandError::new(
            ErrorCode::VaultExists,
            "an identity already exists here; wipe it first",
        ));
    }
    validate_passphrase(passphrase)?;

    let identity = create_identity();
    let sealed = seal_vault(&identity, totp_secret, passphrase)?;
    let config = ConfigFile {
        handle: handle.to_string(),
        nostr_pub: hex::encode(identity.nostr.pub_bytes),
        relays: default_relays(),
        created_at: chrono::Utc::now().timestamp(),
        avatar: None,
    };
    let friends = FriendsFile {
        handle: handle.to_string(),
        friends: vec![],
        blocked: vec![],
    };
    let config_json =
        serde_json::to_string_pretty(&config).map_err(|e| CommandError::internal(e.to_string()))?;
    let friends_json = serde_json::to_string_pretty(&friends)
        .map_err(|e| CommandError::internal(e.to_string()))?;
    create_identity_files(
        files,
        config_json.as_bytes(),
        friends_json.as_bytes(),
        &encode_vault(&sealed),
        write,
    )
    .map_err(|e| CommandError::io(&e))?;
    Ok(identity)
}

/// Open the vault at `vault` with `passphrase` and, if it holds a TOTP
/// secret, `totp_code`. Returns the identity and that secret. The settings
/// open it too, to seal it again (security_cmds.rs).
pub(crate) fn open_vault(
    vault: &Path,
    passphrase: &str,
    totp_code: Option<&str>,
) -> Result<(Identity, Option<Vec<u8>>), CommandError> {
    let bytes = std::fs::read(vault).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => {
            CommandError::new(ErrorCode::NoVault, "there is no identity on this device")
        }
        _ => CommandError::io(&error),
    })?;
    let blob = decode_vault(&bytes)?;
    Ok(unseal_vault(&blob, passphrase, totp_code)?)
}

/// Rotate the signed prekey if it has aged out and expire retired ones; if
/// that changed anything, seal the vault again, with the same passphrase and
/// the same TOTP secret or lack of one, and save it with `write`. `None` when
/// nothing was due.
///
/// Without rotation, one leaked signed prekey would expose every initial
/// message ever sent to us; retention is what keeps peers holding an older
/// cached bundle (and their auto-heal re-handshakes) working across the
/// change. It runs at unlock, the only point where the identity and the
/// passphrase are both at hand.
fn reseal_if_rotated(
    identity: &mut Identity,
    totp_secret: Option<&[u8]>,
    passphrase: &str,
    now: i64,
    write: impl FnOnce(&[u8]) -> std::io::Result<()>,
) -> Option<Result<(), CommandError>> {
    if !crate::identity::rotate_signed_prekey_if_due(identity, now) {
        return None;
    }
    Some(
        seal_vault(identity, totp_secret, passphrase)
            .map_err(CommandError::from)
            .and_then(|sealed| write(&encode_vault(&sealed)).map_err(|e| CommandError::io(&e))),
    )
}

/// What a session that was just opened connects to, and as whom.
struct RelayStart {
    relays: Vec<String>,
    nostr_pub: String,
    handle: String,
}

/// Load the session of an identity whose vault was just opened into `inner`,
/// then give `start_relays` what to connect to. `unseal` and `forge` both end
/// here, so the two always open a session the same way.
///
/// If that identity's session is open already, nothing is loaded or started
/// again: loading would throw away what changed in memory since (sessions
/// with contacts, contacts added), and a second set of relay connections
/// would deliver everything twice. Another identity's session is never
/// replaced.
async fn open_session(
    inner: &tokio::sync::Mutex<InnerState>,
    files: &DataFiles,
    identity: Identity,
    totp_secret: Option<Zeroizing<Vec<u8>>>,
    start_relays: impl FnOnce(RelayStart),
) -> Result<UnsealResponse, CommandError> {
    let fingerprint = fp(
        &identity.ik_sign.pub_bytes,
        &identity.ik_dh.pub_bytes,
        &identity.nostr.pub_bytes,
    );
    let nostr_pub = hex::encode(identity.nostr.pub_bytes);

    let mut inner = inner.lock().await;
    if let Some(open) = inner.identity.as_ref() {
        let open_fingerprint = fp(
            &open.ik_sign.pub_bytes,
            &open.ik_dh.pub_bytes,
            &open.nostr.pub_bytes,
        );
        if open_fingerprint != fingerprint {
            return Err(CommandError::internal(
                "another identity's session is open; lock it first",
            ));
        }
        return Ok(UnsealResponse {
            handle: inner.handle.clone().unwrap_or_default(),
            fingerprint,
            nostr_pub,
            relay_connection_started: false,
        });
    }

    harden_dir(&files.home); // tighten perms on existing installs too
    let cfg_bytes = std::fs::read(&files.config).map_err(|e| CommandError::io(&e))?;
    let mut cfg: ConfigFile = serde_json::from_slice(&cfg_bytes)
        .map_err(|e| CommandError::internal(format!("config.json: {e}")))?;
    cfg.avatar = sanitized_inline_raster(cfg.avatar);

    let friends_bytes = std::fs::read(&files.friends).unwrap_or_else(|_| {
        serde_json::to_vec(&FriendsFile {
            handle: cfg.handle.clone(),
            friends: vec![],
            blocked: vec![],
        })
        .unwrap()
    });
    let mut friends_file: FriendsFile = serde_json::from_slice(&friends_bytes)
        .map_err(|e| CommandError::internal(format!("friends.json: {e}")))?;
    for friend in &mut friends_file.friends {
        friend.avatar = sanitized_inline_raster(friend.avatar.take());
    }

    inner.history_key = Some(derive_history_key(&identity));
    inner.identity = Some(identity);
    // Moved out of its wrapper, which wipes what is left: an empty vector.
    inner.totp_secret = totp_secret.map(|mut secret| std::mem::take(&mut *secret));
    inner.handle = Some(cfg.handle.clone());
    inner.avatar = cfg.avatar.clone();
    inner.friends.clear();
    for f in friends_file.friends {
        inner.friends.insert(f.handle.clone(), f);
    }
    inner.blocked = friends_file.blocked.into_iter().collect();
    inner.groups.clear();
    if let Ok(bytes) = std::fs::read(&files.groups) {
        if let Ok(list) = serde_json::from_slice::<Vec<GroupRoster>>(&bytes) {
            for r in list {
                let r = sanitize_roster(r);
                inner.groups.insert(r.group_id.clone(), r);
            }
        }
    }
    inner.group_invites.clear();
    if let Ok(bytes) = std::fs::read(&files.group_invites) {
        if let Ok(list) = serde_json::from_slice::<Vec<GroupInvite>>(&bytes) {
            for mut invite in list {
                invite.roster = sanitize_roster(invite.roster);
                inner
                    .group_invites
                    .insert(invite.roster.group_id.clone(), invite);
            }
        }
    }
    inner.history.clear();
    load_history(&mut inner, &files.history);
    load_ratchets(&mut inner, &files.ratchets);
    // -- W8 (K12) --
    let profiles = files.home.join(profile::PROFILES_FILE);
    profile::load_into(&mut inner, &profiles, chrono::Utc::now().timestamp());
    drop(inner);

    let relays = if cfg.relays.is_empty() {
        default_relays()
    } else {
        cfg.relays
    };
    start_relays(RelayStart {
        relays,
        nostr_pub: nostr_pub.clone(),
        handle: cfg.handle.clone(),
    });

    Ok(UnsealResponse {
        handle: cfg.handle,
        fingerprint,
        nostr_pub,
        relay_connection_started: true,
    })
}

/// Starts the relay connections of a session `open_session` just opened.
fn relay_starter(app: AppHandle, state: &AppState) -> impl FnOnce(RelayStart) {
    let inner = state.inner.clone();
    move |start: RelayStart| {
        crate::diag::note_with(
            "session open, starting the relay connections",
            &[("relays", &start.relays.len())],
        );
        start_relay_connections(app, inner, start.relays, start.nostr_pub, start.handle);
    }
}

/// This identity's public bundle as contacts get it: the keys, the name and,
/// if there is one, the photo.
fn own_bundle_json(
    identity: &Identity,
    handle: &str,
    avatar: Option<&str>,
) -> Result<String, String> {
    let mut bundle =
        serde_json::to_value(public_bundle_for(identity)).map_err(|e| e.to_string())?;
    if let Some(fields) = bundle.as_object_mut() {
        fields.insert(
            "handle".to_string(),
            serde_json::Value::String(handle.to_string()),
        );
        if let Some(avatar) = avatar {
            fields.insert(
                "avatar".to_string(),
                serde_json::Value::String(avatar.to_string()),
            );
        }
    }
    serde_json::to_string(&bundle).map_err(|e| e.to_string())
}

/// Start setting up TOTP for a new identity: a fresh secret, in memory only,
/// to add to an authenticator app. Calling it again replaces the secret, and
/// any code that confirmed it. `label` names the account in the app; it is
/// the name the identity will get, so an empty one becomes "anon".
#[tauri::command]
pub async fn totp_begin(
    state: State<'_, AppState>,
    label: Option<String>,
) -> Result<TotpBeginResponse, CommandError> {
    let label = display_handle(label.as_deref().unwrap_or_default());
    Ok(state.inner.lock().await.totp_enrollment.begin(&label))
}

/// Check a code from the authenticator app against the secret from
/// `totp_begin`. A valid one confirms that secret for `forge`.
#[tauri::command]
pub async fn totp_verify(state: State<'_, AppState>, code: String) -> Result<bool, CommandError> {
    let code = Zeroizing::new(code);
    state.inner.lock().await.totp_enrollment.verify(&code)
}

/// Where `forge_identity` takes the new vault's TOTP secret from.
enum NewVaultTotp {
    /// No TOTP: the passphrase alone opens the vault.
    Off,
    /// The secret from `totp_begin`, once `totp_verify` has confirmed it.
    Confirmed,
}

/// Create a new identity and open its session at once: the first-run screens
/// go on to the chats without an unlock in between.
///
/// The vault is sealed with `passphrase`, which must pass the policy, and,
/// with `use_totp`, with the TOTP secret confirmed through `totp_begin` and
/// `totp_verify`. An empty `handle` becomes "anon".
#[tauri::command]
pub async fn forge(
    app: AppHandle,
    state: State<'_, AppState>,
    handle: String,
    passphrase: String,
    use_totp: bool,
) -> Result<ForgeResponse, CommandError> {
    let totp = if use_totp {
        NewVaultTotp::Confirmed
    } else {
        NewVaultTotp::Off
    };
    forge_identity(app, &state, handle, passphrase, totp).await
}

/// `forge`, once it knows whether the vault gets the confirmed TOTP secret.
async fn forge_identity(
    app: AppHandle,
    state: &AppState,
    handle: String,
    passphrase: String,
    totp: NewVaultTotp,
) -> Result<ForgeResponse, CommandError> {
    // Wiped when dropped, whichever way this returns.
    let passphrase = Zeroizing::new(passphrase);
    let _gate = state.session_gate.lock().await;
    let totp_secret = {
        let inner = state.inner.lock().await;
        if inner.identity.is_some() {
            return Err(CommandError::new(
                ErrorCode::VaultExists,
                "an identity is open on this device",
            ));
        }
        match totp {
            NewVaultTotp::Off => None,
            NewVaultTotp::Confirmed => Some(Zeroizing::new(
                inner.totp_enrollment.verified_secret()?.to_vec(),
            )),
        }
    };
    let handle = display_handle(&handle);
    let files = DataFiles::in_trino_home();
    crate::diag::remove_stale_log(&files.home, crate::diag::Build::CURRENT);

    // PBKDF2 is slow on purpose: off the async runtime, as in `unseal`.
    let (identity, totp_secret) = tokio::task::spawn_blocking({
        let files = files.clone();
        let handle = handle.clone();
        move || {
            let secret = totp_secret.as_deref().map(Vec::as_slice);
            create_account(&files, &handle, &passphrase, secret, fsutil::atomic_write)
                .map(|identity| (identity, totp_secret))
        }
    })
    .await
    .map_err(|_| CommandError::internal("identity creation worker failed"))??;

    // Sealed into the vault now. On failure it stays, so a retry needs no
    // new QR code.
    state.inner.lock().await.totp_enrollment.clear();
    let bundle_json = own_bundle_json(&identity, &handle, None).map_err(CommandError::internal)?;
    // A new session never inherits TURN credentials (lock and wipe clear them too).
    state.turn.clear();
    let starter = relay_starter(app, state);
    let session = open_session(&state.inner, &files, identity, totp_secret, starter).await?;
    Ok(ForgeResponse {
        session,
        bundle_json,
    })
}

/// Start the relay connections of a session `open_session` just opened.
///
/// Every relay gets its client at once (K3). One that is down keeps being
/// tried while the session is open, instead of being given up until the next
/// unlock, and counts as down in `connection_status` meanwhile. Whenever a
/// socket comes up or goes down, the UI gets a debounced
/// `connection-changed`.
fn start_relay_connections(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
    relays: Vec<String>,
    expected_nostr_pub: String,
    expected_handle: String,
) {
    tauri::async_runtime::spawn(async move {
        let changes = Arc::new(connection_changes(app.clone(), state_inner.clone()));
        let mut clients = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for relay_url in relays {
            if !seen.insert(relay_url.clone()) {
                continue;
            }
            let on_event = incoming_events(app.clone(), state_inner.clone());
            let on_state: StateHandler = {
                let changes = Arc::clone(&changes);
                Arc::new(move |_up| changes.poke())
            };
            let client =
                NostrClient::start(&relay_url, on_event, ClientOptions::new(Some(on_state)));
            // Catch up on messages sent while this device was offline: the
            // whole window on the first connection, and on every reconnect
            // only what this relay may not have delivered yet (so the window
            // does not grow with uptime). Duplicate event ids and ratchet
            // state are checked before anything reaches the UI. Sent once the
            // socket is up.
            let _ = client
                .subscribe_catching_up(
                    &NostrFilter {
                        kinds: Some(vec![TRINO_KIND]),
                        p_tag: Some(vec![expected_nostr_pub.clone()]),
                        ..Default::default()
                    },
                    CatchUp {
                        max_window_secs: CATCH_UP_WINDOW_SECS,
                        overlap_secs: CLOCK_SKEW_SECS,
                    },
                )
                .await;
            clients.push(client);
        }

        let mut inner = state_inner.lock().await;
        let same_identity =
            inner.identity.as_ref().is_some_and(|identity| {
                hex::encode(identity.nostr.pub_bytes) == expected_nostr_pub
            }) && inner.handle.as_deref() == Some(expected_handle.as_str());
        if same_identity {
            inner.relays.extend(clients);
            drop(inner);
            // The UI learns how many relays there are before any is up.
            changes.poke();
        } else {
            drop(inner);
            for client in clients {
                client.close();
            }
        }
    });
}

/// What a relay of the session delivers goes to `handle_incoming_event`.
fn incoming_events(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
) -> Arc<dyn Fn(NostrEvent) + Send + Sync> {
    Arc::new(move |event: NostrEvent| {
        let app = app.clone();
        let inner = state_inner.clone();
        tokio::spawn(async move {
            handle_incoming_event(app, inner, event).await;
        });
    })
}

/// Emits `connection-changed` with the status of the session's relays at
/// most once per `DEBOUNCE` (K3).
fn connection_changes(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<InnerState>>,
) -> Debouncer {
    Debouncer::spawn(DEBOUNCE, move || {
        let app = app.clone();
        let inner = state_inner.clone();
        async move {
            let status = ConnectionStatus::of(&inner.lock().await.relays);
            let _ = app.emit(CONNECTION_CHANGED_EVENT, status);
        }
    })
}

/// Open the vault with `passphrase` and, if it has TOTP, `totp_code` (empty
/// or blank counts as none), then open its session. If that session is open
/// already, this only checks the passphrase and the code again: no prekey
/// rotation, nothing loaded twice and no second set of relay connections.
#[tauri::command]
pub async fn unseal(
    app: AppHandle,
    state: State<'_, AppState>,
    passphrase: String,
    totp_code: Option<String>,
) -> Result<UnsealResponse, CommandError> {
    // Wiped when dropped, whichever way this returns.
    let passphrase = Zeroizing::new(passphrase);
    let totp_code = totp_code.map(Zeroizing::new);
    let _gate = state.session_gate.lock().await;
    let session_open = state.inner.lock().await.identity.is_some();
    let files = DataFiles::in_trino_home();
    crate::diag::remove_stale_log(&files.home, crate::diag::Build::CURRENT);
    let vault = files.vault.clone();

    let (identity, totp_secret) = tokio::task::spawn_blocking(move || {
        let code = submitted_code(totp_code.as_deref().map(String::as_str));
        let (mut identity, totp_secret) = open_vault(&vault, &passphrase, code)?;
        let totp_secret = totp_secret.map(Zeroizing::new);
        if !session_open {
            let now = chrono::Utc::now().timestamp();
            let save = |bytes: &[u8]| fsutil::atomic_write(&vault, bytes);
            let secret = totp_secret.as_deref().map(Vec::as_slice);
            match reseal_if_rotated(&mut identity, secret, &passphrase, now, save) {
                None => {}
                Some(Ok(())) => crate::diag::note_with(
                    "signed prekey rotated",
                    &[
                        ("spk_id", &identity.signed_prekey.id),
                        ("retired", &identity.retired_signed_prekeys.len()),
                    ],
                ),
                // Keep the session usable; we simply retry next unlock.
                Some(Err(_)) => dbg_log("signed prekey rotation could not be saved"),
            }
        }
        Ok::<_, CommandError>((identity, totp_secret))
    })
    .await
    .map_err(|_| CommandError::internal("vault unlock worker failed"))??;

    if !session_open {
        // A new session never inherits TURN credentials (lock and wipe clear them too).
        state.turn.clear();
    }
    let starter = relay_starter(app, &state);
    open_session(&state.inner, &files, identity, totp_secret, starter).await
}

/// What the transport relay can see about one event. Deliberately metadata
/// only: the id, who published it, who it is addressed to, its size and its
/// timestamp — exactly what a relay operator already observes. The encrypted
/// content is never included.
#[derive(Clone, Serialize)]
pub struct RelayObservation {
    pub relay: String,
    pub id: String,
    pub from: String,
    pub to: String,
    pub size: usize,
    pub created_at: i64,
}

/// Open read-only connections to the relays this device is ACTUALLY using and
/// stream back the metadata each one can see.
///
/// These are separate sockets from the messaging ones on purpose. The inspector
/// subscribes to all trino traffic — that is the whole point, showing that the
/// relay sees blobs it cannot read — whereas the messaging subscription is
/// filtered to events addressed to us. Feeding strangers' events into the
/// decryption pipeline would be wasteful at best and a footgun at worst.
#[tauri::command]
pub async fn relay_inspect_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let urls: Vec<String> = {
        let mut inner = state.inner.lock().await;
        // Drop anything left over from a previous inspection first.
        for client in inner.inspector_relays.drain(..) {
            client.close();
        }
        inner.relays.iter().map(|c| c.url().to_string()).collect()
    };
    if urls.is_empty() {
        return Err("no relay connections to inspect".to_string());
    }

    let mut connected = Vec::new();
    for url in urls {
        let app_for_events = app.clone();
        let relay_for_events = url.clone();
        let on_event: Arc<dyn Fn(NostrEvent) + Send + Sync> = Arc::new(move |event: NostrEvent| {
            let to = event.recipient().unwrap_or_default().to_string();
            let _ = app_for_events.emit(
                "relay-event",
                RelayObservation {
                    relay: relay_for_events.clone(),
                    id: event.id.clone(),
                    from: event.pubkey.clone(),
                    to,
                    size: event.content.len(),
                    created_at: event.created_at,
                },
            );
        });

        match NostrClient::connect(&url, on_event).await {
            Ok(client) => {
                let _ = client
                    .subscribe(&NostrFilter {
                        kinds: Some(vec![TRINO_KIND]),
                        limit: Some(40),
                        ..Default::default()
                    })
                    .await;
                state.inner.lock().await.inspector_relays.push(client);
                connected.push(url);
            }
            Err(_) => dbg_log("  inspector relay connection failed"),
        }
    }

    if connected.is_empty() {
        return Err("could not reach any relay".to_string());
    }
    Ok(connected)
}

#[tauri::command]
pub async fn relay_inspect_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    for client in inner.inspector_relays.drain(..) {
        client.close();
    }
    Ok(())
}

#[tauri::command]
pub async fn share_bundle(state: State<'_, AppState>) -> Result<String, String> {
    let inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    own_bundle_json(
        identity,
        inner.handle.as_deref().unwrap_or_default(),
        inner.avatar.as_deref(),
    )
}

/// Add the contact of a code as `handle` (K8). A name another key holds is
/// `name_taken` unless `replace_existing`, which the UI passes only after
/// the user confirmed; the same keys under another name are
/// `already_contact`; a new name the chats would read as the channel or a
/// group, or that holds control, format or bidi characters or shows
/// nothing, is `invalid_name`. Callers from before K8 leave
/// `replace_existing` out.
#[tauri::command]
pub async fn probe_node(
    state: State<'_, AppState>,
    bundle_json: String,
    handle: String,
    replace_existing: Option<bool>,
) -> Result<NodeInfo, CommandError> {
    let code = contacts_cmds::parse_contact_code(&bundle_json)?;
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err(contacts_cmds::sealed());
    }
    let now = chrono::Utc::now().timestamp();
    let replace = replace_existing.unwrap_or(false);
    let (handle, added) = contacts_cmds::add_contact(&mut inner, code, &handle, replace, now)?;
    persist_friends(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    if added != contacts_cmds::Added::Refreshed {
        // The old session is gone, and what the old keys shared: the
        // replaced contact's, or what a contact removed before left under
        // this name.
        save_ratchets(&inner);
        save_history(&inner);
        profile::save(&inner);
    }
    let friend = inner
        .friends
        .get(&handle)
        .ok_or_else(|| CommandError::internal("the contact was not stored"))?;
    Ok(contacts_cmds::node_info(&inner, friend))
}

#[tauri::command]
pub async fn list_nodes(state: State<'_, AppState>) -> Result<Vec<NodeInfo>, String> {
    let inner = state.inner.lock().await;
    let mut out: Vec<NodeInfo> = inner
        .friends
        .values()
        .map(|f| contacts_cmds::node_info(&inner, f))
        .collect();
    out.sort_by_key(|item| std::cmp::Reverse(item.added_at));
    Ok(out)
}

#[tauri::command]
pub async fn connect_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    if inner.ratchets.contains_key(&handle) {
        inner.current_peer = Some(handle);
        return Ok(());
    }

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    send_cipher_inner(&state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Force a fresh handshake with a peer, discarding any existing session. Unlike
/// connect_node this never early-returns on an existing ratchet — it's the
/// deterministic recovery path for auto-heal (both AEAD desync and no-session).
#[tauri::command]
pub async fn resync_session(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let friend = inner.friends.get(&handle).ok_or("unknown node")?.clone();

    inner.ratchets.remove(&handle);
    inner.associated_data.remove(&handle);

    let init = initiate(&identity, &friend.bundle).map_err(|e| e.to_string())?;
    let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| e.to_string())?;
    let state_ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| e.to_string())?;
    inner.ratchets.insert(handle.clone(), state_ratchet);
    inner
        .associated_data
        .insert(handle.clone(), init.associated_data.clone());
    inner.current_peer = Some(handle.clone());
    save_ratchets(&inner);

    let handshake = WireHandshake {
        ik_dh_pub: init.message.ik_dh_pub,
        ek_pub: init.message.ek_pub,
        spk_id: init.message.spk_id,
        opk_id: init.message.opk_id,
    };
    drop(inner);

    dbg_log("RESYNC: forcing a fresh handshake");
    send_cipher_inner(&state, &handle, b"__trino_handshake__", Some(handshake))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// A text to a contact (K4). It counts as sent once a relay says OK, and is
/// stored with the time of that receipt, which says which relay took it.
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    handle: String,
    text: String,
) -> Result<SendReceipt, CommandError> {
    Ok(send_text(&state, &handle, text, ACK_WAIT).await?)
}

/// `send_message`, waiting up to `wait` for a relay's OK. A lock meanwhile
/// keeps nothing of it (`same_session`).
async fn send_text(
    state: &AppState,
    handle: &str,
    text: String,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    // Wiped whichever way this returns, unless they are kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let id = new_msg_id();
    let mut env = Zeroizing::new(encode_envelope(&Envelope::Text {
        body: text.to_string(),
        id: id.clone(),
    }));
    let session = session_key(&*state.inner.lock().await).ok_or(SendError::Sealed)?;
    let sent = send_acked(state, handle, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    remember_outgoing(&mut inner, handle, id, std::mem::take(&mut *env));
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: Some(std::mem::take(&mut *text)),
            file: None,
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(receipt)
}

#[tauri::command]
pub async fn wipe(state: State<'_, AppState>) -> Result<(), String> {
    // An unlock in progress must not save the vault, or open a session, after
    // this deleted it.
    let _gate = state.session_gate.lock().await;
    let mut inner = state.inner.lock().await;
    forget_session(&mut inner, &state.turn);
    drop(inner);

    let mut failures = Vec::new();
    remove_data_files(
        &[
            vault_path(),
            friends_path(),
            config_path(),
            groups_path(),
            group_invites_path(),
            history_path(),
            ratchets_path(),
            profiles_path(),
            trino_home().join(profile::DAMAGED_PROFILES_FILE),
            trino_home().join("trino-gui.log"),
        ],
        &mut failures,
    );
    remove_dir_for_wipe(&stickers_dir(), &mut failures);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "memory cleared, but some files could not be deleted: {}",
            failures.join("; ")
        ))
    }
}

/// Launch trino on OS login so it's already running (and, once unsealed, can
/// receive in the background) without the user reopening it. Windows-only for
/// now (HKCU Run key); a no-op elsewhere so mobile/Linux builds still compile.
#[tauri::command]
pub fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        let result = if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            std::process::Command::new("reg")
                .args([
                    "add",
                    KEY,
                    "/v",
                    "trino",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &exe.to_string_lossy(),
                    "/f",
                ])
                .output()
        } else {
            std::process::Command::new("reg")
                .args(["delete", KEY, "/v", "trino", "/f"])
                .output()
        };
        result.map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = enable;
    Ok(())
}

/// Whether trino is registered to launch on login.
#[tauri::command]
pub fn get_autostart() -> bool {
    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        std::process::Command::new("reg")
            .args(["query", KEY, "/v", "trino"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    false
}

/// Lock the vault: drop all in-memory secrets (identity, keys, ratchets) and
/// disconnect the relays, but KEEP the encrypted files on disk. The UI returns
/// to the unseal screen; unlocking reloads everything. Used by auto-lock.
#[tauri::command]
pub async fn lock_vault(state: State<'_, AppState>) -> Result<(), String> {
    let _gate = state.session_gate.lock().await;
    let mut inner = state.inner.lock().await;
    // Persist current session/history state before wiping it from memory.
    save_ratchets(&inner);
    save_history(&inner);
    forget_session(&mut inner, &state.turn);
    dbg_log("vault LOCKED (auto-lock)");
    Ok(())
}

fn self_member_bundle(identity: &crate::identity::Identity, handle: &str) -> MemberBundle {
    MemberBundle::from_public_bundle(handle, &public_bundle_for(identity))
}

fn group_info(roster: &GroupRoster, my_ik: &str) -> GroupInfo {
    GroupInfo {
        gid: roster.group_id.clone(),
        name: roster.name.clone(),
        epoch: roster.epoch,
        is_admin: roster.admin_pub == my_ik,
        member_count: roster.members.len(),
        members: roster.members.iter().map(|m| m.handle.clone()).collect(),
        ended: !group::is_member(roster, my_ik),
    }
}

/// Establish a pairwise session with `handle` (initiate + send handshake) if none.
async fn ensure_session(state: &AppState, handle: &str) -> Result<(), SendError> {
    let failed = |e: &dyn std::fmt::Display| SendError::Failed(e.to_string());
    let handshake = {
        let mut inner = state.inner.lock().await;
        if inner.ratchets.contains_key(handle) {
            return Ok(());
        }
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?.clone();
        let friend = inner
            .friends
            .get(handle)
            .ok_or(SendError::UnknownContact)?
            .clone();
        let init = initiate(&identity, &friend.bundle).map_err(|e| failed(&e))?;
        let spk_pub = decode_array_32(&friend.bundle.spk_pub).map_err(|e| failed(&e))?;
        let ratchet = init_initiator(init.master_secret, spk_pub).map_err(|e| failed(&e))?;
        inner.ratchets.insert(handle.to_string(), ratchet);
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data.clone());
        save_ratchets(&inner);
        WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        }
    };
    publish_sealed(state, handle, b"__trino_handshake__", Some(handshake)).await
}

/// `ensure_session`, for the callers that answer with a string.
async fn ensure_session_inner(state: &AppState, handle: &str) -> Result<(), String> {
    ensure_session(state, handle)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_group(state: State<'_, AppState>, name: String) -> Result<GroupInfo, String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let handle = inner.handle.clone().unwrap_or_else(|| "me".to_string());
    let me = self_member_bundle(&identity, &handle);
    let roster = group::create_group(&identity, me, name.trim()).map_err(|e| e.to_string())?;
    inner.groups.insert(roster.group_id.clone(), roster.clone());
    persist_groups(&inner)?;
    Ok(group_info(&roster, &my_ik))
}

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> Result<Vec<GroupInfo>, String> {
    let inner = state.inner.lock().await;
    let my_ik = inner
        .identity
        .as_ref()
        .map(|i| hex::encode(i.ik_sign.pub_bytes))
        .unwrap_or_default();
    let mut out: Vec<GroupInfo> = inner
        .groups
        .values()
        .map(|r| group_info(r, &my_ik))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Add a contact to a group I administer (groups_cmds::add_member).
#[tauri::command]
pub async fn add_group_member(
    state: State<'_, AppState>,
    gid: String,
    friend_handle: String,
) -> Result<GroupInfo, CommandError> {
    groups_cmds::add_member(&state, &gid, &friend_handle, persist_groups).await
}

/// A text to a group (K4). Every member is tried, whatever happens to the
/// others, and the receipt says whom it reached. `only` resends to the
/// members it names after a partial failure: the first send stored the
/// message, so a resend does not store it again.
#[tauri::command]
pub async fn send_group_message(
    state: State<'_, AppState>,
    gid: String,
    text: String,
    only: Option<Vec<String>>,
) -> Result<GroupSendReceipt, CommandError> {
    Ok(send_group_text(&state, &gid, text, only.as_deref(), ACK_WAIT).await?)
}

/// `send_group_message`, waiting up to `wait` for each member's relay OK.
/// A lock meanwhile keeps nothing of it (`same_session`).
async fn send_group_text(
    state: &AppState,
    gid: &str,
    text: String,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    // Wiped whichever way this returns, unless it is kept.
    let mut text = Zeroizing::new(text);
    if text.trim().is_empty() {
        return Err(SendError::Empty);
    }
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::Group {
            gid: gid.to_string(),
            ep: roster.epoch,
            body: text.to_string(),
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    crate::diag::note_with("group send", &[("members", &targets.len())]);
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = same_session(state, session).await?;
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: Some(std::mem::take(&mut *text)),
                file: None,
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(receipt)
}

/// Encrypt file bytes, upload the ciphertext to Blossom, return the E2E reference.
/// When every file server fails, the error says why for each (`upload_failed`).
async fn prepare_file(
    state: &AppState,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<FileRef, CommandError> {
    let (identity, blob, file) =
        encrypt_attachment(state, name, mime, data_b64, thumb, gid).await?;
    let url = blossom::upload(&identity, &blob, &file.sha256).await?;
    Ok(FileRef { url, ..file })
}

/// What `prepare_file` uploads: the identity that signs the upload, the
/// encrypted blob, and its reference, without the URL the upload gives it.
/// `gid` is the group it goes to, if any.
async fn encrypt_attachment(
    state: &AppState,
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<String>,
    gid: Option<&str>,
) -> Result<(Identity, Vec<u8>, FileRef), CommandError> {
    let too_large = || CommandError::internal("attachment is too large (25 MB max)");
    if data_b64.len() > MAX_ATTACHMENT_BYTES.div_ceil(3) * 4 + 4 {
        return Err(too_large());
    }
    let thumb = checked_inline_raster(thumb).map_err(CommandError::internal)?;
    if !announcement_fits(name, mime, data_b64, thumb.as_deref(), gid) {
        return Err(SendError::TooLong.into());
    }
    let identity = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?.clone();
        // With no relay to announce the file, the upload would be wasted (K4).
        if !inner.relays.iter().any(|relay| relay.is_connected()) {
            return Err(SendError::Offline.into());
        }
        identity
    };
    // Wiped when dropped, whichever way this returns.
    let data = Zeroizing::new(
        base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .map_err(|_| CommandError::internal("bad base64"))?,
    );
    if data.len() > MAX_ATTACHMENT_BYTES {
        return Err(too_large());
    }
    let size = data.len() as u64;
    let enc = blossom::encrypt_file(&data)?;
    drop(data);
    let file = FileRef {
        url: String::new(),
        key: enc.key_hex,
        sha256: enc.sha256_hex,
        mime: mime.to_string(),
        name: name.to_string(),
        size,
        thumb,
    };
    Ok((identity, enc.blob, file))
}

/// Whether the announcement of a file can fit a relay whatever URL its
/// upload gives it (`blossom::MAX_URL_BYTES`), to a contact or to the group
/// `gid`. Checked before the upload, so a file that cannot be announced,
/// such as one with too large a preview, is never uploaded. The preview is
/// a checked data URL, which JSON writes as it is: a stand-in of its length
/// sizes it without copying it.
fn announcement_fits(
    name: &str,
    mime: &str,
    data_b64: &str,
    thumb: Option<&str>,
    gid: Option<&str>,
) -> bool {
    let announcement = Envelope::File {
        file: FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            key: "0".repeat(64),
            sha256: "0".repeat(64),
            mime: mime.to_string(),
            name: name.to_string(),
            // The most bytes `data_b64` can hold.
            size: (data_b64.len() / 4 * 3 + 3) as u64,
            thumb: thumb.map(|thumb| "t".repeat(thumb.len())),
        },
        gid: gid.map(str::to_string),
        body: None,
    };
    largest_frame_bytes(&encode_envelope(&announcement), unix_now()) <= MAX_EVENT_BYTES
}

/// A file to a contact (K4): uploaded, then announced like a text, and sent
/// once a relay says OK. Answers with the file and its receipt together.
#[tauri::command]
pub async fn send_file(
    state: State<'_, AppState>,
    handle: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
) -> Result<SentFile, CommandError> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb, None).await?;
    Ok(announce_file(&state, &handle, file, ACK_WAIT).await?)
}

/// `send_file` once the file is uploaded: announce it to `handle`, waiting
/// up to `wait` for a relay's OK. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
async fn announce_file(
    state: &AppState,
    handle: &str,
    mut file: FileRef,
    wait: std::time::Duration,
) -> Result<SentFile, SendError> {
    let env = Zeroizing::new(encode_envelope(&Envelope::File {
        file: file.clone(),
        gid: None,
        body: None,
    }));
    let session = session_key(&*state.inner.lock().await).ok_or(SendError::Sealed)?;
    let sent = match ensure_session(state, handle).await {
        Ok(()) => send_acked(state, handle, &env, unix_now(), wait).await,
        Err(error) => Err(error),
    };
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    record_history(
        &mut inner,
        handle.to_string(),
        HistItem {
            side: "me".into(),
            from: None,
            text: None,
            file: Some(file.clone()),
            call: None,
            ts: receipt.ts,
        },
    );
    Ok(SentFile { file, receipt })
}

/// A file to a group (K4), like `send_group_message`: every member is
/// tried, `only` resends to the members it names and does not store it
/// again.
#[tauri::command]
pub async fn send_group_file(
    state: State<'_, AppState>,
    gid: String,
    name: String,
    mime: String,
    data_b64: String,
    thumb: Option<String>,
    only: Option<Vec<String>>,
) -> Result<SentGroupFile, CommandError> {
    let file = prepare_file(&state, &name, &mime, &data_b64, thumb, Some(&gid)).await?;
    Ok(announce_group_file(&state, &gid, file, only.as_deref(), ACK_WAIT).await?)
}

/// `send_group_file` once the file is uploaded: announce it to the group as
/// `send_group_text` sends a text. A lock meanwhile keeps nothing of it
/// (`same_session`) and wipes its key.
async fn announce_group_file(
    state: &AppState,
    gid: &str,
    mut file: FileRef,
    only: Option<&[String]>,
    wait: std::time::Duration,
) -> Result<SentGroupFile, SendError> {
    let (targets, env, session) = {
        let inner = state.inner.lock().await;
        let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
        let my_ik = hex::encode(identity.ik_sign.pub_bytes);
        let roster = inner.groups.get(gid).ok_or(SendError::UnknownGroup)?;
        let env = Zeroizing::new(encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: Some(gid.to_string()),
            body: None,
        }));
        let targets = member_handles(&inner, roster, &my_ik, only);
        (targets, env, identity.nostr.pub_bytes)
    };
    let sent = fan_out(state, &targets, &env, unix_now(), wait).await;
    let mut inner = match same_session(state, session).await {
        Ok(inner) => inner,
        Err(ended) => {
            zeroize_file_ref(&mut file);
            return Err(ended);
        }
    };
    let receipt = sent?;
    if only.is_none() {
        record_history(
            &mut inner,
            group_convo(gid),
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file.clone()),
                call: None,
                ts: receipt.ts,
            },
        );
    }
    Ok(SentGroupFile { file, receipt })
}

/// Download + verify + decrypt a file, returning a `data:` URL for the frontend.
#[tauri::command]
pub async fn fetch_file(
    url: String,
    key: String,
    sha256: String,
    mime: String,
) -> Result<String, String> {
    let blob = blossom::download(&url, &sha256)
        .await
        .map_err(|e| e.to_string())?;
    let mut plain = blossom::decrypt_file(&blob, &key).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&plain);
    plain.zeroize();
    Ok(format!("data:{};base64,{}", mime, b64))
}

/// Forward an already-uploaded file (its FileRef) to another chat or group,
/// without re-encrypting or re-uploading the blob.
#[tauri::command]
pub async fn forward_file(
    state: State<'_, AppState>,
    target: String,
    is_group: bool,
    file: FileRef,
) -> Result<(), String> {
    let file = sanitize_file_ref(file);
    if is_group {
        let (targets, env) = {
            let inner = state.inner.lock().await;
            let identity = inner.identity.as_ref().ok_or("vault sealed")?.clone();
            let my_ik = hex::encode(identity.ik_sign.pub_bytes);
            let _roster = inner.groups.get(&target).ok_or("unknown group")?;
            let env = encode_envelope(&Envelope::File {
                file: file.clone(),
                gid: Some(target.clone()),
                body: None,
            });
            let targets: Vec<String> = _roster
                .members
                .iter()
                .filter(|m| m.ik_sign_pub != my_ik)
                .filter_map(|m| {
                    inner
                        .friends
                        .values()
                        .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                        .map(|f| f.handle.clone())
                })
                .collect();
            (targets, env)
        };
        for handle in targets {
            ensure_session_inner(&state, &handle).await?;
            send_cipher_inner(&state, &handle, &env, None).await?;
        }
        let mut inner = state.inner.lock().await;
        record_history(
            &mut inner,
            group_convo(&target),
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file),
                call: None,
                ts: chrono::Utc::now().timestamp(),
            },
        );
    } else {
        let env = encode_envelope(&Envelope::File {
            file: file.clone(),
            gid: None,
            body: None,
        });
        ensure_session_inner(&state, &target).await?;
        send_cipher_inner(&state, &target, &env, None).await?;
        let mut inner = state.inner.lock().await;
        record_history(
            &mut inner,
            target,
            HistItem {
                side: "me".into(),
                from: None,
                text: None,
                file: Some(file),
                call: None,
                ts: chrono::Utc::now().timestamp(),
            },
        );
    }
    Ok(())
}

/// Remove a contact and all its local state (contacts_cmds::remove_contact).
#[tauri::command]
pub async fn remove_node(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let profile_gone = contacts_cmds::remove_contact(&mut inner, &handle);
    persist_friends(&inner)?;
    save_history(&inner);
    save_ratchets(&inner);
    // -- W8 (K12) --
    if profile_gone {
        profile::save(&inner);
    }
    Ok(())
}

/// Rename a contact's local handle, with all its local state
/// (contacts_cmds::rename_contact).
#[tauri::command]
pub async fn rename_node(
    state: State<'_, AppState>,
    old_handle: String,
    new_handle: String,
) -> Result<(), CommandError> {
    let mut inner = state.inner.lock().await;
    let Some(profile_moved) = contacts_cmds::rename_contact(&mut inner, &old_handle, &new_handle)?
    else {
        return Ok(());
    };
    persist_friends(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
    save_history(&inner);
    save_ratchets(&inner);
    // -- W8 (K12) --
    if profile_moved {
        profile::save(&inner);
    }
    Ok(())
}

/// Block or unblock a contact (by their nostr pubkey). Blocked senders' events
/// are dropped on arrival.
#[tauri::command]
pub async fn block_node(
    state: State<'_, AppState>,
    handle: String,
    blocked: bool,
) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    let pubkey = inner
        .friends
        .get(&handle)
        .map(|f| f.bundle.nostr_pub.clone());
    if let Some(pk) = pubkey {
        if blocked {
            inner.blocked.insert(pk);
        } else {
            inner.blocked.remove(&pk);
        }
        persist_friends(&inner)?;
    }
    Ok(())
}

/// Delete self-destructed (expired) messages from history on disk. The TTL is
/// encoded in the frontend `trm1:` body envelope; we decode it and drop items
/// whose ts + ttl has passed.
#[tauri::command]
pub async fn prune_expired(state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    let mut inner = state.inner.lock().await;
    if prune_history(&mut inner.history, now) {
        save_history(&inner);
    }
    Ok(())
}

/// Drop from `history` what has expired at `now`; whether anything went.
/// A call (K13) goes with its chat's disappearing messages: its `ttl` is the
/// chat's timer when the call was recorded.
fn prune_history(history: &mut HashMap<String, Vec<HistItem>>, now: i64) -> bool {
    use base64::Engine as _;
    let mut changed = false;
    for items in history.values_mut() {
        let before = items.len();
        items.retain(|it| {
            if crate::call_log::expired(it, now) {
                return false;
            }
            let ttl = it.text.as_deref().and_then(|t| {
                let enc = t.strip_prefix("trm1:")?;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(enc)
                    .ok()?;
                let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
                v.get("d").and_then(|d| d.as_i64())
            });
            match ttl {
                Some(ttl) if ttl > 0 => it.ts + ttl > now,
                _ => true,
            }
        });
        if items.len() != before {
            changed = true;
        }
    }
    changed
}

// ---- Sticker library (stored unencrypted in ~/.trino/stickers) ----

/// Restrict the data dir to the owner (0700) on Unix so other local users can't
/// read the vault/history/log. No-op on Windows (uses NTFS ACLs by default).
fn harden_dir(dir: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = dir;
}

fn stickers_dir() -> std::path::PathBuf {
    crate::state::trino_home().join("stickers")
}
fn sticker_ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/gif" => "gif",
        "image/png" => "png",
        "image/webp" => "webp",
        _ => "jpg",
    }
}
fn sticker_mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "gif" => "image/gif",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    }
}

#[derive(serde::Serialize)]
pub struct StickerInfo {
    pub id: String,
    pub mime: String,
    pub data_url: String,
}

#[tauri::command]
pub async fn import_sticker(data_b64: String, mime: String) -> Result<StickerInfo, String> {
    use base64::Engine as _;
    if !matches!(
        mime.as_str(),
        "image/jpeg" | "image/png" | "image/gif" | "image/webp"
    ) {
        return Err("only jpeg/png/gif/webp stickers are allowed".to_string());
    }
    if data_b64.len() > MAX_STICKER_BYTES.div_ceil(3) * 4 + 4 {
        return Err("sticker is too large (5 MB max)".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_STICKER_BYTES {
        return Err("sticker is too large (5 MB max)".to_string());
    }
    let id = hex::encode(&crate::crypto::sha256(&bytes)[..8]);
    let ext = sticker_ext_for_mime(&mime);
    let dir = stickers_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{id}.{ext}")), &bytes).map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(StickerInfo {
        id,
        mime: mime.clone(),
        data_url: format!("data:{mime};base64,{b64}"),
    })
}

#[tauri::command]
pub async fn list_stickers() -> Result<Vec<StickerInfo>, String> {
    use base64::Engine as _;
    let dir = stickers_dir();
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
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
            let bytes = match std::fs::read(&path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let mime = sticker_mime_for_ext(&ext).to_string();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            out.push(StickerInfo {
                id,
                mime: mime.clone(),
                data_url: format!("data:{mime};base64,{b64}"),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn delete_sticker(id: String) -> Result<(), String> {
    let dir = stickers_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let path = e.path();
            if path.file_stem().and_then(|s| s.to_str()) == Some(id.as_str()) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

/// The single source of the default STUN servers for direct calls. Calls are
/// protected (TURN relay only, see turn.rs) by default; STUN is used only in
/// direct mode, after the user explicitly agrees to reveal their IP. The
/// frontend has no copy: it gets them from `get_call_config`. Deployments can
/// replace them with `TRINO_ICE_SERVERS_JSON`; `[]` there means no STUN at all.
fn default_call_ice_servers() -> Vec<CallIceServer> {
    vec![
        CallIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        },
        CallIceServer {
            urls: vec!["stun:stun1.l.google.com:19302".to_string()],
            username: None,
            credential: None,
        },
    ]
}

fn validate_ice_servers(servers: &[CallIceServer]) -> Result<(), String> {
    // An empty list is valid: calls then use only the candidates the peers
    // can find without a STUN server.
    if servers.len() > 8 {
        return Err("ICE configuration must contain at most 8 servers".to_string());
    }
    for server in servers {
        if server.urls.is_empty() || server.urls.len() > 8 {
            return Err("each ICE server must contain between 1 and 8 URLs".to_string());
        }
        let mut has_turn = false;
        for url in &server.urls {
            if url.len() > 512
                || !url.is_ascii()
                || !matches!(
                    url.split_once(':').map(|(scheme, _)| scheme),
                    Some("stun" | "stuns" | "turn" | "turns")
                )
            {
                return Err("ICE server URL is invalid".to_string());
            }
            has_turn |= url.starts_with("turn:") || url.starts_with("turns:");
        }
        if has_turn
            && (server.username.as_deref().unwrap_or_default().is_empty()
                || server.credential.as_deref().unwrap_or_default().is_empty())
        {
            return Err("TURN servers require a username and credential".to_string());
        }
        if server
            .username
            .as_ref()
            .is_some_and(|value| value.len() > 512)
            || server
                .credential
                .as_ref()
                .is_some_and(|value| value.len() > 512)
        {
            return Err("ICE credentials are too long".to_string());
        }
    }
    Ok(())
}

/// The ICE servers for calls: the `TRINO_ICE_SERVERS_JSON` override when it
/// is set, otherwise the backend defaults.
fn ice_servers_from_override(raw: Option<String>) -> Result<Vec<CallIceServer>, String> {
    let Some(raw) = raw else {
        return Ok(default_call_ice_servers());
    };
    if raw.len() > MAX_ICE_CONFIG_BYTES {
        return Err("ICE configuration is too large".to_string());
    }
    let parsed: Vec<CallIceServer> =
        serde_json::from_str(&raw).map_err(|_| "ICE configuration is invalid")?;
    validate_ice_servers(&parsed)?;
    Ok(parsed)
}

/// ICE servers for the direct (unprotected) path only. The frontend asks for
/// them only after `get_turn_servers` failed and the user explicitly agreed to
/// call directly, knowing the contact will see their IP; a protected call
/// never contacts these STUN servers. Deployment-specific STUN/TURN servers
/// can still come from `TRINO_ICE_SERVERS_JSON`, without shared production
/// credentials in the frontend bundle; TURN credentials there should be
/// short-lived. See docs/llamadas-turn.md.
#[tauri::command]
pub fn get_call_config() -> Result<CallConfigResponse, String> {
    let ice_servers = ice_servers_from_override(std::env::var("TRINO_ICE_SERVERS_JSON").ok())?;
    Ok(CallConfigResponse { ice_servers })
}

/// Send a WebRTC signaling payload (offer/answer/ICE/bye) to a peer, E2E-encrypted.
#[tauri::command]
pub async fn send_call_signal(
    state: State<'_, AppState>,
    handle: String,
    payload: String,
) -> Result<(), String> {
    validate_call_signal(&payload).map_err(str::to_string)?;
    ensure_session_inner(&state, &handle).await?;
    let env = encode_envelope(&Envelope::Call { call: payload });
    send_cipher_inner(&state, &handle, &env, None).await
}

/// The frontend reports whether a call holds the microphone or camera, so
/// closing the window or quitting from the tray can hang it up first.
#[tauri::command]
pub fn set_call_active(state: State<'_, AppState>, active: bool) {
    state
        .call_active
        .store(active, std::sync::atomic::Ordering::SeqCst);
}

/// What the frontend sends here is text, and the diagnostic log never holds
/// text (T3): it is dropped. The command stays so the frontend's calls still
/// succeed; in a debug build, its console (DevTools, or chrome://inspect on
/// Android) shows the same lines.
#[tauri::command]
pub fn dev_log(msg: String) {
    drop(msg);
}

// ---- the send path (K4) -----------------------------------------------------

/// How long a message waits for a relay to confirm it (K4).
const ACK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The largest `["EVENT", …]` frame a relay takes. Relays drop larger ones
/// without a word (strfry's `maxEventSize` is 64 KiB); a big inline preview
/// of a file used to go out that way, and never arrive.
const MAX_EVENT_BYTES: usize = 64 * 1024;

/// A message one relay at least took (K4): its time, which is also the time
/// it is stored with, and the relays that took it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SendReceipt {
    pub ts: i64,
    pub accepted_by: Vec<String>,
}

/// A group message (K4): every member is tried, whatever happens to the
/// others. `accepted` and `failed` are their handles.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GroupSendReceipt {
    pub ts: i64,
    pub accepted: Vec<String>,
    pub failed: Vec<String>,
}

/// What `send_file` answers: the file with its receipt, in one object
/// (`SentFile` in src/lib/api.ts). When the UI hands it back to
/// `forward_file`, `FileRef` ignores the receipt's fields.
#[derive(Serialize)]
pub struct SentFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: SendReceipt,
}

/// What `send_group_file` answers, as `SentFile` does.
#[derive(Serialize)]
pub struct SentGroupFile {
    #[serde(flatten)]
    pub file: FileRef,
    #[serde(flatten)]
    pub receipt: GroupSendReceipt,
}

/// Why a message was not sent.
#[derive(Debug, PartialEq, Eq)]
enum SendError {
    Sealed,
    UnknownContact,
    UnknownGroup,
    Empty,
    /// The session has no relays at all.
    NoRelays,
    NoSession,
    /// No relay is up.
    Offline,
    NotAccepted,
    TooLong,
    /// The X3DH, the ratchet or the signature failed; for the log.
    Failed(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The commands that still answer with a string show these, as before.
        f.write_str(match self {
            SendError::Sealed => "vault sealed",
            SendError::UnknownContact => "unknown node",
            SendError::UnknownGroup => "unknown group",
            SendError::Empty => "empty message",
            SendError::NoRelays => "network is still connecting",
            SendError::NoSession => "no session — run connect first",
            SendError::Offline => "no relay is connected",
            SendError::NotAccepted => "no relay accepted the message",
            SendError::TooLong => "the message is too large for the relays",
            SendError::Failed(reason) => reason,
        })
    }
}

impl From<SendError> for CommandError {
    fn from(error: SendError) -> Self {
        let code = match &error {
            SendError::Sealed => ErrorCode::NoVault,
            SendError::NoSession => ErrorCode::NoSession,
            SendError::NoRelays | SendError::Offline => ErrorCode::Offline,
            SendError::NotAccepted => ErrorCode::NotAccepted,
            SendError::TooLong => ErrorCode::MessageTooLong,
            SendError::UnknownContact
            | SendError::UnknownGroup
            | SendError::Empty
            | SendError::Failed(_) => ErrorCode::Internal,
        };
        CommandError::new(code, error.to_string())
    }
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// Encrypt `plaintext` for `handle` into a signed event dated `created_at`
/// (now when `None`), and return it with the relays to send it to.
///
/// Every outgoing message of a contact passes here. A text, group or file
/// message also says that this Trino reads profiles, and which revision of
/// the contact's profile it holds (K12, `profile::with_caps`); the rest goes
/// as it is. The session moves on only when the event fits a relay
/// (`MAX_EVENT_BYTES`), so a message refused for its size costs no ratchet
/// step. With `need_relay_up`, nothing is encrypted while no relay is up.
async fn seal_for(
    state: &AppState,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
    created_at: Option<i64>,
    need_relay_up: bool,
) -> Result<(NostrEvent, Vec<Arc<NostrClient>>), SendError> {
    let failed = |e: &dyn std::fmt::Display| SendError::Failed(e.to_string());
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or(SendError::Sealed)?;
    let signing_key = Zeroizing::new(identity.nostr.priv_bytes);
    let signing_pub = identity.nostr.pub_bytes;
    let recipient = inner
        .friends
        .get(handle)
        .ok_or(SendError::UnknownContact)?
        .bundle
        .nostr_pub
        .clone();
    let relays = inner.relays.clone();
    if relays.is_empty() {
        return Err(SendError::NoRelays);
    }
    let ad = inner
        .associated_data
        .get(handle)
        .ok_or(SendError::NoSession)?
        .clone();
    // A copy: the session itself only moves on once the event fits.
    let mut ratchet = inner
        .ratchets
        .get(handle)
        .ok_or(SendError::NoSession)?
        .clone();
    if need_relay_up && !relays.iter().any(|relay| relay.is_connected()) {
        return Err(SendError::Offline);
    }

    let plaintext = profile::with_caps(&inner.profiles, handle, plaintext);
    let ct: EncryptedMessage =
        ratchet_encrypt(&mut ratchet, &plaintext, &ad).map_err(|e| failed(&e))?;
    let is_handshake = handshake.is_some();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: ct.header.dh_pub,
            pn: ct.header.pn,
            n: ct.header.n,
        },
        nonce: ct.nonce,
        ciphertext: ct.ciphertext,
        handshake,
    };
    let payload_json = serde_json::to_string(&payload).map_err(|e| failed(&e))?;
    let event = build_and_sign_event(
        &signing_key,
        &signing_pub,
        TRINO_KIND,
        &payload_json,
        vec![vec!["p".to_string(), recipient]],
        created_at,
    )
    .map_err(|e| failed(&e))?;
    if event_frame_bytes(&event) > MAX_EVENT_BYTES {
        // The advanced copy of the session is dropped, and wiped with it.
        return Err(SendError::TooLong);
    }

    inner.ratchets.insert(handle.to_string(), ratchet);
    save_ratchets(&inner); // sending chain advanced — persist it
    drop(inner);
    crate::diag::note_with(
        "send",
        &[("handshake", &is_handshake), ("relays", &relays.len())],
    );
    Ok((event, relays))
}

/// The size of `event` as a relay receives it.
fn event_frame_bytes(event: &NostrEvent) -> usize {
    serde_json::json!(["EVENT", event]).to_string().len()
}

/// The largest frame `plaintext` can make once `seal_for` seals it for any
/// contact, dated `ts`: with the longest profile announcement
/// `profile::with_caps` can add, and the widest counters a session can have.
/// A message for several contacts, and a file before its upload, are sized
/// with it, so one too large for the relays goes to nobody.
fn largest_frame_bytes(plaintext: &[u8], ts: i64) -> usize {
    let mut profiles = profile::Profiles::default();
    profiles.contacts.insert(
        String::new(),
        profile::ContactProfile {
            rev: u64::MAX,
            ..Default::default()
        },
    );
    let bare = br#"{"ty":"text"}"#;
    let announcement = profile::with_caps(&profiles, "", bare).len() - bare.len();
    let payload = WirePayload {
        header: WireHeader {
            dh_pub: "0".repeat(64),
            pn: u32::MAX,
            n: u32::MAX,
        },
        // AES-GCM, as `ratchet_encrypt` uses it: a 12-byte nonce, and the
        // plaintext with its 16-byte tag, both in hex.
        nonce: "0".repeat(24),
        ciphertext: "0".repeat((plaintext.len() + announcement + 16) * 2),
        handshake: None,
    };
    let event = NostrEvent {
        id: "0".repeat(64),
        pubkey: "0".repeat(64),
        created_at: ts,
        kind: TRINO_KIND,
        tags: vec![vec!["p".to_string(), "0".repeat(64)]],
        content: serde_json::to_string(&payload).unwrap_or_default(),
        sig: "0".repeat(128),
    };
    event_frame_bytes(&event)
}

/// Encrypt and publish without waiting for any relay: handshakes, call
/// signals, rosters and resends, as before K4. A relay that is down gets it
/// once it is back.
async fn publish_sealed(
    state: &AppState,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
) -> Result<(), SendError> {
    let (event, relays) = seal_for(state, handle, plaintext, handshake, None, false).await?;
    for relay in &relays {
        let _ = relay.publish(&event).await;
    }
    Ok(())
}

/// `publish_sealed`, for the callers that answer with a string.
async fn send_cipher_inner(
    state: &AppState,
    handle: &str,
    plaintext: &[u8],
    handshake: Option<WireHandshake>,
) -> Result<(), String> {
    publish_sealed(state, handle, plaintext, handshake)
        .await
        .map_err(|e| e.to_string())
}

/// Send `plaintext` to `handle` dated `ts`, and wait up to `wait` for the
/// first relay that takes it (K4).
async fn send_acked(
    state: &AppState,
    handle: &str,
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<SendReceipt, SendError> {
    let (event, relays) = seal_for(state, handle, plaintext, None, Some(ts), true).await?;
    let accepted_by = first_acceptance(&relays, &event, wait).await?;
    Ok(SendReceipt {
        ts: event.created_at,
        accepted_by,
    })
}

/// Publish `event` to the relays that are up and answer as soon as one of
/// them takes it. A relay that is down is not asked: a message the UI shows
/// as failed must not go out later by itself.
async fn first_acceptance(
    relays: &[Arc<NostrClient>],
    event: &NostrEvent,
    wait: std::time::Duration,
) -> Result<Vec<String>, SendError> {
    use futures_util::StreamExt;
    let mut answers: futures_util::stream::FuturesUnordered<_> = relays
        .iter()
        .filter(|relay| relay.is_connected())
        .map(|relay| async move { (relay.url(), relay.publish_acked(event, wait).await) })
        .collect();
    if answers.is_empty() {
        return Err(SendError::Offline);
    }
    while let Some((url, ack)) = answers.next().await {
        if ack == crate::nostr::Ack::Accepted {
            return Ok(vec![url.to_string()]);
        }
    }
    Err(SendError::NotAccepted)
}

/// The session a send starts in: its identity's Nostr key. `None` while
/// the vault is locked.
fn session_key(inner: &InnerState) -> Option<[u8; 32]> {
    inner
        .identity
        .as_ref()
        .map(|identity| identity.nostr.pub_bytes)
}

/// `state` locked again once a send has waited for its relays (K4), if the
/// session it started in (`session_key`) is open; `NoSession` if not.
///
/// A lock during that wait ends the session: `lock_vault` saves the history
/// without the message, wipes it, and leaves no history key to write with.
/// So a message a relay accepted while its session was locked is not kept
/// in the sender's history, nor in the outbox to replay, although its
/// contact may receive it: the send answers `no_session` and wipes its
/// text. An unlock of the same identity before the wait ends opens the
/// session again, and the message is kept there. The name is not compared,
/// so renaming this identity meanwhile loses nothing.
async fn same_session(
    state: &AppState,
    session: [u8; 32],
) -> Result<tokio::sync::MutexGuard<'_, InnerState>, SendError> {
    let inner = state.inner.lock().await;
    if session_key(&inner) == Some(session) {
        Ok(inner)
    } else {
        Err(SendError::NoSession)
    }
}

/// Whether any relay of the session is up.
async fn any_relay_up(state: &AppState) -> bool {
    let inner = state.inner.lock().await;
    inner.relays.iter().any(|relay| relay.is_connected())
}

/// The handles of `roster`'s members other than us that are contacts, in
/// roster order; with `only`, just the ones it names.
fn member_handles(
    inner: &InnerState,
    roster: &GroupRoster,
    my_ik: &str,
    only: Option<&[String]>,
) -> Vec<String> {
    roster
        .members
        .iter()
        .filter(|m| m.ik_sign_pub != my_ik)
        .filter_map(|m| {
            inner
                .friends
                .values()
                .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
                .map(|f| f.handle.clone())
        })
        .filter(|handle| only.is_none_or(|only| only.contains(handle)))
        .collect()
}

/// Send `plaintext` to each of `targets`, all dated `ts`, each waiting for
/// its own relay OK. Every member is tried whatever happens to the others:
/// the send used to stop at the first one that failed. A message too large
/// for the relays is refused before any member gets it; when nobody takes
/// it, `group_receipt` says why.
async fn fan_out(
    state: &AppState,
    targets: &[String],
    plaintext: &[u8],
    ts: i64,
    wait: std::time::Duration,
) -> Result<GroupSendReceipt, SendError> {
    if largest_frame_bytes(plaintext, ts) > MAX_EVENT_BYTES {
        return Err(SendError::TooLong);
    }
    if targets.is_empty() {
        return group_receipt(ts, Vec::new());
    }
    if !any_relay_up(state).await {
        return Err(SendError::Offline);
    }
    let sends = targets.iter().map(|handle| async move {
        let sent = match ensure_session(state, handle).await {
            Ok(()) => send_acked(state, handle, plaintext, ts, wait)
                .await
                .map(drop),
            Err(error) => Err(error),
        };
        (handle.clone(), sent)
    });
    group_receipt(ts, futures_util::future::join_all(sends).await)
}

/// What a group send dated `ts` answers once every member was tried: the
/// receipt, when one member at least took it (or there was nobody to send
/// to). When nobody did, why: the reason every member failed for, when it
/// is the same one (too large, offline, no session…), and `NotAccepted`
/// when they failed in different ways.
fn group_receipt(
    ts: i64,
    results: Vec<(String, Result<(), SendError>)>,
) -> Result<GroupSendReceipt, SendError> {
    let mut receipt = GroupSendReceipt {
        ts,
        accepted: Vec::new(),
        failed: Vec::new(),
    };
    let mut causes = Vec::new();
    for (handle, sent) in results {
        match sent {
            Ok(()) => receipt.accepted.push(handle),
            Err(error) => {
                receipt.failed.push(handle);
                causes.push(error);
            }
        }
    }
    let mut causes = causes.into_iter();
    let Some(first) = causes.next() else {
        return Ok(receipt);
    };
    if !receipt.accepted.is_empty() {
        return Ok(receipt);
    }
    if causes.all(|other| other == first) {
        Err(first)
    } else {
        Err(SendError::NotAccepted)
    }
}

/// What to do with a signature-verified event from a relay, decided before any
/// of its content is looked at.
#[derive(Debug)]
enum Admission {
    /// From a contact and not seen before: process it.
    Process(Box<FriendRecord>),
    /// From someone who is not a contact.
    Stranger,
    /// Ignore it; the reason is only for the log.
    Drop(&'static str),
}

/// Checks run in this order, and the event id is remembered only at the very
/// end:
/// 1. kind and recipient (`my_pub`): a relay can feed us a contact's events
///    addressed to someone else, such as group fan-out copies, which could
///    never decrypt and would tear our session down;
/// 2. blocked sender, then contact lookup: the dedup cache is bounded, so
///    letting strangers' events in would let anyone flush it and replay a
///    contact's old events past it.
fn admit_event(inner: &mut InnerState, event: &NostrEvent, my_pub: &str) -> Admission {
    if event.kind != TRINO_KIND {
        return Admission::Drop("not a trino event");
    }
    if event.recipient() != Some(my_pub) {
        return Admission::Drop("addressed to someone else");
    }
    if inner.blocked.contains(&event.pubkey) {
        return Admission::Drop("sender is blocked");
    }
    let Some(friend) = inner
        .friends
        .values()
        .find(|f| f.bundle.nostr_pub == event.pubkey)
        .cloned()
    else {
        return Admission::Stranger;
    };
    if !inner.remember_event(event.id.clone()) {
        return Admission::Drop("duplicate event (already seen from another relay)");
    }
    Admission::Process(Box::new(friend))
}

/// Why an incoming handshake was not allowed to (re)start a session.
#[derive(Debug, PartialEq)]
enum HandshakeRejection {
    Stale { age: i64 },
    FromTheFuture { ahead: i64 },
    NotNewer { last: i64 },
}

/// Whether a contact's handshake (already signature-checked and pinned) may
/// (re)start a session. `mark` is the newest handshake accepted from that
/// contact. Accepted means: no older than `HANDSHAKE_MAX_AGE_SECS`, no more
/// than `CLOCK_SKEW_SECS` in the future, and newer than `mark` (or from the
/// same second with an ephemeral key not seen yet).
fn judge_handshake(
    mark: Option<&HandshakeMark>,
    created_at: i64,
    ek_pub: &str,
    now: i64,
) -> Result<(), HandshakeRejection> {
    let age = now - created_at;
    if age > HANDSHAKE_MAX_AGE_SECS {
        return Err(HandshakeRejection::Stale { age });
    }
    if -age > CLOCK_SKEW_SECS {
        return Err(HandshakeRejection::FromTheFuture { ahead: -age });
    }
    if let Some(mark) = mark {
        let replayed_or_full = created_at == mark.at
            && (mark.ek_pubs.iter().any(|ek| ek == ek_pub)
                || mark.ek_pubs.len() >= MAX_SAME_SECOND_HANDSHAKES);
        if created_at < mark.at || replayed_or_full {
            return Err(HandshakeRejection::NotNewer { last: mark.at });
        }
    }
    Ok(())
}

/// Remember a handshake that `judge_handshake` accepted from `peer`.
fn record_handshake(
    marks: &mut HashMap<String, HandshakeMark>,
    peer: &str,
    created_at: i64,
    ek_pub: &str,
) {
    let mark = marks.entry(peer.to_string()).or_default();
    if created_at > mark.at || mark.ek_pubs.is_empty() {
        *mark = HandshakeMark {
            at: created_at,
            ek_pubs: vec![ek_pub.to_string()],
        };
    } else if created_at == mark.at
        && mark.ek_pubs.len() < MAX_SAME_SECOND_HANDSHAKES
        && !mark.ek_pubs.iter().any(|ek| ek == ek_pub)
    {
        mark.ek_pubs.push(ek_pub.to_string());
    }
}

/// Answer a contact's handshake: run X3DH as responder and start our ratchet.
/// Returns the identity after the exchange (it may have consumed a one-time
/// prekey), the ratchet and the associated data.
///
/// The ratchet starts from the signed prekey the handshake actually used,
/// which after a rotation is often a retired one: the peer's ratchet starts
/// from the public half of the prekey in the bundle it cached.
fn respond_to_handshake(
    identity: &Identity,
    hs: &WireHandshake,
) -> Result<(Identity, RatchetState, Vec<u8>), X3dhError> {
    let mut identity = identity.clone();
    let resp = respond(
        &mut identity,
        &InitialMessage {
            ik_dh_pub: hs.ik_dh_pub.clone(),
            ek_pub: hs.ek_pub.clone(),
            spk_id: hs.spk_id,
            opk_id: hs.opk_id,
        },
    )?;
    let ratchet = init_responder(resp.master_secret, resp.spk_keypair);
    Ok((identity, ratchet, resp.associated_data))
}

async fn handle_incoming_event(
    app: AppHandle,
    state_inner: Arc<tokio::sync::Mutex<crate::state::InnerState>>,
    event: NostrEvent,
) {
    dbg_log("RECV event");
    let mut inner = state_inner.lock().await;
    let identity = match &inner.identity {
        Some(i) => i.clone(),
        None => {
            dbg_log("  DROP: vault sealed (no identity in memory)");
            return;
        }
    };
    let my_pub = hex::encode(identity.nostr.pub_bytes);
    let friend = match admit_event(&mut inner, &event, &my_pub) {
        Admission::Process(friend) => *friend,
        Admission::Stranger => {
            dbg_log("  DROP: sender not a known friend -> emitting handshake-needed");
            let _ = app.emit(
                "handshake-needed",
                HandshakeNeededEvent {
                    from_pubkey: event.pubkey.clone(),
                },
            );
            return;
        }
        Admission::Drop(reason) => {
            dbg_log(reason);
            return;
        }
    };
    // Persist the event id (only a contact's, see admit_event) before
    // processing, so a restart cannot process the same event twice. This is
    // dedup, not replay protection: the cache is bounded, which is why
    // handshakes also pass `judge_handshake`.
    save_ratchets(&inner);
    dbg_log("  sender is a contact");

    let payload: WirePayload = match serde_json::from_str(&event.content) {
        Ok(p) => p,
        Err(_) => {
            dbg_log("  DROP: payload JSON parse failed");
            return;
        }
    };

    if let Some(hs) = &payload.handshake {
        // PINNING (TOFU): the identity DH key in an incoming handshake must match
        // the one we pinned when we added this contact. The ik_dh_pub is stable
        // (only ek/spk rotate), so a legit re-handshake or auto-heal always
        // matches — a mismatch means someone is trying to silently replace the
        // session with a different identity. Reject it.
        if hs.ik_dh_pub != friend.bundle.ik_dh_pub {
            dbg_log(
                "  DROP: handshake ik_dh_pub does not match the pinned bundle (impersonation?)",
            );
            // K8: the UI says so, at most once every 10 minutes per contact.
            // The handshake is still dropped.
            let now = chrono::Utc::now().timestamp();
            if contacts_cmds::should_report_key_mismatch(
                &mut inner.key_mismatch_at,
                &friend.handle,
                now,
            ) {
                let _ = app.emit(
                    "contact-key-mismatch",
                    contacts_cmds::ContactKeyMismatchEvent {
                        handle: friend.handle.clone(),
                    },
                );
            }
            return;
        }
        // REPLAY GATE: relay traffic is public and the dedup cache is bounded,
        // so an old handshake of this contact can be fed to us again. Only a
        // fresh one that is newer than every handshake already accepted from
        // them may (re)start a session. The event and its ciphertext are
        // dropped with it: they belong to a session we are not going to have.
        let now = chrono::Utc::now().timestamp();
        let mark = inner.handshake_marks.get(&friend.bundle.nostr_pub);
        if let Err(rejection) = judge_handshake(mark, event.created_at, &hs.ek_pub, now) {
            match rejection {
                HandshakeRejection::Stale { age } => {
                    crate::diag::note_with("  DROP: stale handshake", &[("age_s", &age)])
                }
                HandshakeRejection::FromTheFuture { ahead } => crate::diag::note_with(
                    "  DROP: handshake from the future",
                    &[("ahead_s", &ahead)],
                ),
                HandshakeRejection::NotNewer { .. } => {
                    dbg_log("  DROP: handshake not newer than the last one accepted")
                }
            }
            return;
        }
        record_handshake(
            &mut inner.handshake_marks,
            &friend.bundle.nostr_pub,
            event.created_at,
            &hs.ek_pub,
        );
        save_ratchets(&inner); // the mark must survive a restart
        let have_session = inner.ratchets.contains_key(&friend.handle);
        // Glare resolution: if BOTH peers initiated a handshake at the same time we
        // end up with two incompatible sessions. Deterministic tie-break: the
        // session initiated by the LOWER nostr pubkey wins. So if the peer's pubkey
        // sorts below ours, we YIELD — accept their handshake and replace our own.
        let peer_wins = friend.bundle.nostr_pub.as_str() < my_pub.as_str();
        crate::diag::note_with(
            "  handshake present",
            &[
                ("spk_id", &hs.spk_id),
                ("has_session", &have_session),
                ("peer_wins", &peer_wins),
            ],
        );
        if !have_session || peer_wins {
            let (identity_after, ratchet, associated_data) =
                match respond_to_handshake(&identity, hs) {
                    Ok(answer) => answer,
                    Err(_) => {
                        dbg_log("  DROP: X3DH respond() failed");
                        return;
                    }
                };
            inner.identity = Some(identity_after);
            inner.ratchets.insert(friend.handle.clone(), ratchet);
            inner
                .associated_data
                .insert(friend.handle.clone(), associated_data);
            save_ratchets(&inner);
            dbg_log("  responder ratchet established");
            // Fresh session: replay any buffered outgoing so messages the peer
            // lost during the desync get re-delivered (deduped by id).
            let _ = app.emit("session-established", friend.handle.clone());
        }
    }

    let ad = match inner.associated_data.get(&friend.handle).cloned() {
        Some(a) => a,
        None => {
            dbg_log("  DROP: no associated_data (no session) — auto-healing");
            trigger_resync(&mut inner, &app, &friend.handle);
            return;
        }
    };
    let has_ratchet = inner.ratchets.contains_key(&friend.handle);
    if !has_ratchet {
        dbg_log("  DROP: no ratchet for friend — auto-healing");
        trigger_resync(&mut inner, &app, &friend.handle);
        return;
    }
    let ratchet = inner.ratchets.get_mut(&friend.handle).unwrap();
    let msg = EncryptedMessage {
        header: MessageHeader {
            dh_pub: payload.header.dh_pub,
            pn: payload.header.pn,
            n: payload.header.n,
        },
        nonce: payload.nonce,
        ciphertext: payload.ciphertext,
    };
    let plain = match ratchet_decrypt(ratchet, &msg, &ad) {
        Ok(p) => p,
        Err(RatchetError::Replay { .. }) => {
            crate::diag::note_with(
                "  skip: replayed ciphertext",
                &[("n", &msg.header.n), ("pn", &msg.header.pn)],
            );
            return;
        }
        Err(_) => {
            crate::diag::note_with(
                "  DROP: ratchet_decrypt failed",
                &[("n", &msg.header.n), ("pn", &msg.header.pn)],
            );
            // AUTO-HEAL: a decrypt failure means our ratchet diverged from the
            // peer's (a lost message, a crash mid-save, call-signal flooding…).
            // Drop the broken session and ask the UI to re-handshake. The
            // deterministic pubkey tie-break then reconverges both sides on one
            // session. Rate-limited so a burst of undecryptable events (or a
            // hostile sender) can't trigger a re-handshake storm.
            //
            // FRESHNESS GATE (anti-DoS): only a RECENT undecryptable message may
            // tear down a session. Relay traffic is public, so anyone could
            // record an old ciphertext of ours, flood `seen_events` until its id
            // is evicted, and replay it — it is too old to be caught by the
            // replay detector, fails AEAD, and would wipe the session. Repeat
            // forever = permanent loss of service. Genuine desyncs surface on
            // live messages; stale ones from the 24h catch-up window are just
            // dropped.
            let now = chrono::Utc::now().timestamp();
            let age = now - event.created_at;
            if !(-AUTO_HEAL_MAX_AGE_SECS..=AUTO_HEAL_MAX_AGE_SECS).contains(&age) {
                crate::diag::note_with(
                    "  stale undecryptable event dropped without auto-heal",
                    &[("age_s", &age)],
                );
                return;
            }
            let last = *inner.resync_at.get(&friend.handle).unwrap_or(&0);
            if now - last > 20 {
                inner.resync_at.insert(friend.handle.clone(), now);
                inner.ratchets.remove(&friend.handle);
                inner.associated_data.remove(&friend.handle);
                save_ratchets(&inner);
                dbg_log("  AUTO-HEAL: cleared a desynced session, requesting resync");
                let _ = app.emit("resync-needed", friend.handle.clone());
            }
            return;
        }
    };
    save_ratchets(&inner); // receiving chain advanced — persist it
    if plain == b"__trino_handshake__" {
        dbg_log("  OK: handshake message decrypted (no UI emit)");
        return;
    }
    // -- W8 (K12) -- A profile message ends here, never as text; text, group
    // and file messages say whether their sender reads profiles.
    if profile::on_message(&app, &mut inner, &friend.handle, &plain, event.created_at) {
        return;
    }

    match decode_envelope(&plain) {
        Envelope::Text { body, id } => {
            // Drop duplicates (a resend after auto-heal replays the same id).
            if !id.is_empty() && !inner.remember_message_id(id.clone()) {
                dbg_log("  skip: duplicate message id");
                return;
            }
            save_ratchets(&inner);
            dbg_log("  OK: text received");
            record_history(
                &mut inner,
                friend.handle.clone(),
                HistItem {
                    side: "them".into(),
                    from: None,
                    text: Some(body.clone()),
                    file: None,
                    call: None,
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "message-received",
                IncomingMessageEvent {
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Group { gid, ep: _, body } => {
            let allowed = inner
                .groups
                .get(&gid)
                .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                .unwrap_or(false);
            if !allowed {
                dbg_log("  DROP: group message from a non-member");
                return;
            }
            dbg_log("  OK: group message received");
            record_history(
                &mut inner,
                group_convo(&gid),
                HistItem {
                    side: "them".into(),
                    from: Some(friend.handle.clone()),
                    text: Some(body.clone()),
                    file: None,
                    call: None,
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "group-message",
                IncomingGroupMessageEvent {
                    gid,
                    from_handle: friend.handle.clone(),
                    text: body,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Roster { roster } => {
            accept_incoming_roster(&app, &mut inner, &identity, &friend, roster);
        }
        Envelope::File { file, gid, body: _ } => {
            let file = sanitize_file_ref(file);
            if let Some(g) = &gid {
                let allowed = inner
                    .groups
                    .get(g)
                    .map(|r| group::is_member(r, &friend.bundle.ik_sign_pub))
                    .unwrap_or(false);
                if !allowed {
                    dbg_log("  DROP: group file from non-member");
                    return;
                }
            }
            dbg_log("  OK: file received");
            let convo = match &gid {
                Some(g) => group_convo(g),
                None => friend.handle.clone(),
            };
            let from = gid.as_ref().map(|_| friend.handle.clone());
            record_history(
                &mut inner,
                convo,
                HistItem {
                    side: "them".into(),
                    from,
                    text: None,
                    file: Some(file.clone()),
                    call: None,
                    ts: event.created_at,
                },
            );
            let _ = app.emit(
                "file-message",
                FileMessageEvent {
                    from_handle: friend.handle.clone(),
                    gid,
                    file,
                    timestamp: event.created_at,
                },
            );
        }
        Envelope::Call { call } => {
            // Call signals (SDP offer/answer, ICE) are only meaningful in real
            // time. The catch-up subscription delivers old ones again after a
            // restart or reconnect, so a stale offer would occupy the call
            // state and make live calls read
            // as "busy". Drop stale/future-dated and malformed signals.
            let age = chrono::Utc::now().timestamp() - event.created_at;
            if !(-60..=60).contains(&age) {
                crate::diag::note_with("  stale call signal ignored", &[("age_s", &age)]);
            } else if validate_call_signal(&call).is_err() {
                dbg_log("  invalid call signal ignored");
            } else {
                dbg_log("  call signal received");
                let _ = app.emit(
                    "call-signal",
                    CallSignalEvent {
                        from_handle: friend.handle.clone(),
                        payload: call,
                    },
                );
            }
        }
    }
}

/// Where an incoming roster ended up. Produced by the pure
/// `ingest_incoming_roster`; the caller persists and notifies.
#[derive(Debug, PartialEq)]
enum RosterOutcome {
    /// Update applied to a group we are in; `notes` explain skipped members.
    Applied {
        gid: String,
        notes: Vec<String>,
    },
    /// Held as a pending invitation: nothing applied, no contacts created.
    Invited {
        gid: String,
    },
    /// The admin's newer roster for a group we are in does not list us: we
    /// were removed, or the group was deleted (K10). Kept, so the chat stays
    /// readable and the group reads as ended.
    Ended {
        gid: String,
    },
    Dropped(String),
}

/// How many invitations one contact may have waiting at once. Any contact can
/// send us validly signed rosters for groups of their own making.
const MAX_PENDING_INVITES_PER_CONTACT: usize = 5;

/// First `n` bytes of `s`, for handle suffixes and notes. Never panics on
/// short or non-ASCII (attacker-controlled) input.
fn short_prefix(s: &str, n: usize) -> &str {
    s.get(..n.min(s.len())).unwrap_or("?")
}

/// Pure part of handling a roster that `sender` sent us (see
/// `group::evaluate_incoming_roster` for the rules). An update to a group we
/// are in is applied; a roster for any other group is at most held as a
/// pending invite, which creates no group and no contacts.
fn ingest_incoming_roster(
    inner: &mut InnerState,
    roster: GroupRoster,
    sender_handle: &str,
    sender_ik: &str,
    my_ik: &str,
    now: i64,
) -> RosterOutcome {
    let gid = roster.group_id.clone();
    if let Some(current) = inner.groups.get(&gid) {
        return match group::evaluate_incoming_roster(Some(current), &roster, sender_ik, my_ik) {
            RosterDecision::Accept => {
                let roster = sanitize_roster(roster);
                let notes = merge_group_members(&mut inner.friends, &roster, my_ik, now);
                inner.groups.insert(gid.clone(), roster);
                RosterOutcome::Applied { gid, notes }
            }
            RosterDecision::PendingInvite => {
                RosterOutcome::Dropped("invite for a group we are already in".into())
            }
            // K10: the admin's next roster leaves us out: we were removed,
            // or the group was deleted. Kept, so later rosters must be newer
            // still and the chat stays readable; the group reads as ended.
            RosterDecision::Reject(group::RosterRejection::NotAMember)
                if group::accept_roster_update(current, &roster) =>
            {
                inner.groups.insert(gid.clone(), sanitize_roster(roster));
                RosterOutcome::Ended { gid }
            }
            RosterDecision::Reject(why) => RosterOutcome::Dropped(why.to_string()),
        };
    }
    let pending = inner.group_invites.get(&gid).map(|i| &i.roster);
    let is_new = pending.is_none();
    match group::evaluate_incoming_roster(pending, &roster, sender_ik, my_ik) {
        RosterDecision::Reject(why) => RosterOutcome::Dropped(why.to_string()),
        // PendingInvite: a new invitation. Accept: a newer roster for an
        // invitation already waiting, which replaces it.
        RosterDecision::PendingInvite | RosterDecision::Accept => {
            let waiting = inner
                .group_invites
                .values()
                .filter(|i| i.roster.admin_pub == roster.admin_pub)
                .count();
            if is_new && waiting >= MAX_PENDING_INVITES_PER_CONTACT {
                return RosterOutcome::Dropped("too many pending invites from this contact".into());
            }
            inner.group_invites.insert(
                gid.clone(),
                GroupInvite {
                    roster: sanitize_roster(roster),
                    from_handle: sender_handle.to_string(),
                    received_at: now,
                },
            );
            RosterOutcome::Invited { gid }
        }
    }
}

/// Join the group of a pending invite: apply its roster and add its members as
/// contacts. Pure. The invite is consumed whether or not joining succeeds.
fn take_group_invite(
    inner: &mut InnerState,
    gid: &str,
    my_ik: &str,
    now: i64,
) -> Result<(GroupRoster, Vec<String>), String> {
    let invite = inner
        .group_invites
        .remove(gid)
        .ok_or("unknown group invite")?;
    if inner.groups.contains_key(gid) {
        return Err("already a member of this group".into());
    }
    // Check again: group_invites.json on disk is not authenticated.
    let roster = invite.roster;
    match group::evaluate_incoming_roster(None, &roster, &roster.admin_pub, my_ik) {
        RosterDecision::PendingInvite => {}
        RosterDecision::Reject(why) => return Err(why.to_string()),
        RosterDecision::Accept => return Err("unexpected roster state".into()),
    }
    let notes = merge_group_members(&mut inner.friends, &roster, my_ik, now);
    inner.groups.insert(gid.to_string(), roster.clone());
    Ok((roster, notes))
}

/// Fill in the `id_sig` of members that lack a valid one (rosters stored before
/// roster v2 carry none) from bundles we hold ourselves: our own, or the stored
/// bundle of the same contact when its DH and Nostr keys match exactly. A
/// member we cannot vouch for is left as is, and the roster builder then
/// refuses the roster rather than sending one every member would reject.
fn refresh_member_bindings(
    members: &mut [MemberBundle],
    friends: &HashMap<String, FriendRecord>,
    me: &MemberBundle,
) {
    let mine = me.to_public_bundle();
    for m in members.iter_mut() {
        if verify_bundle_binding(&m.to_public_bundle()) {
            continue;
        }
        let held = std::iter::once(&mine)
            .chain(friends.values().map(|f| &f.bundle))
            .find(|b| {
                b.ik_sign_pub == m.ik_sign_pub
                    && b.ik_dh_pub == m.ik_dh_pub
                    && b.nostr_pub == m.nostr_pub
            });
        if let Some(bundle) = held {
            m.id_sig = bundle.id_sig.clone();
        }
    }
}

/// Handle a roster a contact sent us: apply it, hold it as an invite for the
/// user, or drop it. Persists and notifies the UI; the rules live in
/// `ingest_incoming_roster`.
fn accept_incoming_roster(
    app: &AppHandle,
    inner: &mut InnerState,
    identity: &crate::identity::Identity,
    sender: &FriendRecord,
    roster: GroupRoster,
) {
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let now = chrono::Utc::now().timestamp();
    match ingest_incoming_roster(
        inner,
        roster,
        &sender.handle,
        &sender.bundle.ik_sign_pub,
        &my_ik,
        now,
    ) {
        RosterOutcome::Applied { gid, notes } => {
            log_skipped_members(&notes);
            let _ = persist_friends(inner);
            let _ = persist_groups(inner);
            dbg_log("  OK: roster stored");
            let _ = app.emit("group-updated", GroupUpdatedEvent { gid });
        }
        RosterOutcome::Invited { gid } => {
            let _ = persist_group_invites(inner);
            dbg_log("  OK: group invite held");
            if let Some(invite) = inner.group_invites.get(&gid) {
                let _ = app.emit("group-invite", invite_info(invite));
            }
        }
        RosterOutcome::Ended { gid } => {
            let _ = persist_groups(inner);
            dbg_log("  OK: group ended for us");
            let _ = app.emit("group-removed", groups_cmds::GroupRemovedEvent { gid });
        }
        RosterOutcome::Dropped(_) => dbg_log("  DROP: roster rejected"),
    }
}

/// Add the members of a group we are in as contacts, so the pairwise fan-out
/// can reach them. Pure; returns one note per member skipped, for the log.
///
/// Never replaces or edits an existing contact. A member is skipped when its
/// own identity key did not sign its keys; when its identity key is already a
/// contact with different DH/Nostr keys (the pinned ones win); when its DH or
/// Nostr key already belongs to another contact (incoming events are matched
/// to contacts by Nostr key); or when no free handle is left for it. A name
/// that cannot name a contact here (`contacts_cmds::check_local_handle`) is
/// left out of its handle.
fn merge_group_members(
    friends: &mut HashMap<String, FriendRecord>,
    roster: &GroupRoster,
    my_ik: &str,
    now: i64,
) -> Vec<String> {
    let mut notes = Vec::new();
    for m in &roster.members {
        if m.ik_sign_pub == my_ik {
            continue;
        }
        let who = short_prefix(&m.ik_sign_pub, 8);
        let bundle = m.to_public_bundle();
        if !verify_bundle_binding(&bundle) {
            notes.push(format!("skip member {who}: keys not bound to its identity"));
            continue;
        }
        if let Some(known) = friends
            .values()
            .find(|f| f.bundle.ik_sign_pub == m.ik_sign_pub)
        {
            if known.bundle.ik_dh_pub != m.ik_dh_pub || known.bundle.nostr_pub != m.nostr_pub {
                notes.push(format!(
                    "skip member {who}: keys differ from contact {:?}",
                    known.handle
                ));
            }
            continue;
        }
        if friends
            .values()
            .any(|f| f.bundle.ik_dh_pub == m.ik_dh_pub || f.bundle.nostr_pub == m.nostr_pub)
        {
            notes.push(format!(
                "skip member {who}: its DH/Nostr key belongs to another contact"
            ));
            continue;
        }
        // The name the member gives itself, if it can name a contact here.
        // One the chats would read as the channel or a group, or with
        // control, format or bidi characters, or showing nothing, is left
        // out as an empty one is: the key tells the member apart.
        let name = match contacts_cmds::check_local_handle(&m.handle) {
            Ok(()) => m.handle.as_str(),
            Err(_) => "",
        };
        let handle = if name.is_empty() || friends.contains_key(name) {
            format!("{}-{}", name, short_prefix(&m.ik_sign_pub, 4))
        } else {
            name.to_string()
        };
        if friends.contains_key(&handle) {
            notes.push(format!("skip member {who}: handle {handle:?} is taken"));
            continue;
        }
        friends.insert(
            handle.clone(),
            FriendRecord {
                handle,
                bundle,
                added_at: now,
                avatar: None,
                previous_fingerprint: None,
                key_changed_at: None,
                // K9: the group panel tells these apart from contacts the
                // user added with a code.
                via_group: Some(roster.group_id.clone()),
            },
        );
    }
    notes
}

fn persist_groups(inner: &crate::state::InnerState) -> Result<(), String> {
    let groups: Vec<&GroupRoster> = inner.groups.values().collect();
    let json = serde_json::to_string_pretty(&groups).map_err(|e| e.to_string())?;
    fsutil::atomic_write(&groups_path(), json.as_bytes()).map_err(|e| e.to_string())
}

fn persist_group_invites(inner: &InnerState) -> Result<(), String> {
    let invites: Vec<&GroupInvite> = inner.group_invites.values().collect();
    let json = serde_json::to_string_pretty(&invites).map_err(|e| e.to_string())?;
    fsutil::atomic_write(&group_invites_path(), json.as_bytes()).map_err(|e| e.to_string())
}

fn invite_info(invite: &GroupInvite) -> GroupInviteInfo {
    GroupInviteInfo {
        gid: invite.roster.group_id.clone(),
        name: invite.roster.name.clone(),
        from_handle: invite.from_handle.clone(),
        member_count: invite.roster.members.len(),
        received_at: invite.received_at,
    }
}

/// Invitations waiting for the user, oldest first. The UI asks on start-up
/// because invites can arrive (catch-up window) before it listens for
/// `group-invite`.
#[tauri::command]
pub async fn list_group_invites(
    state: State<'_, AppState>,
) -> Result<Vec<GroupInviteInfo>, String> {
    let inner = state.inner.lock().await;
    let mut out: Vec<GroupInviteInfo> = inner.group_invites.values().map(invite_info).collect();
    out.sort_by_key(|i| i.received_at);
    Ok(out)
}

/// Join the group of a pending invite and add its members as contacts.
#[tauri::command]
pub async fn accept_group_invite(
    state: State<'_, AppState>,
    gid: String,
) -> Result<GroupInfo, String> {
    let mut inner = state.inner.lock().await;
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    let my_ik = hex::encode(identity.ik_sign.pub_bytes);
    let joined = take_group_invite(&mut inner, &gid, &my_ik, chrono::Utc::now().timestamp());
    // The invite is consumed either way.
    persist_group_invites(&inner)?;
    let (roster, notes) = joined?;
    log_skipped_members(&notes);
    persist_friends(&inner)?;
    persist_groups(&inner)?;
    dbg_log("GROUP INVITE accepted");
    Ok(group_info(&roster, &my_ik))
}

/// Drop a pending invite. Nothing is sent to the inviter.
#[tauri::command]
pub async fn decline_group_invite(state: State<'_, AppState>, gid: String) -> Result<(), String> {
    let mut inner = state.inner.lock().await;
    if inner.identity.is_none() {
        return Err("vault sealed".to_string());
    }
    inner
        .group_invites
        .remove(&gid)
        .ok_or("unknown group invite")?;
    persist_group_invites(&inner)
}

// ---- encrypted chat history -------------------------------------------------

pub(crate) const HISTORY_CAP: usize = 500; // keep last N per conversation (bounds the file)

fn derive_history_key(identity: &crate::identity::Identity) -> [u8; 32] {
    let okm = crate::crypto::hkdf_expand(
        &identity.ik_sign.priv_bytes,
        &[0u8; 32],
        b"trino-history-key-v1",
        32,
    )
    .unwrap_or_else(|_| vec![0u8; 32]);
    let mut k = [0u8; 32];
    k.copy_from_slice(&okm[..32]);
    k
}

pub(crate) fn save_history(inner: &InnerState) {
    // Not fatal, as before: a failed write keeps the previous history.bin
    // whole, and the next save writes everything again.
    if write_history(inner, &history_path()).is_err() {
        dbg_log("history.bin could not be saved");
    }
}

/// Encrypt the history with the history key and replace `path` with it,
/// `nonce ‖ ciphertext`. Without a key (no session) nothing is written.
fn write_history(inner: &InnerState, path: &Path) -> std::io::Result<()> {
    let Some(key) = inner.history_key else {
        return Ok(());
    };
    let json = serde_json::to_vec(&inner.history).map_err(std::io::Error::other)?;
    let (ct, nonce) = crate::crypto::aes_gcm_encrypt(&key, &json, None)
        .map_err(|error| std::io::Error::other(error.to_string()))?;
    let mut blob = Vec::with_capacity(nonce.len() + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    fsutil::atomic_write(path, &blob)
}

pub(crate) fn load_history(inner: &mut InnerState, path: &Path) {
    let Some(key) = inner.history_key else {
        return;
    };
    let Ok(blob) = std::fs::read(path) else {
        return;
    };
    if blob.len() < 12 {
        return;
    }
    let (nonce, ct) = blob.split_at(12);
    if let Ok(json) = crate::crypto::aes_gcm_decrypt(&key, ct, nonce, None) {
        if let Ok(mut h) = serde_json::from_slice::<HashMap<String, Vec<HistItem>>>(&json) {
            for items in h.values_mut() {
                for item in items {
                    if let Some(file) = item.file.take() {
                        item.file = Some(sanitize_file_ref(file));
                    }
                }
            }
            inner.history = h;
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct RatchetsFile {
    ratchets: HashMap<String, crate::ratchet::RatchetState>,
    #[serde(default)]
    associated_data: HashMap<String, Vec<u8>>,
    #[serde(default)]
    seen_events: Vec<String>,
    #[serde(default)]
    seen_msg_ids: Vec<String>,
    /// Defaulted so files written before the handshake replay gate still
    /// load; such contacts start without a mark (see HANDSHAKE_MAX_AGE_SECS).
    #[serde(default)]
    handshake_marks: HashMap<String, HandshakeMark>,
}

impl RatchetsFile {
    fn from_state(inner: &InnerState) -> Self {
        RatchetsFile {
            ratchets: inner.ratchets.clone(),
            associated_data: inner.associated_data.clone(),
            seen_events: inner.seen_event_order.iter().cloned().collect(),
            seen_msg_ids: inner.seen_msg_id_order.iter().cloned().collect(),
            handshake_marks: inner.handshake_marks.clone(),
        }
    }

    fn restore_into(self, inner: &mut InnerState) {
        inner.ratchets = self.ratchets;
        inner.associated_data = self.associated_data;
        inner.handshake_marks = self.handshake_marks;
        inner.clear_seen_ids();
        for id in self.seen_events {
            inner.remember_event(id);
        }
        for id in self.seen_msg_ids {
            inner.remember_message_id(id);
        }
    }
}

/// Persist the Double Ratchet sessions (+ associated data) ENCRYPTED to disk so
/// they survive app restarts. Without this, every restart forces a fresh X3DH
/// handshake and desyncs the peer (messages silently fail to decrypt).
fn save_ratchets(inner: &InnerState) {
    let Some(key) = inner.history_key else {
        return;
    };
    let file = RatchetsFile::from_state(inner);
    let Ok(json) = serde_json::to_vec(&file) else {
        return;
    };
    let Ok((ct, nonce)) = crate::crypto::aes_gcm_encrypt(&key, &json, None) else {
        return;
    };
    let mut blob = Vec::with_capacity(nonce.len() + ct.len());
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ct);
    // Not fatal, as before: a failed write keeps the previous ratchets.bin
    // whole, and the next save writes every session again.
    if fsutil::atomic_write(&ratchets_path(), &blob).is_err() {
        dbg_log("ratchets.bin could not be saved");
    }
}

fn load_ratchets(inner: &mut InnerState, path: &Path) {
    let Some(key) = inner.history_key else {
        return;
    };
    let Ok(blob) = std::fs::read(path) else {
        return;
    };
    if blob.len() < 12 {
        return;
    }
    let (nonce, ct) = blob.split_at(12);
    if let Ok(json) = crate::crypto::aes_gcm_decrypt(&key, ct, nonce, None) {
        if let Ok(f) = serde_json::from_slice::<RatchetsFile>(&json) {
            f.restore_into(inner);
        }
    }
}

/// Auto-heal a broken/absent session: drop it and ask the UI to re-handshake
/// (rate-limited per peer). Covers both decrypt failures (AEAD) and the
/// "peer thinks we have a session but we don't" case. The tie-break reconverges
/// and buffered messages get replayed, so nothing is lost.
fn trigger_resync(inner: &mut InnerState, app: &AppHandle, handle: &str) {
    let now = chrono::Utc::now().timestamp();
    let last = *inner.resync_at.get(handle).unwrap_or(&0);
    if now - last <= 20 {
        return;
    }
    inner.resync_at.insert(handle.to_string(), now);
    inner.ratchets.remove(handle);
    inner.associated_data.remove(handle);
    save_ratchets(inner);
    dbg_log("  AUTO-HEAL: requesting resync");
    let _ = app.emit("resync-needed", handle.to_string());
}

/// Unique-enough message id for dedup (ts + a process counter, hashed).
fn new_msg_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ts = chrono::Utc::now().timestamp_millis();
    let h = crate::crypto::sha256(format!("{ts}:{n}").as_bytes());
    hex::encode(&h[..8])
}

/// Buffer a just-sent text envelope so it can be replayed after an auto-heal.
/// Capped to the last 20 messages / 10 minutes per peer.
fn remember_outgoing(inner: &mut InnerState, handle: &str, id: String, env: Vec<u8>) {
    let now = chrono::Utc::now().timestamp();
    let buf = inner.outbox.entry(handle.to_string()).or_default();
    buf.push((id, env, now));
    buf.retain(|(_, _, ts)| now - *ts < 600);
    if buf.len() > 20 {
        let excess = buf.len() - 20;
        buf.drain(0..excess);
    }
}

/// Re-send the buffered outgoing messages to a peer on the current (freshly
/// re-established) session. The peer drops duplicates by message id, so this
/// recovers messages lost to a session desync without creating doubles.
#[tauri::command]
pub async fn resend_outbox(state: State<'_, AppState>, handle: String) -> Result<(), String> {
    resend_buffered(&state, &handle).await;
    Ok(())
}

/// `resend_outbox`: how many buffered messages it sent again.
async fn resend_buffered(state: &AppState, handle: &str) -> usize {
    let items: Vec<Vec<u8>> = {
        let inner = state.inner.lock().await;
        inner
            .outbox
            .get(handle)
            .map(|v| v.iter().map(|(_, e, _)| e.clone()).collect())
            .unwrap_or_default()
    };
    if items.is_empty() {
        return 0;
    }
    crate::diag::note_with("RESEND buffered messages", &[("count", &items.len())]);
    for env in &items {
        let _ = send_cipher_inner(state, handle, env, None).await;
    }
    items.len()
}

fn record_history(inner: &mut InnerState, convo: String, item: HistItem) {
    let v = inner.history.entry(convo).or_default();
    v.push(item);
    if v.len() > HISTORY_CAP {
        let excess = v.len() - HISTORY_CAP;
        v.drain(0..excess);
    }
    save_history(inner);
}

fn group_convo(gid: &str) -> String {
    format!("grp:{}", gid)
}

#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
) -> Result<HashMap<String, Vec<HistItem>>, String> {
    let inner = state.inner.lock().await;
    Ok(inner.history.clone())
}

#[derive(Serialize)]
pub struct ProfileResponse {
    pub handle: String,
    pub avatar: Option<String>,
    pub fingerprint: String,
    pub nostr_pub: String,
    /// SHA-256 of this identity's keys in full (K7); `fingerprint` is its prefix.
    pub identity_digest: String,
    /// The "about" this identity shares (K12).
    pub about: String,
    /// The version of the profile messages this backend sends (K12).
    pub sync: u64,
}

/// What `get_profile` answers for the open session.
fn profile_of(inner: &InnerState) -> Result<ProfileResponse, String> {
    let identity = inner.identity.as_ref().ok_or("vault sealed")?;
    let (ik_sign, ik_dh, nostr) = (
        &identity.ik_sign.pub_bytes,
        &identity.ik_dh.pub_bytes,
        &identity.nostr.pub_bytes,
    );
    Ok(ProfileResponse {
        handle: inner.handle.clone().unwrap_or_default(),
        avatar: inner.avatar.clone(),
        fingerprint: fp(ik_sign, ik_dh, nostr),
        nostr_pub: hex::encode(nostr),
        identity_digest: contacts_cmds::identity_digest(ik_sign, ik_dh, nostr),
        about: inner.profiles.about.clone(),
        sync: profile::PROFILE_V,
    })
}

#[tauri::command]
pub async fn get_profile(state: State<'_, AppState>) -> Result<ProfileResponse, String> {
    profile_of(&*state.inner.lock().await)
}

/// Save this identity's name, photo and, when given, "about" (K12). A blank
/// name keeps the current one, no photo removes it, and no `about` keeps the
/// current one, as callers from before K12 expect. A name or an "about" a
/// profile cannot carry (over 64 or 140 scalars, with a control, format or
/// bidi character, a name with nothing that shows) or such a new photo is
/// `profile_invalid`; the name and the photo already saved may stay as
/// they are.
///
/// When something changed, the profile's revision grows, and the profile
/// goes in the background to every contact that announced it reads
/// profiles: a failed send never fails this.
#[tauri::command]
pub async fn update_profile(
    app: AppHandle,
    state: State<'_, AppState>,
    handle: String,
    avatar: Option<String>,
    about: Option<String>,
) -> Result<(), CommandError> {
    let about = about.as_deref().map(profile::check_about).transpose()?;
    let targets = {
        let mut inner = state.inner.lock().await;
        if inner.identity.is_none() {
            return Err(contacts_cmds::sealed());
        }
        profile::check_editable(&inner.profiles)?;
        let name = profile::check_name(&handle, inner.handle.as_deref())?;
        let avatar = profile::check_photo(avatar, inner.avatar.as_deref())?;
        let now = chrono::Utc::now().timestamp();
        let changed = profile::apply_update(&mut inner, name, avatar, about, now);
        if changed {
            // Saved before anything goes out: a revision sent but never
            // saved would come back older after a restart, and contacts
            // holding the newer one would look up to date.
            profile::try_save(&inner).map_err(|e| CommandError::io(&e))?;
        }

        // Persist to config.json (keep nostr_pub / relays / created_at).
        let cfg_bytes = std::fs::read(config_path()).map_err(|e| CommandError::io(&e))?;
        let mut cfg: ConfigFile = serde_json::from_slice(&cfg_bytes)
            .map_err(|e| CommandError::internal(format!("config.json: {e}")))?;
        cfg.handle = inner.handle.clone().unwrap_or_default();
        cfg.avatar = inner.avatar.clone();
        let cfg_json = serde_json::to_string_pretty(&cfg)
            .map_err(|e| CommandError::internal(e.to_string()))?;
        fsutil::atomic_write(&config_path(), cfg_json.as_bytes())
            .map_err(|e| CommandError::io(&e))?;
        // friends.json also stores our own handle at the top level.
        persist_friends(&inner).map_err(|e| CommandError::new(ErrorCode::Io, e))?;
        if changed {
            profile::targets(&mut inner)
        } else {
            Vec::new()
        }
    };
    profile::send_in_background(&app, targets);
    Ok(())
}

fn persist_friends(inner: &crate::state::InnerState) -> Result<(), String> {
    let file = FriendsFile {
        handle: inner.handle.clone().unwrap_or_default(),
        friends: inner.friends.values().cloned().collect(),
        blocked: inner.blocked.iter().cloned().collect(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fsutil::atomic_write(&friends_path(), json.as_bytes()).map_err(|e| e.to_string())
}

#[allow(dead_code)]
fn build_filter_for_self(nostr_pub: &str) -> NostrFilter {
    let mut m: HashMap<String, Vec<String>> = HashMap::new();
    m.insert("#p".to_string(), vec![nostr_pub.to_string()]);
    NostrFilter {
        kinds: Some(vec![TRINO_KIND]),
        p_tag: Some(vec![nostr_pub.to_string()]),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fsutil::scratch::ScratchDir;
    use crate::group::roster_signing_bytes;
    use crate::identity::{ed25519_sign, generate_nostr_keypair, generate_x25519, Identity};
    use crate::passphrase::MIN_PASSPHRASE_CHARS;
    use crate::totp::{generate_totp_secret, totp_now};
    use crate::vault::SealedVault;

    const NOW: i64 = 1_760_000_000;

    fn ik(id: &Identity) -> String {
        hex::encode(id.ik_sign.pub_bytes)
    }

    fn member(id: &Identity, handle: &str) -> MemberBundle {
        MemberBundle::from_public_bundle(handle, &public_bundle_for(id))
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

    fn state_with(friends: &[FriendRecord]) -> InnerState {
        let mut inner = InnerState::default();
        for f in friends {
            inner.friends.insert(f.handle.clone(), f.clone());
        }
        inner
    }

    /// A roster built by the admin's honest client.
    fn roster_of(admin: &Identity, others: &[(&Identity, &str)]) -> GroupRoster {
        let mut roster = group::create_group(admin, member(admin, "admin"), "amigos").unwrap();
        for (id, handle) in others {
            roster = group::add_member(&roster, admin, member(id, handle)).unwrap();
        }
        roster
    }

    /// A roster signed exactly as given, as a hostile admin's client can.
    fn signed_raw(admin: &Identity, members: Vec<MemberBundle>) -> GroupRoster {
        let group_id = hex::encode(crate::crypto::random_array::<32>());
        let admin_pub = ik(admin);
        let bytes = roster_signing_bytes(&group_id, "amigos", &None, &admin_pub, &members, 0);
        GroupRoster {
            group_id,
            name: "amigos".into(),
            photo: None,
            admin_pub,
            members,
            epoch: 0,
            signature: hex::encode(ed25519_sign(&admin.ik_sign, &bytes)),
        }
    }

    /// Alice's identity key with new DH and Nostr keys, validly bound: what a
    /// legitimate re-key would look like.
    fn rekeyed(id: &Identity) -> Identity {
        let mut other = id.clone();
        other.ik_dh = generate_x25519();
        other.nostr = generate_nostr_keypair();
        other
    }

    #[test]
    fn unknown_group_waits_as_an_invite_and_creates_no_contacts() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);

        let out = ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);

        assert_eq!(out, RosterOutcome::Invited { gid: gid.clone() });
        assert!(
            inner.groups.is_empty(),
            "nothing applied before the user accepts"
        );
        assert_eq!(
            inner.friends.len(),
            1,
            "no contacts before the user accepts"
        );
        let invite = inner.group_invites.get(&gid).expect("invite stored");
        assert_eq!(invite.from_handle, "admin");
        assert_eq!(invite.received_at, NOW);
    }

    #[test]
    fn accepting_an_invite_joins_and_adds_bound_members() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let roster = roster_of(&admin, &[(&me, "me"), (&ana, "ana")]);
        let gid = roster.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);

        let (joined, _notes) = take_group_invite(&mut inner, &gid, &ik(&me), NOW).unwrap();

        assert_eq!(joined.group_id, gid);
        assert!(inner.groups.contains_key(&gid));
        assert!(inner.group_invites.is_empty());
        let ana_contact = inner.friends.get("ana").expect("ana added on accept");
        assert_eq!(ana_contact.bundle.ik_sign_pub, ik(&ana));
        assert!(verify_bundle_binding(&ana_contact.bundle));
        assert!(
            take_group_invite(&mut inner, &gid, &ik(&me), NOW).is_err(),
            "an invite is taken once"
        );
    }

    #[test]
    fn a_newer_roster_refreshes_a_pending_invite() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let v2 = group::add_member(&v1, &admin, member(&ana, "ana")).unwrap();
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        let admin_ik = ik(&admin);

        let first =
            ingest_incoming_roster(&mut inner, v1.clone(), "admin", &admin_ik, &ik(&me), NOW);
        let second =
            ingest_incoming_roster(&mut inner, v2.clone(), "admin", &admin_ik, &ik(&me), NOW);
        let stale = ingest_incoming_roster(&mut inner, v1, "admin", &admin_ik, &ik(&me), NOW);

        assert_eq!(first, RosterOutcome::Invited { gid: gid.clone() });
        assert_eq!(second, RosterOutcome::Invited { gid: gid.clone() });
        assert!(matches!(stale, RosterOutcome::Dropped(_)));
        assert_eq!(inner.group_invites[&gid].roster.epoch, v2.epoch);
        assert!(inner.groups.is_empty());
        assert_eq!(inner.friends.len(), 1);
    }

    #[test]
    fn roster_relayed_by_a_non_admin_is_dropped() {
        let (admin, juan, me) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&juan, "juan"), (&me, "me")]);
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin"), friend(&juan, "juan")]);

        let out = ingest_incoming_roster(&mut inner, v1.clone(), "juan", &ik(&juan), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert!(inner.groups.is_empty() && inner.group_invites.is_empty());

        // Same for an update to a group we are already in.
        let v2 = group::add_member(&v1, &admin, member(&create_identity(), "ana")).unwrap();
        inner.groups.insert(gid.clone(), v1.clone());
        let out = ingest_incoming_roster(&mut inner, v2, "juan", &ik(&juan), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.groups[&gid].epoch, v1.epoch);
        assert_eq!(inner.friends.len(), 2);
    }

    #[test]
    fn update_from_the_admin_to_a_joined_group_is_applied() {
        let (admin, me, ana) = (create_identity(), create_identity(), create_identity());
        let v1 = roster_of(&admin, &[(&me, "me")]);
        let v2 = group::add_member(&v1, &admin, member(&ana, "ana")).unwrap();
        let gid = v1.group_id.clone();
        let mut inner = state_with(&[friend(&admin, "admin")]);
        inner.groups.insert(gid.clone(), v1);

        let out =
            ingest_incoming_roster(&mut inner, v2.clone(), "admin", &ik(&admin), &ik(&me), NOW);

        assert_eq!(
            out,
            RosterOutcome::Applied {
                gid: gid.clone(),
                notes: vec![]
            }
        );
        assert_eq!(inner.groups[&gid].epoch, v2.epoch);
        assert!(inner.friends.contains_key("ana"));
    }

    #[test]
    fn mallory_cannot_plant_a_fake_alice() {
        // C1 at the app layer: Mallory's own group lists "alice" with Alice's
        // real identity key and Mallory2's transport keys.
        let (mallory, me, alice, mallory2) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let m2 = public_bundle_for(&mallory2);
        let mut fake_alice = member(&alice, "alice");
        fake_alice.ik_dh_pub = m2.ik_dh_pub;
        fake_alice.nostr_pub = m2.nostr_pub;
        let roster = signed_raw(
            &mallory,
            vec![member(&mallory, "mallory"), member(&me, "me"), fake_alice],
        );
        let mut inner = state_with(&[friend(&mallory, "mallory")]);

        let out =
            ingest_incoming_roster(&mut inner, roster, "mallory", &ik(&mallory), &ik(&me), NOW);

        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.friends.len(), 1);
        assert!(inner.groups.is_empty() && inner.group_invites.is_empty());
    }

    #[test]
    fn merge_skips_members_whose_keys_are_not_bound() {
        // Defense in depth below roster validation: merge is given a roster
        // that never went through it.
        let (alice, mallory2) = (create_identity(), create_identity());
        let m2 = public_bundle_for(&mallory2);
        let mut fake_alice = member(&alice, "alice");
        fake_alice.ik_dh_pub = m2.ik_dh_pub;
        fake_alice.nostr_pub = m2.nostr_pub;
        let roster = signed_raw(&mallory2, vec![fake_alice]);
        let mut friends = HashMap::new();

        let notes = merge_group_members(&mut friends, &roster, "not-a-member", NOW);

        assert!(friends.is_empty());
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_replaces_a_contact_and_flags_changed_keys() {
        let alice = create_identity();
        let stored = friend(&alice, "alice");
        let mut friends = HashMap::from([("alice".to_string(), stored.clone())]);

        // Same identity, same keys: nothing to do, nothing to report.
        let same = signed_raw(&alice, vec![member(&alice, "alice")]);
        assert!(merge_group_members(&mut friends, &same, "me", NOW).is_empty());

        // Same identity key, different transport keys: keep what we have.
        let other_keys = signed_raw(&alice, vec![member(&rekeyed(&alice), "alice-new")]);
        let notes = merge_group_members(&mut friends, &other_keys, "me", NOW);

        assert_eq!(friends.len(), 1);
        assert_eq!(friends["alice"].bundle.ik_dh_pub, stored.bundle.ik_dh_pub);
        assert_eq!(friends["alice"].bundle.nostr_pub, stored.bundle.nostr_pub);
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_skips_members_reusing_a_contacts_transport_keys() {
        let alice = create_identity();
        let mut shadow = create_identity();
        shadow.ik_dh = alice.ik_dh.clone();
        shadow.nostr = alice.nostr.clone();
        let roster = signed_raw(&shadow, vec![member(&shadow, "alice2")]);
        let mut friends = HashMap::from([("alice".to_string(), friend(&alice, "alice"))]);

        let notes = merge_group_members(&mut friends, &roster, "me", NOW);

        assert_eq!(friends.len(), 1);
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_overwrites_on_a_handle_collision() {
        let (bob, carol, dave) = (create_identity(), create_identity(), create_identity());
        let taken = format!("bob-{}", &ik(&carol)[..4]);
        let mut friends = HashMap::from([
            ("bob".to_string(), friend(&bob, "bob")),
            (taken.clone(), friend(&dave, &taken)),
        ]);
        let roster = signed_raw(&carol, vec![member(&carol, "bob")]);

        let notes = merge_group_members(&mut friends, &roster, "me", NOW);

        assert_eq!(friends.len(), 2);
        assert_eq!(friends[&taken].bundle.ik_sign_pub, ik(&dave));
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn merge_never_names_a_member_as_the_channel_or_a_group() {
        // The names members give themselves in a roster: here the chats
        // would read them as the announcements channel or as a group, and a
        // bidi control would reorder the list. The key tells them apart.
        let (admin, me, a, b, c, d) = (
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
            create_identity(),
        );
        let roster = roster_of(
            &admin,
            &[
                (&me, "me"),
                (&a, "channel"),
                (&b, "grp:4f1c"),
                (&c, "Ana\u{202E}"),
                (&d, "   "),
            ],
        );
        let mut friends = HashMap::new();

        let notes = merge_group_members(&mut friends, &roster, &ik(&me), NOW);

        assert!(notes.is_empty(), "{notes:?}");
        let handle_of = |id: &Identity| {
            friends
                .values()
                .find(|f| f.bundle.ik_sign_pub == ik(id))
                .map(|f| f.handle.clone())
        };
        for id in [&a, &b, &c, &d] {
            assert_eq!(handle_of(id), Some(format!("-{}", &ik(id)[..4])));
        }
        assert_eq!(handle_of(&admin).as_deref(), Some("admin"));
        assert!(friends
            .keys()
            .all(|handle| contacts_cmds::check_local_handle(handle).is_ok()));
    }

    #[test]
    fn pending_invites_per_contact_are_capped() {
        let (admin, me) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&admin, "admin")]);
        for _ in 0..MAX_PENDING_INVITES_PER_CONTACT {
            let roster = roster_of(&admin, &[(&me, "me")]);
            let out =
                ingest_incoming_roster(&mut inner, roster, "admin", &ik(&admin), &ik(&me), NOW);
            assert!(matches!(out, RosterOutcome::Invited { .. }), "{out:?}");
        }
        let one_more = roster_of(&admin, &[(&me, "me")]);
        let out = ingest_incoming_roster(&mut inner, one_more, "admin", &ik(&admin), &ik(&me), NOW);
        assert!(matches!(out, RosterOutcome::Dropped(_)), "{out:?}");
        assert_eq!(inner.group_invites.len(), MAX_PENDING_INVITES_PER_CONTACT);
    }

    #[test]
    fn refresh_member_bindings_restores_id_sig_from_what_we_hold() {
        // Rosters stored before roster v2 have no id_sig. When we rebuild one
        // (as admin), fill them in from our identity and matching contacts.
        let (admin, juan, ana) = (create_identity(), create_identity(), create_identity());
        let me = member(&admin, "me");
        let mut members = vec![me.clone(), member(&juan, "juan"), member(&ana, "ana")];
        for m in &mut members {
            m.id_sig.clear();
        }
        let friends = HashMap::from([
            ("juan".to_string(), friend(&juan, "juan")),
            // A contact whose keys no longer match the roster entry.
            ("ana".to_string(), friend(&rekeyed(&ana), "ana")),
        ]);

        refresh_member_bindings(&mut members, &friends, &me);

        assert_eq!(members[0].id_sig, me.id_sig);
        assert_eq!(members[1].id_sig, public_bundle_for(&juan).id_sig);
        assert!(
            members[2].id_sig.is_empty(),
            "never borrow a binding for other keys"
        );
    }

    // ---- Admission of relay events (M1, H2 event cache) ----

    fn nostr_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    fn event_to(sender: &Identity, to: &str, kind: u32, created_at: i64) -> NostrEvent {
        build_and_sign_event(
            &sender.nostr.priv_bytes,
            &sender.nostr.pub_bytes,
            kind,
            "{}",
            vec![vec!["p".to_string(), to.to_string()]],
            Some(created_at),
        )
        .unwrap()
    }

    #[test]
    fn a_contacts_event_is_admitted_once() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&me), TRINO_KIND, NOW);

        let first = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(
            matches!(&first, Admission::Process(f) if f.handle == "alice"),
            "{first:?}"
        );
        let again = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(again, Admission::Drop(_)), "{again:?}");
    }

    #[test]
    fn a_contacts_event_addressed_to_someone_else_is_dropped() {
        // A group fan-out copy meant for another member, fed to us by a relay:
        // trying to decrypt it would fail and tear our session down.
        let (me, alice, carol) = (create_identity(), create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&carol), TRINO_KIND, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    #[test]
    fn a_contacts_event_of_another_kind_is_dropped() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        let event = event_to(&alice, &nostr_hex(&me), 1, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    #[test]
    fn strangers_events_never_enter_the_seen_cache() {
        // Otherwise anyone can flush the bounded cache and replay our contacts'
        // old events.
        let (me, stranger) = (create_identity(), create_identity());
        let mut inner = state_with(&[]);
        for n in 0..3 {
            let event = event_to(&stranger, &nostr_hex(&me), TRINO_KIND, NOW + n);
            let out = admit_event(&mut inner, &event, &nostr_hex(&me));
            assert!(matches!(out, Admission::Stranger), "{out:?}");
        }
        assert!(inner.seen_events.is_empty());
        assert!(inner.seen_event_order.is_empty());
    }

    #[test]
    fn blocked_contacts_events_never_enter_the_seen_cache() {
        let (me, alice) = (create_identity(), create_identity());
        let mut inner = state_with(&[friend(&alice, "alice")]);
        inner.blocked.insert(nostr_hex(&alice));
        let event = event_to(&alice, &nostr_hex(&me), TRINO_KIND, NOW);

        let out = admit_event(&mut inner, &event, &nostr_hex(&me));
        assert!(matches!(out, Admission::Drop(_)), "{out:?}");
        assert!(inner.seen_events.is_empty());
    }

    // ---- Handshake replay gate (H2) ----

    #[test]
    fn a_stale_handshake_is_rejected() {
        let created_at = NOW - HANDSHAKE_MAX_AGE_SECS - 1;
        assert_eq!(
            judge_handshake(None, created_at, "ek", NOW),
            Err(HandshakeRejection::Stale {
                age: HANDSHAKE_MAX_AGE_SECS + 1
            })
        );
    }

    #[test]
    fn a_handshake_from_the_future_is_rejected() {
        let created_at = NOW + CLOCK_SKEW_SECS + 1;
        assert_eq!(
            judge_handshake(None, created_at, "ek", NOW),
            Err(HandshakeRejection::FromTheFuture {
                ahead: CLOCK_SKEW_SECS + 1
            })
        );
    }

    #[test]
    fn a_handshake_older_than_the_last_accepted_one_is_rejected() {
        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-new");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 200, "ek-old", NOW),
            Err(HandshakeRejection::NotNewer { last: NOW - 100 })
        );
    }

    #[test]
    fn the_accepted_handshake_cannot_be_replayed() {
        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-1");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 100, "ek-1", NOW),
            Err(HandshakeRejection::NotNewer { last: NOW - 100 })
        );
    }

    #[test]
    fn a_fresh_newer_handshake_is_accepted() {
        assert_eq!(judge_handshake(None, NOW - 30, "ek-0", NOW), Ok(()));

        let mut marks = HashMap::new();
        record_handshake(&mut marks, "alice", NOW - 100, "ek-1");
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 50, "ek-2", NOW),
            Ok(())
        );
        // A second genuine handshake within the same second is not a replay.
        assert_eq!(
            judge_handshake(marks.get("alice"), NOW - 100, "ek-2", NOW),
            Ok(())
        );
        // Marks are per contact.
        assert_eq!(
            judge_handshake(marks.get("bob"), NOW - 200, "ek-1", NOW),
            Ok(())
        );
    }

    #[test]
    fn handshakes_in_one_second_are_bounded() {
        let mut marks = HashMap::new();
        for n in 0..MAX_SAME_SECOND_HANDSHAKES {
            let ek = format!("ek-{n}");
            assert_eq!(judge_handshake(marks.get("alice"), NOW, &ek, NOW), Ok(()));
            record_handshake(&mut marks, "alice", NOW, &ek);
        }
        assert!(judge_handshake(marks.get("alice"), NOW, "ek-extra", NOW).is_err());
        assert_eq!(marks["alice"].ek_pubs.len(), MAX_SAME_SECOND_HANDSHAKES);
    }

    #[test]
    fn handshake_marks_survive_a_restart() {
        let mut inner = state_with(&[]);
        record_handshake(&mut inner.handshake_marks, "alice", NOW, "ek-1");
        assert!(!inner.handshake_marks.is_empty());

        let saved = serde_json::to_vec(&RatchetsFile::from_state(&inner)).unwrap();
        let mut restarted = InnerState::default();
        serde_json::from_slice::<RatchetsFile>(&saved)
            .unwrap()
            .restore_into(&mut restarted);

        assert_eq!(restarted.handshake_marks, inner.handshake_marks);
    }

    #[test]
    fn a_ratchets_file_from_before_handshake_marks_still_loads() {
        let legacy =
            br#"{"ratchets":{},"associated_data":{},"seen_events":["e1"],"seen_msg_ids":[]}"#;
        let mut inner = InnerState::default();
        serde_json::from_slice::<RatchetsFile>(legacy)
            .unwrap()
            .restore_into(&mut inner);
        assert!(inner.handshake_marks.is_empty());
        assert!(inner.seen_events.contains("e1"));
    }

    // ---- Responder ratchet after a prekey rotation (H1) ----

    #[test]
    fn a_handshake_from_a_bundle_cached_before_rotation_decrypts() {
        let alice = create_identity();
        let mut bob = create_identity();
        let cached = public_bundle_for(&bob);
        let rotate_at = bob.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;
        assert!(crate::identity::rotate_signed_prekey_if_due(
            &mut bob, rotate_at
        ));

        // Alice opens a session from the bundle she cached, as connect_node does.
        let init = initiate(&alice, &cached).unwrap();
        let spk_pub = decode_array_32(&cached.spk_pub).unwrap();
        let mut alice_ratchet = init_initiator(init.master_secret, spk_pub).unwrap();
        let first = ratchet_encrypt(
            &mut alice_ratchet,
            b"__trino_handshake__",
            &init.associated_data,
        )
        .unwrap();
        let hs = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };

        let (_bob, mut bob_ratchet, ad) = respond_to_handshake(&bob, &hs).unwrap();
        let plain = ratchet_decrypt(&mut bob_ratchet, &first, &ad)
            .expect("the first message of the new session must decrypt");
        assert_eq!(plain, b"__trino_handshake__");
    }

    fn stun(url: &str) -> CallIceServer {
        CallIceServer {
            urls: vec![url.to_string()],
            username: None,
            credential: None,
        }
    }

    fn urls(servers: &[CallIceServer]) -> Vec<&str> {
        servers
            .iter()
            .flat_map(|s| s.urls.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn ice_config_accepts_an_empty_list_meaning_no_stun() {
        assert_eq!(validate_ice_servers(&[]), Ok(()));
        let servers = ice_servers_from_override(Some("[]".to_string()))
            .expect("an empty override must mean: no STUN, no TURN");
        assert!(servers.is_empty());
    }

    #[test]
    fn ice_config_without_override_is_the_backend_default() {
        // The frontend has no copy of these: this function is the only source.
        let servers = ice_servers_from_override(None).unwrap();
        assert_eq!(
            urls(&servers),
            [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        );
        assert_eq!(validate_ice_servers(&servers), Ok(()));
        assert_eq!(urls(&servers), urls(&default_call_ice_servers()));
    }

    #[test]
    fn ice_config_override_is_still_validated() {
        let nine: Vec<CallIceServer> = (0..9).map(|_| stun("stun:stun.example.net")).collect();
        assert!(validate_ice_servers(&nine).is_err());
        for bad in [
            r#"[{"urls":["http://stun.example.net"]}]"#,
            r#"[{"urls":[]}]"#,
            r#"[{"urls":["turn:turn.example.net"]}]"#,
            "not json",
        ] {
            assert!(
                ice_servers_from_override(Some(bad.to_string())).is_err(),
                "{bad}"
            );
        }
        let one = ice_servers_from_override(Some(
            r#"[{"urls":["stun:stun.example.net:3478"]}]"#.to_string(),
        ))
        .unwrap();
        assert_eq!(urls(&one), ["stun:stun.example.net:3478"]);
    }

    fn data_files_in(home: PathBuf) -> DataFiles {
        DataFiles {
            vault: home.join("vault.bin"),
            config: home.join("config.json"),
            friends: home.join("friends.json"),
            groups: home.join("groups.json"),
            group_invites: home.join("group_invites.json"),
            history: home.join("history.bin"),
            ratchets: home.join("ratchets.bin"),
            home,
        }
    }

    /// Writes like `forge` does, except that `target` fails, as on a full disk.
    fn failing_on(target: &Path) -> impl FnMut(&Path, &[u8]) -> std::io::Result<()> + '_ {
        move |path, bytes| {
            if path == target {
                Err(std::io::Error::other("disk full"))
            } else {
                fsutil::atomic_write(path, bytes)
            }
        }
    }

    #[test]
    fn a_new_identity_writes_its_vault_last() {
        let scratch = ScratchDir::new("identity-order");
        let files = data_files_in(scratch.path().join("home"));
        let mut order = Vec::new();

        create_identity_files(&files, b"config", b"friends", b"vault", |path, bytes| {
            order.push(path.to_path_buf());
            fsutil::atomic_write(path, bytes)
        })
        .unwrap();

        // `status` reports an identity once vault.bin exists, and `unseal`
        // needs config.json: the vault must never exist without the rest.
        assert_eq!(
            order,
            [
                files.config.clone(),
                files.friends.clone(),
                files.vault.clone()
            ]
        );
        assert_eq!(std::fs::read(&files.config).unwrap(), b"config");
        assert_eq!(std::fs::read(&files.friends).unwrap(), b"friends");
        assert_eq!(std::fs::read(&files.vault).unwrap(), b"vault");
    }

    #[test]
    fn a_new_identity_that_cannot_be_finished_leaves_nothing_behind() {
        let scratch = ScratchDir::new("identity-rollback");
        let files = data_files_in(scratch.path().join("home"));

        let result = create_identity_files(
            &files,
            b"config",
            b"friends",
            b"vault",
            failing_on(&files.vault),
        );

        assert!(result.is_err());
        assert!(!files.config.exists(), "config.json was left behind");
        assert!(!files.friends.exists(), "friends.json was left behind");
        assert!(!files.vault.exists(), "vault.bin was left behind");
        assert!(
            !files.home.exists(),
            "the data dir this call created was left behind"
        );
    }

    #[test]
    fn a_failed_new_identity_keeps_what_was_already_there() {
        let scratch = ScratchDir::new("identity-keep");
        let files = data_files_in(scratch.path().to_path_buf());
        // config.json from an earlier attempt that never reached the vault,
        // and a file that forge never writes.
        std::fs::write(&files.config, b"earlier attempt").unwrap();
        let groups = scratch.path().join("groups.json");
        std::fs::write(&groups, b"[]").unwrap();

        let result = create_identity_files(
            &files,
            b"config",
            b"friends",
            b"vault",
            failing_on(&files.vault),
        );

        assert!(result.is_err());
        assert!(files.config.exists(), "config.json existed before");
        assert!(
            !files.friends.exists(),
            "friends.json was created by this call"
        );
        assert!(!files.vault.exists());
        assert_eq!(std::fs::read(&groups).unwrap(), b"[]");
        assert!(files.home.exists(), "the data dir existed before");
    }

    #[test]
    fn a_wipe_also_removes_copies_left_by_an_interrupted_save() {
        let scratch = ScratchDir::new("wipe-leftovers");
        let friends = scratch.path().join("friends.json");
        // What `fsutil::atomic_write` leaves if the app dies mid-save.
        let leftover = scratch.path().join(".friends.json.tmp-1-2-3");
        let unrelated = scratch.path().join("notes.txt");
        for path in [&friends, &leftover, &unrelated] {
            std::fs::write(path, b"[]").unwrap();
        }
        let mut failures = Vec::new();

        remove_data_files(std::slice::from_ref(&friends), &mut failures);

        assert!(failures.is_empty(), "{failures:?}");
        assert!(!friends.exists());
        assert!(!leftover.exists(), "the temporary copy survived the wipe");
        assert!(unrelated.exists());
    }

    /// Every data file is replaced through `fsutil::atomic_write`: a plain
    /// `std::fs::write` truncates the file first, so a crash halfway would
    /// leave it empty or half written.
    #[test]
    fn data_files_are_only_written_atomically() {
        let source: String = include_str!("commands.rs").split_whitespace().collect();
        let plain_writes: Vec<&str> = [
            "vault_path",
            "config_path",
            "friends_path",
            "groups_path",
            "group_invites_path",
            "history_path",
            "ratchets_path",
        ]
        .into_iter()
        .filter(|path_fn| {
            source.contains(&format!("fs::write({path_fn}()"))
                || source.contains(&format!("fs::write(&{path_fn}()"))
        })
        .collect();
        assert!(
            plain_writes.is_empty(),
            "written with fs::write: {plain_writes:?}"
        );
    }

    // ---- Creating and opening the identity (R3.3) ----

    // Each seal or unseal is a full PBKDF2 run, which takes seconds in a debug
    // build: the tests below use as few as they can.
    const PASSPHRASE: &str = "correct horse battery staple";

    fn read_config(files: &DataFiles) -> ConfigFile {
        serde_json::from_slice(&std::fs::read(&files.config).unwrap()).unwrap()
    }

    /// Open `vault` with a code from `secret`, computed just before. The code
    /// is only checked after the slow key derivation; should that take it past
    /// its window, a fresh code gets one more try.
    fn open_with_code(
        vault: &Path,
        secret: &[u8],
    ) -> Result<(Identity, Option<Vec<u8>>), CommandError> {
        match open_vault(vault, PASSPHRASE, Some(&totp_now(secret))) {
            Err(error) if error.code == ErrorCode::InvalidTotp => {
                open_vault(vault, PASSPHRASE, Some(&totp_now(secret)))
            }
            opened => opened,
        }
    }

    #[test]
    fn status_reads_whether_totp_is_on_from_the_vault_header() {
        let scratch = ScratchDir::new("totp-hint");
        let vault = scratch.path().join("vault.bin");
        assert_eq!(totp_hint(&vault), None, "no vault");

        let header = |version: u8, flags: u8| {
            encode_vault(&SealedVault {
                version,
                flags,
                salt: [7; 16],
                nonce: [9; 12],
                ciphertext: vec![1; 48],
            })
        };
        for (bytes, expected) in [
            (header(1, 0b00), Some(true)),
            (header(1, 0b01), Some(false)),
            (header(1, 0b10), None),
            (header(2, 0b00), None),
            (b"not a vault".to_vec(), None),
        ] {
            fsutil::atomic_write(&vault, &bytes).unwrap();
            assert_eq!(totp_hint(&vault), expected, "{bytes:?}");
        }
    }

    #[test]
    fn an_empty_name_becomes_anon() {
        assert_eq!(display_handle("  ana  "), "ana");
        assert_eq!(display_handle(""), "anon");
        assert_eq!(display_handle(" \t "), "anon");
    }

    #[test]
    fn an_empty_or_blank_code_is_no_code() {
        assert_eq!(submitted_code(None), None);
        assert_eq!(submitted_code(Some("")), None);
        assert_eq!(submitted_code(Some("   ")), None);
        assert_eq!(submitted_code(Some(" 123456 ")), Some("123456"));
    }

    #[test]
    fn a_new_identity_with_totp_cannot_be_opened_without_its_code() {
        let scratch = ScratchDir::new("forge-totp");
        let files = data_files_in(scratch.path().join("home"));
        let secret = generate_totp_secret();

        let identity = create_account(
            &files,
            "ana",
            PASSPHRASE,
            Some(&secret),
            fsutil::atomic_write,
        )
        .unwrap();

        assert_eq!(read_config(&files).handle, "ana");
        assert_eq!(totp_hint(&files.vault), Some(true));
        let error = open_vault(&files.vault, PASSPHRASE, None).unwrap_err();
        assert_eq!(error.code, ErrorCode::TotpRequired);
        let (opened, sealed_secret) = open_with_code(&files.vault, &secret).unwrap();
        assert_eq!(opened.ik_sign.pub_bytes, identity.ik_sign.pub_bytes);
        assert_eq!(sealed_secret.as_deref(), Some(secret.as_slice()));
    }

    #[test]
    fn a_new_identity_without_totp_opens_with_the_passphrase_alone() {
        let scratch = ScratchDir::new("forge-no-totp");
        let files = data_files_in(scratch.path().join("home"));

        let identity =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap();

        assert_eq!(totp_hint(&files.vault), Some(false));
        let (opened, sealed_secret) = open_vault(&files.vault, PASSPHRASE, None).unwrap();
        assert_eq!(opened.ik_sign.pub_bytes, identity.ik_sign.pub_bytes);
        assert_eq!(sealed_secret, None);
    }

    #[test]
    fn a_new_identity_needs_a_passphrase_that_passes_the_policy() {
        let scratch = ScratchDir::new("forge-policy");
        let files = data_files_in(scratch.path().join("home"));

        let short = create_account(&files, "ana", "corta", None, fsutil::atomic_write).unwrap_err();
        assert_eq!(
            (short.code, short.min),
            (ErrorCode::PassphraseTooShort, Some(MIN_PASSPHRASE_CHARS))
        );
        let common =
            create_account(&files, "ana", "Contraseña123", None, fsutil::atomic_write).unwrap_err();
        assert_eq!(common.code, ErrorCode::PassphraseTooCommon);
        assert!(!files.home.exists(), "something was written");
    }

    #[test]
    fn a_new_identity_never_replaces_one_that_exists() {
        let scratch = ScratchDir::new("forge-exists");
        let files = data_files_in(scratch.path().to_path_buf());
        fsutil::atomic_write(&files.vault, b"the vault already here").unwrap();

        let error =
            create_account(&files, "ana", PASSPHRASE, None, fsutil::atomic_write).unwrap_err();

        assert_eq!(error.code, ErrorCode::VaultExists);
        assert_eq!(
            std::fs::read(&files.vault).unwrap(),
            b"the vault already here"
        );
        assert!(!files.config.exists());
    }

    #[test]
    fn opening_tells_a_missing_vault_from_a_damaged_one() {
        let scratch = ScratchDir::new("open-missing");
        let vault = scratch.path().join("vault.bin");
        let missing = open_vault(&vault, PASSPHRASE, None).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NoVault);
        fsutil::atomic_write(&vault, b"not a vault").unwrap();
        let damaged = open_vault(&vault, PASSPHRASE, None).unwrap_err();
        assert_eq!(damaged.code, ErrorCode::Internal);
    }

    /// Runs `reseal_if_rotated` and returns what it would have saved.
    fn reseal_capturing(
        identity: &mut Identity,
        totp_secret: Option<&[u8]>,
        now: i64,
    ) -> (Option<Result<(), CommandError>>, Option<Vec<u8>>) {
        let mut saved = None;
        let outcome = reseal_if_rotated(identity, totp_secret, PASSPHRASE, now, |bytes| {
            saved = Some(bytes.to_vec());
            Ok(())
        });
        (outcome, saved)
    }

    #[test]
    fn a_prekey_rotation_keeps_totp_on() {
        // Rotation seals the vault again. Sealing it without the secret would
        // turn TOTP off for good, without anyone asking for it. The header
        // says which: `seal_vault` sets it from the secret it was given.
        let mut identity = create_identity();
        let rotated_from = identity.signed_prekey.id;
        let due = identity.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;
        let secret = generate_totp_secret();

        let (outcome, saved) = reseal_capturing(&mut identity, Some(&secret), due);

        assert_eq!(outcome, Some(Ok(())));
        assert_ne!(identity.signed_prekey.id, rotated_from);
        let saved = saved.expect("the rotated vault was saved");
        assert!(vault_requires_totp(&saved).unwrap(), "the vault lost TOTP");
    }

    #[test]
    fn a_prekey_rotation_keeps_totp_off() {
        let mut identity = create_identity();
        let due = identity.signed_prekey.created_at + crate::identity::SPK_ROTATION_SECS;

        let (outcome, saved) = reseal_capturing(&mut identity, None, due);

        assert_eq!(outcome, Some(Ok(())));
        assert!(!vault_requires_totp(&saved.unwrap()).unwrap());
    }

    #[test]
    fn a_prekey_that_is_not_due_leaves_the_vault_alone() {
        let mut identity = create_identity();
        let soon = identity.signed_prekey.created_at + 60;

        let (outcome, saved) = reseal_capturing(&mut identity, None, soon);

        assert_eq!(outcome, None);
        assert_eq!(saved, None);
    }

    /// The config.json and friends.json a new identity starts with.
    fn write_profile(files: &DataFiles, identity: &Identity, handle: &str) {
        let config = ConfigFile {
            handle: handle.to_string(),
            nostr_pub: hex::encode(identity.nostr.pub_bytes),
            relays: vec!["wss://relay.example".to_string()],
            created_at: NOW,
            avatar: None,
        };
        let friends = FriendsFile {
            handle: handle.to_string(),
            friends: vec![],
            blocked: vec![],
        };
        std::fs::create_dir_all(&files.home).unwrap();
        fsutil::atomic_write(&files.config, &serde_json::to_vec(&config).unwrap()).unwrap();
        fsutil::atomic_write(&files.friends, &serde_json::to_vec(&friends).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn opening_the_open_session_again_starts_no_second_set_of_connections() {
        let scratch = ScratchDir::new("session-reuse");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        write_profile(&files, &me, "ana");
        let inner = tokio::sync::Mutex::new(InnerState::default());
        let mut starts = Vec::new();

        let first = open_session(&inner, &files, me.clone(), None, |start| starts.push(start))
            .await
            .unwrap();

        assert!(first.relay_connection_started);
        assert_eq!(first.handle, "ana");
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].relays, ["wss://relay.example"]);
        assert_eq!(starts[0].nostr_pub, hex::encode(me.nostr.pub_bytes));
        assert_eq!(starts[0].handle, "ana");

        // The session moves on: a contact that so far exists in memory only.
        let bob = create_identity();
        inner
            .lock()
            .await
            .friends
            .insert("bob".to_string(), friend(&bob, "bob"));

        let second = open_session(&inner, &files, me.clone(), None, |start| starts.push(start))
            .await
            .unwrap();

        assert!(!second.relay_connection_started);
        assert_eq!(second.handle, "ana");
        assert_eq!(second.fingerprint, first.fingerprint);
        assert_eq!(starts.len(), 1, "the relay connections were started twice");
        assert!(
            inner.lock().await.friends.contains_key("bob"),
            "the open session was loaded again from disk"
        );
    }

    #[tokio::test]
    async fn another_identity_cannot_take_over_the_open_session() {
        let scratch = ScratchDir::new("session-other");
        let files = data_files_in(scratch.path().to_path_buf());
        let me = create_identity();
        write_profile(&files, &me, "ana");
        let inner = tokio::sync::Mutex::new(InnerState::default());
        open_session(&inner, &files, me.clone(), None, |_| {})
            .await
            .unwrap();

        let error = open_session(&inner, &files, create_identity(), None, |_| {
            panic!("connections started for another identity")
        })
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Internal);
        let open = inner.lock().await;
        assert_eq!(
            open.identity.as_ref().map(|id| id.ik_sign.pub_bytes),
            Some(me.ik_sign.pub_bytes)
        );
    }

    #[tokio::test]
    async fn a_vault_without_its_config_opens_no_session() {
        let scratch = ScratchDir::new("session-no-config");
        let files = data_files_in(scratch.path().to_path_buf());
        let inner = tokio::sync::Mutex::new(InnerState::default());

        let error = open_session(&inner, &files, create_identity(), None, |_| {
            panic!("connections started without a session")
        })
        .await
        .unwrap_err();

        assert_eq!(error.code, ErrorCode::Io);
        assert!(inner.lock().await.identity.is_none());
    }

    #[test]
    fn the_own_bundle_carries_the_name_and_any_photo() {
        let me = create_identity();
        let parse = |json: String| serde_json::from_str::<serde_json::Value>(&json).unwrap();

        let plain = parse(own_bundle_json(&me, "ana", None).unwrap());
        assert_eq!(plain["handle"], "ana");
        assert_eq!(plain["ikSignPub"], hex::encode(me.ik_sign.pub_bytes));
        assert!(plain.get("avatar").is_none());

        let photo = "data:image/png;base64,iVBORw0KGgo=";
        let with_photo = parse(own_bundle_json(&me, "ana", Some(photo)).unwrap());
        assert_eq!(with_photo["avatar"], photo);
    }

    #[test]
    fn forge_answers_like_unseal_plus_the_bundle() {
        let created = ForgeResponse {
            session: UnsealResponse {
                handle: "ana".to_string(),
                fingerprint: "ab12.cd34".to_string(),
                nostr_pub: "ff".to_string(),
                relay_connection_started: true,
            },
            bundle_json: "{}".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&created).unwrap(),
            serde_json::json!({
                "handle": "ana",
                "fingerprint": "ab12.cd34",
                "nostr_pub": "ff",
                "relay_connection_started": true,
                "bundle_json": "{}",
            })
        );
    }

    #[tokio::test]
    async fn locking_or_wiping_forgets_the_turn_credentials() {
        use crate::turn::{TurnError, TurnServers};
        let owner = [9u8; 32];
        let servers = || async {
            Ok(TurnServers {
                ice_servers: Vec::new(),
                expires_at: NOW + 14_400,
            })
        };
        let turn = TurnCache::default();
        let session = turn.session();
        turn.get_or_fetch(owner, session, NOW, servers)
            .await
            .unwrap();

        forget_session(&mut InnerState::default(), &turn);

        // Neither the cache nor a request begun before it may serve them now.
        assert_eq!(
            turn.get_or_fetch(owner, session, NOW, servers).await,
            Err(TurnError::Locked)
        );
        assert_ne!(turn.session(), session);
    }

    #[tokio::test]
    async fn locking_stops_the_relays_still_trying_to_connect() {
        // K3: a relay that was down at unlock is tried again and again while
        // the session is open, and never after.
        use crate::nostr::test_relay::{unreachable_client, wait_until};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let attempts = Arc::new(AtomicUsize::new(0));
        let mut inner = InnerState::default();
        inner.relays.push(unreachable_client(Arc::clone(&attempts)));
        wait_until("a second attempt", || attempts.load(Ordering::SeqCst) >= 2).await;

        forget_session(&mut inner, &TurnCache::default());
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let after_lock = attempts.load(Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        assert!(inner.relays.is_empty());
        assert_eq!(
            attempts.load(Ordering::SeqCst),
            after_lock,
            "it kept trying after the lock"
        );
    }

    // ---- K4: a message counts as sent once a relay says OK ----

    use crate::nostr::test_relay::{unreachable_client, Answer, TestRelay};

    /// How long these tests wait for an OK that will not come.
    const SHORT_WAIT: std::time::Duration = std::time::Duration::from_millis(300);

    /// `contact` as `handle`, with a session open, as `connect_node` leaves it.
    fn add_session(inner: &mut InnerState, me: &Identity, contact: &Identity, handle: &str) {
        inner
            .friends
            .insert(handle.to_string(), friend(contact, handle));
        let bundle = public_bundle_for(contact);
        let init = initiate(me, &bundle).unwrap();
        let spk = decode_array_32(&bundle.spk_pub).unwrap();
        inner.ratchets.insert(
            handle.to_string(),
            init_initiator(init.master_secret, spk).unwrap(),
        );
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data);
    }

    /// The unlocked session of `me`, sending through `relays`. It has no
    /// history key, so nothing is ever written to the real data directory.
    async fn sending_state(me: &Identity, relays: Vec<Arc<NostrClient>>) -> AppState {
        let state = AppState::default();
        {
            let mut inner = state.inner.lock().await;
            inner.identity = Some(me.clone());
            inner.handle = Some("me".to_string());
            inner.relays = relays;
        }
        state
    }

    /// How many messages the session with `handle` has sent.
    async fn sent_so_far(state: &AppState, handle: &str) -> u32 {
        state.inner.lock().await.ratchets[handle].sending_msg_number
    }

    fn pub_hex(id: &Identity) -> String {
        hex::encode(id.nostr.pub_bytes)
    }

    #[tokio::test]
    async fn a_message_counts_as_sent_once_a_relay_says_ok() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let receipt = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted_by, std::slice::from_ref(&relay.url));
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].created_at, receipt.ts);
        assert_eq!(events[0].recipient(), Some(pub_hex(&bob).as_str()));
        let inner = state.inner.lock().await;
        let stored = inner.history["bob"].last().unwrap();
        assert_eq!(stored.ts, receipt.ts, "stored with the time of the receipt");
        assert_eq!(stored.text.as_deref(), Some("hola"));
        assert_eq!(stored.side, "me");
    }

    #[tokio::test]
    async fn a_message_no_relay_takes_is_not_accepted_and_not_stored() {
        let refusing = TestRelay::start(Answer::Reject).await;
        let silent = TestRelay::start(Answer::Silent).await;
        let (me, bob) = (create_identity(), create_identity());
        let relays = vec![refusing.client().await, silent.client().await];
        let state = sending_state(&me, relays).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert_eq!((refusing.events().len(), silent.events().len()), (1, 1));
        assert!(!state.inner.lock().await.history.contains_key("bob"));
    }

    #[tokio::test]
    async fn without_a_relay_up_nothing_is_encrypted_or_sent() {
        let (me, bob) = (create_identity(), create_identity());
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

            let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
                .await
                .unwrap_err();

            assert_eq!(CommandError::from(error).code, ErrorCode::Offline);
            assert_eq!(sent_so_far(&state, "bob").await, 0, "the session moved on");
        }
    }

    #[tokio::test]
    async fn a_message_too_big_for_the_relays_is_refused_without_a_ratchet_step() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");

        // About 80 KB once encrypted and hex-encoded: relays drop it unseen.
        let error = send_text(&state, "bob", "x".repeat(40_000), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(sent_so_far(&state, "bob").await, 0);
        assert!(relay.events().is_empty());
        // About 40 KB fits, on the same session.
        send_text(&state, "bob", "x".repeat(20_000), SHORT_WAIT)
            .await
            .unwrap();
        assert_eq!(sent_so_far(&state, "bob").await, 1);
    }

    #[tokio::test]
    async fn a_message_to_a_contact_without_a_session_says_so() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        state
            .inner
            .lock()
            .await
            .friends
            .insert("bob".to_string(), friend(&bob, "bob"));

        let error = send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NoSession);
        assert!(relay.events().is_empty());
    }

    /// Me, admin of a group with bob, carol and dave, all with sessions.
    async fn group_of_three(state: &AppState, me: &Identity, others: &[Identity; 3]) -> String {
        let mut inner = state.inner.lock().await;
        let handles = ["bob", "carol", "dave"];
        for (who, handle) in others.iter().zip(handles) {
            add_session(&mut inner, me, who, handle);
        }
        let members: Vec<(&Identity, &str)> = others.iter().zip(handles).collect();
        let roster = roster_of(me, &members);
        let gid = roster.group_id.clone();
        inner.groups.insert(gid.clone(), roster);
        gid
    }

    #[tokio::test]
    async fn a_group_message_reaches_every_member_it_can_whatever_happens_to_one() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::RejectTo(pub_hex(&others[1]))).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let receipt = send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["bob", "dave"]);
        assert_eq!(receipt.failed, ["carol"]);
        let events = relay.events();
        assert_eq!(events.len(), 3, "every member was tried");
        assert!(events.iter().all(|e| e.created_at == receipt.ts));
        let inner = state.inner.lock().await;
        let stored = inner.history[&group_convo(&gid)].last().unwrap();
        assert_eq!(stored.ts, receipt.ts);
        assert_eq!(stored.text.as_deref(), Some("hola grupo"));
    }

    #[tokio::test]
    async fn a_resend_goes_only_to_the_members_named_and_is_not_stored_again() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        let only = ["carol".to_string()];

        let receipt = send_group_text(&state, &gid, "hola".to_string(), Some(&only), SHORT_WAIT)
            .await
            .unwrap();

        assert_eq!(receipt.accepted, ["carol"]);
        assert!(receipt.failed.is_empty());
        let events = relay.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].recipient(), Some(pub_hex(&others[1]).as_str()));
        assert!(
            !state
                .inner
                .lock()
                .await
                .history
                .contains_key(&group_convo(&gid)),
            "the first send stored it already"
        );
    }

    #[tokio::test]
    async fn a_group_message_no_member_takes_is_not_accepted() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Reject).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        let error = send_group_text(&state, &gid, "hola".to_string(), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::NotAccepted);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    fn sample_file() -> FileRef {
        FileRef {
            url: "https://blossom.band/abc".to_string(),
            key: "00".repeat(32),
            sha256: "ab".repeat(32),
            mime: "image/png".to_string(),
            name: "foto.png".to_string(),
            size: 3,
            thumb: None,
        }
    }

    #[test]
    fn the_ui_receives_the_receipts_in_the_contract_shape() {
        // `SendReceipt`, `GroupSendReceipt` and `SentFile` in src/lib/api.ts.
        let receipt = SendReceipt {
            ts: NOW,
            accepted_by: vec!["wss://relay.damus.io".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted_by": ["wss://relay.damus.io"] })
        );
        let group = GroupSendReceipt {
            ts: NOW,
            accepted: vec!["bob".to_string()],
            failed: vec!["carol".to_string()],
        };
        assert_eq!(
            serde_json::to_value(&group).unwrap(),
            serde_json::json!({ "ts": NOW, "accepted": ["bob"], "failed": ["carol"] })
        );
        let sent = SentFile {
            file: sample_file(),
            receipt,
        };
        assert_eq!(
            serde_json::to_value(&sent).unwrap(),
            serde_json::json!({
                "url": "https://blossom.band/abc",
                "key": "00".repeat(32),
                "sha256": "ab".repeat(32),
                "mime": "image/png",
                "name": "foto.png",
                "size": 3,
                "ts": NOW,
                "accepted_by": ["wss://relay.damus.io"],
            })
        );
        let sent_to_group = SentGroupFile {
            file: sample_file(),
            receipt: group,
        };
        let value = serde_json::to_value(&sent_to_group).unwrap();
        assert_eq!(value["accepted"], serde_json::json!(["bob"]));
        assert_eq!(value["failed"], serde_json::json!(["carol"]));
        assert_eq!(value["name"], "foto.png");
    }

    #[test]
    fn a_sent_file_given_back_to_forward_file_is_just_the_file() {
        // The UI forwards the `SentFile` it got from `send_file`.
        let sent = serde_json::to_value(SentFile {
            file: sample_file(),
            receipt: SendReceipt {
                ts: NOW,
                accepted_by: vec!["wss://nos.lol".to_string()],
            },
        })
        .unwrap();

        let file: FileRef = serde_json::from_value(sent).expect("extra fields are ignored");

        assert_eq!(file, sample_file());
        let forwarded = encode_envelope(&Envelope::File {
            file,
            gid: None,
            body: None,
        });
        let forwarded: serde_json::Value = serde_json::from_slice(&forwarded).unwrap();
        assert!(forwarded["file"].get("ts").is_none());
        assert!(forwarded["file"].get("accepted_by").is_none());
    }

    #[test]
    fn send_errors_reach_the_ui_with_their_codes_and_the_old_texts() {
        for (error, code) in [
            (SendError::Sealed, ErrorCode::NoVault),
            (SendError::NoSession, ErrorCode::NoSession),
            (SendError::NoRelays, ErrorCode::Offline),
            (SendError::Offline, ErrorCode::Offline),
            (SendError::NotAccepted, ErrorCode::NotAccepted),
            (SendError::TooLong, ErrorCode::MessageTooLong),
            (SendError::UnknownContact, ErrorCode::Internal),
            (SendError::UnknownGroup, ErrorCode::Internal),
            (SendError::Empty, ErrorCode::Internal),
        ] {
            assert_eq!(CommandError::from(error).code, code);
        }
        // The commands that still answer with a string keep their texts.
        assert_eq!(SendError::Sealed.to_string(), "vault sealed");
        assert_eq!(SendError::UnknownContact.to_string(), "unknown node");
        assert_eq!(
            SendError::NoRelays.to_string(),
            "network is still connecting"
        );
        assert_eq!(
            SendError::NoSession.to_string(),
            "no session — run connect first"
        );
    }

    // ---- B2: a message too large for the relays goes to nobody ----

    /// A preview `chars` characters long, as the UI sends a sticker's data
    /// URL with a file.
    fn preview_of(chars: usize) -> String {
        format!("data:image/png;base64,{}", "A".repeat(chars))
    }

    /// Whether the session with each of `handles` is where it started.
    async fn no_session_moved_on(state: &AppState, handles: &[&str]) -> bool {
        for handle in handles {
            if sent_so_far(state, handle).await != 0 {
                return false;
            }
        }
        true
    }

    #[tokio::test]
    async fn a_group_text_too_large_for_the_relays_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;

        // About 80 KB once encrypted and hex-encoded, as for one contact.
        let error = send_group_text(&state, &gid, "x".repeat(40_000), None, SHORT_WAIT)
            .await
            .unwrap_err();

        assert_eq!(error, SendError::TooLong);
        assert_eq!(CommandError::from(error).code, ErrorCode::MessageTooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
        assert!(!state
            .inner
            .lock()
            .await
            .history
            .contains_key(&group_convo(&gid)));
    }

    #[tokio::test]
    async fn a_group_file_whose_preview_is_too_large_goes_to_no_member() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::Accept).await;
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        // A sticker whose 40,000-character data URL goes as its preview.
        let file = FileRef {
            thumb: Some(preview_of(40_000)),
            ..sample_file()
        };

        let Err(error) = announce_group_file(&state, &gid, file, None, SHORT_WAIT).await else {
            panic!("announced");
        };

        assert_eq!(error, SendError::TooLong);
        assert!(relay.events().is_empty(), "a member got it");
        assert!(no_session_moved_on(&state, &["bob", "carol", "dave"]).await);
    }

    #[tokio::test]
    async fn a_file_whose_announcement_cannot_fit_is_refused_before_its_upload() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let data = base64::engine::general_purpose::STANDARD.encode(b"a small sticker");
        let gid = "ab".repeat(32);

        for to_group in [None, Some(gid.as_str())] {
            let encrypted = encrypt_attachment(
                &state,
                "sticker.png",
                "image/png",
                &data,
                Some(preview_of(40_000)),
                to_group,
            )
            .await;

            // Refused here, it never reaches a file server.
            let Err(error) = encrypted else {
                panic!("it would be uploaded, to group {to_group:?}");
            };
            assert_eq!(error.code, ErrorCode::MessageTooLong, "{to_group:?}");
        }
        // A preview that fits goes on to the upload.
        let (_, _, file) = encrypt_attachment(
            &state,
            "sticker.png",
            "image/png",
            &data,
            Some(preview_of(8_000)),
            Some(&gid),
        )
        .await
        .unwrap();
        assert_eq!(file.thumb, Some(preview_of(8_000)));
    }

    #[tokio::test]
    async fn the_largest_frame_of_a_message_bounds_the_event_sealed_for_it() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        {
            let mut inner = state.inner.lock().await;
            add_session(&mut inner, &me, &bob, "bob");
            // The longest announcement a profile revision can make.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: u64::MAX,
                    ..Default::default()
                },
            );
        }
        let file = FileRef {
            url: "u".repeat(blossom::MAX_URL_BYTES),
            thumb: Some(preview_of(8_000)),
            ..sample_file()
        };
        for envelope in [
            Envelope::Text {
                body: String::new(),
                id: new_msg_id(),
            },
            Envelope::Text {
                body: "ñandú \"citado\" \u{1}".repeat(500),
                id: new_msg_id(),
            },
            Envelope::Group {
                gid: "ab".repeat(32),
                ep: u64::MAX,
                body: "x".repeat(20_000),
            },
            Envelope::File {
                file,
                gid: Some("ab".repeat(32)),
                body: None,
            },
        ] {
            let plaintext = encode_envelope(&envelope);
            let ts = unix_now();

            let (event, _) = seal_for(&state, "bob", &plaintext, None, Some(ts), true)
                .await
                .unwrap();

            let sealed = event_frame_bytes(&event);
            let largest = largest_frame_bytes(&plaintext, ts);
            assert!(sealed <= largest, "{sealed} > {largest}");
            // Only the counters of the session can be shorter than the
            // widest: up to nine digits each.
            assert!(largest - sealed <= 18, "{largest} - {sealed}");
        }
    }

    #[test]
    fn when_no_member_takes_a_group_message_the_answer_says_why() {
        let failed = |errors: Vec<SendError>| -> Vec<(String, Result<(), SendError>)> {
            let names = ["bob", "carol", "dave"].map(String::from);
            names.into_iter().zip(errors.into_iter().map(Err)).collect()
        };
        // Every member failed the same way: that is the answer.
        let causes: [fn() -> SendError; 6] = [
            || SendError::TooLong,
            || SendError::Offline,
            || SendError::NoSession,
            || SendError::Sealed,
            || SendError::NotAccepted,
            || SendError::Failed("bad prekey".to_string()),
        ];
        for cause in causes {
            let all = failed(vec![cause(), cause(), cause()]);
            assert_eq!(group_receipt(NOW, all), Err(cause()));
        }
        // Different ways: no relay took it for anyone.
        let mixed = failed(vec![
            SendError::TooLong,
            SendError::NotAccepted,
            SendError::Offline,
        ]);
        assert_eq!(group_receipt(NOW, mixed), Err(SendError::NotAccepted));
        // One member at least took it: the receipt says who did not.
        let partly = vec![
            ("bob".to_string(), Ok(())),
            ("carol".to_string(), Err(SendError::TooLong)),
            ("dave".to_string(), Ok(())),
        ];
        assert_eq!(
            group_receipt(NOW, partly),
            Ok(GroupSendReceipt {
                ts: NOW,
                accepted: vec!["bob".to_string(), "dave".to_string()],
                failed: vec!["carol".to_string()],
            })
        );
    }

    // ---- B2: a lock while a message waits for its relays ----

    /// What `lock_vault` does to the session, as a test can do it.
    fn lock(inner: &mut InnerState) {
        forget_session(inner, &TurnCache::default());
    }

    /// Me, with a session with bob, sending through a relay that holds its
    /// OK until `release` is told; and that relay's client.
    async fn held_ok_to_bob(
        release: &Arc<tokio::sync::Notify>,
    ) -> (Arc<AppState>, TestRelay, Arc<NostrClient>) {
        let relay = TestRelay::start(Answer::AcceptWhenReleased(Arc::clone(release))).await;
        let (me, bob) = (create_identity(), create_identity());
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        add_session(&mut *state.inner.lock().await, &me, &bob, "bob");
        (state, relay, client)
    }

    /// The user locks just as the relay's OK comes in: `lock_vault` holds
    /// the session when the send has its OK, and wipes it.
    async fn lock_as_the_ok_comes_in(
        state: &AppState,
        relay: &TestRelay,
        client: &NostrClient,
        release: &tokio::sync::Notify,
    ) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the event to reach the relay", || relay.events().len() == 1).await;
        let mut locking = state.inner.lock().await;
        release.notify_one();
        wait_until("the OK", || client.awaiting_ok() == 0).await;
        lock(&mut locking);
    }

    /// What a locked session must not hold of a message sent during the lock.
    async fn kept_nothing(state: &AppState) {
        let inner = state.inner.lock().await;
        assert!(inner.history.is_empty(), "in the locked session's history");
        assert!(inner.outbox.is_empty(), "kept to replay");
    }

    #[tokio::test]
    async fn a_message_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move { send_text(&state, "bob", "texto secreto".to_string(), wait).await }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_file_a_relay_took_while_the_session_locked_is_not_kept() {
        let release = Arc::new(tokio::sync::Notify::new());
        let (state, relay, client) = held_ok_to_bob(&release).await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(5);
            async move {
                announce_file(&state, "bob", sample_file(), wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_as_the_ok_comes_in(&state, &relay, &client, &release).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    /// Me in a group with bob, carol and dave, sending through a relay that
    /// takes bob's and carol's events at once and never answers dave's.
    async fn group_waiting_for_dave() -> (Arc<AppState>, String, TestRelay, Arc<NostrClient>) {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let relay = TestRelay::start(Answer::SilentTo(pub_hex(&others[2]))).await;
        let client = relay.client().await;
        let state = Arc::new(sending_state(&me, vec![Arc::clone(&client)]).await);
        let gid = group_of_three(&state, &me, &others).await;
        (state, gid, relay, client)
    }

    /// The user locks once bob's and carol's OKs are in, while the send
    /// still waits for dave's.
    async fn lock_while_waiting_for_dave(
        state: &AppState,
        relay: &TestRelay,
        client: &NostrClient,
    ) {
        use crate::nostr::test_relay::wait_until;
        wait_until("the three events", || relay.events().len() == 3).await;
        wait_until("bob's and carol's OKs", || client.awaiting_ok() == 1).await;
        lock(&mut *state.inner.lock().await);
    }

    #[tokio::test]
    async fn a_group_message_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                let text = "texto secreto del grupo".to_string();
                send_group_text(&state, &gid, text, None, wait).await
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    #[tokio::test]
    async fn a_group_file_members_took_while_the_session_locked_is_not_kept() {
        let (state, gid, relay, client) = group_waiting_for_dave().await;
        let sending = tokio::spawn({
            let state = Arc::clone(&state);
            let wait = std::time::Duration::from_secs(1);
            async move {
                announce_group_file(&state, &gid, sample_file(), None, wait)
                    .await
                    .map(|sent| sent.receipt)
            }
        });

        lock_while_waiting_for_dave(&state, &relay, &client).await;

        assert_eq!(sending.await.unwrap().unwrap_err(), SendError::NoSession);
        kept_nothing(&state).await;
    }

    // ---- B1: what is kept under a contact's name stays with that contact ----

    /// The contact code of `id`, named `handle`, as `probe_node` reads it.
    fn contact_code(id: &Identity, handle: &str) -> contacts_cmds::ContactCode {
        let mut bundle = serde_json::to_value(public_bundle_for(id)).unwrap();
        bundle["handle"] = serde_json::Value::String(handle.to_string());
        contacts_cmds::parse_contact_code(&bundle.to_string()).unwrap()
    }

    #[tokio::test]
    async fn a_contact_added_under_a_removed_contacts_name_gets_none_of_her_messages() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, ana, newcomer) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &ana, "ana");
        send_text(&state, "ana", "solo para Ana".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        {
            let mut inner = state.inner.lock().await;
            assert_eq!(
                inner.outbox.get("ana").map(Vec::len),
                Some(1),
                "kept to replay"
            );
            inner.resync_at.insert("ana".to_string(), NOW);

            contacts_cmds::remove_contact(&mut inner, "ana");
            let (_, added) = contacts_cmds::add_contact(
                &mut inner,
                contact_code(&newcomer, "ana"),
                "ana",
                false,
                NOW,
            )
            .unwrap();

            assert_eq!(added, contacts_cmds::Added::New);
            assert_eq!(
                inner.outbox.get("ana").map(Vec::len),
                None,
                "Ana's messages"
            );
            assert_eq!(inner.resync_at.get("ana"), None);
            // The newcomer's handshake opens a session, and the UI asks for
            // what was kept to be sent again (session-established).
            add_session(&mut inner, &me, &newcomer, "ana");
        }
        let before = relay.events().len();

        assert_eq!(
            resend_buffered(&state, "ana").await,
            0,
            "sent to the newcomer"
        );
        assert_eq!(relay.events().len(), before);
    }

    #[tokio::test]
    async fn the_messages_kept_for_a_contact_follow_it_when_it_is_renamed() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, ana, newcomer) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        add_session(&mut *state.inner.lock().await, &me, &ana, "ana");
        send_text(&state, "ana", "para Ana".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        {
            let mut inner = state.inner.lock().await;
            inner.resync_at.insert("ana".to_string(), NOW);

            contacts_cmds::rename_contact(&mut inner, "ana", "Ana trabajo").unwrap();

            assert_eq!(inner.outbox.get("Ana trabajo").map(Vec::len), Some(1));
            assert_eq!(inner.resync_at.get("Ana trabajo"), Some(&NOW));
            assert_eq!(inner.outbox.get("ana").map(Vec::len), None);
            assert_eq!(inner.resync_at.get("ana"), None);
            // Someone else under the name she had.
            contacts_cmds::add_contact(
                &mut inner,
                contact_code(&newcomer, "ana"),
                "ana",
                false,
                NOW,
            )
            .unwrap();
            add_session(&mut inner, &me, &newcomer, "ana");
        }

        assert_eq!(
            resend_buffered(&state, "ana").await,
            0,
            "sent to the newcomer"
        );
        assert_eq!(resend_buffered(&state, "Ana trabajo").await, 1);
        crate::nostr::test_relay::wait_until("the replay", || relay.events().len() == 2).await;
        assert_eq!(
            relay.events()[1].recipient(),
            Some(pub_hex(&ana).as_str()),
            "the replay goes to Ana"
        );
    }

    // ---- B1: a member is added only when the roster can reach the members ----

    #[tokio::test]
    async fn a_member_is_not_added_while_no_relay_is_up() {
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        for relays in [vec![unreachable_client(Arc::default())], vec![]] {
            let state = sending_state(&me, relays).await;
            let gid = group_of_three(&state, &me, &others).await;
            let before = {
                let mut inner = state.inner.lock().await;
                inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
                inner.groups[&gid].clone()
            };
            let mut saved = false;

            let added = groups_cmds::add_member(&state, &gid, "eve", |_| {
                saved = true;
                Ok(())
            })
            .await;

            let Err(error) = added else {
                panic!("added with no relay up");
            };
            assert_eq!(error.code, ErrorCode::Offline);
            assert_eq!(state.inner.lock().await.groups[&gid], before, "stored");
            assert!(!saved, "groups.json was written");
        }
    }

    #[tokio::test]
    async fn a_member_that_cannot_be_reached_does_not_stop_the_others() {
        let relay = TestRelay::start(Answer::Accept).await;
        let me = create_identity();
        let others = [create_identity(), create_identity(), create_identity()];
        let eve = create_identity();
        let state = sending_state(&me, vec![relay.client().await]).await;
        let gid = group_of_three(&state, &me, &others).await;
        {
            let mut inner = state.inner.lock().await;
            inner.friends.insert("eve".to_string(), friend(&eve, "eve"));
            // bob, the first member the roster goes to, cannot be reached:
            // his session is gone, and the prekey kept for him no longer
            // verifies, so no new one can start.
            let first = inner.groups[&gid]
                .members
                .iter()
                .find(|m| m.ik_sign_pub != ik(&me));
            assert_eq!(first.unwrap().ik_sign_pub, ik(&others[0]));
            inner.ratchets.remove("bob");
            inner.associated_data.remove("bob");
            inner.friends.get_mut("bob").unwrap().bundle.spk_sig = "00".repeat(64);
        }

        let info = groups_cmds::add_member(&state, &gid, "eve", |_| Ok(()))
            .await
            .unwrap();

        assert!(info.members.contains(&"eve".to_string()));
        assert!(group::is_member(
            &state.inner.lock().await.groups[&gid],
            &ik(&eve)
        ));
        // carol and dave get the roster; eve gets the handshake that opens
        // her session, then the roster.
        crate::nostr::test_relay::wait_until("the rosters", || relay.events().len() == 4).await;
        let mut reached: Vec<String> = relay
            .events()
            .iter()
            .filter_map(|event| event.recipient().map(str::to_string))
            .collect();
        reached.sort();
        let mut expected = vec![
            pub_hex(&others[1]),
            pub_hex(&others[2]),
            pub_hex(&eve),
            pub_hex(&eve),
        ];
        expected.sort();
        assert_eq!(reached, expected);
    }

    // ---- I0: what goes out says that this Trino reads profiles (K12) ----

    /// `add_session`, plus the contact's own side of that session, so a test
    /// reads what was sent as the contact's Trino would.
    fn add_session_read_by(
        inner: &mut InnerState,
        me: &Identity,
        contact: &Identity,
        handle: &str,
    ) -> (RatchetState, Vec<u8>) {
        inner
            .friends
            .insert(handle.to_string(), friend(contact, handle));
        let bundle = public_bundle_for(contact);
        let init = initiate(me, &bundle).unwrap();
        let spk = decode_array_32(&bundle.spk_pub).unwrap();
        inner.ratchets.insert(
            handle.to_string(),
            init_initiator(init.master_secret, spk).unwrap(),
        );
        inner
            .associated_data
            .insert(handle.to_string(), init.associated_data);
        let handshake = WireHandshake {
            ik_dh_pub: init.message.ik_dh_pub,
            ek_pub: init.message.ek_pub,
            spk_id: init.message.spk_id,
            opk_id: init.message.opk_id,
        };
        let (_, ratchet, associated_data) = respond_to_handshake(contact, &handshake).unwrap();
        (ratchet, associated_data)
    }

    /// What `event` carries, decrypted by its recipient's side of the session.
    fn opened_by(event: &NostrEvent, ratchet: &mut RatchetState, ad: &[u8]) -> Vec<u8> {
        let payload: WirePayload = serde_json::from_str(&event.content).unwrap();
        let message = EncryptedMessage {
            header: MessageHeader {
                dh_pub: payload.header.dh_pub,
                pn: payload.header.pn,
                n: payload.header.n,
            },
            nonce: payload.nonce,
            ciphertext: payload.ciphertext,
        };
        ratchet_decrypt(ratchet, &message, ad).unwrap()
    }

    #[tokio::test]
    async fn text_group_and_file_messages_say_that_this_trino_reads_profiles() {
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob) = (create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        let (mut bob_side, ad, gid) = {
            let mut inner = state.inner.lock().await;
            let (bob_side, ad) = add_session_read_by(&mut inner, &me, &bob, "bob");
            // Revision 7 of bob's profile is the one kept here.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: 7,
                    ..Default::default()
                },
            );
            let roster = roster_of(&me, &[(&bob, "bob")]);
            let gid = roster.group_id.clone();
            inner.groups.insert(gid.clone(), roster);
            (bob_side, ad, gid)
        };
        let file = Envelope::File {
            file: sample_file(),
            gid: None,
            body: None,
        };

        send_text(&state, "bob", "hola".to_string(), SHORT_WAIT)
            .await
            .unwrap();
        send_group_text(&state, &gid, "hola grupo".to_string(), None, SHORT_WAIT)
            .await
            .unwrap();
        send_acked(
            &state,
            "bob",
            &encode_envelope(&file),
            unix_now(),
            SHORT_WAIT,
        )
        .await
        .unwrap();

        let events = relay.events();
        assert_eq!(events.len(), 3);
        let opened: Vec<Vec<u8>> = events
            .iter()
            .map(|event| opened_by(event, &mut bob_side, &ad))
            .collect();
        // Each is still the message sent,
        assert!(
            matches!(decode_envelope(&opened[0]), Envelope::Text { body, .. } if body == "hola")
        );
        assert!(matches!(
            decode_envelope(&opened[1]),
            Envelope::Group { gid: to, body, .. } if to == gid && body == "hola grupo"
        ));
        assert_eq!(decode_envelope(&opened[2]), file);
        // and it says that this Trino reads profiles and which revision of
        // bob's it holds, which bob's Trino records.
        let mut bobs_profiles = profile::Profiles::default();
        for (event, plain) in events.iter().zip(&opened) {
            let fields: serde_json::Value = serde_json::from_slice(plain).unwrap();
            assert_eq!(
                fields["prof"],
                serde_json::json!({ "v": 1, "have": 7 }),
                "{fields}"
            );
            profile::receive(&mut bobs_profiles, "me", plain, event.created_at);
            assert_eq!(bobs_profiles.contacts["me"].caps, profile::PROFILE_V);
            assert_eq!(bobs_profiles.contacts["me"].have, 7);
        }
    }

    #[tokio::test]
    async fn calls_rosters_handshakes_and_profiles_go_out_as_they_are() {
        use crate::nostr::test_relay::wait_until;
        let relay = TestRelay::start(Answer::Accept).await;
        let (me, bob, carol) = (create_identity(), create_identity(), create_identity());
        let state = sending_state(&me, vec![relay.client().await]).await;
        let (mut bob_side, ad, roster) = {
            let mut inner = state.inner.lock().await;
            let (bob_side, ad) = add_session_read_by(&mut inner, &me, &bob, "bob");
            // bob reads profiles, and revision 3 is this identity's.
            inner.profiles.contacts.insert(
                "bob".to_string(),
                profile::ContactProfile {
                    rev: 7,
                    caps: profile::PROFILE_V,
                    ..Default::default()
                },
            );
            inner.profiles.rev = 3;
            // carol is a contact with no session yet.
            inner
                .friends
                .insert("carol".to_string(), friend(&carol, "carol"));
            (bob_side, ad, roster_of(&me, &[(&bob, "bob")]))
        };
        let call = encode_envelope(&Envelope::Call {
            call: r#"{"type":"bye"}"#.to_string(),
        });
        let roster = encode_envelope(&Envelope::Roster { roster });

        // A call signal and a roster, as send_call_signal and
        // groups_cmds::send_roster send them, this identity's profile,
        send_cipher_inner(&state, "bob", &call, None).await.unwrap();
        send_cipher_inner(&state, "bob", &roster, None)
            .await
            .unwrap();
        profile::send_profile(&state, vec!["bob".to_string()]).await;
        // and the handshake that opens a session with carol.
        ensure_session(&state, "carol").await.unwrap();
        wait_until("the four events", || relay.events().len() == 4).await;

        let events = relay.events();
        assert_eq!(opened_by(&events[0], &mut bob_side, &ad), call);
        assert_eq!(opened_by(&events[1], &mut bob_side, &ad), roster);
        // A profile message with anything more would be dropped as invalid.
        let profile_message = opened_by(&events[2], &mut bob_side, &ad);
        let mut bobs_profiles = profile::Profiles::default();
        let received = profile::receive(
            &mut bobs_profiles,
            "me",
            &profile_message,
            events[2].created_at,
        );
        assert!(received.consumed && received.save, "bob's Trino refused it");
        assert_eq!(bobs_profiles.contacts["me"].rev, 3);
        assert_eq!(bobs_profiles.contacts["me"].name.as_deref(), Some("me"));
        // carol reads the handshake as it was.
        let payload: WirePayload = serde_json::from_str(&events[3].content).unwrap();
        let (_, mut carol_side, carol_ad) =
            respond_to_handshake(&carol, payload.handshake.as_ref().unwrap()).unwrap();
        assert_eq!(
            opened_by(&events[3], &mut carol_side, &carol_ad),
            b"__trino_handshake__"
        );
    }

    // ---- K13: calls go with the chat's disappearing messages ----

    #[test]
    fn pruning_drops_the_calls_whose_timer_ran_out_and_keeps_the_rest() {
        use crate::call_log::{CallDirection, CallEvent, CallOutcome};
        let item = |ts: i64| HistItem {
            side: "them".to_string(),
            from: None,
            text: None,
            file: None,
            call: None,
            ts,
        };
        let call = |id: &str, ttl: Option<i64>| HistItem {
            call: Some(CallEvent {
                id: id.to_string(),
                direction: CallDirection::Incoming,
                video: false,
                outcome: CallOutcome::Missed,
                duration_sec: 0,
                ttl,
            }),
            ..item(NOW - 100)
        };
        // A disappearing text, as the frontend writes it.
        let timed_text = HistItem {
            text: Some(format!(
                "trm1:{}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"d":60,"t":"hola"}"#)
            )),
            ..item(NOW - 100)
        };
        let plain_text = HistItem {
            text: Some("hola".to_string()),
            ..item(NOW - 100)
        };
        let mut history = HashMap::from([(
            "ana".to_string(),
            vec![
                call("expired-call-00001", Some(60)),
                call("running-call-00001", Some(3_600)),
                call("no-timer-call-0001", None),
                timed_text,
                plain_text,
            ],
        )]);

        assert!(prune_history(&mut history, NOW));

        let calls: Vec<&str> = history["ana"]
            .iter()
            .filter_map(|it| it.call.as_ref().map(|c| c.id.as_str()))
            .collect();
        assert_eq!(calls, ["running-call-00001", "no-timer-call-0001"]);
        assert_eq!(
            history["ana"].len(),
            3,
            "the timed text went too, as before"
        );
        assert!(!prune_history(&mut history, NOW), "nothing left to drop");
    }
}
