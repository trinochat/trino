/**
 * The updater as the backend tells it: `update_status` at first, then every
 * `update-changed`. Null until it answers, when it cannot say, or without
 * the network (`api` null): nothing of updates shows then.
 */
import { useEffect, useState } from 'react';
import type { UpdateInfo } from '../../lib/net';
import { listenAll } from '../shell/listen';
import type { NetScreensApi } from './net-api';

export function useUpdateInfo(api: Pick<NetScreensApi, 'updateStatus' | 'onUpdateChanged'> | null): UpdateInfo | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    // An event says what changed after the question was asked: it wins.
    let heard = false;
    api.updateStatus().then(
      now => {
        if (active && !heard) setInfo(now);
      },
      error => console.error('update_status failed', error),
    );
    const stop = listenAll([
      api.onUpdateChanged(next => {
        if (!active) return;
        heard = true;
        setInfo(next);
      }),
    ]);
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  return api ? info : null;
}
