/**
 * A group's own settings on this device: whether it is muted (a local mark
 * that silences its sound and notifications, plan §1.4) and how long your
 * new messages in it last. Both live in src/lib/prefs.ts, under the keys the
 * chat already reads: `trino.pref.groupMuted:<gid>` and `ttl:grp:<gid>`.
 */
import { convoKey } from '../../lib/convo';
import { prefs as devicePrefs, type Prefs } from '../../lib/prefs';

/** The times the chats offer for disappearing messages, in seconds; 0 is off. */
export const GROUP_TTL_OPTIONS = [0, 30, 300, 3600, 86400, 604800] as const;

export interface GroupPrefs {
  isMuted(gid: string): boolean;
  setMuted(gid: string, muted: boolean): boolean;
  /** Seconds after which your new messages in the group disappear; 0 is off. */
  getTtl(gid: string): number;
  setTtl(gid: string, seconds: number): boolean;
  /** A group you just created or joined starts muted when Settings says new groups do. */
  applyDefaults(gid: string): void;
}

/** The group settings over `prefs`, this device's by default. */
export function groupPrefs(prefs: Prefs = devicePrefs): GroupPrefs {
  const ttlKey = (gid: string) => convoKey({ kind: 'group', gid });
  return {
    isMuted: gid => prefs.getGroupMuted(gid),
    setMuted: (gid, muted) => prefs.setGroupMuted(gid, muted),
    getTtl: gid => prefs.getTtl(ttlKey(gid)),
    setTtl: (gid, seconds) => prefs.setTtl(ttlKey(gid), seconds),
    applyDefaults: gid => {
      if (prefs.getMuteGroupsByDefault()) prefs.setGroupMuted(gid, true);
    },
  };
}
