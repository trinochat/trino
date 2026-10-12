import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';

// Open a URL in the system browser (not inside the webview).
export function openLink(url: string): void {
  openUrl(url).catch(e => console.error('openUrl failed', e));
}

let notifPermission: boolean | null = null;
export async function ensureNotifyPermission(): Promise<boolean> {
  if (notifPermission !== null) return notifPermission;
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    notifPermission = granted;
    return granted;
  } catch {
    notifPermission = false;
    return false;
  }
}
export async function notify(title: string, body: string): Promise<void> {
  try {
    // `sound: 'default'` plays the OS notification sound — the system default on
    // desktop, and on Android the tone the user has configured for the channel.
    if (await ensureNotifyPermission()) sendNotification({ title, body, sound: 'default' });
  } catch (e) {
    console.error('notify failed', e);
  }
}

export interface StatusResponse {
  has_vault: boolean;
  is_unsealed: boolean;
  handle: string | null;
  nostr_pub: string | null;
  home_dir: string;
  // Whether unlocking will ask for a TOTP code, read from the vault header:
  // null when there is no vault or it cannot be read. Only a hint for what to
  // show; unlocking can still fail with `totp_required`.
  totp_enabled: boolean | null;
}

export interface UnsealResponse {
  handle: string;
  fingerprint: string;
  nostr_pub: string;
  // False when the session was open already: whoever opened it started the
  // relay connections.
  relay_connection_started: boolean;
}

// What `forge` returns: the session it opened, as `unseal` describes it, and
// the new identity's bundle to share.
export interface ForgeResponse extends UnsealResponse {
  bundle_json: string;
}

// A new TOTP secret to add to an authenticator app, as a QR code or typed in.
export interface TotpBeginResponse {
  otpauth_uri: string;
  secret_base32: string;
}

// What `forge`, `unseal`, `totp_begin` and `totp_verify` reject with, and the
// commands of the redesign after them: a code for the UI to turn into its own
// text, and an English message for the log. The names match `ErrorCode` in
// src-tauri/src/command_error.rs; the codes after `internal` arrive with the
// backend units W7 and W8.
export const COMMAND_ERROR_CODES = [
  'passphrase_too_short',
  'passphrase_too_common',
  'totp_not_verified',
  'vault_exists',
  'no_vault',
  'wrong_passphrase',
  'totp_required',
  'invalid_totp',
  'unsupported_vault',
  'io',
  'internal',
  // Sending (K2, K4): no relay reachable, no relay accepted it, the event is
  // too big for the relays, no session with the contact, every file server failed.
  'offline',
  'not_accepted',
  'message_too_long',
  'no_session',
  'upload_failed',
  // Contacts (K8): a code that does not verify, a name another key already
  // has, the same keys under another name.
  'invalid_code',
  'name_taken',
  'already_contact',
  // Groups and history (K10, K11).
  'not_admin',
  'not_found',
  // The shared profile (K12): a name, an "about" or a photo over its limit.
  'profile_invalid',
  // A contact's name the app cannot use: one the chats read as the channel
  // or a group (`channel`, `grp:…`), or with control, format or bidi
  // characters, or with nothing that shows (probe_node, rename_node).
  'invalid_name',
] as const;

export type CommandErrorCode = (typeof COMMAND_ERROR_CODES)[number];

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  // The minimum length, with `passphrase_too_short` only.
  min?: number;
  // Why each file server failed, with `upload_failed` only (W7, K2).
  servers?: { server: string; reason: string }[];
  // The name the contact already has, with `already_contact` only (W8, K8).
  handle?: string;
  // W7 and W8 add `servers` and `handle` to the Rust `CommandError` under
  // these names; both edit that struct, so the merge keeps both fields.
}

// Whether a rejected command carries a `CommandError`. The other commands
// still reject with a plain string.
export function isCommandError(error: unknown): error is CommandError {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    typeof message === 'string' && (COMMAND_ERROR_CODES as readonly unknown[]).includes(code)
  );
}

export interface CallIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CallConfigResponse {
  ice_servers: CallIceServer[];
}

// Short-lived Cloudflare TURN servers for a protected (relay-only) call.
// `expires_at` is in unix seconds; the backend caches them until shortly
// before, so ask again for every call.
export interface TurnServersResponse {
  ice_servers: CallIceServer[];
  expires_at: number;
}

