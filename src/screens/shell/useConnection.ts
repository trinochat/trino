/**
 * The connection chip's state (Main:73-76), only from what the backend says
 * (K3): `connection_status` at first, then `connection-changed`. Never a
 * fixed "connected", as App.tsx had, and nothing about Tor, which the app
 * does not have.
 *
 * With no relay up, it says "Conectando…" for a while after unlocking, when
 * the relays are still answering, and "Sin conexión · reintentando" once
 * that time passed or after the connection it had was lost (the backend
 * keeps retrying, K3). Null hides the chip: without the capability, or when
 * the backend cannot say.
 */
import { useEffect, useState } from 'react';
import type { ConnectionStatus } from '../../lib/api';
import type { Connection } from '../types';
import { listenAll } from './listen';
import type { ShellApi, ShellEvents } from './shell-api';

/** How long after unlocking no relay up still reads as connecting, in ms. */
export const CONNECTING_GRACE_MS = 15_000;

export function useConnection(
  api: Pick<ShellApi, 'connectionStatus'>,
  events: Pick<ShellEvents, 'onConnectionChanged'>,
  enabled: boolean,
): Connection | null {
  const [last, setLast] = useState<Pick<ConnectionStatus, 'up' | 'total'> | null>(null);
  const [failed, setFailed] = useState(false);
  const [wasUp, setWasUp] = useState(false);
  const [graceOver, setGraceOver] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const take = ({ up, total }: ConnectionStatus) => {
      if (!active) return;
      setLast({ up, total });
      if (up > 0) setWasUp(true);
    };
    api.connectionStatus().then(take, error => {
      console.error('connectionStatus failed', error);
      if (active) setFailed(true);
    });
    const stop = listenAll([events.onConnectionChanged(take)]);
    const grace = setTimeout(() => {
      if (active) setGraceOver(true);
    }, CONNECTING_GRACE_MS);
    return () => {
      active = false;
      stop();
      clearTimeout(grace);
    };
    // The backend is the app's for as long as the shell lives.
  }, [enabled]);

  if (!enabled || failed) return null;
  if (!last) return { status: 'connecting' };
  if (last.up > 0) return { status: 'connected', up: last.up, total: last.total };
  return wasUp || graceOver ? { status: 'offline', up: 0, total: last.total } : { status: 'connecting' };
}
