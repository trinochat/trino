import { describe, expect, it, vi } from 'vitest';
import type { BridgesInfo, BridgesSet, FirstWay, NetStatus } from '../lib/net';
import type { SearchState } from '../screens/net/bridge-search';
import { startFirstConnection } from './first-connection';

// The first run's "Conexión" step (TOR-6, card 1; TOR-8, card 4): the
// choice first, then Tor, in that order, so the first connection already
// goes the chosen way, and never some other way.
const INFO: BridgesInfo = {
  transport: 'none',
  private: null,
  lines: 0,
  start: 'open',
  program: true,
  builtin: ['snowflake', 'obfs4'],
};

function fakeNet(saved = true, info: BridgesInfo = INFO) {
  const calls: string[] = [];
  const net = {
    bridges: vi.fn(async (): Promise<BridgesInfo> => info),
    setBridges: vi.fn(async (choice: unknown): Promise<BridgesSet> => {
      calls.push(`setBridges ${JSON.stringify(choice)}`);
      return { saved, errors: [], status: { state: 'off' } };
    }),
    start: vi.fn(async (): Promise<NetStatus> => {
      calls.push('start');
      return { state: 'starting', pct: 0 };
    }),
  };
  return { net, calls };
}

function fakeSearch(after: SearchState = { phase: 'trying', transport: 'snowflake', step: 1, of: 2 }, calls: string[] = []) {
  let state: SearchState = { phase: 'idle' };
  return {
    start: vi.fn(async () => {
      calls.push('search');
      state = after;
    }),
    get: () => state,
  };
}

describe('startFirstConnection', () => {
  it('goes straight to Tor, saying so before it starts', async () => {
    const { net, calls } = fakeNet();
    await startFirstConnection(net, { kind: 'none' }, fakeSearch());
    expect(calls).toEqual(['setBridges {"kind":"none"}', 'start']);
  });

  it.each<[FirstWay]>([[{ kind: 'builtin', transport: 'snowflake' }], [{ kind: 'builtin', transport: 'obfs4' }]])(
    'goes through the built-in way chosen, %j',
    async way => {
      const { net, calls } = fakeNet();
      await startFirstConnection(net, way, fakeSearch());
      expect(calls).toEqual([`setBridges ${JSON.stringify(way)}`, 'start']);
    },
  );

  it('goes through the code pasted on card 4, which the backend already holds', async () => {
    const { net, calls } = fakeNet(true, { ...INFO, transport: 'obfs4', private: true, lines: 1, start: 'on_unlock' });
    await startFirstConnection(net, { kind: 'private' }, fakeSearch());
    expect(calls).toEqual(['start']);

    // Not there: Tor does not start some other way.
    const lost = fakeNet();
    await expect(startFirstConnection(lost.net, { kind: 'private' }, fakeSearch())).rejects.toThrow();
    expect(lost.calls).toEqual([]);
  });

  it('starts the search of the built-in ways, which starts Tor through the first', async () => {
    const { net, calls } = fakeNet();
    const search = fakeSearch(undefined, calls);
    await startFirstConnection(net, { kind: 'search' }, search);
    expect(calls).toEqual(['search']);

    // Over a pasted code, which the search never goes over: the code is left first.
    const coded = fakeNet(true, { ...INFO, transport: 'obfs4', private: true, lines: 1, start: 'on_unlock' });
    await startFirstConnection(coded.net, { kind: 'search' }, fakeSearch(undefined, coded.calls));
    expect(coded.calls).toEqual(['setBridges {"kind":"none"}', 'search']);

    // It could not search: say so, nothing else starts.
    const refused = fakeNet();
    await expect(startFirstConnection(refused.net, { kind: 'search' }, fakeSearch({ phase: 'failed' }))).rejects.toThrow();
    expect(refused.net.start).not.toHaveBeenCalled();
  });

  it('never starts Tor some other way than the one chosen', async () => {
    const { net, calls } = fakeNet(false);
    await expect(startFirstConnection(net, { kind: 'builtin', transport: 'snowflake' }, fakeSearch())).rejects.toThrow();
    expect(calls).toEqual(['setBridges {"kind":"builtin","transport":"snowflake"}']);

    const refusing = fakeNet();
    refusing.net.setBridges.mockRejectedValueOnce(new Error('this build has no bridge program'));
    await expect(startFirstConnection(refusing.net, { kind: 'builtin', transport: 'snowflake' }, fakeSearch())).rejects.toThrow();
    expect(refusing.net.start).not.toHaveBeenCalled();
  });
});
