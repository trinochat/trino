/**
 * The official channel, "Novedades de Trino" (Main:140-142, 247-249): the
 * team's announcements as messages of their day, the newest at the end, and
 * no composer: "Solo el equipo de Trino publica en este canal."
 *
 * It keeps the trust line of the feed, an honest state (plan §1.2): signed
 * by the team, or the copy that came with this version. A feed that failed
 * its signature is an attack sign, not a missing file (announcements.ts),
 * so it is an alert. "Sin leer" marks where the news after `lastReadId`
 * start. Links open in the system browser through `onOpenLink`.
 */
import { ArrowLeft, Bell, BellOff, ExternalLink, PackageCheck } from 'lucide-react';
import { useId, useMemo } from 'react';
import type { Announcement } from '../../lib/announcements';
import { clockTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Avatar, Banner, DaySeparator, FOCUS_RING_INSET, IconButton, MessageBubble, TrustBadge, cx, iconSize } from '../../ui';
import type { ChannelViewProps, Msg } from '../types';
import { BUBBLE_RING } from './bubble-ring';
import { withDaySeparators } from './day';
import { Linkify } from './Linkify';
import { useStickyScroll } from './use-sticky-scroll';

/** When an announcement was published, in epoch seconds like `Msg.ts`; 0 when its date cannot be read. */
function publishedTs(announcement: Announcement): number {
  const ms = Date.parse(announcement.publishedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/** One announcement: an incoming bubble with its title, its text, its version and its link. */
function AnnouncementBubble({ announcement, ts, onOpenLink }: { announcement: Announcement; ts: number; onOpenLink(url: string): void }) {
  const t = useT();
  const { lang } = useLang();
  const { url, version } = announcement;
  return (
    <div data-announcement={announcement.id}>
      <MessageBubble direction="in" time={clockTime(ts, lang)}>
        <p className="text-ui-base font-bold [overflow-wrap:anywhere]">{announcement.title}</p>
        <p className="whitespace-pre-wrap text-ui-base [overflow-wrap:anywhere]">
          <Linkify text={announcement.body} onOpenLink={onOpenLink} />
        </p>
        {(version || url) && (
          <div className="flex flex-wrap items-center gap-x-3 text-ui-sm">
            {version && <span className="text-ui-muted">{t('channel.version', { version })}</span>}
            {url && (
              <button
                type="button"
                onClick={() => onOpenLink(url)}
                className={cx('inline-flex min-h-11 items-center gap-1.5 rounded-ui font-semibold underline', BUBBLE_RING)}
              >
                <ExternalLink {...iconSize('sm', 'shrink-0')} aria-hidden="true" />
                {t('channel.open')}
              </button>
            )}
          </div>
        )}
      </MessageBubble>
    </div>
  );
}

export function ChannelView({ announcements, source, lastReadId, muted, onToggleMuted, onOpenLink, onBack, now }: ChannelViewProps) {
  const t = useT();
  const { lang } = useLang();
  const headingId = useId();

  // The log orders and separates messages; an announcement takes its place by its date.
  const { items, byId } = useMemo(() => {
    const byId = new Map(announcements.map(announcement => [announcement.id, announcement]));
    const asMessages: Msg[] = announcements.map(announcement => ({
      key: announcement.id,
      side: 'them',
      ts: publishedTs(announcement),
    }));
    return { items: withDaySeparators(asMessages, now, lang, t), byId };
  }, [announcements, now, lang, t]);

  const ordered = items.flatMap(item => (item.type === 'msg' ? [item.msg.key] : []));
  const read = lastReadId === null ? -1 : ordered.indexOf(lastReadId);
  const firstUnread = read >= 0 ? ordered[read + 1] : undefined;
  const scroll = useStickyScroll(ordered[ordered.length - 1], false);

  return (
    <section aria-labelledby={headingId} className="flex h-full min-h-0 min-w-0 flex-col bg-ui-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-ui-line px-4 py-3">
        {onBack && <IconButton aria-label={t('common2.back')} icon={<ArrowLeft {...iconSize('lg')} />} onClick={onBack} />}
        <Avatar initials="T" size={44} />
        <div className="flex min-w-0 flex-[1_1_12.5rem] flex-col gap-0.5">
          <h1 id={headingId} className="font-ui-display text-[1.125rem] font-bold leading-tight [overflow-wrap:anywhere]">
            {t('channel.title')}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ui-md text-ui-muted">
            <span>{t('channel.subtitle')}</span>
            {source === 'verified' && <TrustBadge kind="verified" label={t('channel.verified')} />}
            {source === 'bundled' && (
              <span className="inline-flex items-center gap-1">
                <PackageCheck {...iconSize('md', 'shrink-0')} aria-hidden="true" />
                {t('channel.bundled')}
              </span>
            )}
          </div>
        </div>
        <IconButton
          aria-label={t('channel.mute')}
          pressed={muted}
          icon={muted ? <BellOff {...iconSize('lg')} /> : <Bell {...iconSize('lg')} />}
          onClick={onToggleMuted}
        />
      </header>
      {source === 'untrusted' && (
        <Banner tone="danger" className="mx-4 mt-3">
          {t('channel.untrusted')}
        </Banner>
      )}
      <div
        ref={scroll.ref}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={t('channel.log')}
        tabIndex={0}
        onScroll={scroll.onScroll}
        className={cx('flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4', FOCUS_RING_INSET)}
      >
        {items.length === 0 && <p className="m-auto text-center text-ui-md text-ui-muted">{t('channel.empty')}</p>}
        {items.map(item => {
          if (item.type === 'day') return <DaySeparator key={item.key} label={item.label} />;
          const announcement = byId.get(item.msg.key);
          if (!announcement) return null;
          const bubble = (
            <AnnouncementBubble key={item.msg.key} announcement={announcement} ts={item.msg.ts} onOpenLink={onOpenLink} />
          );
          if (item.msg.key !== firstUnread) return bubble;
          return [
            <p key="unread" className="flex items-center gap-3 text-ui-xs font-semibold text-ui-accent-text">
              <span aria-hidden="true" className="h-px flex-1 bg-ui-line" />
              {t('channel.unread')}
              <span aria-hidden="true" className="h-px flex-1 bg-ui-line" />
            </p>,
            bubble,
          ];
        })}
      </div>
      <p className="border-t border-ui-line px-4 py-3.5 text-center text-ui-md text-ui-muted">{t('channel.readOnly')}</p>
    </section>
  );
}
