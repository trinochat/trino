// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmergencyAlertEvent, EmergencyAlerts } from '../lib/api';
import { useEmergencyAlerts, type EmergencyAlertsBackend } from './emergency-alerts';

afterEach(cleanup);

function backend(first: EmergencyAlerts) {
  let alerts = first;
  let heard: ((event: EmergencyAlertEvent) => void) | null = null;
  const fake = {
    emergencyAlerts: vi.fn(async () => alerts),
    answerEmergencyAlert: vi.fn(async (handle: string) => {
      alerts = { ...alerts, asks: alerts.asks.filter(ask => ask !== handle) };
    }),
    onEmergencyAlert: vi.fn(async (cb: (event: EmergencyAlertEvent) => void) => {
      heard = cb;
      return () => {
        heard = null;
      };
    }),
  } satisfies EmergencyAlertsBackend;
  const set = (next: EmergencyAlerts) => {
    alerts = next;
  };
  const emit = (event: EmergencyAlertEvent) => act(async () => heard?.(event));
  return { fake, set, emit, listening: () => heard !== null };
}

const ana = { kind: 'contact' as const, handle: 'Ana' };

// The chats' side of the warning (CE-6): what each chat with a contact gets.
describe('useEmergencyAlerts', () => {
  it('gives a chat its question and its warning, and nothing to a group', async () => {
    const { fake } = backend({ asks: ['Ana'], warnings: [{ handle: 'Bea', at: 10, sent: 7, message: 'hola' }] });
    const { result } = renderHook(() => useEmergencyAlerts(fake, vi.fn()));
    await waitFor(() => expect(result.current(ana).onEmergencyAnswer).toBeTypeOf('function'));
    expect(result.current(ana).emergencyWarning).toBeUndefined();
    expect(result.current({ kind: 'contact', handle: 'Bea' })).toEqual({ emergencyWarning: { at: 10, sent: 7, message: 'hola' } });
    expect(result.current({ kind: 'group', gid: 'g1' })).toEqual({});
  });

  it('sends the answer and reads again, so the question goes', async () => {
    const { fake } = backend({ asks: ['Ana'], warnings: [] });
    const { result } = renderHook(() => useEmergencyAlerts(fake, vi.fn()));
    await waitFor(() => expect(result.current(ana).onEmergencyAnswer).toBeTypeOf('function'));
    await act(async () => result.current(ana).onEmergencyAnswer!(true));
    expect(fake.answerEmergencyAlert).toHaveBeenCalledWith('Ana', true);
    expect(result.current(ana).onEmergencyAnswer).toBeUndefined();
  });

  it('reads again on each event, and tells of a warning that came', async () => {
    const { fake, set, emit } = backend({ asks: [], warnings: [] });
    const onWarned = vi.fn();
    const { result } = renderHook(() => useEmergencyAlerts(fake, onWarned));
    await waitFor(() => expect(fake.onEmergencyAlert).toHaveBeenCalled());
    set({ asks: ['Ana'], warnings: [] });
    await emit({ handle: 'Ana', what: 'asked' });
    await waitFor(() => expect(result.current(ana).onEmergencyAnswer).toBeTypeOf('function'));
    expect(onWarned).not.toHaveBeenCalled();
    set({ asks: [], warnings: [{ handle: 'Ana', at: 20, sent: null, message: '' }] });
    await emit({ handle: 'Ana', what: 'warned' });
    expect(onWarned).toHaveBeenCalledWith('Ana');
    await waitFor(() => expect(result.current(ana).emergencyWarning).toEqual({ at: 20, sent: null, message: '' }));
  });

  it('stops listening when it goes, and does nothing without a backend', async () => {
    const { fake, listening } = backend({ asks: [], warnings: [] });
    const { unmount } = renderHook(() => useEmergencyAlerts(fake, vi.fn()));
    await waitFor(() => expect(listening()).toBe(true));
    unmount();
    expect(listening()).toBe(false);
    const none = renderHook(() => useEmergencyAlerts(null, vi.fn()));
    expect(none.result.current(ana)).toEqual({});
  });
});
