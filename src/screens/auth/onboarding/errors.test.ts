import { describe, expect, it } from 'vitest';
import type { CommandError, CommandErrorCode } from '../../../lib/api';
import { PASSPHRASE_MIN, onboardingFailure, type OnboardingFailure } from './errors';

const commandError = (code: CommandErrorCode, extra: Partial<CommandError> = {}): CommandError => ({
  code,
  message: `${code} for the log`,
  ...extra,
});

describe('onboardingFailure', () => {
  // What the commands of the first run (checkPassphrase, totpBegin,
  // totpVerify, createIdentity) reject with, and what the flow does about it
  // (plan §3 W1 and the auth map).
  it.each<[string, unknown, OnboardingFailure]>([
    ['a short password, with its minimum', commandError('passphrase_too_short', { min: 12 }), { kind: 'tooShort', min: 12 }],
    ['a common password', commandError('passphrase_too_common'), { kind: 'tooCommon' }],
    ['a TOTP secret nobody confirmed', commandError('totp_not_verified'), { kind: 'totpNotVerified' }],
    ['an identity already on this device', commandError('vault_exists'), { kind: 'vaultExists' }],
    ['a disk error', commandError('io'), { kind: 'retry' }],
    ['an internal error', commandError('internal'), { kind: 'retry' }],
  ])('turns %s into what the flow does', (_, error, failure) => {
    expect(onboardingFailure(error)).toEqual(failure);
  });

  it('falls back to the policy minimum when a short password comes without one', () => {
    expect(PASSPHRASE_MIN).toBe(10);
    expect(onboardingFailure(commandError('passphrase_too_short'))).toEqual({ kind: 'tooShort', min: 10 });
  });

  // A command the backend does not have yet rejects with a plain string,
  // and so does anything else: the person can only try again.
  it('lets the person try again after a plain text, a code of another command or nothing at all', () => {
    for (const error of [
      'command check_passphrase not found',
      new Error('boom'),
      commandError('offline'),
      commandError('wrong_passphrase'),
      { code: 'not_a_code', message: 'x' },
      null,
      undefined,
    ]) {
      expect(onboardingFailure(error), String(error)).toEqual({ kind: 'retry' });
    }
  });
});
