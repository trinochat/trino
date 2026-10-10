/**
 * A chat in the inbox, as one button: avatar, name, trust, a one-line preview
 * (with the draft prefix), time and unread count. The selected chat carries
 * aria-current, the accent tint and an accent bar on its leading edge, drawn
 * as a border so forced colours keep it.
 */
import { cx } from '../cx';
import { FOCUS_RING_INSET } from '../focus';
import { Avatar, type AvatarProps } from './Avatar';
import { TrustBadge, type TrustKind } from './TrustBadge';
import { UnreadBadge } from './UnreadBadge';

export interface ChatRowProps {
  name: string;
  /** Drawn at 44 px, as decoration beside the name. */
  avatar: Omit<AvatarProps, 'size' | 'alt' | 'className'>;
  /** Last message or the draft, cut to one line. */
  preview?: string;
  /** Before the preview when it is a draft, such as "Borrador:". */
  draftPrefix?: string;
  /** Time or day of the last message, as the screen formats it. */
  time?: string;
  /**
   * Unread count and its screen-reader suffix ("sin leer"); nothing shows at
   * 0. A muted chat's count is an outline, not a fill.
   */
  unread?: { count: number; label: string; muted?: boolean };
  /** Compact trust badge after the name, such as verified. */
  trust?: { kind: TrustKind; label: string };
  selected?: boolean;
  onClick: () => void;
  className?: string;
}

export function ChatRow({
  name,
  avatar,
  preview,
  draftPrefix,
  time,
  unread,
  trust,
  selected = false,
  onClick,
  className,
}: ChatRowProps) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      className={cx(
        'relative flex min-h-16 w-full items-center gap-3 rounded-ui p-2.5 text-left text-ui-ink',
        // `raised` almost matches the sidebar in Terminal light, so the
        // selection uses the accent tint plus a bar that keeps 3:1.
        selected ? 'bg-ui-accent-soft' : 'hover:bg-ui-raised',
        FOCUS_RING_INSET,
        className,
      )}
    >
      {selected && (
        <span
          data-selection-bar
          aria-hidden="true"
          className="absolute inset-y-2 left-0 rounded-full border-s-[3px] border-ui-accent-text"
        />
      )}
      <Avatar {...avatar} size={44} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-semibold">
          <span className="truncate">{name}</span>
          {/* The spaces keep words apart in the button's accessible name; flex layout ignores them. */}
          {trust && (
            <>
              {' '}
              <TrustBadge kind={trust.kind} label={trust.label} compact />
            </>
          )}
        </span>
        {(preview || draftPrefix) && (
          <span className="truncate text-ui-md text-ui-muted">
            {draftPrefix && (
              <>
                <span className="font-semibold text-ui-accent-text">{draftPrefix}</span>{' '}
              </>
            )}
            {preview}
          </span>
        )}
      </span>
      {(time || unread) && (
        <span className="flex shrink-0 flex-col items-end gap-1.5">
          {time && (
            <>
              {' '}
              <span className="font-ui-mono text-ui-xs text-ui-muted">{time}</span>
            </>
          )}
          {unread && (
            <>
              {' '}
              <UnreadBadge count={unread.count} label={unread.label} variant={unread.muted ? 'muted' : 'default'} />
            </>
          )}
        </span>
      )}
    </button>
  );
}
