/**
 * A fake of the network for the screens' tests: every command a vi.fn with
 * a sensible answer, and `emit` to send `net-changed` and `update-changed`
 * as the backend would. Test-only.
 */
import { vi } from 'vitest';
import type { BridgeChoice, BridgesChecked, BridgesInfo, BridgesSet, NetStatus, UpdateInfo } from '../../lib/net';
import type { NetScreensApi } from './net-api';

export const READY: NetStatus = { state: 'ready', transport: 'none' };

export const BRIDGES: BridgesInfo = {
  transport: 'none',
  private: false,
  lines: 0,
  start: 'open',
  program: true,
  builtin: ['snowflake', 'obfs4'],
};

export const UPDATES: UpdateInfo = { state: { state: 'idle' }, installed: '0.1.0', daily: true, freeze: null };

export function fakeNet(status: NetStatus = READY) {
  const netListeners = new Set<(status: NetStatus) => void>();
  const updateListeners = new Set<(info: UpdateInfo) => void>();
  const api = {
    status: vi.fn(async () => status),
    retry: vi.fn(async (): Promise<NetStatus> => ({ state: 'starting', pct: 0 })),
    bridges: vi.fn(async () => BRIDGES),
    tryBridge: vi.fn(async (): Promise<NetStatus> => ({ state: 'starting', pct: 0 })),
    setBridges: vi.fn(async (_choice: BridgeChoice): Promise<BridgesSet> => ({ saved: true, errors: [], status })),
    checkBridges: vi.fn(async (_text: string): Promise<BridgesChecked> => ({ lines: 1, errors: [] })),
    connectWithoutTor: vi.fn(async (): Promise<NetStatus> => ({ state: 'direct' })),
    backToTor: vi.fn(async () => READY),
    setStartOnUnlock: vi.fn(async (on: boolean): Promise<BridgesInfo> => ({ ...BRIDGES, start: on ? 'on_unlock' : 'open' })),
    updateStatus: vi.fn(async () => UPDATES),
    setDailyUpdates: vi.fn(async (on: boolean): Promise<UpdateInfo> => ({ ...UPDATES, daily: on })),
    checkUpdateNow: vi.fn(async (): Promise<UpdateInfo> => ({ ...UPDATES, state: { state: 'checking' } })),
    installUpdate: vi.fn(async () => UPDATES),
    checkUpdateWithoutTor: vi.fn(async (): Promise<UpdateInfo> => ({ ...UPDATES, state: { state: 'checking' } })),
    onNetChanged: vi.fn(async (cb: (status: NetStatus) => void) => {
      netListeners.add(cb);
      return () => netListeners.delete(cb);
    }),
    onUpdateChanged: vi.fn(async (cb: (info: UpdateInfo) => void) => {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    }),
  } satisfies NetScreensApi;
  const emit = {
    net: (next: NetStatus) => netListeners.forEach(cb => cb(next)),
    update: (next: UpdateInfo) => updateListeners.forEach(cb => cb(next)),
  };
  return { api, emit, listening: () => netListeners.size };
}
