/**
 * A call with this contact, as a line of the chat (K13, PropLlamadas:137-155):
 * centred, with its icon, what happened ("Llamada saliente · 4 min",
 * "Llamada perdida") and the time it started, in mono. It is no message: no
 * bubble, no options and no delivery state.
 *
 * A missed call is set apart by its icon, its words and their weight, and
 * also by the danger colour (plan-cambios §6.5); "Devolver llamada" calls
 * back with the voice. The words and the icon come from call-events.ts, so
 * the call log (W2) says the same.
 */
import { Phone } from 'lucide-react';
import { CALL_EVENT_ICONS, callEventIcon, callEventText, type CallEvent } from '../../lib/call-events';
import { clockTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { Button, cx, iconSize } from '../../ui';

export interface CallEventItemProps {
  call: CallEvent;
  /** When the call started, in epoch seconds. */
  ts: number;
  /** Calls the contact; without it, a missed call has no "Devolver llamada". */
  onCall?(video: boolean): void;
}

export function CallEventItem({ call, ts, onCall }: CallEventItemProps) {
  const t = useT();
  const { lang } = useLang();
  const kind = callEventIcon(call);
  const Icon = CALL_EVENT_ICONS[kind];
  const missed = kind === 'missed';
  return (
    <div
      data-call-event={kind}
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 py-1 text-center text-ui-md text-ui-muted"
    >
      <span className={cx('inline-flex', missed && 'text-ui-danger')}>
        <Icon {...iconSize('md')} aria-hidden="true" />
      </span>
      <span className={cx(missed && 'font-semibold text-ui-danger')}>{callEventText(call, t, 'chat')}</span>
      <time dateTime={new Date(ts * 1000).toISOString()} className="font-ui-mono text-ui-xs">
        {clockTime(ts, lang)}
      </time>
      {missed && onCall && (
        <Button onClick={() => onCall(false)} leadingIcon={<Phone {...iconSize('sm')} aria-hidden="true" />}>
          {t('callEvent.callBack')}
        </Button>
      )}
    </div>
  );
}
