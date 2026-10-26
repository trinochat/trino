// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEvents } from './test-fakes';
import { useStrangerAttempts } from './useStrangerAttempts';

afterEach(cleanup);

describe('useStrangerAttempts', () => {
  it('counts the strangers who tried to write in this session, each one once', async () => {
    const { events, emit, listening } = fakeEvents();
    const hook = renderHook(() => useStrangerAttempts(events));
    await act(async () => {});
    expect(hook.result.current).toBe(0);
    act(() => emit.handshakeNeeded({ from_pubkey: 'aa' }));
    act(() => emit.handshakeNeeded({ from_pubkey: 'aa' }));
    act(() => emit.handshakeNeeded({ from_pubkey: 'bb' }));
    expect(hook.result.current).toBe(2);
    hook.unmount();
    await act(async () => {});
    expect(listening()).toBe(0);
  });

  // R-30: anyone with your Nostr key can fire it, so the set of keys has a cap.
  it('counts 99 keys at most', async () => {
    const { events, emit } = fakeEvents();
    const hook = renderHook(() => useStrangerAttempts(events));
    await act(async () => {});
    act(() => {
      for (let n = 0; n < 150; n += 1) emit.handshakeNeeded({ from_pubkey: `k${n}` });
    });
    expect(hook.result.current).toBe(99);
  });
});
