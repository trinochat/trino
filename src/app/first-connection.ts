/**
 * The first run's "Conexión" step (TOR-6, PropTorSimple card 1; TOR-8,
 * card 4; Tor design §9.2): the way in is kept first, then Tor starts, so
 * its first connection already goes the chosen way.
 *
 * - none, or a built-in way ("No quiero que mi proveedor note que uso
 *   Trino" is Snowflake, the backend's first to try): kept with
 *   net_bridges_set, then net_start;
 * - a code pasted on card 4: the backend holds its lines already (in
 *   memory until the account is made, then sealed): net_start, once the
 *   backend says it has them;
 * - the search of the built-in ways (bridge-search.ts): it starts Tor itself
 *   through the first, and goes on while the account is made.
 *
 * If the choice is not kept, Tor does not start: never some other way than
 * the one chosen.
 */
import type { FirstWay, NetApi } from '../lib/net';
import type { BridgeSearch } from '../screens/net/bridge-search';

export async function startFirstConnection(
  net: Pick<NetApi, 'bridges' | 'setBridges' | 'start'>,
  way: FirstWay,
  search: Pick<BridgeSearch, 'start' | 'get'>,
): Promise<void> {
  const keep = async (choice: Parameters<NetApi['setBridges']>[0]) => {
    const kept = await net.setBridges(choice);
    if (!kept.saved) throw new Error('the way to connect was not kept');
  };
  switch (way.kind) {
    case 'private':
      if ((await net.bridges()).private !== true) throw new Error('the connection code is not there');
      break;
    case 'search':
      // The search never goes over a code: one pasted before is left first.
      if ((await net.bridges()).private === true) await keep({ kind: 'none' });
      await search.start();
      if (search.get().phase === 'failed') throw new Error('the search could not start');
      return;
    default:
      await keep(way);
  }
  await net.start();
}
