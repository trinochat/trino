/**
 * "Nuevo chat" and "Nueva llamada" (PropNuevoChat:40-116): shortcuts on top
 * while the search is empty, then your contacts from A to Z, filtered as you
 * type. It only lists your contacts: this batch looks nobody up on the
 * network, so it takes no API, and there is no search by @name (David, 11
 * Oct: it comes with the invitations and Tor, plan-cambios-11oct §8).
 *
 * In a new chat a contact opens its chat; in a new call it calls with voice,
 * from the row or from its "Llamar a …" button. The shell closes the dialog
 * when it acts on a choice.
 */
import { useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Phone, QrCode, Search, Users, type LucideIcon } from 'lucide-react';
import { Avatar, Button, Dialog, FOCUS_RING_INSET, IconButton, Input, TrustBadge, cx, iconSize } from '../../../ui';
import { useT, type TFunction } from '../../../lib/i18n';
import { useLang } from '../../../lib/i18n-context';
import { identityInitials } from '../../../lib/initials';
import { safeInlineRasterSrc } from '../../../lib/safe-media';
import type { NewChatPurpose, NewChatSlotProps } from '../../types';
import { LABEL } from '../styles';
import { contactIndex } from './contact-index';

/** No API: this batch looks nobody up on the network. */
export type NewChatDialogProps = NewChatSlotProps;

export interface NewChatShortcut {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect(): void;
}

/**
 * The shortcuts above the contacts, as a list: the seam where the
 * invitations unit adds "Buscar por @nombre" and "Invitar con un enlace"
 * (plan-cambios-11oct §8). A new call has none.
 */
export function newChatShortcuts(
  purpose: NewChatPurpose,
  t: TFunction,
  actions: Pick<NewChatSlotProps, 'onNewGroup' | 'onAddWithCode'>,
): NewChatShortcut[] {
  if (purpose !== 'chat') return [];
  return [
    { id: 'new-group', label: t('contacts.newChat.newGroup'), icon: Users, onSelect: actions.onNewGroup },
    { id: 'add-with-code', label: t('contacts.newChat.addWithCode'), icon: QrCode, onSelect: actions.onAddWithCode },
  ];
}

const LIST = 'm-0 flex list-none flex-col overflow-hidden rounded-ui-lg border border-ui-line p-0';
const ROW_BUTTON = cx(
  'flex min-w-0 flex-1 items-center gap-3 bg-transparent text-left text-ui-ink hover:bg-ui-raised',
  FOCUS_RING_INSET,
);

export function NewChatDialog({
  purpose,
  contacts,
  trust,
  onClose,
  onOpenChat,
  onCall,
  onNewGroup,
  onAddWithCode,
}: NewChatDialogProps) {
  const t = useT();
  const { lang } = useLang();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');

  const letters = useMemo(() => contactIndex(contacts, query, lang), [contacts, query, lang]);
  const searching = query.trim() !== '';
  const shortcuts = searching ? [] : newChatShortcuts(purpose, t, { onNewGroup, onAddWithCode });
  const nobody = letters.length === 0;

  const pick = (handle: string) => (purpose === 'call' ? onCall(handle, false) : onOpenChat(handle));

  return (
    <Dialog
      open
      onClose={onClose}
      title={t(purpose === 'call' ? 'contacts.newChat.titleCall' : 'contacts.newChat.title')}
      closeLabel={t('common2.close')}
      initialFocusRef={searchRef}
      // PropNuevoChat:40 is 560 px wide: min(100%, 35rem), over the Dialog's own widths.
      className="!max-w-[35rem]"
    >
      <div className="relative flex items-center">
        <label htmlFor={searchId} className="sr-only">
          {t('contacts.newChat.search')}
        </label>
        <span aria-hidden="true" className="pointer-events-none absolute left-3 flex text-ui-muted">
          <Search {...iconSize('md')} aria-hidden="true" />
        </span>
        <Input
          ref={searchRef}
          id={searchId}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={t('contacts.newChat.placeholder')}
          autoComplete="off"
          spellCheck={false}
          // Input's own min-h-12 sets the height: a min-h-11 here sorts before it in the CSS and never applies.
          className="pl-9"
        />
      </div>

      {shortcuts.length > 0 && (
        <ul aria-label={t('contacts.newChat.shortcuts')} className={LIST}>
          {shortcuts.map((shortcut, index) => {
            const Icon = shortcut.icon;
            return (
              <li key={shortcut.id} className={cx(index > 0 && 'border-t border-ui-line')}>
                <button
                  type="button"
                  onClick={() => shortcut.onSelect()}
                  className={cx(ROW_BUTTON, 'min-h-[3.25rem] w-full px-3.5 text-ui-base font-semibold')}
                >
                  <span aria-hidden="true" className="flex text-ui-accent-text">
                    <Icon {...iconSize('lg')} aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">{shortcut.label}</span>
                  <span aria-hidden="true" className="flex text-ui-muted">
                    <ChevronRight {...iconSize('md')} aria-hidden="true" />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {letters.length > 0 && (
        <div className="flex min-h-0 flex-col gap-3.5">
          {letters.map(({ letter, nodes }) => (
            <section key={letter} className="flex flex-col gap-1.5">
              <h3 className={cx('m-0 px-1', LABEL)}>{letter}</h3>
              <ul aria-label={t('contacts.newChat.letterList', { letter })} className={LIST}>
                {nodes.map((node, index) => (
                  <li key={node.handle} className={cx('flex items-center gap-1', index > 0 && 'border-t border-ui-line')}>
                    <button type="button" onClick={() => pick(node.handle)} className={cx(ROW_BUTTON, 'min-h-14 px-3.5 py-2')}>
                      <Avatar initials={identityInitials(node.handle)} src={safeInlineRasterSrc(node.avatar)} size={40} />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ui-base font-semibold">
                        <span className="truncate">{node.handle}</span>
                        {trust[node.handle] === 'verified' && (
                          <>
                            {/* A space, so the name reads "Ana Torres Verificado". */}{' '}
                            <TrustBadge kind="verified" label={t('contacts.newChat.verified')} compact />
                          </>
                        )}
                      </span>
                    </button>
                    {purpose === 'call' && (
                      <IconButton
                        aria-label={t('contacts.newChat.callTo', { name: node.handle })}
                        icon={<Phone {...iconSize('lg')} aria-hidden="true" />}
                        variant="secondary"
                        onClick={() => onCall(node.handle, false)}
                        className="mr-1.5"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Read out when a search finds nobody; empty otherwise. */}
      <div role="status" className={cx(!nobody && 'sr-only')}>
        {nobody && (
          <p className="m-0 px-1 text-ui-base leading-normal">
            {searching ? t('contacts.newChat.noMatch', { q: query.trim() }) : t('contacts.newChat.empty')}
          </p>
        )}
      </div>
      {nobody && shortcuts.length === 0 && (
        <Button
          leadingIcon={<QrCode {...iconSize('lg')} aria-hidden="true" />}
          onClick={() => onAddWithCode()}
          className="self-start"
        >
          {t('contacts.newChat.addCode')}
        </Button>
      )}
    </Dialog>
  );
}
