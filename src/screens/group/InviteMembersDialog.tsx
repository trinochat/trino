/**
 * "Invitar" in the group panel (Group:91-93), for whoever administers: pick
 * contacts who are not members yet, by identity (group-model.ts), and add
 * them one by one with add_group_member, showing the progress. A partial
 * failure says who was left out and keeps them picked to try again. The
 * note is the honest one of plan §1.4: an invitation only reaches contacts
 * who have you added too.
 */
import { useMemo, useState } from 'react';
import { CircleAlert, UserPlus } from 'lucide-react';
import { Button, Checkbox, Dialog, iconSize } from '../../ui';
import type { GroupInfo, GroupMember, NodeInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { ERROR_LINE } from '../contacts/styles';
import type { GroupApi } from './group-api';
import { inviteCandidates } from './group-model';

export interface InviteMembersDialogProps {
  group: GroupInfo;
  /** The members as group_members gave them (K9). */
  members: readonly GroupMember[];
  contacts: readonly NodeInfo[];
  api: Pick<GroupApi, 'addGroupMember'>;
  onClose(): void;
  /** At least one contact was added: read the group again. */
  onInvited(): void;
}

export function InviteMembersDialog({ group, members, contacts, api, onClose, onInvited }: InviteMembersDialogProps) {
  const t = useT();
  const { lang } = useLang();
  const candidates = useMemo(() => {
    const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    return inviteCandidates(contacts, members).sort((a, b) => collator.compare(a.handle, b.handle));
  }, [contacts, members, lang]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [progress, setProgress] = useState<{ name: string; done: number; total: number } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);

  const toggle = (handle: string, on: boolean) =>
    setPicked(current => {
      const next = new Set(current);
      if (on) next.add(handle);
      else next.delete(handle);
      return next;
    });

  const invite = async () => {
    const chosen = candidates.filter(contact => picked.has(contact.handle)).map(contact => contact.handle);
    if (chosen.length === 0 || progress) return;
    setFailed([]);
    const missed: string[] = [];
    for (const [index, handle] of chosen.entries()) {
      setProgress({ name: handle, done: index + 1, total: chosen.length });
      try {
        await api.addGroupMember(group.gid, handle);
      } catch {
        missed.push(handle);
      }
    }
    setProgress(null);
    if (missed.length < chosen.length) onInvited();
    if (missed.length === 0) {
      onClose();
      return;
    }
    setFailed(missed);
    setPicked(new Set(missed));
  };

  const busy = progress !== null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('groupPanel.inviteTitle', { group: group.name })}
      description={t('groupPanel.inviteHint')}
      closeLabel={t('common2.close')}
      closeOnEscape={!busy}
    >
      {candidates.length === 0 ? (
        <p className="m-0 text-ui-base text-ui-muted">{t('groupPanel.inviteNone')}</p>
      ) : (
        <>
          <fieldset className="m-0 flex max-h-[20rem] min-w-0 flex-col overflow-y-auto border-0 p-0">
            <legend className="sr-only">{t('groupPanel.inviteList')}</legend>
            {candidates.map(contact => (
              <Checkbox
                key={contact.handle}
                label={contact.handle}
                checked={picked.has(contact.handle)}
                disabled={busy}
                onChange={event => toggle(contact.handle, event.target.checked)}
                className="[overflow-wrap:anywhere]"
              />
            ))}
          </fieldset>
          <p role="status" className={progress ? 'm-0 text-ui-md text-ui-muted' : 'sr-only'}>
            {progress ? t('groupPanel.inviting', { name: progress.name, done: progress.done, total: progress.total }) : ''}
          </p>
          {failed.length > 0 && (
            <p role="alert" className={ERROR_LINE}>
              <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
              <span>{t('groupPanel.invitePartial', { names: failed.join(', ') })}</span>
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose} disabled={busy}>
              {t('common2.cancel')}
            </Button>
            <Button
              variant="primary"
              leadingIcon={<UserPlus {...iconSize('md')} aria-hidden="true" />}
              disabled={picked.size === 0 && !busy}
              loading={busy}
              onClick={() => void invite()}
            >
              {t('groupPanel.invite')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
