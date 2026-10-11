/**
 * Renaming a contact: the name you gave them, which changes on this device
 * only. Empty is not a name, and the backend refuses one another contact
 * already has (`name_taken`, K8).
 */
import { useState, type FormEvent } from 'react';
import { isCommandError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Dialog, Field, Input } from '../../ui';
import { ErrorLine } from '../settings/ErrorLine';
import { NAME_MAX } from '../settings/sections/ProfileSection';
import { capScalars } from '../settings/scalars';

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
