/**
 * The announcements channel ("Novedades de Trino"): the posts that came with
 * the app, then the signed feed if it verifies (lib/announcements), oldest
 * first. The latest post is unread until the channel is opened; muting and
 * what was read are kept as before (`updates.muted`, `updates.lastRead`).
 */
import { useEffect, useMemo, useState } from 'react';
import { BUNDLED_ANNOUNCEMENTS, type AnnouncementFeed } from '../../lib/announcements';
import type { ShellPrefs } from './shell-api';

type ChannelPrefs = Pick<ShellPrefs, 'getUpdatesMuted' | 'setUpdatesMuted' | 'getUpdatesLastRead' | 'setUpdatesLastRead'>;

export function useAnnouncements(loadFeed: () => Promise<AnnouncementFeed>, prefs: ChannelPrefs) {
  const [feed, setFeed] = useState<AnnouncementFeed>({ announcements: BUNDLED_ANNOUNCEMENTS, source: 'bundled' });
  const [muted, setMuted] = useState(() => prefs.getUpdatesMuted());
  const [lastRead, setLastRead] = useState(() => prefs.getUpdatesLastRead());
  /** What had been read when the channel was last opened, so the view can mark what is new. */
  const [readBeforeOpening, setReadBeforeOpening] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadFeed()
      .then(next => {
        if (active) setFeed(next);
      })
      .catch(error => console.error('loading the announcements failed', error));
    return () => {
      active = false;
    };
    // Read once per unlock, as before.
  }, []);

  const announcements = useMemo(
    () => [...feed.announcements].sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt)),
    [feed],
  );
  const latest = announcements.length > 0 ? announcements[announcements.length - 1] : undefined;

  return {
    announcements,
    source: feed.source,
    latest,
    unread: latest && latest.id !== lastRead ? 1 : 0,
    muted,
    lastReadId: readBeforeOpening,
    /** The channel was opened: its latest post is read now. */
    opened() {
      setReadBeforeOpening(lastRead || null);
      if (latest && latest.id !== lastRead) {
        prefs.setUpdatesLastRead(latest.id);
        setLastRead(latest.id);
      }
    },
    toggleMuted() {
      prefs.setUpdatesMuted(!muted);
      setMuted(!muted);
    },
  };
}