export interface NodeInfo {
  handle: string;
  fingerprint: string;
  has_session: boolean;
  added_at: number;
  avatar?: string | null;
  blocked?: boolean;
  // The fields below arrive with W8 (K7, K8); optional until then.
  // SHA-256 of the identity keys in full hex; `fingerprint` is its prefix.
  identity_digest?: string | null;
  // The contact's keys changed: the old fingerprint, and when (epoch seconds).
  previous_fingerprint?: string | null;
  key_changed_at?: number | null;
  // The profile the contact shares (W8, K12); optional until then. The name
  // they gave themselves never replaces `handle`, the one given here; their
  // photo arrives as `avatar`. `profile_sync`: their Trino announced that it
  // takes profiles, so yours reaches them.
  profile_name?: string | null;
  about?: string | null;
  profile_sync?: boolean;
}

export interface ProfileResponse {
  handle: string;
  avatar: string | null;
  fingerprint: string;
  nostr_pub: string;
  // Arrives with W8 (K7); optional until then.
  identity_digest?: string | null;
  // The shared profile (W8, K12); optional until then. `sync` is the version
  // of the profile messages this backend sends, 1 with K12.
  about?: string | null;
  sync?: number;
}

// A contact's shared profile changed (K12): read the contacts again.
export interface ProfileUpdatedEvent {
  handle: string;
}

export interface IncomingMessageEvent {
  from_handle: string;
  text: string;
  timestamp: number;
}

export interface HandshakeNeededEvent {
  from_pubkey: string;
}

export interface GroupInfo {
  gid: string;
  name: string;
  epoch: number;
  is_admin: boolean;
  member_count: number;
  members: string[];
  // The admin removed us or deleted the group (W8, K10); optional until then.
  ended?: boolean;
}

export interface IncomingGroupMessageEvent {
  gid: string;
  from_handle: string;
  text: string;
  timestamp: number;
}

export interface GroupUpdatedEvent {
  gid: string;
}

// A group invitation waiting for the user to accept or decline it.
export interface GroupInvite {
  gid: string;
  name: string;
  from_handle: string;
  member_count: number;
  received_at: number;
}

export interface FileRef {
  url: string;
  key: string;
  sha256: string;
  mime: string;
  name: string;
  size: number;
  thumb?: string | null; // small inline preview (data: URL)
}

export interface FileMessageEvent {
  from_handle: string;
  gid: string | null;
  file: FileRef;
  timestamp: number;
}

export interface HistItem {
  side: 'me' | 'them';
  from?: string | null;
  text?: string | null;
  file?: FileRef | null;
  // A call with this contact (W7, K13); such an item has no text or file.
  call?: CallEventWire | null;
  ts: number;
}

// The values of the Rust `CallEvent` (K13), as serde writes them.
export type CallDirection = 'outgoing' | 'incoming';
export type CallOutcome = 'answered' | 'missed' | 'declined' | 'unanswered' | 'cancelled' | 'failed';

// A call as the backend stores it, in the history of its contact's chat
// (K13). Tauri does not rename nested keys, so these stay snake_case.
// `duration_sec` is 0 unless the call was answered. `ttl` follows the chat's
// disappearing messages: the call goes with them.
export interface CallEventWire {
  id: string;
  direction: CallDirection;
  video: boolean;
  outcome: CallOutcome;
  duration_sec: number;
  ttl?: number | null;
}

// One call of the call log (K13): the contact and when it started (epoch seconds).
export interface CallLogWire {
  peer: string;
  ts: number;
  call: CallEventWire;
}

export interface CallSignalEvent {
  from_handle: string;
  payload: string;
}

export interface StickerInfo {
  id: string;
  mime: string;
  data_url: string;
}

// ── Contracts of the redesign's backend (plan §5, K1–K11) ────────────────────
// The wrappers below exist before their commands do: until W7 and W8 land,
// calling one rejects, and the screens hide what it backs (capabilities).

// A message one relay at least acknowledged (K4): when it was stored and by
// which relays.
export interface SendReceipt {
  ts: number;
  accepted_by: string[];
}

