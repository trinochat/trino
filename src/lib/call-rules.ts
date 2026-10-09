// call-rules.ts — pure decisions behind the call state machine in call.ts.
// Kept free of WebRTC and Tauri so they can be tested on their own.

export type CallState =
  | 'idle'
  | 'starting' // we pressed "call" and are acquiring the microphone
  | 'ringing-out' // we called, waiting for them
  | 'ringing-in' // they called, waiting for us
  | 'connecting'
  | 'connected'
  | 'rejected' // they declined our outgoing call
  | 'ended';

/** A call is in progress: a new one must not start, the vault must not auto-lock. */
export function isBusy(state: CallState): boolean {
  return (
    state === 'starting' ||
    state === 'ringing-out' ||
    state === 'ringing-in' ||
    state === 'connecting' ||
    state === 'connected'
  );
}

/**
 * The microphone or camera may be open. Ringing-in is busy but holds no
 * media: nothing is captured until the user accepts.
 */
export function holdsMedia(state: CallState): boolean {
  return isBusy(state) && state !== 'ringing-in';
}

/** Answers, candidates, bye, reject and renegotiation must come from the peer of this call. */
export function signalBelongsToCall(
  current: { callId: string | null; peer: string | null },
  from: string,
  callId: string,
): boolean {
  return current.callId !== null && current.peer !== null && current.callId === callId && current.peer === from;
}

/** A bounded set that forgets the oldest entry first. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.ids.size;
  }

  add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.add(id);
    while (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}

/**
 * Both people called each other at once. Each device keeps the call with the
 * lower id, so they agree without another round trip.
 */
export function resolveGlare(ours: string, theirs: string): 'ours' | 'theirs' {
  return ours < theirs ? 'ours' : 'theirs';
}

export interface OfferContext {
  state: CallState;
  peer: string | null;
  callId: string | null;
  /** We placed the current call. */
  outgoing: boolean;
  /** The current call's media path is up. */
  connected: boolean;
  from: string;
  offerCallId: string;
  /** The offer's call already ended (its bye or our reject came first). */
  alreadyEnded: boolean;
}

export type OfferDecision =
  | 'ignore' // stale or duplicate: do nothing
  | 'ring'
  | 'busy' // decline it
  | 'replace' // same peer called again: drop the stale call and ring
  | 'glare-keep-ours' // ignore theirs; they will hang up theirs and accept ours
  | 'glare-take-theirs'; // hang up ours and accept theirs

/** What to do with a new (non-renegotiation) offer. */
export function decideIncomingOffer(ctx: OfferContext): OfferDecision {
  if (ctx.alreadyEnded || ctx.offerCallId === ctx.callId) return 'ignore';
  if (!isBusy(ctx.state)) return 'ring';
  if (ctx.from !== ctx.peer) return 'busy';
  if (ctx.outgoing && (ctx.state === 'starting' || ctx.state === 'ringing-out')) {
    return resolveGlare(ctx.callId ?? '', ctx.offerCallId) === 'ours'
      ? 'glare-keep-ours'
      : 'glare-take-theirs';
  }
  return ctx.connected ? 'busy' : 'replace';
}

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Keep the well-formed STUN/TURN entries from the backend's configuration.
 * An empty result is valid and means "no STUN": there is no fallback list in
 * the frontend; the backend (`default_call_ice_servers`) is the only source.
 */
export function sanitizeIceServers(servers: unknown): IceServerConfig[] {
  if (!Array.isArray(servers)) return [];
  return servers.filter((server): server is IceServerConfig => {
    if (typeof server !== 'object' || server === null) return false;
    const urls: unknown = (server as { urls?: unknown }).urls;
    const list = Array.isArray(urls) ? urls : [urls];
    return (
      list.length > 0 &&
      list.every(url => typeof url === 'string' && /^(stun|stuns|turn|turns):/i.test(url))
    );
  });
}
