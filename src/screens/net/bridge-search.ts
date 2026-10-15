/**
 * "Buscar una forma que funcione aquí" (PropTorSimple, card 4; Tor design
 * §5.3; TOR-8): the built-in ways in the backend's order, Snowflake then
 * obfs4, each through `net_bridges_try`, which keeps the kind once Tor is
 * ready through it. meek is not one of them (spike S3: Arti refuses its
 * line, which has no fingerprint), and moat, the Tor Project's automatic
 * answer for a country (§5.4), is not built: its query needs an
 * authorization of its own.
 *
 * It starts only from a tap, never changes the way by itself otherwise, and
 * never goes without Tor. A way counts as failed only once Tor started
 * through it and then said it is blocked; where another way would not help
 * (no internet, the clock, the antivirus, Arti too old) it stops and the
 * screens say why from the network's state.
 *
 * One search per network (`bridgeSearchOf`), outside React: it goes on when
 * the dialog or the screen that started it closes, and every screen sees
 * the same one.
 */
import type { NetStatus, TransportKind } from '../../lib/net';
import type { NetScreensApi } from './net-api';

export type SearchApi = Pick<NetScreensApi, 'bridges' | 'tryBridge' | 'onNetChanged'>;

/**
 * - idle: not started, or given way to the person's own choice;
 * - trying: through `transport`, the `step`th of `of` ways;
 * - found: Tor is ready through `transport`, which the backend kept;
 * - none: no way Trino carries connected here;
 * - stopped: another way would not help; the network's state says why;
 * - failed: it could not search (no bridge program, a connection code in
 *   use, or a command failed).
 */
export type SearchState =
  | { phase: 'idle' }
  | { phase: 'trying'; transport: TransportKind; step: number; of: number }
  | { phase: 'found'; transport: TransportKind }
  | { phase: 'none' }
  | { phase: 'stopped' }
  | { phase: 'failed' };

export interface BridgeSearch {
  get(): SearchState;
  /** Every change from now on. Returns the function that stops listening. */
  subscribe(cb: (state: SearchState) => void): () => void;
  /** Start, from a tap. Resolves once the first way is being tried, or it could not be. */
  start(): Promise<void>;
  /** Give way to a choice the person made: nothing more is tried. */
  cancel(): void;
}

const searches = new WeakMap<object, BridgeSearch>();

/** The search of this network: the same object for the same `api`. */
export function bridgeSearchOf(api: SearchApi): BridgeSearch {
  let search = searches.get(api);
  if (!search) {
    search = createBridgeSearch(api);
    searches.set(api, search);
  }
  return search;
}

/** Where another way would not help. */
function hopeless(status: NetStatus): boolean {
  return (
    status.state === 'ptMissing' ||
    status.state === 'obsolete' ||
    (status.state === 'blocked' && (status.kind === 'offline' || status.kind === 'clockSkewed'))
  );
}

function createBridgeSearch(api: SearchApi): BridgeSearch {
  let state: SearchState = { phase: 'idle' };
  const listeners = new Set<(state: SearchState) => void>();
  // Each run has its number: what an older one hears after it ended counts for nothing.
  let run = 0;
  let unlisten: (() => void) | null = null;

  const set = (next: SearchState) => {
    state = next;
    listeners.forEach(cb => cb(next));
  };

  const end = (next: SearchState) => {
    run += 1;
    unlisten?.();
    unlisten = null;
    set(next);
  };

  const begin = async () => {
    const mine = ++run;
    let order: TransportKind[] = [];
    let index = 0;
    // Whether `net_bridges_try` answered for the way being tried, and
    // whether Tor stopped or started for it since the tap: until both, a
    // failure heard is the old start's.
    let armed = false;
    let started = false;

    const tryAt = async (at: number) => {
      index = at;
      armed = false;
      started = false;
      set({ phase: 'trying', transport: order[at]!, step: at + 1, of: order.length });
      try {
        const now = await api.tryBridge(order[at]!);
        if (mine !== run) return;
        armed = true;
        hear(now);
      } catch (error) {
        console.error('net_bridges_try failed', error);
        if (mine === run) end({ phase: 'failed' });
      }
    };

    const hear = (status: NetStatus) => {
      if (mine !== run) return;
      if (status.state === 'direct') return end({ phase: 'idle' });
      // Tor stopped for this way, or started through it.
      if (status.state === 'off' || status.state === 'starting') {
        started = true;
        return;
      }
      if (!armed && !started) return;
      if (status.state === 'ready') {
        return end({ phase: 'found', transport: status.transport === 'none' ? order[index]! : status.transport });
      }
      if (!armed || !started) return;
      if (hopeless(status)) return end({ phase: 'stopped' });
      if (status.state === 'blocked') {
        if (index + 1 < order.length) void tryAt(index + 1);
        else end({ phase: 'none' });
      }
    };

    try {
      const info = await api.bridges();
      if (mine !== run) return;
      order = info.builtin;
      if (!info.program || info.private === true || order.length === 0) return end({ phase: 'failed' });
      const stop = await api.onNetChanged(hear);
      if (mine !== run) return stop();
      unlisten = stop;
    } catch (error) {
      console.error('the bridge search could not start', error);
      if (mine === run) end({ phase: 'failed' });
      return;
    }
    await tryAt(0);
  };

  let starting: Promise<void> | null = null;

  return {
    get: () => state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start() {
      if (starting) return starting;
      if (state.phase === 'trying') return Promise.resolve();
      starting = begin().finally(() => {
        starting = null;
      });
      return starting;
    },
    cancel() {
      if (state.phase === 'idle' && !unlisten && !starting) return;
      end({ phase: 'idle' });
    },
  };
}
