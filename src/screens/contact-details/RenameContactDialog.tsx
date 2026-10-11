/**
 * Renaming a contact: the name you gave them, which changes on this device
 * only. Empty is not a name, neither is one that stands for a group or the
 * channel, and the backend refuses one another contact already has
 * (`name_taken`, K8).
 */
import { useState, type FormEvent } from 'react';
import { isCommandError } from '../../lib/api';
import { parseConvoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { Button, Dialog, Field, Input } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import { NAME_MAX } from '../settings/sections/ProfileSection';
import { capScalars, countScalars } from '../settings/scalars';

/**
 * Whether a contact can have this name here. The name is also the key of
 * the contact's chat and of what this device keeps for them, and `channel`
 * and `grp:…` are the keys of the channel and of the groups (convo.ts): a
 * contact named so would take over their timer here and their history in
 * the backend. A name is at most NAME_MAX characters, where a profile
 * allows 64.
 */
export function isContactName(name: string): boolean {
  return name.length > 0 && parseConvoKey(name).kind === 'contact' && countScalars(name) <= NAME_MAX;
}

export interface RenameContactDialogProps {
  /** The name the contact has now. */
  name: string;
  rename(oldName: string, newName: string): Promise<void>;
  onClose(): void;
  onRenamed(newName: string): void;
}

export function RenameContactDialog({ name, rename, onClose, onRenamed }: RenameContactDialogProps) {
  const t = useT();
  const [value, setValue] = useState(name);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim();
    setError(null);
    if (!next) {
      setEmpty(true);
      return;
    }
    if (next === name) {
      onClose();
      return;
    }
    if (!isContactName(next)) {
      setError('contactInfo.errNameReserved');
      return;
    }
    setBusy(true);
    try {
      await rename(name, next);
      onRenamed(next);
    } catch (cause) {
      setError(
        isCommandError(cause) && cause.code === 'name_taken' ? 'contactInfo.errNameTaken' : 'contactInfo.errRename',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} closeLabel={t('common2.close')} title={t('contactInfo.renameTitle', { name })}>
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4">
        <Field
          label={t('contactInfo.renameLabel')}
          hint={t('contactInfo.renameHint')}
          error={empty ? t('contactInfo.errRenameEmpty') : undefined}
        >
          <Input
            autoFocus
            autoComplete="off"
            value={value}
            onChange={event => {
              setEmpty(false);
              setValue(capScalars(event.target.value, NAME_MAX));
            }}
          />
        </Field>
        {error ? <ErrorLine>{t(error)}</ErrorLine> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>{t('common2.cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {t('common2.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
