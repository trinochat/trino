/**
 * The list of chats (Main:87-111), one ChatRow each, in a scroll of its own
 * that keeps at least 8 rem, almost two rows, inside the sidebar's region.
 *
 * Beyond its count, an unread chat is set in bold. A muted chat shows its
 * count as an outline and carries BellOff, so muted is not just grey;
 * ChatRow has no place for the icon, so it sits at the row's end, in room
 * the row leaves for it. Tabbing through the chats reads only each row's
 * name, so the words go inside the row, on its second line: a group says
 * "Grupo" first, since Terminal squares every avatar, draft or not, and a
 * muted chat says "Silenciado" last, where a long line hides it from view
 * but never from the name. The icon is then decoration.
 *
 * Each item carries its chat's key (data-row-key), for the shell to give
 * the focus back to the row when one pane returns to the list.
 *
 * A right-click on a row, or Shift + F10 or the menu key on it, opens its
 * menu (MC-2, PropMenuContextual case 6), with what the chat already offers
 * elsewhere: a group, Silenciar or Activar sonido and Ver detalles; a
 * contact, Llamada de voz and Videollamada when you can call them, and Ver
 * detalles; Novedades, Silenciar or Activar sonido. A contact cannot be
 * muted. The row stays marked while its menu is open.
 */
import { Bell, BellOff, Info, Phone, Video } from 'lucide-react';
import { memo, useState } from 'react';
import { rowTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { ChatRow, cx, iconSize, useContextMenu, type ChatRowProps, type MenuEntry } from '../../ui';
import type { ConvoRef, InboxItem } from '../types';

/** What the menu of a row does; the shell owns each action. */
export interface InboxRowActions {
  /** Silenciar or Activar sonido, for a group or Novedades. */
  onToggleMuted(ref: ConvoRef): void;
  /** Opens the chat with its details, for a contact or a group. */
  onOpenDetails(ref: ConvoRef): void;
  /** Whether a contact can be called: not one you blocked. */
  canCall(handle: string): boolean;
  onCall(handle: string, video: boolean): void;
}

export interface InboxListProps {
  items: readonly InboxItem[];
  selectedKey: string | null;
  onSelect(ref: ConvoRef): void;
  /** Epoch seconds, for the times of the rows. */
  now: number;
  'aria-label': string;
  /** What the list says when it has no rows. */
  emptyText: string;
  /** The actions of the rows' right-click menu; without them, no row has one. */
  rowActions?: InboxRowActions;
}

/** The parts that are there, joined as the rows join them: "Grupo · Papá: Hola". */
const joined = (...parts: ReadonlyArray<string | undefined>): string | undefined =>
  parts.filter(part => part).join(' · ') || undefined;

/** The menu of a row: what the chat offers for it elsewhere. */
function rowEntries(item: InboxItem, actions: InboxRowActions, t: (key: string) => string): MenuEntry[] {
  const { ref } = item;
  const entries: MenuEntry[] = [];
  if (ref.kind === 'contact' && actions.canCall(ref.handle)) {
    entries.push(
      { id: 'voice', label: t('inbox.voiceCall'), icon: Phone, onSelect: () => actions.onCall(ref.handle, false) },
      { id: 'video', label: t('inbox.videoCall'), icon: Video, onSelect: () => actions.onCall(ref.handle, true) },
    );
  }
  if (ref.kind !== 'contact') {
    entries.push(
      item.muted
        ? { id: 'unmute', label: t('inbox.unmute'), icon: Bell, onSelect: () => actions.onToggleMuted(ref) }
        : { id: 'mute', label: t('inbox.mute'), icon: BellOff, onSelect: () => actions.onToggleMuted(ref) },
    );
  }
  if (ref.kind !== 'channel') {
    entries.push({ id: 'details', label: t('inbox.details'), icon: Info, onSelect: () => actions.onOpenDetails(ref) });
  }
  return entries;
}

/**
 * Memoized (FIX-2): the shell renders again for much that the list does not
 * show, such as a dialog that opens, and the list renders every row. With
 * the same props it does not render again.
 */
export const InboxList = memo(function InboxList({
  items,
  selectedKey,
  onSelect,
  now,
  emptyText,
  rowActions,
  ...name
}: InboxListProps) {
  const t = useT();
  const { lang } = useLang();
  /** The row whose menu was asked for; it is marked while the menu is open. */
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const contextMenu = useContextMenu(target => {
    const key = target.closest<HTMLElement>('[data-row-key]')?.dataset.rowKey;
    const item = items.find(candidate => candidate.key === key);
    if (!rowActions || !item) return null;
    setMenuKey(item.key);
    return { label: t('inbox.rowMenu', { name: item.name }), entries: rowEntries(item, rowActions, t) };
  });
  const marked = contextMenu.open ? menuKey : null;
  if (items.length === 0) return <p className="m-2 text-ui-md text-ui-muted">{emptyText}</p>;

  const trustOf = (item: InboxItem): ChatRowProps['trust'] => {
    if (item.trust === 'verified') return { kind: 'verified', label: t('inbox.trust.verified') };
    if (item.trust === 'keyChanged') return { kind: 'keyChanged', label: t('inbox.trust.keyChanged') };
    return undefined;
  };
  /** The second line: ChatRow draws the prefix first, in the accent, then the text. */
  const lineOf = (item: InboxItem): Pick<ChatRowProps, 'preview' | 'draftPrefix'> => {
    const group = item.ref.kind === 'group' ? t('inbox.group') : undefined;
    const muted = item.muted ? t('inbox.muted') : undefined;
    if (item.draft) return { draftPrefix: joined(group, t('inbox.draft')), preview: joined(item.draft, muted) };
    return { preview: joined(group, item.preview, muted) };
  };

  return (
    <ul
      {...contextMenu.triggerProps}
      aria-label={name['aria-label']}
      className="-mx-1 flex min-h-[8rem] grow basis-0 flex-col gap-0.5 overflow-y-auto px-1"
    >
      {items.map(item => (
        <li key={item.key} data-row-key={item.key} className="relative">
          <ChatRow
            name={item.name}
            avatar={{ initials: item.avatar.initials, src: item.avatar.src, kind: item.avatar.kind }}
            {...lineOf(item)}
            time={item.lastTs !== undefined ? rowTime(item.lastTs, now, lang) : undefined}
            unread={item.unread > 0 ? { count: item.unread, label: t('inbox.unread'), muted: item.muted } : undefined}
            trust={trustOf(item)}
            selected={item.key === selectedKey}
            onClick={() => onSelect(item.ref)}
            className={cx(
              item.unread > 0 && 'font-bold',
              item.muted && 'pe-10',
              item.key === marked && item.key !== selectedKey && 'bg-ui-raised',
            )}
          />
          {item.muted && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute end-3 top-1/2 flex -translate-y-1/2 text-ui-muted"
            >
              <BellOff {...iconSize('md')} />
            </span>
          )}
        </li>
      ))}
      {contextMenu.menu}
    </ul>
  );
});
