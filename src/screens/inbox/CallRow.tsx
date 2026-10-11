/**
 * One call of the log (PropLlamadas:62-83): the contact's avatar and name, a
 * line with the call's icon and words ("Saliente · 4 min"), its time, and
 * "Llamar a {name}". The row opens the contact's chat. A missed call is told
 * by its icon (PhoneMissed), its words ("Perdida") and its weight, and only
 * then by `danger`.
 */
import { Phone } from 'lucide-react';
import { CALL_EVENT_ICONS, callEventIcon, callEventText, isMissed } from '../../lib/call-events';
import { rowTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { Avatar, cx, FOCUS_RING_INSET, IconButton, iconSize } from '../../ui';
import type { CallLogEntry } from '../types';

/** A call of the log, with what the shell knows of its contact. */
export interface CallRowView {
  entry: CallLogEntry;
  /** The contact's name: its handle. */
  name: string;
  avatarSrc?: string;
  /** The contact still exists and is not blocked: it can be called. */
  callable: boolean;
}

export interface CallRowProps {
  row: CallRowView;
  selected: boolean;
  /** Epoch seconds, for the time of the call. */
  now: number;
  onCall(handle: string): void;
  /** Opens the contact's chat from this call, named by its key. */
  onOpenChat(handle: string, key: string): void;
}

export function CallRow({ row, selected, now, onCall, onOpenChat }: CallRowProps) {
  const t = useT();
  const { lang } = useLang();
  const { entry, name } = row;
  const missed = isMissed(entry.call);
  const Icon = CALL_EVENT_ICONS[callEventIcon(entry.call)];
  return (
    <div className={cx('flex items-center gap-1 rounded-ui', selected && 'bg-ui-raised')}>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => onOpenChat(entry.peer, entry.key)}
        className={cx(
          'flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-ui p-2.5 text-start text-ui-ink',
          !selected && 'hover:bg-ui-raised',
          FOCUS_RING_INSET,
        )}
      >
        <Avatar size={44} initials={identityInitials(name)} src={row.avatarSrc} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-ui-base font-semibold">{name}</span>{' '}
          <span
            data-call-detail=""
            className={cx(
              'flex min-w-0 items-center gap-1.5 text-ui-md',
              missed ? 'font-semibold text-ui-danger' : 'text-ui-muted',
            )}
          >
            <Icon {...iconSize('sm', 'shrink-0')} aria-hidden="true" />
            <span className="truncate">{callEventText(entry.call, t, 'row')}</span>
          </span>
        </span>{' '}
        <span className="shrink-0 font-ui-mono text-ui-xs text-ui-muted">{rowTime(entry.ts, now, lang)}</span>
      </button>
      {row.callable && (
        <IconButton
          variant="secondary"
          aria-label={t('inbox.calls.callTo', { name })}
          icon={<Phone {...iconSize('lg')} />}
          onClick={() => onCall(entry.peer)}
          className="me-1.5"
        />
      )}
    </div>
  );
}
