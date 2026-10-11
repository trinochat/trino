// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallEventWire, CallLogWire } from '../../lib/api';
import { fakeApi, fakeEvents, fakePrefs } from './test-fakes';
import { useCallLog, type CallLogOptions } from './useCallLog';

afterEach(cleanup);

const T0 = 1_760_000_000;

const log = (id: string, ts: number, over: Partial<CallEventWire> = {}): CallLogWire => ({
  peer: 'Ana',
  ts,
  call: { id, direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0, ...over },
});

function setup(
  over: Partial<CallLogOptions> = {},
  { seed = {} as Record<string, string>, wires = [] as CallLogWire[] } = {},
) {
  const api = fakeApi();
  api.listCallHistory.mockResolvedValue(wires);
  const { events, emit, listening } = fakeEvents();
  const { prefs, storage } = fakePrefs(seed);
  const options: CallLogOptions = { api, events, prefs, enabled: true, watching: () => false, ...over };
  const hook = renderHook((props: CallLogOptions) => useCallLog(props), { initialProps: options });
  return { api, emit, listening, storage, hook };
}

describe('useCallLog', () => {
  it('lists the calls, the newest first, and adds a logged call once', async () => {
    const { emit, hook } = setup({}, { wires: [log('old', T0), log('new', T0 + 60)] });
    await waitFor(() => expect(hook.result.current.entries.map(e => e.call.id)).toEqual(['new', 'old']));
    act(() => emit.callLogged(log('newest', T0 + 120)));
    act(() => emit.callLogged(log('newest', T0 + 120)));
    expect(hook.result.current.entries.map(e => e.key)).toEqual(['call:newest', 'call:new', 'call:old']);
  });

  it('counts the missed calls after the log was last seen, and seeing it saves when', async () => {
    const { hook, storage } = setup(
      {},
      {
        seed: { 'trino.pref.callsSeenAt': String(T0 + 30) },
        wires: [log('before', T0), log('after', T0 + 60), log('answered', T0 + 90, { outcome: 'answered', duration_sec: 5 })],
      },
    );
    await waitFor(() => expect(hook.result.current.entries).toHaveLength(3));
    expect(hook.result.current.missedUnseen).toBe(1);
    act(() => hook.result.current.markSeen(T0 + 100));
    expect(hook.result.current.missedUnseen).toBe(0);
    expect(storage.data.get('trino.pref.callsSeenAt')).toBe(String(T0 + 100));
  });

  it('does not count a missed call that arrives while the log is being looked at', async () => {
    const watching = { now: true };
    const { emit, hook } = setup({ watching: () => watching.now });
    await act(async () => {});
    act(() => emit.callLogged(log('seen', T0)));
    expect(hook.result.current.missedUnseen).toBe(0);
    watching.now = false;
    act(() => emit.callLogged(log('unseen', Math.floor(Date.now() / 1000) + 5)));
    expect(hook.result.current.missedUnseen).toBe(1);
  });

  it('moves the calls of a renamed contact', async () => {
    const { emit, hook } = setup();
    await act(async () => {});
    act(() => emit.callLogged(log('a', T0)));
    act(() => hook.result.current.renamed('Ana', 'Ana Torres'));
    expect(hook.result.current.entries[0]?.peer).toBe('Ana Torres');
  });

  it('asks and listens for nothing without the call log (K13)', async () => {
    const { api, listening, hook } = setup({ enabled: false });
    await act(async () => {});
    expect(api.listCallHistory).not.toHaveBeenCalled();
    expect(listening()).toBe(0);
    expect(hook.result.current.entries).toEqual([]);
    expect(hook.result.current.missedUnseen).toBe(0);
  });
});
