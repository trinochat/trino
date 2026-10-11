/**
 * How many people who are not in your contacts tried to write in this
 * session. The backend drops their message and only says `handshake-needed`
 * with their key, so this is all Trino can tell (plan §1.2): Contacts shows
 * it honestly, and nothing is kept after locking.
 */
import { useEffect, useState } from 'react';
import { listenAll } from './listen';
import type { ShellEvents } from './shell-api';

export function useStrangerAttempts(events: Pick<ShellEvents, 'onHandshakeNeeded'>): number {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(
    () =>
      listenAll([
        events.onHandshakeNeeded(({ from_pubkey }) =>
          setKeys(current => (current.has(from_pubkey) ? current : new Set(current).add(from_pubkey))),
        ),
      ]),
    // The backend is the app's for as long as the shell lives.
    [],
  );
  return keys.size;
}
