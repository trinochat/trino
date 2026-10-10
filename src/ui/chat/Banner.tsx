/**
 * Banner across a screen, such as a changed security code: info (accent
 * tint), warning or danger, with an icon, the text and an optional action.
 * Info and warnings are read politely (role="status"); danger interrupts
 * (role="alert").
 */
import type { ReactNode } from 'react';
import { CircleAlert, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { ICON_SIZE } from '../../design/type';
import { cx } from '../cx';

export type BannerTone = 'info' | 'warn' | 'danger';

export interface BannerProps {
  tone: BannerTone;
  /** The message. */
  children: ReactNode;
  /** Such as a "Comprobar código" button. */
  action?: ReactNode;
  className?: string;
}

const TONES: Record<BannerTone, { Icon: LucideIcon; role: 'status' | 'alert'; background: string; icon: string }> = {
  info: { Icon: Info, role: 'status', background: 'bg-ui-accent-soft', icon: 'text-ui-accent-text' },
  warn: { Icon: TriangleAlert, role: 'status', background: 'bg-ui-warn-bg', icon: 'text-ui-warn' },
  danger: { Icon: CircleAlert, role: 'alert', background: 'bg-ui-danger-bg', icon: 'text-ui-danger' },
};

export function Banner({ tone, children, action, className }: BannerProps) {
  const { Icon, role, background, icon } = TONES[tone];
  return (
    <div
      role={role}
      className={cx('flex flex-wrap items-center gap-3 rounded-ui px-3.5 py-3 text-ui-md leading-[1.45] text-ui-ink', background, className)}
    >
      <span className={cx('flex shrink-0', icon)}>
        <Icon size={ICON_SIZE.lg} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-[1_1_16.25rem]">{children}</div>
      {action}
    </div>
  );
}
