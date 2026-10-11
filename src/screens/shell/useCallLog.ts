/**
 * The call log of the Calls tab (K13): the backend's list, then each call
 * that ends (`call-logged`), the newest first. "Llamadas · N" counts the
 * missed calls that started after the log was last seen
 * (`trino.pref.callsSeenAt`); a call that arrives while the log is on screen
 * and the window has the focus is seen already, so N does not grow.
 *
 * A call lives in its contact's chat history, so it leaves the log when it
 * leaves there: with the chat's disappearing messages, on the shell's
 * cleanup clock (`now`), and with the contact when it is removed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addCall,
  fromLog,
  missedUnseen,
  renamePeer,
  sortCalls,
  withoutExpired,
  withoutPeer,
  type LoggedCall,
} from '../inbox/call-history-model';
import { listenAll, nowSeconds } from './listen';
import type { ShellApi, ShellEvents, ShellPrefs } from './shell-api';

export interface CallLogOptions {
  api: Pick<ShellApi, 'listCallHistory'>;
  events: Pick<ShellEvents, 'onCallLogged'>;
  prefs: Pick<ShellPrefs, 'getCallsSeenAt' | 'setCallsSeenAt'>;
  /** The backend records calls (K13); without it there is no log to show. */
  enabled: boolean;
  /** The log is on screen and the window has the focus. */
  watching(): boolean;
  /**
   * Epoch seconds of the shell's cleanup of disappearing messages, every
   * 10 s: a call whose time ran out by then is gone from its chat, and here.
   */
  now: number;
}

export function useCallLog(options: CallLogOptions) {
  const latest = useRef(options);
  latest.current = options;
  const [entries, setEntries] = useState<readonly LoggedCall[]>([]);
  const [seenAt, setSeenAt] = useState(() => options.prefs.getCallsSeenAt());
  const seenRef = useRef(seenAt);

  /** The log was seen up to `ts` (epoch seconds); it never goes back. */
  const markSeen = useCallback((ts: number) => {
    if (!(ts > seenRef.current)) return;
    seenRef.current = ts;
    latest.current.prefs.setCallsSeenAt(ts);
    setSeenAt(ts);
  }, []);

  const reload = useCallback(async () => {
    if (!latest.current.enabled) return;
    try {
      const list = await latest.current.api.listCallHistory();
      setEntries(sortCalls(list.map(fromLog)));
    } catch (error) {
      console.error('listCallHistory failed', error);
    }
  }, []);

  useEffect(() => {
    if (!options.enabled) return;
    void reload();
    return listenAll([
      latest.current.events.onCallLogged(wire => {
        const entry = fromLog(wire);
        setEntries(current => addCall(current, entry));
        if (latest.current.watching()) markSeen(Math.max(nowSeconds(), entry.ts));
      }),
    ]);
  }, [options.enabled, reload, markSeen]);

  const renamed = useCallback((from: string, to: string) => setEntries(current => renamePeer(current, from, to)), []);
  /** A contact was removed: the backend deleted its history, and its calls with it. */
  const removed = useCallback((handle: string) => setEntries(current => withoutPeer(current, handle)), []);

  const { now } = options;
  const live = useMemo(() => withoutExpired(entries, now), [entries, now]);
  return {
    entries: live,
    seenAt,
    missedUnseen: useMemo(() => missedUnseen(live, seenAt), [live, seenAt]),
    markSeen,
    renamed,
    removed,
    reload,
  };
}
