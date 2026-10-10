/**
 * A conversation and its key, for maps of drafts, unread counts and messages.
 * A contact's key is its handle and a group's is `grp:<gid>`, as in the
 * history the backend returns; the announcements channel is `channel`.
 */
export type ConvoRef = { kind: 'contact'; handle: string } | { kind: 'group'; gid: string } | { kind: 'channel' };

const GROUP_PREFIX = 'grp:';
const CHANNEL_KEY = 'channel';

export function convoKey(ref: ConvoRef): string {
  switch (ref.kind) {
    case 'contact':
      return ref.handle;
    case 'group':
      return GROUP_PREFIX + ref.gid;
    case 'channel':
      return CHANNEL_KEY;
  }
}

/**
 * The conversation of a key from `convoKey`. Handles are not restricted, so a
 * contact named `channel` or `grp:…` reads as the channel or a group: the same
 * limit the history keys of the backend have.
 */
export function parseConvoKey(key: string): ConvoRef {
  if (key === CHANNEL_KEY) return { kind: 'channel' };
  if (key.startsWith(GROUP_PREFIX)) return { kind: 'group', gid: key.slice(GROUP_PREFIX.length) };
  return { kind: 'contact', handle: key };
}
