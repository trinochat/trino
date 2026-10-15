import { describe, expect, it, vi } from 'vitest';
import type { NetStatus } from '../../lib/net';
import { bridgeSearchOf, type SearchState } from './bridge-search';
import { BRIDGES, fakeNet, READY } from './test-support';

// "Buscar una forma que funcione aquí" (PropTorSimple, card 4; Tor design
// §5.3, spike S3): the built-in ways in the backend's order, Snowflake then
// obfs4 (meek dropped: Arti refuses its line), each until Tor is ready
// through it or gives up on it, and never without a tap. Moat is not built.
const BLOCKED: NetStatus = { state: 'blocked', kind: 'filtering', pct: 15 };
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(status: NetStatus = BLOCKED) {
  const fake = fakeNet(status);
  const search = bridgeSearchOf(fake.api);
  const seen: SearchState[] = [];
  search.subscribe(state => seen.push(state));
  return { ...fake, search, seen };
}

describe('the bridge search', () => {
  it('is one per network, so every screen sees the same search', () => {
    const { api, search } = setup();
    expect(bridgeSearchOf(api)).toBe(search);
    expect(bridgeSearchOf(fakeNet().api)).not.toBe(search);
    expect(search.get()).toEqual({ phase: 'idle' });
  });

  it('tries Snowflake first and stops there once Tor is ready through it', async () => {
    const { api, emit, search } = setup();
    await search.start();
    expect(api.tryBridge.mock.calls).toEqual([['snowflake']]);
    expect(search.get()).toEqual({ phase: 'trying', transport: 'snowflake', step: 1, of: 2 });
    emit.net({ state: 'starting', pct: 30 });
    emit.net({ state: 'ready', transport: 'snowflake' });
    expect(search.get()).toEqual({ phase: 'found', transport: 'snowflake' });
    expect(api.tryBridge).toHaveBeenCalledTimes(1);
  });

  it('goes on to obfs4 when Snowflake does not connect either, and says when none did', async () => {
    const { api, emit, search } = setup();
    await search.start();
    emit.net({ state: 'starting', pct: 5 });
    emit.net({ state: 'blocked', kind: 'noProgress', pct: 5 });
    await flush();
    expect(api.tryBridge.mock.calls).toEqual([['snowflake'], ['obfs4']]);
    expect(search.get()).toEqual({ phase: 'trying', transport: 'obfs4', step: 2, of: 2 });
    emit.net({ state: 'starting', pct: 10 });
    emit.net({ state: 'blocked', kind: 'cantReachTor', pct: 10 });
    await flush();
    expect(search.get()).toEqual({ phase: 'none' });
    expect(api.tryBridge).toHaveBeenCalledTimes(2);
    expect(api.connectWithoutTor).not.toHaveBeenCalled();
  });

  it('takes no failure for that way before Tor started through it', async () => {
    const { api, emit, search } = setup();
    // What the old start said, heard before the answer and before Tor stopped for this way.
    api.tryBridge.mockImplementationOnce(async () => {
      emit.net(BLOCKED);
      return BLOCKED;
    });
    await search.start();
    await flush();
    expect(api.tryBridge).toHaveBeenCalledTimes(1);
    expect(search.get()).toMatchObject({ phase: 'trying', transport: 'snowflake' });
  });

  it('stops without trying more where another way would not help', async () => {
    for (const status of [
      { state: 'blocked', kind: 'offline', pct: 0 },
      { state: 'blocked', kind: 'clockSkewed', pct: 50 },
      { state: 'ptMissing' },
      { state: 'obsolete', confirmed: true },
    ] satisfies NetStatus[]) {
      const { api, emit, search } = setup();
      await search.start();
      emit.net({ state: 'starting', pct: 5 });
      emit.net(status);
      await flush();
      expect(search.get(), status.state).toEqual({ phase: 'stopped' });
      expect(api.tryBridge).toHaveBeenCalledTimes(1);
    }
  });

  it('gives way to "Conectar sin protección" and to a choice the person makes', async () => {
    const direct = setup();
    await direct.search.start();
    direct.emit.net({ state: 'direct' });
    expect(direct.search.get()).toEqual({ phase: 'idle' });

    const chosen = setup();
    await chosen.search.start();
    chosen.search.cancel();
    expect(chosen.search.get()).toEqual({ phase: 'idle' });
    chosen.emit.net({ state: 'starting', pct: 5 });
    chosen.emit.net({ state: 'blocked', kind: 'noProgress', pct: 5 });
    await flush();
    expect(chosen.api.tryBridge).toHaveBeenCalledTimes(1);
    expect(chosen.listening()).toBe(0);
  });

  it('runs once at a time', async () => {
    const { api, search } = setup();
    await Promise.all([search.start(), search.start()]);
    expect(api.tryBridge).toHaveBeenCalledTimes(1);
  });

  it('cannot run without the bridge program, over a connection code, or when a command fails', async () => {
    const noProgram = setup();
    noProgram.api.bridges.mockResolvedValue({ ...BRIDGES, program: false });
    await noProgram.search.start();
    expect(noProgram.search.get()).toEqual({ phase: 'failed' });
    expect(noProgram.api.tryBridge).not.toHaveBeenCalled();

    const code = setup();
    code.api.bridges.mockResolvedValue({ ...BRIDGES, transport: 'obfs4', private: true, lines: 2, start: 'on_unlock' });
    await code.search.start();
    expect(code.search.get()).toEqual({ phase: 'failed' });
    expect(code.api.tryBridge).not.toHaveBeenCalled();

    const refused = setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    refused.api.tryBridge.mockRejectedValueOnce(new Error('not a bridge to try'));
    await refused.search.start();
    expect(refused.search.get()).toEqual({ phase: 'failed' });
    expect(refused.listening()).toBe(0);
    error.mockRestore();
  });

  it('can start again after it ended', async () => {
    const { api, emit, search, seen } = setup();
    await search.start();
    emit.net({ state: 'starting', pct: 5 });
    emit.net(READY);
    await search.start();
    expect(api.tryBridge).toHaveBeenCalledTimes(2);
    expect(seen.map(state => state.phase)).toEqual(['trying', 'found', 'trying']);
  });
});
