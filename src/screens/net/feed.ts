/**
 * A value the backend keeps, shared by every component that shows it: the
 * first one to subscribe asks for it and listens to its event; the last one
 * to go stops listening and forgets it. Each component then renders only for
 * itself as the value changes, and one that comes later gets the value at
 * once, without asking the backend again (FIX-2: before this, the whole shell
 * held Tor's state and the updater's and rendered again on each event).
 */
import { listenAll } from '../shell/listen';

export interface Feed<T> {
  /** For useSyncExternalStore: the same function for as long as the feed lives. */
  subscribe(listener: () => void): () => void;
  /** Null until the backend answers, when it cannot say, or with nobody subscribed. */
  get(): T | null;
}

/**
 * A feed of `load` at first, then of every `listen` event. An event says
 * what changed after the question was asked: it wins over the answer.
 */
export function backendFeed<T>(
  load: () => Promise<T>,
  listen: (callback: (next: T) => void) => Promise<() => void>,
  failure: string,
): Feed<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  let stop: (() => void) | null = null;
  const set = (next: T) => {
    value = next;
    for (const listener of [...listeners]) listener();
  };
  const start = () => {
    let active = true;
    let heard = false;
    load().then(
      now => {
        if (active && !heard) set(now);
      },
      error => console.error(failure, error),
    );
    const unlisten = listenAll([
      listen(next => {
        if (!active) return;
        heard = true;
        set(next);
      }),
    ]);
    stop = () => {
      active = false;
      unlisten();
      value = null;
    };
  };
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stop?.();
        stop = null;
      };
    },
  };
}

/** Without the network: nothing, ever. */
export const NO_FEED: Feed<never> = { subscribe: () => () => {}, get: () => null };

/** One feed per object of the API, made the first time it is asked for. */
export function feedsBy<A extends object, T>(make: (api: A) => Feed<T>): (api: A) => Feed<T> {
  const feeds = new WeakMap<A, Feed<T>>();
  return api => {
    let feed = feeds.get(api);
    if (!feed) {
      feed = make(api);
      feeds.set(api, feed);
    }
    return feed;
  };
}
