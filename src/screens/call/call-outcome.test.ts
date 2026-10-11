import { describe, expect, it } from 'vitest';
import { MAX_CALL_SECONDS, callOutcome, type CallTrace } from './call-outcome';

const CONNECTED_AT = 1_700_000_000_000;

function outgoing(trace: Partial<CallTrace>): CallTrace {
  return { direction: 'outgoing', states: [], errors: [], local: null, connectedAt: null, endedAt: CONNECTED_AT, ...trace };
}

function incoming(trace: Partial<CallTrace>): CallTrace {
  return { direction: 'incoming', states: [], errors: [], local: null, connectedAt: null, endedAt: CONNECTED_AT, ...trace };
}

// plan-cambios-11oct §4, W6: what a call that ended leaves in the chat and the call log.
describe('callOutcome', () => {
  describe('an outgoing call that never rang is not recorded', () => {
    it.each<[string, Partial<CallTrace>]>([
      ['the microphone failed', { states: ['starting', 'ended'], errors: ['microphone'] }],
      ['the microphone was not allowed', { states: ['starting', 'ended'], errors: ['permission'] }],
      ['"no" to calling directly', { states: ['starting', 'ended'], local: 'hangup' }],
      ['hung up while TURN was being asked for', { states: ['starting', 'ended'], local: 'hangup' }],
      ['the offer could not be sent', { states: ['starting', 'ended'], errors: ['signal'] }],
    ])('%s', (_, trace) => {
      expect(callOutcome(outgoing(trace))).toBeNull();
    });
  });

  it('records a call that connected as answered, with its length from connecting', () => {
    const states = ['starting', 'ringing-out', 'connected', 'ended'] as const;
    expect(
      callOutcome(outgoing({ states, connectedAt: CONNECTED_AT, endedAt: CONNECTED_AT + 201_900, local: 'hangup' })),
    ).toEqual({ outcome: 'answered', durationSec: 201 });
    expect(
      callOutcome(
        incoming({ states: ['ringing-in', 'connecting', 'connected', 'ended'], connectedAt: CONNECTED_AT, endedAt: CONNECTED_AT + 4_000 }),
      ),
    ).toEqual({ outcome: 'answered', durationSec: 4 });
  });

  it('keeps an answered call answered when the connection is lost afterwards', () => {
    const trace = outgoing({
      states: ['starting', 'ringing-out', 'connected', 'connecting', 'ended'],
      errors: ['connection'],
      connectedAt: CONNECTED_AT,
      endedAt: CONNECTED_AT + 61_000,
    });
    expect(callOutcome(trace)).toEqual({ outcome: 'answered', durationSec: 61 });
  });

  it('keeps the length within what the backend takes', () => {
    const long = outgoing({ states: ['ringing-out', 'connected', 'ended'], connectedAt: CONNECTED_AT, endedAt: CONNECTED_AT + 2 * 86_400_000 });
    expect(callOutcome(long)).toEqual({ outcome: 'answered', durationSec: MAX_CALL_SECONDS });
    const backwards = outgoing({ states: ['ringing-out', 'connected', 'ended'], connectedAt: CONNECTED_AT, endedAt: CONNECTED_AT - 5_000 });
    expect(callOutcome(backwards)).toEqual({ outcome: 'answered', durationSec: 0 });
  });

  it('records an outgoing call the other person rejected as declined', () => {
    expect(callOutcome(outgoing({ states: ['starting', 'ringing-out', 'rejected'] }))).toEqual({ outcome: 'declined', durationSec: 0 });
  });

  it('records an outgoing call nobody picked up as unanswered', () => {
    const trace = outgoing({ states: ['starting', 'ringing-out', 'ended'], errors: ['no-answer'] });
    expect(callOutcome(trace)).toEqual({ outcome: 'unanswered', durationSec: 0 });
  });

  it('records hanging up while it rang as cancelled', () => {
    const trace = outgoing({ states: ['starting', 'ringing-out', 'ended'], local: 'hangup' });
    expect(callOutcome(trace)).toEqual({ outcome: 'cancelled', durationSec: 0 });
  });

  it('records a call that lost its connection before connecting as failed', () => {
    expect(
      callOutcome(outgoing({ states: ['starting', 'ringing-out', 'connecting', 'ended'], errors: ['connection'] })),
    ).toEqual({ outcome: 'failed', durationSec: 0 });
    expect(
      callOutcome(incoming({ states: ['ringing-in', 'connecting', 'ended'], errors: ['connection'] })),
    ).toEqual({ outcome: 'failed', durationSec: 0 });
  });

  it('records hanging up while it was still connecting as failed, not cancelled', () => {
    const trace = outgoing({ states: ['starting', 'ringing-out', 'connecting', 'ended'], local: 'hangup' });
    expect(callOutcome(trace)).toEqual({ outcome: 'failed', durationSec: 0 });
  });

  it('records nothing for an outgoing call the other side ended before anything happened', () => {
    // Both called at once and theirs won: ours gives way to theirs, which is recorded.
    expect(callOutcome(outgoing({ states: ['starting', 'ringing-out', 'ended'] }))).toBeNull();
  });

  it('records an incoming call declined here as declined, a "no" to answering directly included', () => {
    expect(callOutcome(incoming({ states: ['ringing-in', 'ended'], local: 'decline' }))).toEqual({
      outcome: 'declined',
      durationSec: 0,
    });
    expect(callOutcome(incoming({ states: ['ringing-in', 'connecting', 'ended'], local: 'decline' }))).toEqual({
      outcome: 'declined',
      durationSec: 0,
    });
  });

  it('records an incoming call that stopped ringing as missed', () => {
    expect(callOutcome(incoming({ states: ['ringing-in', 'ended'] }))).toEqual({ outcome: 'missed', durationSec: 0 });
    // Locked while it rang: nobody answered it either.
    expect(callOutcome(incoming({ states: ['ringing-in', 'ended'], local: 'hangup' }))).toEqual({
      outcome: 'missed',
      durationSec: 0,
    });
  });

  it('records an incoming call answered here that never connected as failed', () => {
    expect(callOutcome(incoming({ states: ['ringing-in', 'connecting', 'ended'] }))).toEqual({ outcome: 'failed', durationSec: 0 });
    expect(callOutcome(incoming({ states: ['ringing-in', 'connecting', 'ended'], local: 'hangup' }))).toEqual({
      outcome: 'failed',
      durationSec: 0,
    });
    // The microphone failed after answering.
    expect(callOutcome(incoming({ states: ['ringing-in', 'connecting', 'ended'], errors: ['microphone'] }))).toEqual({
      outcome: 'failed',
      durationSec: 0,
    });
  });

  it('records the call both answered at once from its first state, without ringing', () => {
    // We both called and theirs won: we answer it at once (call.ts, glare).
    const trace = incoming({ states: ['connecting', 'connected', 'ended'], connectedAt: CONNECTED_AT, endedAt: CONNECTED_AT + 1_000 });
    expect(callOutcome(trace)).toEqual({ outcome: 'answered', durationSec: 1 });
  });
});
