/**
 * What the unlock screen shows when `unseal` fails (R3.6). The backend tells
 * a wrong password (`wrong_passphrase`) from a wrong code (`invalid_totp`),
 * but with 2FA the screen names both, as Unlock:126 does: two-step
 * verification protects against whoever uses the computer, and telling them
 * the password was right would hand them half of it.
 */
import { isCommandError } from '../../../lib/api';

export type UnlockMessageKey = 'unlock2.errPass' | 'unlock2.errPassOrCode' | 'unlock2.errUnsupported' | 'unlock2.errUnlock';

export type UnlockFailure =
  /** A message under the fields; `field` is the one to type again, if any. */
  | { kind: 'message'; key: UnlockMessageKey; field: 'pass' | null }
  /** The vault asks for a code: show the code field and focus it. */
  | { kind: 'codeRequired' }
  /** There is no identity on this device any more. */
  | { kind: 'noVault' };

/** `withCode`: the screen asked for a code, so the vault has 2FA. */
export function unlockFailure(error: unknown, withCode: boolean): UnlockFailure {
  const code = isCommandError(error) ? error.code : null;
  switch (code) {
    case 'wrong_passphrase':
      return { kind: 'message', key: withCode ? 'unlock2.errPassOrCode' : 'unlock2.errPass', field: 'pass' };
    case 'invalid_totp':
      return { kind: 'message', key: 'unlock2.errPassOrCode', field: 'pass' };
    case 'totp_required':
      return { kind: 'codeRequired' };
    case 'no_vault':
      return { kind: 'noVault' };
    case 'unsupported_vault':
      return { kind: 'message', key: 'unlock2.errUnsupported', field: null };
    default:
      return { kind: 'message', key: 'unlock2.errUnlock', field: null };
  }
}
