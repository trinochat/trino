/**
 * The network's state, only from what the backend says: `net_status` at
 * first, then every `net-changed`. Null until it answers, when it cannot
 * say, or without the network (`api` null): the screens then show nothing
 * of Tor, never a made-up state.
 */
import { useEffect, useState } from 'react';
import type { NetStatus } from '../../lib/net';
import { listenAll } from '../shell/listen';
import type { NetScreensApi } from './net-api';

export function useNetStatus(api: Pick<NetScreensApi, 'status' | 'onNetChanged'> | null): NetStatus | null {
  const [status, setStatus] = useState<NetStatus | null>(null);

  useEffect(() => {
    if (!api) return;
    let active = true;
    // An event says what changed after the question was asked: it wins.
    let heard = false;
    api.status().then(
      now => {
        if (active && !heard) setStatus(now);
      },
      error => console.error('net_status failed', error),
    );
    const stop = listenAll([
      api.onNetChanged(next => {
        if (!active) return;
        heard = true;
        setStatus(next);
      }),
    ]);
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  return api ? status : null;
}
