/**
 * Delivery state of your own message: a clock while sending, a check once
 * sent, an alert if it failed. The icon is decoration; screen readers get the
 * state from the label.
 */
import { Check, CircleAlert, Clock, type LucideIcon } from 'lucide-react';
import { ICON_SIZE } from '../../design/type';
import { cx } from '../cx';

export type MessageStatus = 'sending' | 'sent' | 'failed';

export interface StatusTicksProps {
  state: MessageStatus;
  /** Screen-reader text of the state, such as "Enviado". */
  label: string;
  className?: string;
}

const ICONS: Record<MessageStatus, LucideIcon> = { sending: Clock, sent: Check, failed: CircleAlert };

export function StatusTicks({ state, label, className }: StatusTicksProps) {
  const Icon = ICONS[state];
  return (
    <span className={cx('inline-flex shrink-0', className)}>
      <Icon size={ICON_SIZE.sm} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
