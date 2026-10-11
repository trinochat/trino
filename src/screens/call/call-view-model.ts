/**
 * What the call screens show for a call.ts state: the view, why a call
 * ended (its end card), and the call's clock. Pure, except `useNow`, the
 * one-second tick of that clock.
 */
import { useEffect, useState } from 'react';
import type { CallState } from '../../lib/call';
import { durationLabel } from '../../lib/dates';
import type { CallTrace } from './call-outcome';

/**
 * The moments of a call (Call.dc.html): calling, an incoming call, connecting,
 * in the call, and its end card. No IP warning: with TURN the contact never
 * sees the IP, and the question of calling directly is a dialog of its own.
 */
export type CallView = 'idle' | 'ringing-out' | 'incoming' | 'connecting' | 'connected' | 'ended';

/** The view of a call.ts state; a call that is over shows its end card, if it has one. */
export function viewOf(state: CallState, hasEndCard: boolean): CallView {
  switch (state) {
    case 'starting':
    case 'ringing-out':
      return 'ringing-out';
    case 'ringing-in':
      return 'incoming';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    default:
      return hasEndCard ? 'ended' : 'idle';
  }
}

/** Why a call ended, as its end card says it. */
export type CallEndReason =
  | 'ended'
  | 'rejected'
  | 'no-answer'
  | 'connection'
  | 'microphone'
  | 'permission'
  | 'signal'
  | 'security';

/** The trace of a call (call-outcome.ts), and whether its remote DTLS fingerprint changed. */
export interface EndTrace extends CallTrace {
  security: boolean;
}

/** The errors that end a call before it connects; a connected one only ends by losing the connection. */
const STARTING_ERRORS = ['microphone', 'permission', 'signal', 'no-answer', 'connection'] as const;

/**
 * The end card of a call that ended, or null for none: a call this side
 * declined or hung up before it connected, an incoming call that only rang
 * (the call log shows it), or one that gave way to another.
 */
export function endReasonOf(trace: EndTrace): CallEndReason | null {
  if (trace.security) return 'security';
  const last = trace.errors[trace.errors.length - 1];
  if (trace.connectedAt !== null || trace.states.includes('connected')) {
    return last === 'connection' ? 'connection' : 'ended';
  }
  if (trace.states[trace.states.length - 1] === 'rejected') return 'rejected';
  if (trace.local !== null) return null;
  const reason = [...trace.errors].reverse().find(error => (STARTING_ERRORS as readonly string[]).includes(error));
  return (reason as CallEndReason | undefined) ?? null;
}

/** The time since connecting, as the call shows it: "03:21", and "1:02:03" from the first hour. */
export function callClock(connectedAt: number, now: number): string {
  return durationLabel(Math.max(0, now - connectedAt) / 1000);
}

/** Epoch milliseconds, ticking every second while `running`. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}
