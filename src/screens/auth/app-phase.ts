/**
 * Which screen the app shows before the chats (plan §3 W1): reading the
 * status, its error, the first run, the unlock screen, and the chats. Pure:
 * the integration keeps the phase with `useReducer` and turns what happens
 * (the status, an identity created, an unlock, a lock) into events.
 *
 * Locking always reads the status again, so the unlock screen shows the name
 * and the code field as they are now. With an identity the password is always
 * asked, also when a reload left the session open: the status never skips it.
 */
import type { StatusResponse } from '../../lib/api';
import type { LockReason, OnboardingIntent } from '../types';

export type AppPhase =
  /** Reading the status; `then` is why it locked, if it did. */
  | { kind: 'loading'; then?: LockReason }
  /** The status could not be read; `then` survives the retry. */
  | { kind: 'startupError'; then?: LockReason }
  | { kind: 'onboarding' }
  | { kind: 'unlock'; reason: LockReason; handle: string | null; totpEnabled: boolean | null }
  | { kind: 'main'; intent: OnboardingIntent };

export type PhaseEvent =
  | { type: 'status'; status: StatusResponse }
  | { type: 'statusFailed' }
  | { type: 'retry' }
  /** The first run created the identity and ended with this intent. */
  | { type: 'created'; intent: OnboardingIntent }
  /** The first run found an identity on this device. */
  | { type: 'vaultExists' }
  | { type: 'unlocked' }
  /** The unlock screen found no identity: deleted, by hand or by "Borrar identidad". */
  | { type: 'noVault' }
  | { type: 'locked'; reason: LockReason };

export const INITIAL_PHASE: AppPhase = Object.freeze({ kind: 'loading' }) as AppPhase;

export function phaseReducer(phase: AppPhase, event: PhaseEvent): AppPhase {
  switch (phase.kind) {
    case 'loading':
      if (event.type === 'status') {
        const { status } = event;
        if (!status.has_vault) return { kind: 'onboarding' };
        return {
          kind: 'unlock',
          reason: phase.then ?? { kind: 'cold' },
          handle: status.handle,
          totpEnabled: status.totp_enabled,
        };
      }
      if (event.type !== 'statusFailed') return phase;
      return phase.then ? { kind: 'startupError', then: phase.then } : { kind: 'startupError' };
    case 'startupError':
      if (event.type !== 'retry') return phase;
      return phase.then ? { kind: 'loading', then: phase.then } : { kind: 'loading' };
    case 'onboarding':
      if (event.type === 'created') return { kind: 'main', intent: event.intent };
      if (event.type === 'vaultExists') return { kind: 'loading' };
      return phase;
    case 'unlock':
      if (event.type === 'unlocked') return { kind: 'main', intent: 'chats' };
      if (event.type === 'noVault') return { kind: 'onboarding' };
      return phase;
    case 'main':
      return event.type === 'locked' ? { kind: 'loading', then: event.reason } : phase;
  }
}
