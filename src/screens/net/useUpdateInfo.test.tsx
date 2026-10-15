// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeNet, UPDATES } from './test-support';
import { useUpdateInfo } from './useUpdateInfo';

afterEach(cleanup);

const flush = () => act(async () => {});

// FIX-2: the inbox's notice and "Trino necesita actualizarse" follow the
// updater themselves, sharing one question and one listener.
describe('useUpdateInfo', () => {
  it('is null until the backend answers, then follows update-changed', async () => {
    const { api, emit } = fakeNet();
    const hook = renderHook(() => useUpdateInfo(api));
    expect(hook.result.current).toBeNull();
    await flush();
    expect(hook.result.current).toEqual(UPDATES);
    const ready = { ...UPDATES, state: { state: 'ready' as const, version: '0.2.0' } };
    act(() => emit.update(ready));
    expect(hook.result.current).toEqual(ready);
  });

  it('asks once for every component that follows it, and the later one gets it at once', async () => {
    const { api } = fakeNet();
    renderHook(() => useUpdateInfo(api));
    await flush();
    const later = renderHook(() => useUpdateInfo(api));
    expect(later.result.current).toEqual(UPDATES);
    expect(api.updateStatus).toHaveBeenCalledTimes(1);
    expect(api.onUpdateChanged).toHaveBeenCalledTimes(1);
  });

  it('stays null when the backend cannot say, and without the network', async () => {
    const { api } = fakeNet();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.updateStatus.mockRejectedValueOnce(new Error('no backend'));
    const hook = renderHook(() => useUpdateInfo(api));
    const none = renderHook(() => useUpdateInfo(null));
    await flush();
    expect(hook.result.current).toBeNull();
    expect(none.result.current).toBeNull();
    expect(error).toHaveBeenCalledWith('update_status failed', expect.any(Error));
    error.mockRestore();
  });
});