// A group message (K4): sent to every member, with who it reached and who not.
export interface GroupSendReceipt {
  ts: number;
  accepted: string[];
  failed: string[];
}

// What `send_file` and `send_group_file` return: the file, plus its receipt
// once K4 lands. W7 keeps the `FileRef` fields and flattens the receipt in
// (`ts` and `accepted_by` for a contact; `ts`, `accepted` and `failed` for a
// group): the chat shows and forwards the file it gets back.
export type SentFile = FileRef & Partial<SendReceipt>;
export type SentGroupFile = FileRef & Partial<GroupSendReceipt>;

export interface RelayStatus {
  url: string;
  connected: boolean;
}

// The real connection (K3): `connection_status` and the `connection-changed` event.
export interface ConnectionStatus {
  up: number;
  total: number;
  relays: RelayStatus[];
}

// A pasted code, checked and not saved (K8). `existing` is the contact that
// already has that name, or those keys.
export interface ContactPreview {
  handle: string;
  fingerprint: string;
  identity_digest: string;
  existing: { handle: string; same_keys: boolean } | null;
}

// A member of a group as its roster names it (K9), matched to a contact by key.
// `via_group` is the group the contact came with (`FriendRecord.via_group`);
// only the members carry it, not `NodeInfo`.
export interface GroupMember {
  ik_sign_pub: string;
  roster_handle: string;
  local_handle?: string | null;
  fingerprint: string;
  is_admin: boolean;
  is_self: boolean;
  via_group?: string | null;
}

export interface ContactKeyMismatchEvent {
  handle: string;
}

export interface GroupRemovedEvent {
  gid: string;
}

