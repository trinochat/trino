/**
 * Connection state, in the label style on the accent tint. The icon follows
 * the real state, never a fixed "connected": a filled circle in ok when
 * connected, a dashed one in warn while connecting, a slashed one in danger
 * offline. Each state has its own shape, so colour is never the only cue and
 * forced colours keep it (the icon is `currentColor`, not a background). At
 * 10 px the icon only helps: the label is the main cue, so it starts with the
 * state's word ("Conectado · 3 de 3 servidores"). role="status" reads changes
 * out politely, so the label should only change when the state does.
 */
import { Circle, CircleDashed, CircleSlash, type LucideIcon } from 'lucide-react';
import { iconSize } from '../../design/type';
import { cx } from '../cx';
import { LABEL_TEXT } from './label';

export type ConnectionStatus = 'connected' | 'connecting' | 'offline';

export interface ConnectionChipProps {
  status: ConnectionStatus;
  /** What the chip says, such as "Conectado por Tor · 3 de 3 relays". */
  label: string;
  className?: string;
}

const STATES: Record<ConnectionStatus, { Icon: LucideIcon; icon: string; colour: string; filled: boolean }> = {
  connected: { Icon: Circle, icon: 'circle', colour: 'text-ui-ok', filled: true },
  connecting: { Icon: CircleDashed, icon: 'circle-dashed', colour: 'text-ui-warn', filled: false },
  offline: { Icon: CircleSlash, icon: 'circle-slash', colour: 'text-ui-danger', filled: false },
};

export function ConnectionChip({ status, label, className }: ConnectionChipProps) {
  const { Icon, icon, colour, filled } = STATES[status];
  return (
    <span
      role="status"
      data-status={status}
      className={cx('inline-flex items-center gap-1.5 rounded-full bg-ui-accent-soft px-2.5 py-1 text-ui-muted', LABEL_TEXT, className)}
    >
      <Icon
        {...iconSize('xs', cx('shrink-0', colour))}
        aria-hidden="true"
        data-icon={icon}
        fill={filled ? 'currentColor' : 'none'}
      />
      {label}
    </span>
  );
}
