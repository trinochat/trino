/**
 * The question before leaving a group, deleting it or removing a member
 * (Group:105-114): an alertdialog with "Cancelar" focused, since none of the
 * three can be undone from here. The texts say what the change does not
 * reach (plan §1.4 and §8.6): an older Trino keeps showing the group, and a
 * deletion or a removal misses whoever was offline for more than a day (the
 * relays' catch-up window).
 */
import { useRef, useState } from 'react';
import { CircleAlert, LogOut, Trash2, UserMinus } from 'lucide-react';
import { Button, Dialog, iconSize } from '../../ui';
import { isCommandError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { ERROR_LINE } from '../contacts/styles';

export type GroupExitKind = 'leave' | 'delete' | 'remove';

export interface ConfirmGroupExitDialogProps {
  kind: GroupExitKind;
  groupName: string;
  /** Who is removed, with `remove`. */
  memberName?: string;
  /** Makes the change. A rejection shows why; the panel closes the dialog when it works. */
  onConfirm(): Promise<void>;
  onCancel(): void;
}

const COPY = {
  leave: { title: 'groupPanel.leaveTitle', body: 'groupPanel.leaveBody', confirm: 'groupPanel.leave', failed: 'groupPanel.leaveFailed' },
  delete: { title: 'groupPanel.deleteTitle', body: 'groupPanel.deleteBody', confirm: 'groupPanel.delete', failed: 'groupPanel.deleteFailed' },
  remove: { title: 'groupPanel.removeTitle', body: 'groupPanel.removeBody', confirm: 'groupPanel.removeConfirm', failed: 'groupPanel.removeFailed' },
} as const satisfies Record<GroupExitKind, Record<string, string>>;

export function ConfirmGroupExitDialog({ kind, groupName, memberName = '', onConfirm, onCancel }: ConfirmGroupExitDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[kind];
  const vars = { group: groupName, name: memberName };

  const confirm = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    onConfirm().then(
      () => setBusy(false),
      (reason: unknown) => {
        setBusy(false);
        setError(isCommandError(reason) && reason.code === 'not_admin' ? t('groupPanel.notAdmin') : t(copy.failed, vars));
      },
    );
  };

  const label = t(copy.confirm);
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onCancel}
      title={t(copy.title, vars)}
      description={t(copy.body)}
      initialFocusRef={cancelRef}
      closeOnEscape={!busy}
      size="sm"
    >
      {error && (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
          {t('common2.cancel')}
        </Button>
        {kind === 'delete' ? (
          <Button
            variant="dangerSolid"
            leadingIcon={<Trash2 {...iconSize('md')} aria-hidden="true" />}
            loading={busy}
            onClick={confirm}
          >
            {label}
          </Button>
        ) : (
          <Button
            variant="danger"
            leadingIcon={
              kind === 'leave' ? (
                <LogOut {...iconSize('md')} aria-hidden="true" />
              ) : (
                <UserMinus {...iconSize('md')} aria-hidden="true" />
              )
            }
            loading={busy}
            onClick={confirm}
          >
            {label}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
