/**
 * The sidebar of the shell (Main:68-121, PropLlamadas:41-103): the wordmark
 * and one button, "Nuevo chat" in Chats or "Nueva llamada" in Calls (it
 * replaces the old "+" menu); a notice only while no server is reachable
 * (David, 12 Oct 2026: no connection line while all is well); a notice of
 * invitations or of a stranger; the tabs "Chats | Llamadas · N";
 * and your profile at the foot. Chats has the search, the chips and the
 * chats; Calls has its chips, the log and its note. Without the call log
 * (K13) there are no tabs, only the chats.
 *
 * Tor's state (TOR-6, PropTorSimple card 2) is one line of text in the
 * same live region, under the wordmark: "Conectando de forma privada…
 * 40 %", "Esperando internet…", "No se pudo conectar." with "Ver qué
 * hacer", or "Sin protección" for as long as it lasts. No pill, no dot, no
 * panel, and gone once connected. While it shows, it says why the servers
 * are down too, so the notice of the servers waits until Tor is ready.
 *
 * Each list scrolls on its own and keeps at least 8 rem. Everything between
 * the head and the foot is one region that scrolls when it does not fit, as
 * at 200 % in a small window: #root cuts off whatever overflows
 * (accesibilidad.md §4.7, rule 9), so nothing there may only shrink.
 */
import { PhoneOutgoing, Plus, Search, WifiOff } from 'lucide-react';
import { useId, type Ref } from 'react';
import type { TorLineTone } from '../net/net-model';
import { useT } from '../../lib/i18n';
import { Banner, Button, FOCUS_RING, IconButton, Input, cx, iconSize } from '../../ui';
import type { Connection, ConvoRef, InboxFilter, InboxItem } from '../types';
import type { CallFilter } from './call-history-model';
import { CallHistoryList } from './CallHistoryList';
import type { CallRowView } from './CallRow';
import { FilterChips } from './FilterChips';
import { filterItems } from './inbox-model';
import { InboxList, type InboxRowActions } from './InboxList';
import { InboxTabs, type InboxTab } from './InboxTabs';
import { ProfileFooter } from './ProfileFooter';

export interface InboxPanelProps {
  /** "Trino" in Calma, "trino" in Terminal: the wordmark is part of the theme. */
  wordmark: string;
  /** Every chat; the panel applies the chip and the search. */
  items: readonly InboxItem[];
  selectedKey: string | null;
  onSelect(ref: ConvoRef): void;
  filter: InboxFilter;
  onFilterChange(filter: InboxFilter): void;
  search: string;
  onSearchChange(query: string): void;
  searchRef?: Ref<HTMLInputElement>;
  /** Offline shows the notice; null (no capability, or no answer) shows nothing. */
  connection: Connection | null;
  /** Tor's line (card 2), in the same live region; null or left out while connected. */
  tor?: TorLineView | null;
  me: { handle: string; avatarSrc?: string };
  onNewChat(): void;
  onNewCall(): void;
  tab: InboxTab;
  onTabChange(tab: InboxTab): void;
  /** The call log, the newest first; null without it (K13): no tabs, only the chats. */
  calls: readonly CallRowView[] | null;
  callFilter: CallFilter;
  onCallFilterChange(filter: CallFilter): void;
  /** The missed calls not seen yet: the N of "Llamadas · N". */
  missedUnseen: number;
  /** The call whose chat was opened from the log. */
  selectedCallKey: string | null;
  /** "Llamar a {name}" in the log: a voice call. */
  onCallBack(handle: string): void;
  /** Opens the chat of a call in the log; the tab stays on Calls. */
  onOpenCallChat(handle: string, key: string): void;
  onShareCode(): void;
  onOpenSettings(): void;
  /** No contact and no group yet: the chats offer to add someone. */
  hasContacts: boolean;
  onAddContact(): void;
  /** A notice above the tabs, such as pending invitations, with "Ver". */
  notice?: { text: string; onAction(): void } | null;
  /** Epoch seconds. */
  now: number;
  /**
   * A chat listed whatever the chip: the one just opened from the list, which
   * reading would take out of "No leídos" with the focus on its row. The shell
   * lets it go when the chip or the chat changes.
   */
  keepKey?: string | null;
  /** The Settings button of the foot, for the shell to give the focus back to. */
  settingsRef?: Ref<HTMLButtonElement>;
  /** What the rows' right-click menu does (MC-2); without it, no row has one. */
  rowActions?: InboxRowActions;
}

/** Tor's line as the shell words it: its text, its tone and maybe "Ver qué hacer". */
export interface TorLineView {
  text: string;
  tone: TorLineTone;
  action?: { label: string; onAction(): void };
}

/** Quiet while it works, stronger when it needs you, a warning without protection. */
const TOR_TONES: Readonly<Record<TorLineTone, string>> = {
  muted: 'text-ui-muted',
  alert: 'font-semibold text-ui-ink',
  warn: 'font-bold text-ui-warn',
};

