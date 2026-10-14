import { invoke } from '@tauri-apps/api/core';

/**
 * "Novedades de Trino": fetched from trinochat.org through Tor and verified in
 * Rust, with rPGP, against the "Trino Updates" key built into the program
 * (crates/trino-net/src/news, Tor design §7 and R-06). The WebView only paints
 * what the `news_fetch` command says is verified; it fetches nothing and
 * checks no signature itself.
 */
export interface Announcement {
  id: string;
  title: string;
  body: string;
  publishedAt: string;
  version?: string;
  url?: string;
}

/**
 * Why updates look frozen (Tor design §6.4), for the warning the UI will show
 * (TOR-9 and the mockups): the news name a version no mirror offers, the newest
 * feed is past its `validUntil`, or no current feed came for over 14 days.
 */
export type NewsFreeze =
  | { kind: 'notOffered'; latest: string }
  | { kind: 'expired'; days: number }
  | { kind: 'unchecked'; days: number };

export interface AnnouncementFeed {
  announcements: Announcement[];
  /**
   * - `verified`: signature checked in Rust against the PINNED signer key.
   * - `bundled`: no signed feed reachable (or no Tor) — normal, compile-time copy.
   * - `untrusted`: a feed WAS served but failed verification (bad signature,
   *   wrong signer, or a rollback). That is an attack indicator, not a missing
   *   file, and the UI must say so instead of silently showing stale content.
   */
  source: 'verified' | 'bundled' | 'untrusted';
  signerFingerprint?: string;
  /** The newest version the signed news have named on this device. */
  latest?: string;
  freeze?: NewsFreeze;
}

/** What `news_fetch` returns (trino_net::news::News). */
interface News {
  status: AnnouncementFeed['source'];
  items: Announcement[];
  signerFingerprint: string | null;
  latest: string | null;
  freeze: NewsFreeze | null;
}

export const BUNDLED_ANNOUNCEMENTS: Announcement[] = [
  {
    id: '2026-07-17-mobile-themes',
    title: 'Trino móvil estrena una interfaz más familiar',
    body:
      'La lista de chats, el compositor y las llamadas usan patrones móviles conocidos. También se agregaron estilos Trino, Corporativo y Simple con color de acento configurable.',
    publishedAt: '2026-07-17T09:30:00-05:00',
    version: '0.1.0',
  },
];

export async function loadAnnouncementFeed(): Promise<AnnouncementFeed> {
  let news: News;
  try {
    news = await invoke<News>('news_fetch');
  } catch (error) {
    console.warn('announcement feed unavailable, using bundled', error);
    return { announcements: BUNDLED_ANNOUNCEMENTS, source: 'bundled' };
  }
  const updates = {
    ...(news.latest ? { latest: news.latest } : {}),
    ...(news.freeze ? { freeze: news.freeze } : {}),
  };
  if (news.status === 'verified') {
    return {
      announcements: news.items,
      source: 'verified',
      ...(news.signerFingerprint ? { signerFingerprint: news.signerFingerprint } : {}),
      ...updates,
    };
  }
  // Only verified items are ever painted: otherwise the copy the app shipped.
  return {
    announcements: BUNDLED_ANNOUNCEMENTS,
    source: news.status === 'untrusted' ? 'untrusted' : 'bundled',
    ...updates,
  };
}
