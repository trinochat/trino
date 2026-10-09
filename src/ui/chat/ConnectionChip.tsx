/**
 * Connection state, in the label style on the accent tint. The dot follows the
 * real state (ok when connected, warn while connecting, danger offline), never
 * a fixed "connected". role="status" reads changes out politely, so the label
 * should only change when the state does.
 */
import { cx } from '../cx';
import { LABEL_TEXT } from './label';

export type ConnectionStatus = 'connected' | 'connecting' | 'offline';

export interface ConnectionChipProps {
  status: ConnectionStatus;
  /** What the chip says, such as "Conectado por Tor · 3 de 3 relays". */
  label: string;
  className?: string;
}

const DOTS: Record<ConnectionStatus, string> = {
  connected: 'bg-ui-ok',
  connecting: 'bg-ui-warn',
  offline: 'bg-ui-danger',
};

export function ConnectionChip({ status, label, className }: ConnectionChipProps) {
  return (
    <span
      role="status"
      data-status={status}
      className={cx('inline-flex items-center gap-1.5 rounded-full bg-ui-accent-soft px-[10px] py-1 text-ui-muted', LABEL_TEXT, className)}
    >
      <span aria-hidden="true" className={cx('h-2 w-2 shrink-0 rounded-full', DOTS[status])} />
      {label}
    </span>
  );
}
