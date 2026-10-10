import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMAND_ERROR_CODES,
  api,
  isCommandError,
  onConnectionChanged,
  onContactKeyMismatch,
  onGroupRemoved,
} from './api';

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

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
});

const FILE = { url: 'https://b.example/x', key: 'k', sha256: 's', mime: 'image/png', name: 'a.png', size: 3 };

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
    ]);
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
    expect(invoke.mock.calls).toEqual([
      ['probe_node', { bundleJson: '{}', handle: 'Ana' }],
      ['send_group_message', { gid: 'g1', text: 'hola' }],
      ['send_group_file', { gid: 'g1', name: 'a.png', mime: 'image/png', dataB64: 'AAAA', thumb: null }],
    ]);
  });

  it('send it when it is given', async () => {
    await api.probeNode('{}', 'Ana', true);
    await api.sendGroupMessage('g1', 'hola', ['Ana']);
    await api.sendGroupFile('g1', 'a.png', 'image/png', 'AAAA', null, ['Ana']);
    expect(invoke.mock.calls).toEqual([
      ['probe_node', { bundleJson: '{}', handle: 'Ana', replaceExisting: true }],
      ['send_group_message', { gid: 'g1', text: 'hola', only: ['Ana'] }],
      ['send_group_file', { gid: 'g1', name: 'a.png', mime: 'image/png', dataB64: 'AAAA', thumb: null, only: ['Ana'] }],
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

describe('the new events', () => {
  it.each([
    ['onConnectionChanged', onConnectionChanged, 'connection-changed', { up: 1, total: 3, relays: [] }],
    ['onContactKeyMismatch', onContactKeyMismatch, 'contact-key-mismatch', { handle: 'Ana' }],
    ['onGroupRemoved', onGroupRemoved, 'group-removed', { gid: 'g1' }],
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
