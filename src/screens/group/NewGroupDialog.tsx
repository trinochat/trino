/**
 * "Nuevo grupo" (from "Nuevo chat"; no board draws it, plan §1.8): a name
 * and the contacts to add. It creates the group, then adds the chosen
 * contacts one by one with add_group_member, showing the progress; if some
 * cannot be added, it says who, honestly, and the group stays: they can be
 * invited from its details. You administer the group you create.
 */
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button, Checkbox, Dialog, Field, Input, iconSize } from '../../ui';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import type { NewGroupSlotProps } from '../types';
import { ERROR_LINE } from '../contacts/styles';
import type { GroupApi } from './group-api';
import { groupPrefs as deviceGroupPrefs, type GroupPrefs } from './group-prefs';
import { GROUP_NAME_MAX } from './RenameGroupDialog';

export type NewGroupDialogProps = NewGroupSlotProps & {
  api: Pick<GroupApi, 'createGroup' | 'addGroupMember'>;
  /** This device's group settings, for the new group's mute; tests pass their own. */
  groupPrefs?: GroupPrefs;
};

type Phase =
  | { kind: 'edit'; failed: boolean }
  | { kind: 'creating' }
  | { kind: 'adding'; name: string; done: number; total: number }
  /** The group exists, but these contacts could not be added. */
  | { kind: 'partial'; gid: string; missed: string[] };

export function NewGroupDialog({ contacts, onClose, onCreated, api, groupPrefs = deviceGroupPrefs() }: NewGroupDialogProps) {
  const t = useT();
  const { lang } = useLang();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ kind: 'edit', failed: false });
  const candidates = useMemo(() => {
    const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
    return contacts.filter(contact => !contact.blocked).sort((a, b) => collator.compare(a.handle, b.handle));
  }, [contacts, lang]);

  const busy = phase.kind === 'creating' || phase.kind === 'adding';
  const groupName = name.trim();

  const toggle = (handle: string, on: boolean) =>
    setPicked(current => {
      const next = new Set(current);
      if (on) next.add(handle);
      else next.delete(handle);
      return next;
    });

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (groupName === '' || busy) return;
    setPhase({ kind: 'creating' });
    let gid: string;
    try {
      gid = (await api.createGroup(groupName)).gid;
    } catch {
      setPhase({ kind: 'edit', failed: true });
      return;
    }
    groupPrefs.applyDefaults(gid);
    const chosen = candidates.filter(contact => picked.has(contact.handle)).map(contact => contact.handle);
    const missed: string[] = [];
    for (const [index, handle] of chosen.entries()) {
      setPhase({ kind: 'adding', name: handle, done: index + 1, total: chosen.length });
      try {
        await api.addGroupMember(gid, handle);
      } catch {
        missed.push(handle);
      }
    }
    if (missed.length === 0) onCreated(gid);
    else setPhase({ kind: 'partial', gid, missed });
  };

  if (phase.kind === 'partial') {
    // The group exists: closing still tells the shell, so it shows up.
    const done = () => onCreated(phase.gid);
    return (
      <Dialog open onClose={done} title={t('groupNew.title')} closeLabel={t('common2.close')}>
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t('groupNew.partial', { names: phase.missed.join(', ') })}</span>
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="primary" onClick={done}>
            {t('groupNew.open')}
          </Button>
        </div>
      </Dialog>
    );
  }

  const progress =
    phase.kind === 'creating'
      ? t('groupNew.creating')
      : phase.kind === 'adding'
        ? t('groupNew.adding', { name: phase.name, done: phase.done, total: phase.total })
        : '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('groupNew.title')}
      description={t('groupNew.adminNote')}
      closeLabel={busy ? undefined : t('common2.close')}
      closeOnEscape={!busy}
      closeOnScrimClick={!busy}
      initialFocusRef={nameRef}
    >
      <form onSubmit={event => void create(event)} className="flex min-h-0 flex-col gap-4">
        <Field label={t('groupPanel.name')}>
          <Input
            ref={nameRef}
            value={name}
            maxLength={GROUP_NAME_MAX}
            onChange={event => setName(event.target.value)}
            readOnly={busy}
            autoComplete="off"
          />
        </Field>
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 font-ui text-ui-base font-semibold text-ui-ink">{t('groupPanel.members')}</legend>
          <p className="m-0 text-ui-md text-ui-muted">
            {candidates.length === 0 ? t('groupNew.noContacts') : t('groupPanel.inviteHint')}
          </p>
          {candidates.length > 0 && (
            <div className="flex max-h-[18rem] min-h-0 flex-col overflow-y-auto">
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
            </div>
          )}
        </fieldset>
        <p role="status" className={progress ? 'm-0 text-ui-md text-ui-muted' : 'sr-only'}>
          {progress}
        </p>
        {phase.kind === 'edit' && phase.failed && (
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{t('groupNew.failed')}</span>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t('common2.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={groupName === '' && !busy} loading={busy}>
            {t('groupNew.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
