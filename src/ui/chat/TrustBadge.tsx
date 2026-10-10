/**
 * Trust state of a contact: verified, unverified, key changed or message
 * request. Only "verified" uses the accent; a key change and a request warn.
 * Compact mode, for chat rows, shows the icon alone and keeps the label for
 * screen readers.
 */
import type { ReactNode } from 'react';
import { Shield, ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react';
import { ICON_SIZE } from '../../design/type';
import { cx } from '../cx';

export type TrustKind = 'verified' | 'unverified' | 'keyChanged' | 'request';

export interface TrustBadgeProps {
  kind: TrustKind;
  /** Visible text; in compact mode, the screen-reader text. */
  label: string;
  /** Icon only, for chat rows. */
  compact?: boolean;
  /** After the label, outside compact mode: such as the "Verificar" button of an unverified contact. */
  action?: ReactNode;
  className?: string;
}

const KINDS: Record<TrustKind, { Icon: LucideIcon; tone: string; iconWithLabel: boolean }> = {
  verified: { Icon: ShieldCheck, tone: 'font-semibold text-ui-accent-text', iconWithLabel: true },
  unverified: { Icon: Shield, tone: 'text-ui-muted', iconWithLabel: false },
  keyChanged: { Icon: ShieldAlert, tone: 'font-semibold text-ui-warn', iconWithLabel: true },
  request: { Icon: ShieldQuestion, tone: 'font-semibold text-ui-warn', iconWithLabel: false },
};

export function TrustBadge({ kind, label, compact = false, action, className }: TrustBadgeProps) {
  const { Icon, tone, iconWithLabel } = KINDS[kind];
  if (compact) {
    return (
      <span data-trust={kind} className={cx('inline-flex shrink-0', tone, className)}>
        <Icon size={ICON_SIZE.md} aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </span>
    );
  }
  const badge = (
    <span data-trust={kind} className={cx('inline-flex items-center gap-1 text-ui-md', tone, !action && className)}>
      {iconWithLabel && <Icon size={ICON_SIZE.md} aria-hidden="true" />}
      {label}
    </span>
  );
  if (!action) return badge;
  return (
    <span className={cx('inline-flex flex-wrap items-center gap-2.5', className)}>
      {badge}
      {action}
    </span>
  );
}