export const api = {
  status: (): Promise<StatusResponse> => invoke('status'),
  // Starts setting up TOTP with a new secret, replacing any earlier one.
  // `label` names the account in the authenticator app: the identity's name.
  totpBegin: (label?: string): Promise<TotpBeginResponse> =>
    invoke('totp_begin', { label: label ?? null }),
  // Checks a code from the authenticator app; true confirms the secret.
  totpVerify: (code: string): Promise<boolean> => invoke('totp_verify', { code }),
  // The `forge` command: creates the identity and opens its session, so the
  // chats follow without an unlock. With `useTotp`, the secret from
  // `totpBegin` must have been confirmed through `totpVerify` first.
  createIdentity: (
    handle: string,
    passphrase: string,
    useTotp: boolean,
  ): Promise<ForgeResponse> => invoke('forge', { handle, passphrase, useTotp }),
  // Leave `totpCode` out, or empty, for a vault without TOTP.
  unseal: (passphrase: string, totpCode?: string | null): Promise<UnsealResponse> =>
    invoke('unseal', { passphrase, totpCode: totpCode ?? null }),
  shareBundle: (): Promise<string> => invoke('share_bundle'),
  // `replaceExisting` (K8) replaces a contact that has the name, after the
  // user confirmed it; left out, the payload is the one older backends take.
  // Rejects with `invalid_name` for a name the chats read as the channel or
  // a group, or with control, format or bidi characters.
  probeNode: (bundleJson: string, handle: string, replaceExisting?: boolean): Promise<NodeInfo> =>
    invoke(
      'probe_node',
      replaceExisting === undefined ? { bundleJson, handle } : { bundleJson, handle, replaceExisting },
    ),
  listNodes: (): Promise<NodeInfo[]> => invoke('list_nodes'),
  connectNode: (handle: string): Promise<void> => invoke('connect_node', { handle }),
  // The receipt arrives with K4; until then the backend returns nothing (null).
  sendMessage: (handle: string, text: string): Promise<SendReceipt | null> =>
    invoke('send_message', { handle, text }),
  createGroup: (name: string): Promise<GroupInfo> => invoke('create_group', { name }),
  listGroups: (): Promise<GroupInfo[]> => invoke('list_groups'),
  addGroupMember: (gid: string, friendHandle: string): Promise<GroupInfo> =>
    invoke('add_group_member', { gid, friendHandle }),
  listGroupInvites: (): Promise<GroupInvite[]> => invoke('list_group_invites'),
  acceptGroupInvite: (gid: string): Promise<GroupInfo> =>
    invoke('accept_group_invite', { gid }),
  declineGroupInvite: (gid: string): Promise<void> => invoke('decline_group_invite', { gid }),
  // `only` (K4) resends to the members it names, after a partial failure.
  // The receipt arrives with K4; until then the backend returns nothing (null).
  sendGroupMessage: (gid: string, text: string, only?: string[]): Promise<GroupSendReceipt | null> =>
    invoke('send_group_message', only === undefined ? { gid, text } : { gid, text, only }),
  sendFile: (
    handle: string,
    name: string,
    mime: string,
    dataB64: string,
    thumb: string | null,
  ): Promise<SentFile> => invoke('send_file', { handle, name, mime, dataB64, thumb }),
  sendGroupFile: (
    gid: string,
    name: string,
    mime: string,
    dataB64: string,
    thumb: string | null,
    only?: string[],
  ): Promise<SentGroupFile> =>
    invoke(
      'send_group_file',
      only === undefined ? { gid, name, mime, dataB64, thumb } : { gid, name, mime, dataB64, thumb, only },
    ),
  fetchFile: (url: string, key: string, sha256: string, mime: string): Promise<string> =>
    invoke('fetch_file', { url, key, sha256, mime }),
  getHistory: (): Promise<Record<string, HistItem[]>> => invoke('get_history'),
  getProfile: (): Promise<ProfileResponse> => invoke('get_profile'),
  // `about` (K12) is the "about me" the contacts get, and '' clears it; left
  // out, the payload is the one older backends take. Rejects with
  // `profile_invalid` over the limits of K12.
  updateProfile: (handle: string, avatar: string | null, about?: string): Promise<void> =>
    invoke('update_profile', about === undefined ? { handle, avatar } : { handle, avatar, about }),
  // Rejects with a `CommandError` (it used to be a string): `offline` when no
  // relay is up, and then nothing is sent or stored.
  forwardFile: (target: string, isGroup: boolean, file: FileRef): Promise<void> =>
    invoke('forward_file', { target, isGroup, file }),
  removeNode: (handle: string): Promise<void> => invoke('remove_node', { handle }),
  // Rejects with `name_taken` (another contact's name), `invalid_name` (as
  // for probeNode) or `not_found`.
  renameNode: (oldHandle: string, newHandle: string): Promise<void> =>
    invoke('rename_node', { oldHandle, newHandle }),
  blockNode: (handle: string, blocked: boolean): Promise<void> =>
    invoke('block_node', { handle, blocked }),
  pruneExpired: (): Promise<void> => invoke('prune_expired'),
  importSticker: (dataB64: string, mime: string): Promise<StickerInfo> =>
    invoke('import_sticker', { dataB64, mime }),
  listStickers: (): Promise<StickerInfo[]> => invoke('list_stickers'),
  deleteSticker: (id: string): Promise<void> => invoke('delete_sticker', { id }),
  // STUN for a direct call, only after the user agreed to reveal their IP.
  getCallConfig: (): Promise<CallConfigResponse> => invoke('get_call_config'),
  // Rejects with a `CommandError` when protection is unavailable.
  getTurnServers: (): Promise<TurnServersResponse> => invoke('get_turn_servers'),
  sendCallSignal: (handle: string, payload: string): Promise<void> =>
    invoke('send_call_signal', { handle, payload }),
  // Tells the backend a call holds the microphone/camera, so closing the
  // window or quitting from the tray hangs it up first.
  setCallActive: (active: boolean): Promise<void> => invoke('set_call_active', { active }),
  devLog: (msg: string): Promise<void> => invoke<void>('dev_log', { msg }).catch(() => {}),
  wipe: (): Promise<void> => invoke('wipe'),
  lockVault: (): Promise<void> => invoke('lock_vault'),
  resendOutbox: (handle: string): Promise<void> =>
    invoke<void>('resend_outbox', { handle }).catch(() => {}),
  resyncSession: (handle: string): Promise<void> => invoke('resync_session', { handle }),
  setAutostart: (enable: boolean): Promise<void> => invoke('set_autostart', { enable }),
  getAutostart: (): Promise<boolean> => invoke('get_autostart'),
  // The system's text size as a factor, such as 1.25 for Windows at 125 %;
  // 1 where the app cannot read it (a11y.rs). WebView2 does not apply it by
  // itself, so the frontend follows it (src/design/apply.ts).
  systemTextScale: (): Promise<number> => invoke('system_text_scale'),
  // Returns the relays actually being observed, which are the ones this device
  // is connected to — not a hardcoded list.
  relayInspectStart: (): Promise<string[]> => invoke('relay_inspect_start'),
  relayInspectStop: (): Promise<void> =>
    invoke<void>('relay_inspect_stop').catch(() => {}),

  // ── Commands of the redesign's backend (plan §5). Names match src-tauri. ──
  // K1: the passphrase policy, checked before the identity exists. Rejects
  // with `passphrase_too_short` or `passphrase_too_common`; writes nothing.
  checkPassphrase: (passphrase: string): Promise<void> => invoke('check_passphrase', { passphrase }),
  // K3: how many relays are connected right now.
  connectionStatus: (): Promise<ConnectionStatus> => invoke('connection_status'),
  // K5: turns TOTP on with the secret confirmed through `totpBegin` and
  // `totpVerify`, or off with a valid code.
  totpEnable: (passphrase: string): Promise<void> => invoke('totp_enable', { passphrase }),
  totpDisable: (passphrase: string, code: string): Promise<void> =>
    invoke('totp_disable', { passphrase, code }),
  // K6: re-seals the vault with a new passphrase and keeps the TOTP secret.
  changePassphrase: (current: string, next: string, totpCode?: string | null): Promise<void> =>
    invoke('change_passphrase', { current, next, totpCode: totpCode ?? null }),
  // K8: checks a pasted code and reports a clash, without saving anything.
  previewContact: (bundleJson: string): Promise<ContactPreview> =>
    invoke('preview_contact', { bundleJson }),
  // K8: the user saw that the contact's keys changed.
  acknowledgeKeyChange: (handle: string): Promise<void> =>
    invoke('acknowledge_key_change', { handle }),
  // K9 and K10: the members of a group and what its admin can do. Removing a
  // member and renaming answer with the group as it is after the change;
  // leaving and deleting answer with nothing.
  groupMembers: (gid: string): Promise<GroupMember[]> => invoke('group_members', { gid }),
  removeGroupMember: (gid: string, ikSignPub: string): Promise<GroupInfo> =>
    invoke('remove_group_member', { gid, ikSignPub }),
  renameGroup: (gid: string, name: string): Promise<GroupInfo> => invoke('rename_group', { gid, name }),
  leaveGroup: (gid: string): Promise<void> => invoke('leave_group', { gid }),
  deleteGroup: (gid: string): Promise<void> => invoke('delete_group', { gid }),
  // K11: deletes one message here for good. `convo` is the history key (the
  // handle, or `grp:<gid>`); a text matches on `text`, a file on `sha256`.
  // `from`, the sender of a group message (HistItem.from), tells apart two
  // members who sent the same in the same second; left out, the payload is
  // as before and the first that matches goes.
  deleteHistoryItem: (
    convo: string,
    ts: number,
    side: 'me' | 'them',
    text?: string | null,
    sha256?: string | null,
    from?: string | null,
  ): Promise<void> =>
    invoke(
      'delete_history_item',
      from === undefined
        ? { convo, ts, side, text: text ?? null, sha256: sha256 ?? null }
        : { convo, ts, side, text: text ?? null, sha256: sha256 ?? null, from },
    ),
  // K13: records a call that ended in its contact's chat, at the time it
  // started (epoch seconds), and answers with the log entry. The same `id`
  // twice answers with the entry already there.
  recordCall: (peer: string, call: CallEventWire, startedAt: number): Promise<CallLogWire> =>
    invoke('record_call', { peer, call, startedAt }),
  // K13: the calls of every chat, the newest first; 200 when `limit` is left out.
  listCallHistory: (limit?: number): Promise<CallLogWire[]> =>
    invoke('list_call_history', { limit: limit ?? null }),
};

