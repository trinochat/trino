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
}

export interface ForgeResponse {
  handle: string;
  otpauth_uri: string;
  bundle_json: string;
  fingerprint: string;
}

export interface UnsealResponse {
  handle: string;
  fingerprint: string;
  nostr_pub: string;
  relay_connection_started: boolean;
}

export interface CallIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CallConfigResponse {
  ice_servers: CallIceServer[];
}

export interface NodeInfo {
  handle: string;
  fingerprint: string;
  has_session: boolean;
  added_at: number;
  avatar?: string | null;
  blocked?: boolean;
}

export interface ProfileResponse {
  handle: string;
  avatar: string | null;
  fingerprint: string;
  nostr_pub: string;
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
  ts: number;
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

export const api = {
  status: (): Promise<StatusResponse> => invoke('status'),
  forge: (handle: string, passphrase: string): Promise<ForgeResponse> =>
    invoke('forge', { handle, passphrase }),
  unseal: (passphrase: string, totpCode: string): Promise<UnsealResponse> =>
    invoke('unseal', { passphrase, totpCode }),
  shareBundle: (): Promise<string> => invoke('share_bundle'),
  probeNode: (bundleJson: string, handle: string): Promise<NodeInfo> =>
    invoke('probe_node', { bundleJson, handle }),
  listNodes: (): Promise<NodeInfo[]> => invoke('list_nodes'),
  connectNode: (handle: string): Promise<void> => invoke('connect_node', { handle }),
  sendMessage: (handle: string, text: string): Promise<void> =>
    invoke('send_message', { handle, text }),
  createGroup: (name: string): Promise<GroupInfo> => invoke('create_group', { name }),
  listGroups: (): Promise<GroupInfo[]> => invoke('list_groups'),
  addGroupMember: (gid: string, friendHandle: string): Promise<GroupInfo> =>
    invoke('add_group_member', { gid, friendHandle }),
  sendGroupMessage: (gid: string, text: string): Promise<void> =>
    invoke('send_group_message', { gid, text }),
  sendFile: (
    handle: string,
    name: string,
    mime: string,
    dataB64: string,
    thumb: string | null,
  ): Promise<FileRef> => invoke('send_file', { handle, name, mime, dataB64, thumb }),
  sendGroupFile: (
    gid: string,
    name: string,
    mime: string,
    dataB64: string,
    thumb: string | null,
  ): Promise<FileRef> => invoke('send_group_file', { gid, name, mime, dataB64, thumb }),
  fetchFile: (url: string, key: string, sha256: string, mime: string): Promise<string> =>
    invoke('fetch_file', { url, key, sha256, mime }),
  getHistory: (): Promise<Record<string, HistItem[]>> => invoke('get_history'),
  getProfile: (): Promise<ProfileResponse> => invoke('get_profile'),
  updateProfile: (handle: string, avatar: string | null): Promise<void> =>
    invoke('update_profile', { handle, avatar }),
  forwardFile: (target: string, isGroup: boolean, file: FileRef): Promise<void> =>
    invoke('forward_file', { target, isGroup, file }),
  removeNode: (handle: string): Promise<void> => invoke('remove_node', { handle }),
  renameNode: (oldHandle: string, newHandle: string): Promise<void> =>
    invoke('rename_node', { oldHandle, newHandle }),
  blockNode: (handle: string, blocked: boolean): Promise<void> =>
    invoke('block_node', { handle, blocked }),
  pruneExpired: (): Promise<void> => invoke('prune_expired'),
  importSticker: (dataB64: string, mime: string): Promise<StickerInfo> =>
    invoke('import_sticker', { dataB64, mime }),
  listStickers: (): Promise<StickerInfo[]> => invoke('list_stickers'),
  deleteSticker: (id: string): Promise<void> => invoke('delete_sticker', { id }),
  getCallConfig: (): Promise<CallConfigResponse> => invoke('get_call_config'),
  sendCallSignal: (handle: string, payload: string): Promise<void> =>
    invoke('send_call_signal', { handle, payload }),
  devLog: (msg: string): Promise<void> => invoke<void>('dev_log', { msg }).catch(() => {}),
  wipe: (): Promise<void> => invoke('wipe'),
  lockVault: (): Promise<void> => invoke('lock_vault'),
  resendOutbox: (handle: string): Promise<void> =>
    invoke<void>('resend_outbox', { handle }).catch(() => {}),
  resyncSession: (handle: string): Promise<void> => invoke('resync_session', { handle }),
  setAutostart: (enable: boolean): Promise<void> => invoke('set_autostart', { enable }),
  getAutostart: (): Promise<boolean> => invoke('get_autostart'),
};

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
