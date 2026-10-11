/**
 * The list of chats (Main:87-111), one ChatRow each, in a scroll of its own.
 *
 * Beyond its count, an unread chat is set in bold. A muted chat shows its
 * count as an outline and carries BellOff, so muted is not just grey;
 * ChatRow has no place for the icon, so it sits at the row's end, in room
 * the row leaves for it. In Terminal every avatar is square, so a group says
 * "Grupo" in its preview.
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

export function InboxList({ items, selectedKey, onSelect, now, emptyText, ...name }: InboxListProps) {
  const t = useT();
  const { lang } = useLang();
  if (items.length === 0) return <p className="m-2 text-ui-md text-ui-muted">{emptyText}</p>;

  const trustOf = (item: InboxItem): ChatRowProps['trust'] => {
    if (item.trust === 'verified') return { kind: 'verified', label: t('inbox.trust.verified') };
    if (item.trust === 'keyChanged') return { kind: 'keyChanged', label: t('inbox.trust.keyChanged') };
    return undefined;
  };
  const previewOf = (item: InboxItem): string | undefined => {
    if (item.draft) return item.draft;
    if (item.ref.kind !== 'group') return item.preview;
    return item.preview ? `${t('inbox.group')} · ${item.preview}` : t('inbox.group');
  };

  return (
    <ul aria-label={name['aria-label']} className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
      {items.map(item => (
        <li key={item.key} className="relative">
          <ChatRow
            name={item.name}
            avatar={{ initials: item.avatar.initials, src: item.avatar.src, kind: item.avatar.kind }}
            preview={previewOf(item)}
            draftPrefix={item.draft ? t('inbox.draft') : undefined}
            time={item.lastTs !== undefined ? rowTime(item.lastTs, now, lang) : undefined}
            unread={item.unread > 0 ? { count: item.unread, label: t('inbox.unread'), muted: item.muted } : undefined}
            trust={trustOf(item)}
            selected={item.key === selectedKey}
            onClick={() => onSelect(item.ref)}
            className={cx(item.unread > 0 && 'font-bold', item.muted && 'pe-10')}
          />
          {item.muted && (
            <span
              role="img"
              aria-label={t('inbox.muted')}
              className="pointer-events-none absolute end-3 top-1/2 flex -translate-y-1/2 text-ui-muted"
            >
              <BellOff {...iconSize('md')} aria-hidden="true" />
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
