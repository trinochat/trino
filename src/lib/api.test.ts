import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  COMMAND_ERROR_CODES,
  api,
  isCommandError,
  onCallLogged,
  onConnectionChanged,
  onContactKeyMismatch,
  onGroupRemoved,
  onProfileUpdated,
  type CallEventWire,
  type CallLogWire,
  type CommandError,
  type FileRef,
  type GroupInfo,
  type GroupMember,
  type GroupSendReceipt,
  type HistItem,
  type NodeInfo,
  type ProfileResponse,
  type SendReceipt,
  type SentFile,
  type SentGroupFile,
  type UnsealResponse,
} from './api';
import type { PrefsImported } from './prefs-session';

// The wrappers are the contract with src-tauri: the command and event names
// and the argument keys must match the Rust side exactly (plan §5). Tauri
// turns the camelCase keys here into the snake_case parameters there.
const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  listen: vi.fn(async (..._args: unknown[]) => () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));
const { clearAllBrowsingData } = vi.hoisted(() => ({ clearAllBrowsingData: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/api/webview', () => ({ getCurrentWebview: () => ({ clearAllBrowsingData }) }));

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
});

const FILE = { url: 'https://b.example/x', key: 'k', sha256: 's', mime: 'image/png', name: 'a.png', size: 3 };

// A call as W6 records it (K13). Nested keys are not renamed by Tauri, so they
// stay snake_case, as the Rust `CallEvent` reads them.
const CALL: CallEventWire = {
  id: 'c4ll-1d-0000000001',
  direction: 'outgoing',
  video: false,
  outcome: 'answered',
  duration_sec: 240,
  ttl: null,
};

describe('command errors', () => {
  it('keep the codes of the first run and unlock, in their order', () => {
    expect(COMMAND_ERROR_CODES.slice(0, 11)).toEqual([
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
    ]);
  });

  it('add the codes of the new commands after them', () => {
    expect(COMMAND_ERROR_CODES.slice(11)).toEqual([
      'offline',
      'not_accepted',
      'message_too_long',
      'no_session',
      'upload_failed',
      'invalid_code',
      'name_taken',
      'already_contact',
      'not_admin',
      'not_found',
      'profile_invalid',
      'invalid_name',
    ]);
  });

  // K12: a name, an "about" or a photo over its limit. Added at the end, so
  // no earlier code moved; only the code of a contact's name came after it.
  it('keep the code of the shared profile after the codes before it', () => {
    expect(COMMAND_ERROR_CODES.indexOf('profile_invalid')).toBe(21);
    expect(COMMAND_ERROR_CODES[COMMAND_ERROR_CODES.length - 2]).toBe('profile_invalid');
    expect(isCommandError({ code: 'profile_invalid', message: 'about is longer than 140' })).toBe(true);
  });

  // A contact's name the app cannot use: one the chats read as the channel
  // or a group (`channel`, `grp:…`), with control, format or bidi
  // characters, or with nothing that shows. Added at the end, so no earlier
  // code moves.
  it('end with the code of a name a contact cannot have', () => {
    expect(COMMAND_ERROR_CODES[COMMAND_ERROR_CODES.length - 1]).toBe('invalid_name');
    expect(isCommandError({ code: 'invalid_name', message: 'that name is a group' })).toBe(true);
  });

  it('are recognised with their extra fields', () => {
    expect(
      isCommandError({
        code: 'upload_failed',
        message: 'every server refused',
        servers: [{ server: 'https://b.example', reason: '401' }],
      }),
    ).toBe(true);
    expect(isCommandError({ code: 'already_contact', message: 'same keys', handle: 'Ana' })).toBe(true);
    expect(isCommandError({ code: 'no_such_code', message: 'x' })).toBe(false);
    expect(isCommandError('offline')).toBe(false);
  });
});

describe('the new commands', () => {
  it.each([
    ['checkPassphrase', () => api.checkPassphrase('una frase larga'), 'check_passphrase', { passphrase: 'una frase larga' }],
    ['connectionStatus', () => api.connectionStatus(), 'connection_status', undefined],
    ['totpEnable', () => api.totpEnable('p'), 'totp_enable', { passphrase: 'p' }],
    ['totpDisable', () => api.totpDisable('p', '123456'), 'totp_disable', { passphrase: 'p', code: '123456' }],
    ['changePassphrase', () => api.changePassphrase('a', 'b'), 'change_passphrase', { current: 'a', next: 'b', totpCode: null }],
    [
      'changePassphrase with a code',
      () => api.changePassphrase('a', 'b', '123456'),
      'change_passphrase',
      { current: 'a', next: 'b', totpCode: '123456' },
    ],
    ['previewContact', () => api.previewContact('{}'), 'preview_contact', { bundleJson: '{}' }],
    ['acknowledgeKeyChange', () => api.acknowledgeKeyChange('Ana'), 'acknowledge_key_change', { handle: 'Ana' }],
    ['groupMembers', () => api.groupMembers('g1'), 'group_members', { gid: 'g1' }],
    ['removeGroupMember', () => api.removeGroupMember('g1', 'ab12'), 'remove_group_member', { gid: 'g1', ikSignPub: 'ab12' }],
    ['renameGroup', () => api.renameGroup('g1', 'Familia'), 'rename_group', { gid: 'g1', name: 'Familia' }],
    ['leaveGroup', () => api.leaveGroup('g1'), 'leave_group', { gid: 'g1' }],
    ['deleteGroup', () => api.deleteGroup('g1'), 'delete_group', { gid: 'g1' }],
    [
      'deleteHistoryItem for a text',
      () => api.deleteHistoryItem('Ana', 1760000000, 'me', 'hola'),
      'delete_history_item',
      { convo: 'Ana', ts: 1760000000, side: 'me', text: 'hola', sha256: null },
    ],
    [
      'deleteHistoryItem for a file',
      () => api.deleteHistoryItem('grp:g1', 1760000000, 'them', undefined, 'abc'),
      'delete_history_item',
      { convo: 'grp:g1', ts: 1760000000, side: 'them', text: null, sha256: 'abc' },
    ],
    [
      // Two members may send the same text in the same second: `from` says whose.
      'deleteHistoryItem for a group message, with its sender',
      () => api.deleteHistoryItem('grp:g1', 1760000000, 'them', 'ok', undefined, 'Bob'),
      'delete_history_item',
      { convo: 'grp:g1', ts: 1760000000, side: 'them', text: 'ok', sha256: null, from: 'Bob' },
    ],
    [
      'recordCall',
      () => api.recordCall('Ana', CALL, 1760000000),
      'record_call',
      { peer: 'Ana', call: CALL, startedAt: 1760000000 },
    ],
    ['listCallHistory', () => api.listCallHistory(), 'list_call_history', { limit: null }],
    ['listCallHistory with a limit', () => api.listCallHistory(50), 'list_call_history', { limit: 50 }],
  ])('%s calls its command', async (_name, call, command, args) => {
    await call();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(args === undefined ? [command] : [command, args]);
  });

  it('return what the backend answers', async () => {
    const status = { up: 2, total: 3, relays: [{ url: 'wss://r.example', connected: true }] };
    invoke.mockResolvedValueOnce(status);
    await expect(api.connectionStatus()).resolves.toEqual(status);
  });
});

describe('the existing commands that gain an optional argument', () => {
  // Without the new argument, the payload is exactly the one the current
  // backend already takes, so nothing changes until W7 and W8 land.
  it('send the same payload as before when it is left out', async () => {
    await api.probeNode('{}', 'Ana');
    await api.sendGroupMessage('g1', 'hola');
    await api.sendGroupFile('g1', 'a.png', 'image/png', 'AAAA', null);
    await api.updateProfile('Ana', null);
    expect(invoke.mock.calls).toEqual([
      ['probe_node', { bundleJson: '{}', handle: 'Ana' }],
      ['send_group_message', { gid: 'g1', text: 'hola' }],
      ['send_group_file', { gid: 'g1', name: 'a.png', mime: 'image/png', dataB64: 'AAAA', thumb: null }],
      ['update_profile', { handle: 'Ana', avatar: null }],
    ]);
  });

  it('send it when it is given', async () => {
    await api.probeNode('{}', 'Ana', true);
    await api.sendGroupMessage('g1', 'hola', ['Ana']);
    await api.sendGroupFile('g1', 'a.png', 'image/png', 'AAAA', null, ['Ana']);
    await api.updateProfile('Ana', 'data:image/jpeg;base64,AAAA', 'Hola');
    // An empty "about" is given too: it clears the one saved (K12).
    await api.updateProfile('Ana', null, '');
    expect(invoke.mock.calls).toEqual([
      ['probe_node', { bundleJson: '{}', handle: 'Ana', replaceExisting: true }],
      ['send_group_message', { gid: 'g1', text: 'hola', only: ['Ana'] }],
      ['send_group_file', { gid: 'g1', name: 'a.png', mime: 'image/png', dataB64: 'AAAA', thumb: null, only: ['Ana'] }],
      ['update_profile', { handle: 'Ana', avatar: 'data:image/jpeg;base64,AAAA', about: 'Hola' }],
      ['update_profile', { handle: 'Ana', avatar: null, about: '' }],
    ]);
  });

  it('pass the send receipt through, or null from a backend without one', async () => {
    invoke.mockResolvedValueOnce({ ts: 1760000000, accepted_by: ['wss://r.example'] });
    await expect(api.sendMessage('Ana', 'hola')).resolves.toEqual({ ts: 1760000000, accepted_by: ['wss://r.example'] });
    invoke.mockResolvedValueOnce(null);
    await expect(api.sendMessage('Ana', 'hola')).resolves.toBeNull();
    invoke.mockResolvedValueOnce({ ...FILE, ts: 1760000000, accepted_by: [] });
    await expect(api.sendFile('Ana', 'a.png', 'image/png', 'AAAA', null)).resolves.toMatchObject({ ...FILE, ts: 1760000000 });
  });
});

// What the backend units must answer with. Plan §5 leaves these shapes open;
// the screens are written against them, so W7 and W8 match them (tsc checks
// this side, `cargo test` the other).
describe('the answers W7 and W8 must match', () => {
  it('keep the file of a sent file, with the receipt flattened in (K4)', () => {
    expectTypeOf<SentFile>().toEqualTypeOf<FileRef & Partial<SendReceipt>>();
    expectTypeOf<SentGroupFile>().toEqualTypeOf<FileRef & Partial<GroupSendReceipt>>();
    expectTypeOf<GroupSendReceipt>().toEqualTypeOf<{ ts: number; accepted: string[]; failed: string[] }>();
  });

  it('pass a sent group file through with its file and its receipt', async () => {
    const answer = { ...FILE, ts: 1760000000, accepted: ['Ana'], failed: ['Luis'] };
    invoke.mockResolvedValueOnce(answer);
    await expect(api.sendGroupFile('g1', 'a.png', 'image/png', 'AAAA', null)).resolves.toEqual(answer);
  });

  it('answer removing a member and renaming with the group as it is now (K10)', () => {
    expectTypeOf(api.removeGroupMember).returns.toEqualTypeOf<Promise<GroupInfo>>();
    expectTypeOf(api.renameGroup).returns.toEqualTypeOf<Promise<GroupInfo>>();
    expectTypeOf(api.leaveGroup).returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf(api.deleteGroup).returns.toEqualTypeOf<Promise<void>>();
  });

  it('name the extra fields of a command error (K2, K8)', () => {
    expectTypeOf<CommandError['servers']>().toEqualTypeOf<{ server: string; reason: string }[] | undefined>();
    expectTypeOf<CommandError['handle']>().toEqualTypeOf<string | undefined>();
  });

  it('carry via_group on the members of a group only, as K9 names it', () => {
    expectTypeOf<GroupMember>().toHaveProperty('via_group');
    expectTypeOf<NodeInfo>().not.toHaveProperty('via_group');
  });

  // K13: each call is a history item of its contact's chat, and the call log
  // lists them with their contact.
  it('carry a call in the history and in the call log (K13)', () => {
    expectTypeOf<HistItem['call']>().toEqualTypeOf<CallEventWire | null | undefined>();
    expectTypeOf<CallEventWire>().toEqualTypeOf<{
      id: string;
      direction: 'outgoing' | 'incoming';
      video: boolean;
      outcome: 'answered' | 'missed' | 'declined' | 'unanswered' | 'cancelled' | 'failed';
      duration_sec: number;
      ttl?: number | null;
    }>();
    expectTypeOf<CallLogWire>().toEqualTypeOf<{ peer: string; ts: number; call: CallEventWire }>();
    expectTypeOf(api.recordCall).returns.toEqualTypeOf<Promise<CallLogWire>>();
    expectTypeOf(api.listCallHistory).returns.toEqualTypeOf<Promise<CallLogWire[]>>();
  });

  it('pass a recorded call and the call log through', async () => {
    const entry: CallLogWire = { peer: 'Ana', ts: 1760000000, call: CALL };
    invoke.mockResolvedValueOnce(entry);
    await expect(api.recordCall('Ana', CALL, 1760000000)).resolves.toEqual(entry);
    invoke.mockResolvedValueOnce([entry]);
    await expect(api.listCallHistory()).resolves.toEqual([entry]);
  });

  // K12: the name, photo and "about" each contact shares. Optional until W8.
  it('add the shared profile to your profile and to each contact (K12)', () => {
    expectTypeOf<ProfileResponse['about']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<ProfileResponse['sync']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<NodeInfo['profile_name']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<NodeInfo['about']>().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<NodeInfo['profile_sync']>().toEqualTypeOf<boolean | undefined>();
  });
});

describe('the new events', () => {
  it.each([
    ['onConnectionChanged', onConnectionChanged, 'connection-changed', { up: 1, total: 3, relays: [] }],
    ['onContactKeyMismatch', onContactKeyMismatch, 'contact-key-mismatch', { handle: 'Ana' }],
    ['onGroupRemoved', onGroupRemoved, 'group-removed', { gid: 'g1' }],
    ['onCallLogged', onCallLogged, 'call-logged', { peer: 'Ana', ts: 1760000000, call: CALL }],
    ['onProfileUpdated', onProfileUpdated, 'profile-updated', { handle: 'Ana' }],
  ])('%s listens to %s and hands over the payload', async (_name, subscribe, event, payload) => {
    const callback = vi.fn();
    await (subscribe as (cb: (p: unknown) => void) => Promise<unknown>)(callback);
    expect(listen).toHaveBeenCalledTimes(1);
    const [name, handler] = listen.mock.calls[0] as [string, (e: { payload: unknown }) => void];
    expect(name).toBe(event);
    handler({ payload });
    expect(callback).toHaveBeenCalledWith(payload);
  });
});

// Cifrado local CL-2a: the account's preferences in the store (prefs_cmds.rs).
describe("the account's preferences", () => {
  it.each([
    ['prefsSave', () => api.prefsSave({ 'note:Ana': 'x' }), 'prefs_save', { prefs: { 'note:Ana': 'x' } }],
    ['prefsImport', () => api.prefsImport({ autolock: '1' }), 'prefs_import', { entries: { autolock: '1' } }],
    ['prefsGet', () => api.prefsGet(), 'prefs_get', undefined],
  ])('%s calls its command', async (_name, call, command, args) => {
    await call();
    expect(invoke.mock.calls).toEqual([args === undefined ? [command] : [command, args]]);
  });

  it('clear the WebView through its own call, once imported', async () => {
    await api.clearBrowsingData();
    expect(clearAllBrowsingData).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('come with the unlock answer, as the backend sends it', () => {
    const answer: UnsealResponse = {
      handle: 'Ana',
      fingerprint: 'f1f2',
      nostr_pub: 'cc',
      relay_connection_started: true,
      prefs: { 'note:Bob': 'Vecino' },
      prefs_import: 'pending',
      custom_data_dir: false,
      integrity: { findings: [{ file: 'account', what: 'olderCopy', action: 'ask' }] },
      migration: { contacts: 1, groups: 0, stickers: 0 },
    };
    expectTypeOf(answer.prefs_import).toEqualTypeOf<'done' | 'pending' | 'unavailable'>();
    expectTypeOf<PrefsImported>().toEqualTypeOf<{ taken: Record<string, string>; saved: boolean; notes: number }>();
  });
});

// Windows' text size (Settings > Accessibility > Text size), which WebView2
// does not apply by itself: the app reads it and follows it (a11y.rs).
describe("the system's text size", () => {
  it('is read with system_text_scale, as a factor such as 1.25', async () => {
    invoke.mockResolvedValueOnce(1.25);
    await expect(api.systemTextScale()).resolves.toBe(1.25);
    expect(invoke.mock.calls).toEqual([['system_text_scale']]);
  });
});
