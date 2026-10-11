/**
 * What a call that ended leaves in its chat and in the call log (K13,
 * plan-cambios-11oct §4, W6). Pure: the controller (useCallController.ts)
 * gathers the trace from call.ts and records the result once per call.
 *
 * | The call                                                          | Outcome    |
 * |-------------------------------------------------------------------|------------|
 * | Outgoing that never rang (microphone, "no" to calling directly,   | not        |
 * | hung up while TURN was being asked for)                           | recorded   |
 * | Reached `connected`                                               | answered   |
 * | Outgoing, the other person rejected it                            | declined   |
 * | Outgoing, nobody picked up (`no-answer`)                          | unanswered |
 * | Hung up here while it rang                                        | cancelled  |
 * | The connection failed (`connection`)                              | failed     |
 * | Incoming, declined here ("no" to answering directly included)     | declined   |
 * | Incoming that stopped ringing                                     | missed     |
 * | Incoming, answered here, never connected                          | failed     |
 */
import type { CallDirection, CallOutcome } from '../../lib/api';
import type { CallErrorCode, CallState } from '../../lib/call';

/** What the person on this side did to end the call. */
export type LocalEnd = 'hangup' | 'decline';

/** Everything the controller saw of one call. */
export interface CallTrace {
  direction: CallDirection;
  /** Every state call.ts reported for the call, in order, the final one included. */
  states: readonly CallState[];
  /** Every error call.ts reported during the call, in order. */
  errors: readonly CallErrorCode[];
  /** Hung up or declined here; null when the other side, the network or a timer ended it. */
  local: LocalEnd | null;
  /** Epoch milliseconds of the first `connected`, or null. */
  connectedAt: number | null;
  /** Epoch milliseconds when it ended. */
  endedAt: number;
}

/** The longest call the backend records (`record_call`): a day. */
export const MAX_CALL_SECONDS = 86_400;

export interface CallRecord {
  outcome: CallOutcome;
  /** Seconds from connecting to the end; 0 unless answered. */
  durationSec: number;
}

const FINAL: ReadonlySet<CallState> = new Set(['ended', 'rejected', 'idle']);

/** The outcome of a call that ended, or null when it leaves no record. */
export function callOutcome(trace: CallTrace): CallRecord | null {
  const reached = (state: CallState) => trace.states.includes(state);
  if (trace.connectedAt !== null || reached('connected')) {
    return { outcome: 'answered', durationSec: lengthOf(trace) };
  }
  const outcome = trace.direction === 'outgoing' ? outgoingOutcome(trace, reached) : incomingOutcome(trace, reached);
  return outcome ? { outcome, durationSec: 0 } : null;
}

function outgoingOutcome(trace: CallTrace, reached: (state: CallState) => boolean): CallOutcome | null {
  // Before `ringing-out` the offer had not gone out: nobody was called.
  if (!reached('ringing-out')) return null;
  if (trace.states[trace.states.length - 1] === 'rejected') return 'declined';
  if (trace.errors.includes('no-answer')) return 'unanswered';
  const before = stateBeforeTheEnd(trace.states);
  if (trace.local === 'hangup' && (before === 'ringing-out' || before === 'starting')) return 'cancelled';
  if (trace.errors.includes('connection') || trace.errors.includes('signal') || before === 'connecting') return 'failed';
  // The other side ended it before anything happened, such as both calling
  // at once: ours gives way to theirs, which is the one recorded.
  return null;
}

function incomingOutcome(trace: CallTrace, reached: (state: CallState) => boolean): CallOutcome {
  if (trace.local === 'decline') return 'declined';
  // Answering moves the call to `connecting`; one that never got there rang out.
  if (!reached('connecting')) return 'missed';
  return 'failed';
}

/** The last state before the final one. */
function stateBeforeTheEnd(states: readonly CallState[]): CallState | undefined {
  const live = states.filter(state => !FINAL.has(state));
  return live[live.length - 1];
}

/** Whole seconds from the first `connected` to the end, within what the backend takes. */
function lengthOf({ connectedAt, endedAt }: CallTrace): number {
  if (connectedAt === null) return 0;
  const seconds = Math.floor((endedAt - connectedAt) / 1000);
  return Number.isFinite(seconds) ? Math.min(MAX_CALL_SECONDS, Math.max(0, seconds)) : 0;
}