/** The chips of the inbox, in order; "Solicitudes" joins them with message requests (R6b). */
const FILTERS: readonly InboxFilter[] = ['all', 'unread', 'groups'];
const FILTER_LABELS: Readonly<Record<InboxFilter, string>> = {
  all: 'inbox.filter.all',
  unread: 'inbox.filter.unread',
  groups: 'inbox.filter.groups',
};

export function InboxPanel(props: InboxPanelProps) {
  const t = useT();
  const searchId = useId();
  const { connection, calls, tab, notice } = props;
  const onCalls = calls !== null && tab === 'calls';
  const tor = props.tor ?? null;
  const offline = !tor && connection?.status === 'offline';

  const visible = filterItems(props.items, props.filter, props.search, props.keepKey ?? null);
  const chats = (
    <>
      <div className="relative flex items-center">
        <label htmlFor={searchId} className="sr-only">
          {t('inbox.search.label')}
        </label>
        <Search
          {...iconSize('md', 'pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ui-muted')}
          aria-hidden="true"
        />
        <Input
          ref={props.searchRef}
          id={searchId}
          type="search"
          placeholder={t('inbox.search.placeholder')}
          value={props.search}
          onChange={event => props.onSearchChange(event.target.value)}
          className="ps-9"
        />
      </div>
      <FilterChips
        aria-label={t('inbox.filter.label')}
        chips={FILTERS.map(value => ({ value, label: t(FILTER_LABELS[value]) }))}
        value={props.filter}
        onValueChange={props.onFilterChange}
      />
      <InboxList
        aria-label={t('inbox.tabs.chats')}
        items={visible}
        selectedKey={props.selectedKey}
        onSelect={props.onSelect}
        now={props.now}
        emptyText={props.search.trim() ? t('inbox.noMatch', { q: props.search.trim() }) : t('inbox.empty')}
        rowActions={props.rowActions}
      />
      {!props.hasContacts && (
        <div className="flex flex-col items-start gap-2 px-1">
          <p className="m-0 text-ui-md text-ui-muted">{t('inbox.firstContact')}</p>
          <Button onClick={props.onAddContact}>{t('inbox.addWithCode')}</Button>
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 bg-ui-side px-3 py-4 text-ui-ink">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="font-ui-display text-ui-title font-bold">{props.wordmark}</span>
        {onCalls ? (
          <IconButton
            variant="secondary"
            aria-label={t('inbox.newCall')}
            icon={<PhoneOutgoing {...iconSize('lg')} />}
            onClick={props.onNewCall}
          />
        ) : (
          <IconButton variant="secondary" aria-label={t('inbox.newChat')} icon={<Plus {...iconSize('lg')} />} onClick={props.onNewChat} />
        )}
      </div>
      {/* Its padding, edge to edge, keeps the focus rings inside what it clips. */}
      <div className="-mx-3 -my-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-1">
        {/*
          * One live region, always there and empty while connected (or still connecting after unlocking:
          * useConnection waits before it says offline), so a screen reader hears the notice come and go.
          * Out of the flow while empty, so it adds no gap.
          */}
        <div
          role="status"
          className={cx(
            tor
              ? 'flex flex-col px-1'
              : offline
                ? 'flex items-center gap-2 rounded-ui bg-ui-warn-bg px-3 py-2 text-ui-md leading-[1.45] text-ui-ink'
                : 'sr-only',
          )}
        >
          {tor && (
            <span className={cx('flex min-h-6 flex-wrap items-center gap-x-2 text-ui-md leading-[1.45]', TOR_TONES[tor.tone])}>
              <span>{tor.text}</span>
              {tor.action && (
                <button
                  type="button"
                  onClick={tor.action.onAction}
                  className={cx(
                    'min-h-8 rounded-ui px-1 font-ui text-ui-md font-semibold text-ui-accent-text hover:underline',
                    FOCUS_RING,
                  )}
                >
                  {tor.action.label}
                </button>
              )}
            </span>
          )}
          {offline && (
            <>
              <WifiOff {...iconSize('md', 'shrink-0 text-ui-warn')} aria-hidden="true" />
              <span className="min-w-0">{t('inbox.offline')}</span>
            </>
          )}
        </div>
        {notice && (
          <Banner
            tone="info"
            action={
              <Button variant="ghost" onClick={notice.onAction}>
                {t('inbox.notice.view')}
              </Button>
            }
          >
            {notice.text}
          </Banner>
        )}
        {calls === null ? (
          <div className="flex flex-1 flex-col gap-3">{chats}</div>
        ) : (
          <InboxTabs
            tab={tab}
            onTabChange={props.onTabChange}
            missedUnseen={props.missedUnseen}
            chats={chats}
            calls={
              <CallHistoryList
                rows={calls}
                filter={props.callFilter}
                onFilterChange={props.onCallFilterChange}
                selectedKey={props.selectedCallKey}
                onCall={props.onCallBack}
                onOpenChat={props.onOpenCallChat}
                now={props.now}
              />
            }
          />
        )}
      </div>
      <ProfileFooter
        me={props.me}
        onShareCode={props.onShareCode}
        onOpenSettings={props.onOpenSettings}
        settingsRef={props.settingsRef}
      />
    </div>
  );
}