// Metadata a transport relay can see about one event — never its content.
export interface RelayObservation {
  relay: string;
  id: string;
  from: string;
  to: string;
  size: number;
  created_at: number;
}

export async function onRelayEvent(
  cb: (event: RelayObservation) => void,
): Promise<UnlistenFn> {
  return await listen<RelayObservation>('relay-event', e => cb(e.payload));
}

export async function onMessageReceived(
  cb: (event: IncomingMessageEvent) => void,
): Promise<UnlistenFn> {
  return await listen<IncomingMessageEvent>('message-received', e => cb(e.payload));
}

export async function onHandshakeNeeded(
  cb: (event: HandshakeNeededEvent) => void,
): Promise<UnlistenFn> {
  return await listen<HandshakeNeededEvent>('handshake-needed', e => cb(e.payload));
}

// Backend detected a desynced session (decrypt failures) and cleared it; the
// UI should re-initiate the handshake so the tie-break reconverges both sides.
export async function onResyncNeeded(cb: (handle: string) => void): Promise<UnlistenFn> {
  return await listen<string>('resync-needed', e => cb(e.payload));
}

// A fresh session was established with a peer — replay buffered outgoing so any
// message lost to a desync is re-delivered (deduped by id on the other side).
export async function onSessionEstablished(cb: (handle: string) => void): Promise<UnlistenFn> {
  return await listen<string>('session-established', e => cb(e.payload));
}

