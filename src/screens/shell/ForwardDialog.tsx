/**
 * "Reenviar a…": the chats a message can go to, found by name. A text goes
 * again as a new message; a file goes without being uploaded again.
 */
import { Search } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../../lib/i18n';
import { Avatar, cx, Dialog, FOCUS_RING_INSET, Input, iconSize } from '../../ui';
import { filterItems } from '../inbox/inbox-model';
import type { ConvoRef, InboxItem } from '../types';

export interface ForwardDialogProps {
  open: boolean;
  /** The contacts and groups that can take a message, in the inbox's order. */
  targets: readonly InboxItem[];
  onPick(ref: ConvoRef): void;
  onClose(): void;
}

export function ForwardDialog({ open, targets, onPick, onClose }: ForwardDialogProps) {
  const t = useT();
  const searchId = useId();
  const [query, setQuery] = useState('');
  // By name only: a preview is not what one looks for here.
  const visible = filterItems(
    targets.map(({ preview: _preview, ...target }) => target),
    'all',
    query,
  );
  return (
    <Dialog open={open} onClose={onClose} title={t('forward.title')} closeLabel={t('common2.close')} size="sm">
      <div className="relative flex items-center">
        <label htmlFor={searchId} className="sr-only">
          {t('forward.search')}
        </label>
        <Search
          {...iconSize('md', 'pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-ui-muted')}
          aria-hidden="true"
        />
        <Input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} className="ps-9" />
      </div>
      {visible.length > 0 ? (
        <ul aria-label={t('inbox.tabs.chats')} className="-mx-2 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {visible.map(target => (
            <li key={target.key}>
              <button
                type="button"
                onClick={() => onPick(target.ref)}
                className={cx(
                  'flex min-h-12 w-full items-center gap-3 rounded-ui px-2 py-1.5 text-start text-ui-base font-semibold text-ui-ink hover:bg-ui-raised',
                  FOCUS_RING_INSET,
                )}
              >
                <Avatar size={40} initials={target.avatar.initials} src={target.avatar.src} kind={target.avatar.kind} />
                <span className="min-w-0 flex-1 truncate">{target.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-ui-md text-ui-muted">{t('forward.noMatch', { q: query.trim() })}</p>
      )}
    </Dialog>
  );
}
