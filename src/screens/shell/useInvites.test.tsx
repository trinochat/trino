// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { GroupInvite } from '../../lib/api';
import { fakeApi, fakeEvents } from './test-fakes';
import { useInvites } from './useInvites';

afterEach(cleanup);

const invite = (gid: string, name: string): GroupInvite => ({
  gid,
  name,
  from_handle: 'Ana',
  member_count: 3,
  received_at: 1_760_000_000,
});

describe('useInvites', () => {
  it('lists the pending invitations, adds new ones once, and reads them again on demand', async () => {
    const api = fakeApi();
    api.listGroupInvites.mockResolvedValueOnce([invite('g1', 'Familia')]);
    const { events, emit } = fakeEvents();
    const hook = renderHook(() => useInvites(api, events));
    await waitFor(() => expect(hook.result.current.invites).toHaveLength(1));

    act(() => emit.groupInvite(invite('g2', 'Trabajo')));
    act(() => emit.groupInvite(invite('g2', 'Trabajo (nuevo nombre)')));
    expect(hook.result.current.invites.map(i => i.name)).toEqual(['Familia', 'Trabajo (nuevo nombre)']);

    api.listGroupInvites.mockResolvedValueOnce([]);
    await act(() => hook.result.current.refresh());
    expect(hook.result.current.invites).toEqual([]);
  });
});
