/**
 * The Calls tab (PropLlamadas:53-87): the chips Todas and Perdidas, the calls
 * in a scroll of their own, and a note that stays in view: the log only has
 * the calls that came in with Trino open and unlocked (K13).
 */
import { isMissed } from '../../lib/call-events';
import { useT } from '../../lib/i18n';
import { CALL_FILTERS, type CallFilter } from './call-history-model';
import { CallRow, type CallRowView } from './CallRow';
import { FilterChips } from './FilterChips';

export interface CallHistoryListProps {
  /** The newest first. */
  rows: readonly CallRowView[];
  filter: CallFilter;
  onFilterChange(filter: CallFilter): void;
  /** The key of the call whose chat was opened from here. */
  selectedKey: string | null;
  /** Calls the contact back with voice. */
  onCall(handle: string): void;
  onOpenChat(handle: string): void;
  /** Epoch seconds. */
  now: number;
}

const CHIP_LABELS: Readonly<Record<CallFilter, string>> = { all: 'inbox.calls.all', missed: 'inbox.calls.missed' };

export function CallHistoryList({ rows, filter, onFilterChange, selectedKey, onCall, onOpenChat, now }: CallHistoryListProps) {
  const t = useT();
  const visible = filter === 'missed' ? rows.filter(row => isMissed(row.entry.call)) : rows;
  return (
    <>
      <FilterChips
        aria-label={t('inbox.calls.filterLabel')}
        chips={CALL_FILTERS.map(value => ({ value, label: t(CHIP_LABELS[value]) }))}
        value={filter}
        onValueChange={onFilterChange}
      />
      {visible.length > 0 ? (
        <ul aria-label={t('inbox.calls.listLabel')} className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
          {visible.map(row => (
            <li key={row.entry.key}>
              <CallRow row={row} selected={row.entry.key === selectedKey} now={now} onCall={onCall} onOpenChat={onOpenChat} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-2 flex-1 text-ui-md text-ui-muted">
          {filter === 'missed' ? t('inbox.calls.emptyMissed') : t('inbox.calls.empty')}
        </p>
      )}
      <p className="m-0 px-1 text-ui-sm text-ui-muted">{t('inbox.calls.lockedNote')}</p>
    </>
  );
}
