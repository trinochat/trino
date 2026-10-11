/**
 * The message a reply quotes, at the top of its bubble: who wrote it and the
 * start of it, behind a bar at the start edge. In your bubble the quote takes
 * its own ink (`bubbleMeInk`, `bubbleMeMuted`); in theirs, the accent marks
 * the author, as it marks a group member's name.
 *
 * It is a quote to screen readers too: a blockquote that starts with "En
 * respuesta a Ana Torres:" (or "a tu mensaje"), which they read in place of
 * the visible name, so a reply that quotes the contact never sounds as if
 * the contact had said it.
 */
import { useT } from '../../lib/i18n';
import { cx } from '../../ui';

export interface ReplyQuoteProps {
  author: string;
  preview: string;
  /** In your own bubble. */
  mine: boolean;
  /** The quoted message is yours. */
  yours?: boolean;
}

export function ReplyQuote({ author, preview, mine, yours = false }: ReplyQuoteProps) {
  const t = useT();
  return (
    <blockquote
      data-reply-quote=""
      className={cx('flex min-w-0 flex-col border-s-2 ps-2 text-ui-sm', mine ? 'border-ui-bubble-me-muted' : 'border-ui-accent-text')}
    >
      <span className="sr-only">{yours ? t('msg2.inReplyToYours') : t('msg2.inReplyTo', { author })}</span>
      <span
        aria-hidden="true"
        className={cx('font-semibold [overflow-wrap:anywhere]', mine ? 'text-ui-bubble-me-ink' : 'text-ui-accent-text')}
      >
        {author}
      </span>
      <span className={cx('line-clamp-2 [overflow-wrap:anywhere]', mine ? 'text-ui-bubble-me-muted' : 'text-ui-muted')}>
        {preview}
      </span>
    </blockquote>
  );
}
