/**
 * One message of a conversation. Incoming and outgoing bubbles have their own
 * tokens, and yours follow the accent. The text keeps its line breaks, since
 * the composer sends Shift+Enter newlines. Under a failed message, a row says
 * so and holds the screen's retry button.
 */
import type { ReactNode } from 'react';
import { cx } from '../cx';
import { StatusTicks, type MessageStatus } from './StatusTicks';

export interface MessageBubbleProps {
  /** `in`: from someone else; `out`: yours. */
  direction: 'in' | 'out';
  /** The message text; its line breaks are kept. */
  text?: string;
  /** Author's name in a group; incoming messages only. */
  sender?: string;
  /** Time as the screen formats it, such as "10:42". */
  time: string;
  /** Delivery state of your message, with its screen-reader text. */
  status?: { state: MessageStatus; label: string };
  /** Row under a failed message: what happened, and the screen's retry button. */
  failure?: { text: string; retry?: ReactNode };
  /** Attachments (pictures, files, stickers), above the text. */
  children?: ReactNode;
  className?: string;
}

const DIRECTIONS = {
  in: {
    align: 'items-start',
    bubble: 'border-ui-bubble-in-line bg-ui-bubble-in text-ui-bubble-in-ink',
    meta: 'text-ui-muted',
  },
  out: {
    align: 'items-end',
    bubble: 'border-ui-bubble-me-line bg-ui-bubble-me text-ui-bubble-me-ink',
    meta: 'text-ui-bubble-me-muted',
  },
} as const;

export function MessageBubble({ direction, text, sender, time, status, failure, children, className }: MessageBubbleProps) {
  const look = DIRECTIONS[direction];
  return (
    <div className={cx('flex flex-col gap-1', look.align, className)}>
      <div
        data-direction={direction}
        className={cx('flex max-w-[min(72%,520px)] flex-col gap-1 rounded-ui-bubble border px-3 py-2', look.bubble)}
      >
        {/* accent-text is checked on the incoming bubble only (contrast.test.ts). */}
        {direction === 'in' && sender && <span className="text-[13px] font-bold text-ui-accent-text">{sender}</span>}
        {children}
        {text && <p className="whitespace-pre-wrap break-words text-[15px] leading-[1.45]">{text}</p>}
        <div data-meta="" className={cx('flex items-center justify-end gap-[5px] font-ui-mono text-[12px]', look.meta)}>
          {time}
          {status && (
            <>
              {' '}
              <StatusTicks state={status.state} label={status.label} />
            </>
          )}
        </div>
      </div>
      {status?.state === 'failed' && failure && (
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          <span className="font-semibold text-ui-danger">{failure.text}</span>
          {failure.retry}
        </div>
      )}
    </div>
  );
}
