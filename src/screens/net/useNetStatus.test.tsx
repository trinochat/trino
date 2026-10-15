// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetStatus } from '../../lib/net';
import { fakeNet, READY } from './test-support';
import { useNetStatus } from './useNetStatus';

afterEach(cleanup);

const flush = () => act(async () => {});

describe('useNetStatus', () => {
  it('is null until the backend answers, then its state', async () => {
    const { api } = fakeNet({ state: 'starting', pct: 10 });
    const hook = renderHook(() => useNetStatus(api));
    expect(hook.result.current).toBeNull();
    await flush();
    expect(hook.result.current).toEqual({ state: 'starting', pct: 10 });
  });

  it('follows net-changed, and stops listening when it goes', async () => {
    const { api, emit, listening } = fakeNet();
    const hook = renderHook(() => useNetStatus(api));
    await flush();
    act(() => emit.net({ state: 'starting', pct: 40 }));
    expect(hook.result.current).toEqual({ state: 'starting', pct: 40 });
    act(() => emit.net({ state: 'direct' }));
    expect(hook.result.current).toEqual({ state: 'direct' });
    hook.unmount();
    expect(listening()).toBe(0);
  });

  it('keeps an event that came before the first answer over that answer', async () => {
    const { api, emit } = fakeNet();
    let answer!: (status: NetStatus) => void;
    api.status.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const hook = renderHook(() => useNetStatus(api));
    await flush();
    act(() => emit.net({ state: 'starting', pct: 70 }));
    await act(async () => answer(READY));
    expect(hook.result.current).toEqual({ state: 'starting', pct: 70 });
  });

  it('stays null when the backend cannot say', async () => {
    const { api } = fakeNet();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.status.mockRejectedValueOnce(new Error('no backend'));
    const hook = renderHook(() => useNetStatus(api));
    await flush();
    expect(hook.result.current).toBeNull();
    error.mockRestore();
  });

  it('asks nothing without the network', async () => {
    const hook = renderHook(() => useNetStatus(null));
    await flush();
    expect(hook.result.current).toBeNull();
  });
});

// FIX-2: each component that shows Tor's state follows it itself, instead of
// the whole shell; they share one question and one listener.
describe('useNetStatus, shared', () => {
  it('asks the backend once and listens once for every component that follows it', async () => {
    const { api, emit, listening } = fakeNet({ state: 'starting', pct: 10 });
    const one = renderHook(() => useNetStatus(api));
    const two = renderHook(() => useNetStatus(api));
    await flush();
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.onNetChanged).toHaveBeenCalledTimes(1);
    expect(listening()).toBe(1);
    act(() => emit.net({ state: 'starting', pct: 50 }));
    expect(one.result.current).toEqual({ state: 'starting', pct: 50 });
    expect(two.result.current).toEqual({ state: 'starting', pct: 50 });
  });

  it('gives one that comes later the state at once', async () => {
    const { api, emit } = fakeNet();
    renderHook(() => useNetStatus(api));
    await flush();
    act(() => emit.net({ state: 'direct' }));
    const later = renderHook(() => useNetStatus(api));
    expect(later.result.current).toEqual({ state: 'direct' });
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('listens until the last one goes, then forgets and asks again', async () => {
    const { api, listening } = fakeNet({ state: 'starting', pct: 20 });
    const one = renderHook(() => useNetStatus(api));
    const two = renderHook(() => useNetStatus(api));
    await flush();
    one.unmount();
    expect(listening()).toBe(1);
    two.unmount();
    expect(listening()).toBe(0);
    api.status.mockResolvedValueOnce(READY);
    const again = renderHook(() => useNetStatus(api));
    expect(again.result.current).toBeNull();
    await flush();
    expect(again.result.current).toEqual(READY);
    expect(api.status).toHaveBeenCalledTimes(2);
  });
});
