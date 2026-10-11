/**
 * "Contactos" (Contacts:40-133): add someone with their code, share yours,
 * and answer group invitations, as three tabs. The shell owns the open tab
 * (`tab`, `onTabChange`), so "Agregar con código o QR" opens it on "Agregar".
 */
import { Dialog, Tabs, type TabItem } from '../../ui';
import { useT } from '../../lib/i18n';
import type { ContactsSlotProps, ContactsTab } from '../types';
import type { GroupPrefs } from '../group/group-prefs';
import { AddContactPanel } from './AddContactPanel';
import type { ContactsApi } from './contacts-api';
import { InvitesPanel } from './InvitesPanel';
import { ShareCodePanel } from './ShareCodePanel';

export type ContactsDialogProps = ContactsSlotProps & {
  api: ContactsApi;
  /** Saves a file for the person: the QR code's PNG. */
  download(name: string, blob: Blob): void;
  /** This device's group settings, for a group you join; tests pass their own. */
  groupPrefs?: GroupPrefs;
};

export function ContactsDialog({
  tab,
  onTabChange,
  onClose,
  onContactAdded,
  onGroupJoined,
  invites,
  onInvitesChanged,
  strangerAttempts,
  api,
  download,
  groupPrefs,
}: ContactsDialogProps) {
  const t = useT();
  const items: TabItem<ContactsTab>[] = [
    {
      value: 'add',
      label: t('contacts.dialog.tabAdd'),
      panel: <AddContactPanel api={api} onContactAdded={onContactAdded} />,
    },
    {
      value: 'share',
      label: t('contacts.dialog.tabShare'),
      panel: <ShareCodePanel api={api} download={download} />,
    },
    {
      value: 'invites',
      label:
        invites.length > 0 ? t('contacts.dialog.tabInvitesCount', { n: invites.length }) : t('contacts.dialog.tabInvites'),
      panel: (
        <InvitesPanel
          api={api}
          invites={invites}
          strangerAttempts={strangerAttempts}
          onGroupJoined={onGroupJoined}
          onInvitesChanged={onInvitesChanged}
          groupPrefs={groupPrefs}
        />
      ),
    },
  ];

  return (
    <Dialog open onClose={onClose} title={t('contacts.dialog.title')} closeLabel={t('common2.close')} size="lg">
      <Tabs aria-label={t('contacts.dialog.tabs')} items={items} value={tab} onValueChange={onTabChange} />
    </Dialog>
  );
}
