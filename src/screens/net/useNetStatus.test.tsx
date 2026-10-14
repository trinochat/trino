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
