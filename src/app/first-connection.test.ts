import { describe, expect, it, vi } from 'vitest';
import type { BridgesSet, NetStatus } from '../lib/net';
import { startFirstConnection, HIDDEN_WAY } from './first-connection';

// The first run's "Conexión" step (TOR-6, card 1): the choice first, then
// Tor, in that order, so the first connection already goes the chosen way.
function fakeNet(saved = true) {
  const calls: string[] = [];
  const net = {
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

describe('startFirstConnection', () => {
  it('goes straight to Tor, saying so before it starts', async () => {
    const { net, calls } = fakeNet();
    await startFirstConnection(net, false);
    expect(calls).toEqual(['setBridges {"kind":"none"}', 'start']);
  });

  it('goes through a built-in bridge, Snowflake, when the provider must not notice', async () => {
    const { net, calls } = fakeNet();
    await startFirstConnection(net, true);
    expect(HIDDEN_WAY).toBe('snowflake');
    expect(calls).toEqual(['setBridges {"kind":"builtin","transport":"snowflake"}', 'start']);
  });

  it('never starts Tor some other way than the one chosen', async () => {
    const { net, calls } = fakeNet(false);
    await expect(startFirstConnection(net, true)).rejects.toThrow();
    expect(calls).toEqual(['setBridges {"kind":"builtin","transport":"snowflake"}']);

    const refusing = fakeNet();
    refusing.net.setBridges.mockRejectedValueOnce(new Error('this build has no bridge program'));
    await expect(startFirstConnection(refusing.net, true)).rejects.toThrow();
    expect(refusing.net.start).not.toHaveBeenCalled();
  });
});
