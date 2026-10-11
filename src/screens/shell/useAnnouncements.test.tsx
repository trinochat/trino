// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_ANNOUNCEMENTS, type Announcement, type AnnouncementFeed } from '../../lib/announcements';
import { fakePrefs } from './test-fakes';
import { useAnnouncements } from './useAnnouncements';

afterEach(cleanup);

const flush = () => act(async () => {});

const post = (id: string, publishedAt: string): Announcement => ({ id, title: `Post ${id}`, body: '…', publishedAt });

describe('useAnnouncements', () => {
  it('starts with the bundled posts, then shows the feed, oldest first, with its source', async () => {
    let answer!: (feed: AnnouncementFeed) => void;
    const { prefs } = fakePrefs();
    const hook = renderHook(() => useAnnouncements(() => new Promise(resolve => (answer = resolve)), prefs));
    expect(hook.result.current.announcements).toEqual(BUNDLED_ANNOUNCEMENTS);
    expect(hook.result.current.source).toBe('bundled');
    await act(async () =>
      answer({ announcements: [post('b', '2026-10-02T10:00:00Z'), post('a', '2026-10-01T10:00:00Z')], source: 'verified' }),
    );
    expect(hook.result.current.announcements.map(a => a.id)).toEqual(['a', 'b']);
    expect(hook.result.current.latest?.id).toBe('b');
    expect(hook.result.current.source).toBe('verified');
  });

  it('counts the latest post as unread until the channel is opened, and the view still knows what was new', async () => {
    const { prefs, storage } = fakePrefs({ 'updates.lastRead': 'a' });
    const feed = { announcements: [post('a', '2026-10-01T10:00:00Z'), post('b', '2026-10-02T10:00:00Z')], source: 'verified' } as const;
    const hook = renderHook(() => useAnnouncements(async () => ({ ...feed, announcements: [...feed.announcements] }), prefs));
    await flush();
    expect(hook.result.current.unread).toBe(1);
    act(() => hook.result.current.opened());
    expect(hook.result.current.unread).toBe(0);
    expect(storage.data.get('updates.lastRead')).toBe('b');
    // What was read before opening, so the channel can mark what is new.
    expect(hook.result.current.lastReadId).toBe('a');
  });

  it('mutes and unmutes the channel, and remembers it', async () => {
    const { prefs, storage } = fakePrefs();
    const hook = renderHook(() => useAnnouncements(async () => ({ announcements: [], source: 'bundled' }), prefs));
    await flush();
    expect(hook.result.current.muted).toBe(false);
    act(() => hook.result.current.toggleMuted());
    expect(hook.result.current.muted).toBe(true);
    expect(storage.data.get('updates.muted')).toBe('1');
  });
});
