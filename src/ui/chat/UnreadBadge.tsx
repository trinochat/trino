/**
 * Unread count of a chat: the number, plus a suffix such as "sin leer" that
 * only screen readers read. Nothing at zero. A muted chat's count is an
 * outline in `muted` around a muted number, not a grey fill, so "muted" is
 * told by shape and not by colour alone; `muted` reaches 4.5:1, where the
 * decorative `line` would leave the outline invisible.
 */
import { cx } from '../cx';

export type UnreadBadgeVariant = 'default' | 'muted';

const VARIANTS: Record<UnreadBadgeVariant, string> = {
  default: 'bg-ui-badge text-ui-badge-ink',
  muted: 'border border-ui-muted bg-transparent text-ui-muted',
};

export interface UnreadBadgeProps {
  count: number;
  /** Read after the number by screen readers, such as "sin leer". */
  label: string;
  /** Larger counts show as "99+". Default 99. */
  max?: number;
  /** `muted` for a muted chat. Default `default`. */
  variant?: UnreadBadgeVariant;
  className?: string;
}

export function UnreadBadge({ count, label, max = 99, variant = 'default', className }: UnreadBadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span
      className={cx(
        'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-ui-xs font-bold leading-none',
        VARIANTS[variant],
        className,
      )}
    >
      {count > max ? `${max}+` : count}
      <span className="sr-only"> {label}</span>
    </span>
  );
}
