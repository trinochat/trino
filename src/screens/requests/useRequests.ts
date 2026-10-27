/**
 * Solicitudes as the shell holds them (uso responsable UR-4): read once the
 * shell opens, and again each time the backend says their count changed
 * (`requests-changed`, which carries nothing else). Nothing here rings or
 * notifies: the row above the chats only changes its number.
 *
 * Without the backend for it (`api` null: no capability, or a test that
 * leaves it out) there are none, and nothing is asked.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RequestView } from '../../lib/api';
import { listenAll } from '../shell/listen';
import type { RequestsApi } from './requests-api';

export interface Requests {
  /** The latest first. */
  requests: readonly RequestView[];
  /** How many did not fit in their source's quota. */
  overflow: number;
  /** The account is of 16 or 17 (UR-10): only its links' redemptions come. */
  onlyLinks: boolean;
  /** The last reading failed. */
  failed: boolean;
  /** Reads them again; resolves once it is done, whatever came of it. */
  refresh(): Promise<void>;
}

const NONE: readonly RequestView[] = [];

export function useRequests(api: RequestsApi | null): Requests {
  const [requests, setRequests] = useState<readonly RequestView[]>(NONE);
  const [overflow, setOverflow] = useState(0);
  const [onlyLinks, setOnlyLinks] = useState(false);
  const [failed, setFailed] = useState(false);
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(async () => {
    const current = apiRef.current;
    if (!current) return;
    try {
      const view = await current.listRequests();
      setRequests(view.requests);
      setOverflow(view.overflow);
      setOnlyLinks(view.only_links === true);
      setFailed(false);
    } catch (error) {
      console.error('listRequests failed', error);
      setFailed(true);
    }
  }, []);

  const present = api !== null;
  useEffect(() => {
    const current = apiRef.current;
    if (!current) return;
    void refresh();
    return listenAll([current.onRequestsChanged(() => void refresh())]);
  }, [present, refresh]);

  return { requests, overflow, onlyLinks, failed, refresh };
}
