/**
 * The call while you chat (Main:43-66): a bar over both panes with who the
 * call is with and its time, mute, hang up and "Volver a la llamada". Every
 * target is 44 px. How the call travels is not repeated here: the call
 * screen says it.
 */
import { Mic, MicOff, Phone } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { FOCUS_RING, cx, iconSize } from '../../ui';
import { callClock } from './call-view-model';
import { CallToggle, HangUpButton } from './controls';

export interface CallBarProps {
  peerName: string;
  /** Epoch milliseconds of connecting, or null before. */
  connectedAt: number | null;
  /** Epoch milliseconds, for the time. */
  now: number;
  muted: boolean;
  onToggleMute(): void;
  onHangUp(): void;
  onReturn(): void;
  /** Before connecting: "Llamando…" while it rings, "Conectando…" otherwise. */
  ringing?: boolean;
}

export function CallBar({ peerName, connectedAt, now, muted, onToggleMute, onHangUp, onReturn, ringing = false }: CallBarProps) {
  const t = useT();
  const status =
    connectedAt === null
      ? t(ringing ? 'call2.screen.calling' : 'call2.screen.connecting')
      : callClock(connectedAt, now);
  return (
    <div
      role="region"
      aria-label={t('call2.bar.region')}
      className="flex min-h-[2.8125rem] flex-none flex-wrap items-center gap-x-4 border-b border-ui-line bg-ui-accent-soft py-0.5 pl-4 pr-3 font-ui text-ui-md text-ui-ink"
    >
      <span className="flex min-h-11 min-w-0 flex-[1_1_16.25rem] items-center gap-2">
        <Phone {...iconSize('md', 'shrink-0')} aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          <span className="font-semibold">{t('call2.bar.with', { name: peerName })}</span>
          {' · '}
          <span className="font-ui-mono">{status}</span>
        </span>
      </span>
      <span className="flex min-h-11 items-center gap-2.5">
        <CallToggle label={t('call2.screen.mute')} pressed={muted} icons={{ pressed: MicOff, idle: Mic }} size="bar" onClick={onToggleMute} />
        <HangUpButton label={t('call2.screen.hangup')} size="bar" onClick={onHangUp} />
        <button
          type="button"
          onClick={onReturn}
          className={cx('min-h-11 rounded-ui px-2 text-ui-md font-semibold text-ui-accent-text hover:underline', FOCUS_RING)}
        >
          {t('call2.bar.return')}
        </button>
      </span>
    </div>
  );
}
