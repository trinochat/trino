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
 */
import { BellOff } from 'lucide-react';
import { rowTime } from '../../lib/dates';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { ChatRow, cx, iconSize, type ChatRowProps } from '../../ui';
import type { ConvoRef, InboxItem } from '../types';

export interface InboxListProps {
  items: readonly InboxItem[];
  selectedKey: string | null;
  onSelect(ref: ConvoRef): void;
  /** Epoch seconds, for the times of the rows. */
  now: number;
  'aria-label': string;
  /** What the list says when it has no rows. */
  emptyText: string;
}

/** The parts that are there, joined as the rows join them: "Grupo · Papá: Hola". */
const joined = (...parts: ReadonlyArray<string | undefined>): string | undefined =>
  parts.filter(part => part).join(' · ') || undefined;

export function InboxList({ items, selectedKey, onSelect, now, emptyText, ...name }: InboxListProps) {
  const t = useT();
  const { lang } = useLang();
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
            className={cx(item.unread > 0 && 'font-bold', item.muted && 'pe-10')}
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
    </ul>
  );
}
