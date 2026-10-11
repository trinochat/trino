/**
 * Renaming a group, for whoever administers it (a deviation of the canvas,
 * plan §1.8 point 6; K10 `rename_group`). The new name goes out in a signed
 * roster, which older versions apply too.
 */
import { useRef, useState, type FormEvent } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button, Dialog, Field, Input, iconSize } from '../../ui';
import { isCommandError, type GroupInfo } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { ERROR_LINE } from '../contacts/styles';
import type { GroupApi } from './group-api';

export interface RenameGroupDialogProps {
  group: GroupInfo;
  api: Pick<GroupApi, 'renameGroup'>;
  onClose(): void;
  /** The group as it is after the change. */
  onRenamed(group: GroupInfo): void;
}

/** A group's name: long enough for any real one, short enough for every screen. */
export const GROUP_NAME_MAX = 64;

export function RenameGroupDialog({ group, api, onClose, onRenamed }: RenameGroupDialogProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(group.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = name.trim();
  const canSave = next !== '' && next !== group.name && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    api.renameGroup(group.gid, next).then(
      renamed => {
        setBusy(false);
        onRenamed(renamed);
      },
      (reason: unknown) => {
        setBusy(false);
        setError(t(isCommandError(reason) && reason.code === 'not_admin' ? 'groupPanel.notAdmin' : 'groupPanel.renameFailed'));
      },
    );
  };

  return (
    <Dialog open onClose={onClose} title={t('groupPanel.rename')} closeLabel={t('common2.close')} initialFocusRef={inputRef} size="sm">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t('groupPanel.name')}>
          <Input
            ref={inputRef}
            value={name}
            maxLength={GROUP_NAME_MAX}
            onChange={event => setName(event.target.value)}
            readOnly={busy}
            autoComplete="off"
          />
        </Field>
        {error && (
          <p role="alert" className={ERROR_LINE}>
            <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            {t('common2.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave && !busy} loading={busy}>
            {t('common2.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
