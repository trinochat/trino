/**
 * The network's state, only from what the backend says: `net_status` at
 * first, then every `net-changed`. Null until it answers, when it cannot
 * say, or without the network (`api` null): the screens then show nothing
 * of Tor, never a made-up state.
 *
 * Every component that calls it with the same API shares one question and
 * one listener (feed.ts), and renders only for itself when the state
 * changes: the shell does not hold it (FIX-2).
 */
import { useSyncExternalStore } from 'react';
import type { NetStatus } from '../../lib/net';
import { backendFeed, feedsBy, NO_FEED } from './feed';
import type { NetScreensApi } from './net-api';

type NetStatusApi = Pick<NetScreensApi, 'status' | 'onNetChanged'>;

const feedOf = feedsBy((api: NetStatusApi) =>
  backendFeed<NetStatus>(
    () => api.status(),
    callback => api.onNetChanged(callback),
    'net_status failed',
  ),
);

export function useNetStatus(api: NetStatusApi | null): NetStatus | null {
  const feed = api ? feedOf(api) : NO_FEED;
  return useSyncExternalStore(feed.subscribe, feed.get);
}
