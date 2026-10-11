/**
 * The group invitations waiting for an answer. They can arrive before the
 * shell listens (the catch-up after unlocking), so the list is asked for as
 * well. Nothing is joined until the person accepts, in Contacts.
 */
import { useCallback, useEffect, useState } from 'react';
import type { GroupInvite } from '../../lib/api';
import { listenAll } from './listen';
import type { ShellApi, ShellEvents } from './shell-api';

export function useInvites(api: Pick<ShellApi, 'listGroupInvites'>, events: Pick<ShellEvents, 'onGroupInvite'>) {
  const [invites, setInvites] = useState<readonly GroupInvite[]>([]);

  const refresh = useCallback(async () => {
    try {
      setInvites(await api.listGroupInvites());
    } catch (error) {
      console.error('listGroupInvites failed', error);
    }
    // The backend is the app's for as long as the shell lives.
  }, []);

  useEffect(() => {
    void refresh();
    return listenAll([
      events.onGroupInvite(invite =>
        setInvites(current => {
          const index = current.findIndex(other => other.gid === invite.gid);
          return index < 0 ? [...current, invite] : current.map((other, i) => (i === index ? invite : other));
        }),
      ),
    ]);
  }, [refresh]);

  return { invites, refresh };
}
