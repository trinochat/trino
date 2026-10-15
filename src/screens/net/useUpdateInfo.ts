/**
 * The updater as the backend tells it: `update_status` at first, then every
 * `update-changed`. Null until it answers, when it cannot say, or without
 * the network (`api` null): nothing of updates shows then.
 *
 * Every component that calls it with the same API shares one question and
 * one listener (feed.ts), and renders only for itself when it changes: the
 * shell does not hold it (FIX-2).
 */
import { useSyncExternalStore } from 'react';
import type { UpdateInfo } from '../../lib/net';
import { backendFeed, feedsBy, NO_FEED } from './feed';
import type { NetScreensApi } from './net-api';

type UpdateInfoApi = Pick<NetScreensApi, 'updateStatus' | 'onUpdateChanged'>;

const feedOf = feedsBy((api: UpdateInfoApi) =>
  backendFeed<UpdateInfo>(
    () => api.updateStatus(),
    callback => api.onUpdateChanged(callback),
    'update_status failed',
  ),
);

export function useUpdateInfo(api: UpdateInfoApi | null): UpdateInfo | null {
  const feed = api ? feedOf(api) : NO_FEED;
  return useSyncExternalStore(feed.subscribe, feed.get);
}
