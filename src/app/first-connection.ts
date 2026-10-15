/**
 * The first run's "Conexión" step (TOR-6, PropTorSimple card 1; Tor design
 * §9.2): the way in is kept first, then Tor starts, so its first connection
 * already goes the chosen way. "No quiero que mi proveedor note que uso
 * Trino" is the built-in Snowflake bridge (§5.1: it looks least like Tor of
 * the built-ins; the backend's first to try). If the choice is not kept,
 * Tor does not start: never some other way than the one chosen.
 */
import type { NetApi, TransportKind } from '../lib/net';

/** The built-in bridge of "No quiero que mi proveedor note que uso Trino". */
export const HIDDEN_WAY: TransportKind = 'snowflake';

export async function startFirstConnection(net: Pick<NetApi, 'setBridges' | 'start'>, hidden: boolean): Promise<void> {
  const kept = await net.setBridges(hidden ? { kind: 'builtin', transport: HIDDEN_WAY } : { kind: 'none' });
  if (!kept.saved) throw new Error('the way to connect was not kept');
  await net.start();
}
