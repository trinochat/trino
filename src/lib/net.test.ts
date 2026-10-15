import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  netApi,
  onNetChanged,
  onUpdateChanged,
  type BlockKind,
  type BridgeChoice,
  type BridgesInfo,
  type NetStatus,
  type StartWhen,
  type TransportKind,
  type UpdateInfo,
} from './net';

// The wrappers are the contract with src-tauri (net_cmds.rs, commands.rs,
// bridges_cmds.rs, updater.rs): the command and event names, the argument
// keys, and the shapes serde gives NetStatus, BridgesInfo and UpdateInfo.
const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  listen: vi.fn(async (..._args: unknown[]) => () => {}),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen }));

beforeEach(() => {
  invoke.mockClear();
  listen.mockClear();
});

describe('the network commands', () => {
  it.each([
    ['status', () => netApi.status(), 'net_status', undefined],
    ['start', () => netApi.start(), 'net_start', undefined],
    ['retry', () => netApi.retry(), 'net_retry', undefined],
    // "Conectar sin protección" and "Volver a conectarse de forma privada" (TOR-6).
    ['connectWithoutTor', () => netApi.connectWithoutTor(), 'net_connect_without_tor', undefined],
    ['backToTor', () => netApi.backToTor(), 'net_back_to_tor', undefined],
    ['setStartOnUnlock', () => netApi.setStartOnUnlock(true), 'net_set_start_on_unlock', { on: true }],
    ['bridges', () => netApi.bridges(), 'net_bridges_get', undefined],
    ['tryBridge', () => netApi.tryBridge('snowflake'), 'net_bridges_try', { transport: 'snowflake' }],
    ['updateStatus', () => netApi.updateStatus(), 'update_status', undefined],
    ['setDailyUpdates', () => netApi.setDailyUpdates(false), 'update_set_daily', { on: false }],
    // A link in the browser, after its question (card 10; links_cmds.rs).
    ['openLink', () => netApi.openLink('https://example.org/', true, false), 'open_link', { url: 'https://example.org/', confirmed: true, dontAskAgain: false }],
  ] as const)('%s calls %s', async (_name, call, command, args) => {
    await call();
    expect(invoke.mock.calls).toEqual([args === undefined ? [command] : [command, args]]);
  });

  it.each<[BridgeChoice]>([
    [{ kind: 'none' }],
    [{ kind: 'builtin', transport: 'snowflake' }],
    [{ kind: 'private', text: 'obfs4 192.0.2.10:443 …' }],
  ])('setBridges sends the choice as bridges_cmds.rs reads it, %j', async choice => {
    await netApi.setBridges(choice);
    expect(invoke.mock.calls).toEqual([['net_bridges_set', { choice }]]);
  });

  it('hand back what the backend answers', async () => {
    const status: NetStatus = { state: 'starting', pct: 40 };
    invoke.mockResolvedValueOnce(status);
    await expect(netApi.status()).resolves.toEqual(status);
  });
});

describe('the network events', () => {
  it.each([
    ['onNetChanged', onNetChanged, 'net-changed', { state: 'blocked', kind: 'filtering', pct: 15 }],
    ['onUpdateChanged', onUpdateChanged, 'update-changed', { state: { state: 'idle' }, installed: '0.1.0', daily: true, freeze: null }],
  ])('%s listens to %s and hands over the payload', async (_name, subscribe, event, payload) => {
    const callback = vi.fn();
    await (subscribe as (cb: (p: unknown) => void) => Promise<unknown>)(callback);
    const [name, handler] = listen.mock.calls[0] as [string, (e: { payload: unknown }) => void];
    expect(name).toBe(event);
    handler({ payload });
    expect(callback).toHaveBeenCalledWith(payload);
  });
});

describe('the shapes serde gives them', () => {
  it('are a NetStatus tagged by state, as status.rs serializes it', () => {
    expectTypeOf<Extract<NetStatus, { state: 'starting' }>>().toEqualTypeOf<{ state: 'starting'; pct: number }>();
    expectTypeOf<Extract<NetStatus, { state: 'blocked' }>>().toEqualTypeOf<{ state: 'blocked'; kind: BlockKind; pct: number }>();
    expectTypeOf<Extract<NetStatus, { state: 'ready' }>>().toEqualTypeOf<{ state: 'ready'; transport: TransportKind }>();
    expectTypeOf<Extract<NetStatus, { state: 'obsolete' }>>().toEqualTypeOf<{ state: 'obsolete'; confirmed: boolean }>();
    expectTypeOf<NetStatus['state']>().toEqualTypeOf<
      'off' | 'starting' | 'ready' | 'blocked' | 'ptMissing' | 'obsolete' | 'direct'
    >();
    expectTypeOf<BlockKind>().toEqualTypeOf<
      'offline' | 'filtering' | 'cantReachTor' | 'clockSkewed' | 'cantBootstrap' | 'noProgress'
    >();
    expectTypeOf<TransportKind>().toEqualTypeOf<'none' | 'snowflake' | 'obfs4' | 'webtunnel' | 'meek'>();
    expectTypeOf<StartWhen>().toEqualTypeOf<'open' | 'on_unlock'>();
  });

  it('are the bridges and the updater as the UI gets them, never the lines', () => {
    expectTypeOf<BridgesInfo>().toEqualTypeOf<{
      transport: TransportKind;
      private: boolean | null;
      lines: number;
      start: StartWhen;
      program: boolean;
      builtin: TransportKind[];
    }>();
    expectTypeOf<UpdateInfo['daily']>().toEqualTypeOf<boolean>();
    expectTypeOf<UpdateInfo['installed']>().toEqualTypeOf<string>();
  });
});
