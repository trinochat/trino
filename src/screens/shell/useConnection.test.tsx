// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, fakeEvents } from './test-fakes';
import { CONNECTING_GRACE_MS, useConnection } from './useConnection';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => {});

function setup(enabled = true, status = { up: 0, total: 3 }) {
  const api = fakeApi();
  api.connectionStatus.mockResolvedValue({ ...status, relays: [] });
  const { events, emit, listening } = fakeEvents();
  const hook = renderHook(() => useConnection(api, events, enabled));
  return { api, emit, listening, hook };
}

describe('useConnection', () => {
  it('is null without the real connection state (K3), and asks nothing', async () => {
    const { api, hook } = setup(false);
    await flush();
    expect(hook.result.current).toBeNull();
    expect(api.connectionStatus).not.toHaveBeenCalled();
  });

  it('says connecting until the backend answers, then how many servers are up', async () => {
    const api = fakeApi();
    let answer!: (status: { up: number; total: number; relays: [] }) => void;
    api.connectionStatus.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    const { events } = fakeEvents();
    const hook = renderHook(() => useConnection(api, events, true));
    expect(hook.result.current).toEqual({ status: 'connecting' });
    await act(async () => answer({ up: 2, total: 3, relays: [] }));
    expect(hook.result.current).toEqual({ status: 'connected', up: 2, total: 3 });
  });

  it('follows the events, and says offline once the connection it had is gone', async () => {
    const { emit, hook } = setup(true, { up: 3, total: 3 });
    await flush();
    expect(hook.result.current).toEqual({ status: 'connected', up: 3, total: 3 });
    act(() => emit.connectionChanged({ up: 1, total: 3, relays: [] }));
    expect(hook.result.current).toEqual({ status: 'connected', up: 1, total: 3 });
    act(() => emit.connectionChanged({ up: 0, total: 3, relays: [] }));
    expect(hook.result.current).toEqual({ status: 'offline', up: 0, total: 3 });
  });

  it('keeps saying connecting for a while at the start, then offline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { hook } = setup(true, { up: 0, total: 3 });
    await flush();
    expect(hook.result.current).toEqual({ status: 'connecting' });
    act(() => vi.advanceTimersByTime(CONNECTING_GRACE_MS));
    expect(hook.result.current).toEqual({ status: 'offline', up: 0, total: 3 });
  });

  it('is null when the backend cannot say', async () => {
    const api = fakeApi();
    api.connectionStatus.mockRejectedValueOnce(new Error('unknown command'));
    const { events } = fakeEvents();
    const hook = renderHook(() => useConnection(api, events, true));
    await flush();
    expect(hook.result.current).toBeNull();
  });

  it('stops listening when unmounted', async () => {
    const { listening, hook } = setup();
    await flush();
    expect(listening()).toBe(1);
    hook.unmount();
    await flush();
    expect(listening()).toBe(0);
  });
});
