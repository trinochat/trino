import { describe, expect, it } from 'vitest';
import type { StatusResponse } from '../../lib/api';
import { INITIAL_PHASE, phaseReducer, type AppPhase, type PhaseEvent } from './app-phase';

const status = (change: Partial<StatusResponse> = {}): StatusResponse => ({
  has_vault: false,
  is_unsealed: false,
  handle: null,
  nostr_pub: null,
  home_dir: 'C:/Users/rechita/.trino',
  totp_enabled: null,
  ...change,
});

/** Applies the events in order. */
const run = (from: AppPhase, ...events: PhaseEvent[]) => events.reduce(phaseReducer, from);

const VAULT = status({ has_vault: true, handle: 'Rechita', totp_enabled: true });
const LOCKED_BY_HAND: PhaseEvent = { type: 'locked', reason: { kind: 'manual' } };
const main = run(INITIAL_PHASE, { type: 'status', status: VAULT }, { type: 'unlocked' });

describe('phaseReducer', () => {
  it('starts by reading the status', () => {
    expect(INITIAL_PHASE).toEqual({ kind: 'loading' });
  });

  it('goes to the first run when there is no identity on this device', () => {
    expect(run(INITIAL_PHASE, { type: 'status', status: status() })).toEqual({ kind: 'onboarding' });
  });

  it('goes to the unlock screen when there is one, with its name and whether it asks for a code', () => {
    expect(run(INITIAL_PHASE, { type: 'status', status: VAULT })).toEqual({
      kind: 'unlock',
      reason: { kind: 'cold' },
      handle: 'Rechita',
      totpEnabled: true,
    });
  });

  // A reload of the window leaves the session open in the backend; the
  // password is asked anyway, as the old screens did.
  it('asks for the password even when the session is still open', () => {
    expect(run(INITIAL_PHASE, { type: 'status', status: { ...VAULT, is_unsealed: true } })).toMatchObject({ kind: 'unlock' });
  });

  it('shows the start-up error when the status cannot be read, and reads it again on retry', () => {
    const failed = run(INITIAL_PHASE, { type: 'statusFailed' });
    expect(failed).toEqual({ kind: 'startupError' });
    expect(run(failed, { type: 'retry' })).toEqual({ kind: 'loading' });
  });

  it('opens the chats with the intent the first run ended with', () => {
    const onboarding = run(INITIAL_PHASE, { type: 'status', status: status() });
    expect(run(onboarding, { type: 'created', intent: 'add-contact' })).toEqual({ kind: 'main', intent: 'add-contact' });
    expect(run(onboarding, { type: 'created', intent: 'chats' })).toEqual({ kind: 'main', intent: 'chats' });
  });

  // createIdentity said there is an identity already: read the status again,
  // which leads to unlocking it.
  it('reads the status again when the first run finds an identity', () => {
    const onboarding = run(INITIAL_PHASE, { type: 'status', status: status() });
    const loading = run(onboarding, { type: 'vaultExists' });
    expect(loading).toEqual({ kind: 'loading' });
    expect(run(loading, { type: 'status', status: VAULT }).kind).toBe('unlock');
  });

  it('opens the chats once unlocked, and goes to the first run when the identity is gone', () => {
    expect(main).toEqual({ kind: 'main', intent: 'chats' });
    const unlock = run(INITIAL_PHASE, { type: 'status', status: VAULT });
    expect(run(unlock, { type: 'noVault' })).toEqual({ kind: 'onboarding' });
  });

  // Locking always reads the status again, so the unlock screen shows the
  // name and the code field as they are now.
  it('reads the status again on locking, then unlocks with the reason', () => {
    const loading = run(main, LOCKED_BY_HAND);
    expect(loading).toEqual({ kind: 'loading', then: { kind: 'manual' } });
    const renamed = status({ has_vault: true, handle: 'Rechi', totp_enabled: false });
    expect(run(loading, { type: 'status', status: renamed })).toEqual({
      kind: 'unlock',
      reason: { kind: 'manual' },
      handle: 'Rechi',
      totpEnabled: false,
    });
    const idle = run(main, { type: 'locked', reason: { kind: 'idle', minutes: 5 } }, { type: 'status', status: VAULT });
    expect(idle).toMatchObject({ kind: 'unlock', reason: { kind: 'idle', minutes: 5 } });
  });

  it('keeps the reason through a failed read and its retry', () => {
    const failed = run(main, LOCKED_BY_HAND, { type: 'statusFailed' });
    expect(failed).toEqual({ kind: 'startupError', then: { kind: 'manual' } });
    expect(run(failed, { type: 'retry' }, { type: 'status', status: VAULT })).toMatchObject({ reason: { kind: 'manual' } });
  });

  it('goes to the first run when the identity is gone after locking', () => {
    expect(run(main, LOCKED_BY_HAND, { type: 'status', status: status() })).toEqual({ kind: 'onboarding' });
  });

  // A late status, or an event of another screen, changes nothing.
  it('ignores what does not belong to the phase', () => {
    const onboarding = run(INITIAL_PHASE, { type: 'status', status: status() });
    const unlock = run(INITIAL_PHASE, { type: 'status', status: VAULT });
    const cases: Array<[AppPhase, PhaseEvent]> = [
      [main, { type: 'status', status: status() }],
      [main, { type: 'statusFailed' }],
      [main, { type: 'retry' }],
      [onboarding, { type: 'unlocked' }],
      [onboarding, LOCKED_BY_HAND],
      [unlock, { type: 'created', intent: 'chats' }],
      [unlock, LOCKED_BY_HAND],
      [INITIAL_PHASE, LOCKED_BY_HAND],
      [INITIAL_PHASE, { type: 'unlocked' }],
    ];
    for (const [phase, event] of cases) {
      expect(phaseReducer(phase, event), `${phase.kind} + ${event.type}`).toBe(phase);
    }
  });
});
