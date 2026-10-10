import { describe, expect, it } from 'vitest';
import { convoKey, parseConvoKey, type ConvoRef } from './convo';

// One key per conversation, for maps of drafts, unread counts and messages.
// Groups use `grp:<gid>`, as the history from the backend and App.tsx do.
describe('convoKey', () => {
  it('is the handle for a contact, grp:<gid> for a group and channel for the channel', () => {
    expect(convoKey({ kind: 'contact', handle: 'Ana Torres' })).toBe('Ana Torres');
    expect(convoKey({ kind: 'group', gid: '9f3a' })).toBe('grp:9f3a');
    expect(convoKey({ kind: 'channel' })).toBe('channel');
  });
});

describe('parseConvoKey', () => {
  it('turns every key back into its conversation', () => {
    const refs: ConvoRef[] = [
      { kind: 'contact', handle: 'Ana Torres' },
      { kind: 'contact', handle: 'María 🐦' },
      { kind: 'group', gid: '9f3a' },
      { kind: 'channel' },
    ];
    for (const ref of refs) expect(parseConvoKey(convoKey(ref))).toEqual(ref);
  });

  it('reads any other key as a contact handle', () => {
    expect(parseConvoKey('grp')).toEqual({ kind: 'contact', handle: 'grp' });
    expect(parseConvoKey('Channel')).toEqual({ kind: 'contact', handle: 'Channel' });
  });

  it('keeps everything after grp: as the group id', () => {
    expect(parseConvoKey('grp:a:b')).toEqual({ kind: 'group', gid: 'a:b' });
  });
});
