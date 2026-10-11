import { describe, expect, it } from 'vitest';
import type { CallEventWire, CallLogWire } from '../../lib/api';
import type { CallLogEntry } from '../types';
import { addCall, filterCalls, fromLog, missedUnseen, renamePeer, sortCalls } from './call-history-model';

const T0 = 1_760_000_000;

function wire(id: string, ts: number, over: Partial<CallEventWire> = {}, peer = 'Ana'): CallLogWire {
  return { peer, ts, call: { id, direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0, ...over } };
}

const entry = (id: string, ts: number, over: Partial<CallEventWire> = {}, peer = 'Ana'): CallLogEntry =>
  fromLog(wire(id, ts, over, peer));

const ids = (entries: readonly CallLogEntry[]) => entries.map(item => item.call.id);

describe('the call log', () => {
  it('reads an entry of the backend as the screens show it, keyed like its chat message', () => {
    expect(fromLog(wire('a1', T0, { direction: 'outgoing', outcome: 'answered', duration_sec: 240, ttl: 60 }))).toEqual({
      key: 'call:a1',
      peer: 'Ana',
      ts: T0,
      call: { id: 'a1', direction: 'outgoing', video: false, outcome: 'answered', durationSec: 240 },
    });
  });

  it('lists the newest first, and adds a call once', () => {
    const log = sortCalls([entry('old', T0), entry('new', T0 + 100), entry('mid', T0 + 50)]);
    expect(ids(log)).toEqual(['new', 'mid', 'old']);
    const added = addCall(log, entry('mid2', T0 + 60));
    expect(ids(added)).toEqual(['new', 'mid2', 'mid', 'old']);
    expect(addCall(added, entry('mid2', T0 + 60))).toBe(added);
  });

  it('shows every call, or only the missed ones', () => {
    const log = [
      entry('missed', T0 + 3),
      entry('out', T0 + 2, { direction: 'outgoing', outcome: 'unanswered' }),
      entry('in', T0 + 1, { outcome: 'answered', duration_sec: 30 }),
      // Not picked up, on the side it rang for: missed too.
      entry('rang', T0, { outcome: 'unanswered' }),
    ];
    expect(ids(filterCalls(log, 'all'))).toEqual(['missed', 'out', 'in', 'rang']);
    expect(ids(filterCalls(log, 'missed'))).toEqual(['missed', 'rang']);
  });

  it('counts the missed calls after the log was last seen', () => {
    const log = [
      entry('after', T0 + 10),
      entry('declined', T0 + 9, { outcome: 'declined' }),
      entry('mine', T0 + 8, { direction: 'outgoing', outcome: 'unanswered' }),
      entry('seen', T0),
      entry('before', T0 - 5),
    ];
    expect(missedUnseen(log, T0)).toBe(1);
    expect(missedUnseen(log, 0)).toBe(3);
    expect(missedUnseen(log, T0 + 10)).toBe(0);
  });

  it('follows a renamed contact', () => {
    const log = [entry('a', T0 + 1), entry('b', T0, {}, 'Bea')];
    expect(renamePeer(log, 'Ana', 'Ana Torres').map(item => [item.peer, item.key])).toEqual([
      ['Ana Torres', 'call:a'],
      ['Bea', 'call:b'],
    ]);
    expect(renamePeer(log, 'nadie', 'otro')).toBe(log);
  });
});
