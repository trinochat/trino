/**
 * What the first run does when one of its commands fails: `checkPassphrase`,
 * `totpBegin`, `totpVerify` and `createIdentity` reject with a
 * `CommandError` (src-tauri/src/command_error.rs), and a command the backend
 * does not have yet rejects with a plain string. The flow never shows the
 * backend's message: it picks its own text from this.
 */
import { isCommandError } from '../../../lib/api';

/** The policy's minimum length (David, R3.3), for a rejection that does not carry one. */
export const PASSPHRASE_MIN = 10;

export type OnboardingFailure =
  /** The password is shorter than the policy's minimum: back to the password step. */
  | { kind: 'tooShort'; min: number }
  /** The password is too common: back to the password step. */
  | { kind: 'tooCommon' }
  /** The TOTP secret was not confirmed: back to checking a code. */
  | { kind: 'totpNotVerified' }
  /** There is an identity on this device already: the parent unlocks it instead. */
  | { kind: 'vaultExists' }
  /** Anything else (a disk error, an internal one, a plain text): try again where you are. */
  | { kind: 'retry' };

export function onboardingFailure(error: unknown): OnboardingFailure {
  if (!isCommandError(error)) return { kind: 'retry' };
  switch (error.code) {
    case 'passphrase_too_short':
      return { kind: 'tooShort', min: error.min ?? PASSPHRASE_MIN };
    case 'passphrase_too_common':
      return { kind: 'tooCommon' };
    case 'totp_not_verified':
      return { kind: 'totpNotVerified' };
    case 'vault_exists':
      return { kind: 'vaultExists' };
    default:
      return { kind: 'retry' };
  }
}
