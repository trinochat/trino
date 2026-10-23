/**
 * The text of each answer the emergency key's commands reject with (CE-5,
 * design §11.4). The rules of the key live in Rust (passphrase.rs), so they
 * come back as codes; a wrong password or code is told apart, as the other
 * settings do, because whoever is here already opened Trino.
 */
import { isCommandError } from '../../../lib/api';
import type { TVars } from '../../../lib/i18n';

export interface Problem {
  key: string;
  vars?: TVars;
}

/** The policy's minimum, as the backend reports it; 10 since R3.3. */
export const KEY_MIN = 10;

/** A wrong password or code, or null for any other answer. */
export function credentialsProblem(cause: unknown, totpEnabled: boolean): Problem | null {
  if (!isCommandError(cause)) return null;
  switch (cause.code) {
    case 'wrong_passphrase':
      return { key: totpEnabled ? 'emergency.err.wrongCode' : 'emergency.err.wrong' };
    case 'invalid_totp':
    case 'totp_required':
      return { key: 'emergency.err.wrongCode' };
    default:
      return null;
  }
}

/** Why a new key was refused; `fallback` for anything the user cannot fix by typing. */
export function keyProblem(cause: unknown, fallback: string): Problem {
  if (!isCommandError(cause)) return { key: fallback };
  switch (cause.code) {
    case 'passphrase_too_short':
      return { key: 'emergency.err.short', vars: { min: cause.min ?? KEY_MIN } };
    case 'passphrase_too_common':
      return { key: 'emergency.err.common' };
    case 'same_as_passphrase':
      return { key: 'emergency.err.same' };
    case 'like_passphrase':
      return { key: 'emergency.err.like' };
    case 'choose_another':
      return { key: 'emergency.err.another' };
    default:
      return { key: fallback };
  }
}

/** A code as typed, without the spaces of "482 913". */
export function cleanCode(code: string): string {
  return code.replace(/\s/g, '');
}
