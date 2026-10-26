/**
 * Fakes for the tests of Solicitudes and of the shell. Not part of the app:
 * only test files import this module.
 */
import { vi } from 'vitest';
import type { RequestView, RequestsChangedEvent, RequestsView } from '../../lib/api';
import type { RequestsApi } from './requests-api';

export const T0 = 1_760_000_000;

/** A request by @name from "ana", one text; `over` changes what a test needs. */
export function request(over: Partial<RequestView> = {}): RequestView {
  return {
    key: 'ab'.repeat(32),
    name: 'ana',
    by_admin: false,
    fingerprint: '70A583C6' + '0'.repeat(56),
    via: { kind: 'name' },
    received_at: T0,
    last_at: T0,
    items: [{ kind: 'text', text: 'Hola, soy Ana, la del taller de cerámica', at: T0 }],
    dropped: 0,
    looks_like: null,
    ...over,
  };
}

/** The requests' API, answering with `view`; `emit` fires `requests-changed`. */
export function fakeRequestsApi(view: RequestsView = { requests: [], overflow: 0 }) {
  const listeners = new Set<(event: RequestsChangedEvent) => void>();
  const api = {
    listRequests: vi.fn(async () => view),
    acceptRequest: vi.fn(async (_key: string) => ({ handle: 'ana' })),
    deleteRequest: vi.fn(async (_key: string) => {}),
    onRequestsChanged: vi.fn(async (cb: (event: RequestsChangedEvent) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
  } satisfies RequestsApi;
  const emit = (event: RequestsChangedEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { api, emit, listening: () => listeners.size };
}