export async function onGroupMessage(
  cb: (event: IncomingGroupMessageEvent) => void,
): Promise<UnlistenFn> {
  return await listen<IncomingGroupMessageEvent>('group-message', e => cb(e.payload));
}

export async function onGroupUpdated(
  cb: (event: GroupUpdatedEvent) => void,
): Promise<UnlistenFn> {
  return await listen<GroupUpdatedEvent>('group-updated', e => cb(e.payload));
}

// A contact invited us to a group. Nothing is joined until the user accepts.
export async function onGroupInvite(cb: (invite: GroupInvite) => void): Promise<UnlistenFn> {
  return await listen<GroupInvite>('group-invite', e => cb(e.payload));
}

export async function onFileMessage(
  cb: (event: FileMessageEvent) => void,
): Promise<UnlistenFn> {
  return await listen<FileMessageEvent>('file-message', e => cb(e.payload));
}

export async function onCallSignal(
  cb: (event: CallSignalEvent) => void,
): Promise<UnlistenFn> {
  return await listen<CallSignalEvent>('call-signal', e => cb(e.payload));
}

// The window was closed while a call holds the microphone/camera. The backend
// kept it open; confirm, hang up, clear the flag and close it again.
export async function onCallCloseRequested(cb: () => void): Promise<UnlistenFn> {
  return await listen('call-close-requested', () => cb());
}

// "Salir" was chosen in the tray during a call. Hang up now: the backend exits
// once the call flag clears, or after a short grace period.
export async function onCallQuitRequested(cb: () => void): Promise<UnlistenFn> {
  return await listen('call-quit-requested', () => cb());
}

// The relays connected changed (K3), debounced by the backend.
export async function onConnectionChanged(
  cb: (status: ConnectionStatus) => void,
): Promise<UnlistenFn> {
  return await listen<ConnectionStatus>('connection-changed', e => cb(e.payload));
}

// A handshake came with other keys than the ones saved for this contact (K8).
// It is still rejected; at most one event every 10 minutes per contact.
export async function onContactKeyMismatch(
  cb: (event: ContactKeyMismatchEvent) => void,
): Promise<UnlistenFn> {
  return await listen<ContactKeyMismatchEvent>('contact-key-mismatch', e => cb(e.payload));
}

// The admin removed us from a group, or deleted it (K10): it is marked ended.
export async function onGroupRemoved(cb: (event: GroupRemovedEvent) => void): Promise<UnlistenFn> {
  return await listen<GroupRemovedEvent>('group-removed', e => cb(e.payload));
}

// A call was recorded (K13): the same entry `recordCall` answers with.
export async function onCallLogged(cb: (entry: CallLogWire) => void): Promise<UnlistenFn> {
  return await listen<CallLogWire>('call-logged', e => cb(e.payload));
}

// A contact's shared profile changed (K12).
export async function onProfileUpdated(cb: (event: ProfileUpdatedEvent) => void): Promise<UnlistenFn> {
  return await listen<ProfileUpdatedEvent>('profile-updated', e => cb(e.payload));
}
