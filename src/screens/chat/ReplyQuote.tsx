/**
 * The message a reply quotes, at the top of its bubble: who wrote it and the
 * start of it, behind a bar at the start edge. In your bubble the quote takes
 * its own ink (`bubbleMeInk`, `bubbleMeMuted`); in theirs, the accent marks
 * the author, as it marks a group member's name.
 */
import { cx } from '../../ui';

export interface ReplyQuoteProps {
  author: string;
  preview: string;
  /** In your own bubble. */
  mine: boolean;
}

export function ReplyQuote({ author, preview, mine }: ReplyQuoteProps) {
  return (
    <div
      data-reply-quote=""
      className={cx('flex min-w-0 flex-col border-s-2 ps-2 text-ui-sm', mine ? 'border-ui-bubble-me-muted' : 'border-ui-accent-text')}
    >
      <span className={cx('font-semibold [overflow-wrap:anywhere]', mine ? 'text-ui-bubble-me-ink' : 'text-ui-accent-text')}>
        {author}
      </span>
      <span className={cx('line-clamp-2 [overflow-wrap:anywhere]', mine ? 'text-ui-bubble-me-muted' : 'text-ui-muted')}>
        {preview}
      </span>
    </div>
  );
}
