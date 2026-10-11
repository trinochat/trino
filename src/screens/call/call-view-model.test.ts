// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallState } from '../../lib/call';
import { callClock, endReasonOf, useNow, viewOf, type EndTrace } from './call-view-model';

afterEach(() => {
  vi.useRealTimers();
});

describe('viewOf', () => {
  it.each<[CallState, string]>([
    ['starting', 'ringing-out'],
    ['ringing-out', 'ringing-out'],
    ['ringing-in', 'incoming'],
    ['connecting', 'connecting'],
    ['connected', 'connected'],
  ])('shows %s as %s', (state, view) => {
    expect(viewOf(state, false)).toBe(view);
    expect(viewOf(state, true)).toBe(view);
  });

  it.each<CallState>(['ended', 'rejected', 'idle'])('shows a finished call (%s) as its end card, or nothing', state => {
    expect(viewOf(state, true)).toBe('ended');
    expect(viewOf(state, false)).toBe('idle');
  });
});

const BASE: EndTrace = {
  direction: 'outgoing',
  states: ['starting', 'ringing-out', 'connected', 'ended'],
  errors: [],
  local: null,
  connectedAt: 1_000,
  endedAt: 61_000,
  security: false,
};

describe('endReasonOf', () => {
  it('ends a call that connected with "Llamada finalizada", whoever hung up', () => {
    expect(endReasonOf(BASE)).toBe('ended');
    expect(endReasonOf({ ...BASE, local: 'hangup' })).toBe('ended');
  });

  it('says the connection was lost when that ended a connected call', () => {
    expect(endReasonOf({ ...BASE, errors: ['connection'] })).toBe('connection');
    // A camera that failed during the call did not end it.
    expect(endReasonOf({ ...BASE, errors: ['camera'] })).toBe('ended');
  });

  it('puts the changed key of the connection before anything else', () => {
    expect(endReasonOf({ ...BASE, security: true, errors: ['connection'] })).toBe('security');
    expect(endReasonOf({ ...BASE, connectedAt: null, states: ['starting', 'ringing-out', 'ended'], security: true })).toBe(
      'security',
    );
  });

  it('tells the caller the other person rejected the call, or did not answer', () => {
    expect(endReasonOf({ ...BASE, connectedAt: null, states: ['starting', 'ringing-out', 'rejected'] })).toBe('rejected');
    expect(
      endReasonOf({ ...BASE, connectedAt: null, states: ['starting', 'ringing-out', 'ended'], errors: ['no-answer'] }),
    ).toBe('no-answer');
  });

  it('explains why a call could not start: the microphone, its permission, the signal or the connection', () => {
    const early = { ...BASE, connectedAt: null, states: ['starting', 'ended'] as CallState[] };
    expect(endReasonOf({ ...early, errors: ['microphone'] })).toBe('microphone');
    expect(endReasonOf({ ...early, errors: ['permission'] })).toBe('permission');
    expect(endReasonOf({ ...early, errors: ['signal'] })).toBe('signal');
    expect(
      endReasonOf({ ...BASE, direction: 'incoming', connectedAt: null, states: ['ringing-in', 'connecting', 'ended'], errors: ['connection'] }),
    ).toBe('connection');
  });

  it('shows no end card when this side ended the call before it connected', () => {
    const ringing = { ...BASE, connectedAt: null, states: ['starting', 'ringing-out', 'ended'] as CallState[] };
    expect(endReasonOf({ ...ringing, local: 'hangup' })).toBeNull();
    // "No" to calling directly: nothing was placed.
    expect(endReasonOf({ ...BASE, connectedAt: null, states: ['starting', 'ended'], local: 'hangup' })).toBeNull();
    const incoming = { ...BASE, direction: 'incoming' as const, connectedAt: null };
    expect(endReasonOf({ ...incoming, states: ['ringing-in', 'ended'], local: 'decline' })).toBeNull();
    expect(endReasonOf({ ...incoming, states: ['ringing-in', 'connecting', 'ended'], local: 'decline' })).toBeNull();
  });

  it('shows no end card for a call that only rang here, or that gave way to another', () => {
    const incoming = { ...BASE, direction: 'incoming' as const, connectedAt: null };
    expect(endReasonOf({ ...incoming, states: ['ringing-in', 'ended'] })).toBeNull();
    expect(endReasonOf({ ...BASE, connectedAt: null, states: ['starting', 'ringing-out', 'ended'] })).toBeNull();
  });
});

describe('callClock', () => {
  it('counts from connecting, in minutes and seconds, and hours from the first hour', () => {
    expect(callClock(1_000, 1_000)).toBe('00:00');
    expect(callClock(1_000, 202_999)).toBe('03:21');
    expect(callClock(0, 3_723_000)).toBe('1:02:03');
  });

  it('never goes below zero', () => {
    expect(callClock(10_000, 1_000)).toBe('00:00');
  });
});

describe('useNow', () => {
  it('ticks every second while it runs, and stops when it does not', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const { result, rerender } = renderHook(({ running }) => useNow(running), { initialProps: { running: true } });
    expect(result.current).toBe(100_000);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(101_000);
    rerender({ running: false });
    const stopped = result.current;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current).toBe(stopped);
  });
});
