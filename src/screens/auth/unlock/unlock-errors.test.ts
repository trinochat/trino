import { describe, expect, it } from 'vitest';
import type { CommandError, CommandErrorCode } from '../../../lib/api';
import { unlockFailure, type UnlockFailure } from './unlock-errors';

const failure = (code: CommandErrorCode): CommandError => ({ code, message: 'for the log' });

describe('unlockFailure', () => {
  // What `unseal` rejects with (src-tauri/src/command_error.rs) and what the
  // unlock screen shows. With 2FA the message names both fields, as Unlock:126
  // does: it does not tell whoever has the computer which one was right.
  it.each<[string, unknown, boolean, UnlockFailure]>([
    ['a wrong password', failure('wrong_passphrase'), false, { kind: 'message', key: 'unlock2.errPass', field: 'pass' }],
    ['a wrong password, with 2FA', failure('wrong_passphrase'), true, { kind: 'message', key: 'unlock2.errPassOrCode', field: 'pass' }],
    ['a wrong code', failure('invalid_totp'), true, { kind: 'message', key: 'unlock2.errPassOrCode', field: 'pass' }],
    ['a missing code', failure('totp_required'), false, { kind: 'codeRequired' }],
    ['no identity on this device', failure('no_vault'), false, { kind: 'noVault' }],
    ['a vault from a newer Trino', failure('unsupported_vault'), false, { kind: 'message', key: 'unlock2.errUnsupported', field: null }],
    ['a disk error', failure('io'), false, { kind: 'message', key: 'unlock2.errUnlock', field: null }],
    ['an internal error', failure('internal'), true, { kind: 'message', key: 'unlock2.errUnlock', field: null }],
    ['a plain text', 'vault sealed', false, { kind: 'message', key: 'unlock2.errUnlock', field: null }],
    ['a code of another command', failure('offline'), false, { kind: 'message', key: 'unlock2.errUnlock', field: null }],
    ['nothing', undefined, false, { kind: 'message', key: 'unlock2.errUnlock', field: null }],
  ])('turns %s into what the screen shows', (_, error, withCode, expected) => {
    expect(unlockFailure(error, withCode)).toEqual(expected);
  });
});
