/**
 * Unread count of a chat: the number, plus a suffix such as "sin leer" that
 * only screen readers read. Nothing at zero.
 */
import { cx } from '../cx';

export interface UnreadBadgeProps {
  count: number;
  /** Read after the number by screen readers, such as "sin leer". */
  label: string;
  /** Larger counts show as "99+". Default 99. */
  max?: number;
  className?: string;
}

export function UnreadBadge({ count, label, max = 99, className }: UnreadBadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span
      className={cx(
        'inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-ui-badge px-1.5 text-[12px] font-bold leading-none text-ui-badge-ink',
        className,
      )}
    >
      {count > max ? `${max}+` : count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}
