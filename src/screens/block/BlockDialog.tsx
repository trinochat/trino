/**
 * The confirmation before blocking (uso responsable UR-2, PropBloquear card
 * 3; `Uso responsable/diseno.md` §3.4 and §12.1). Blocking never happens in
 * one click: an alertdialog with Cancelar focused, and Bloquear in red with
 * its icon.
 *
 * It asks the backend first (`blockPreview`) what blocking would do:
 * - the groups you share (decision U5): they stop getting what you write
 *   there, and may notice. Where you administer, "Sacar del grupo"; where
 *   they do, you keep seeing who comes and goes (R-04), and "Salir del
 *   grupo". Each runs at once, blocked or not;
 * - a key clash (P1 R-14): a key they proved they hold is another
 *   contact's. Then there is no Bloquear, only the line that says so.
 *
 * Someone known only from a group shows as "~name": the admin wrote that
 * name (R-10). Whoever sent a request (UR-4) shows as Solicitudes names
 * them. "Reportar también" arrives with the report (UR-5).
 */
import { Ban, CircleAlert, LogOut, UserMinus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  isCommandError,
  type BlockPreview,
  type BlockTarget,
  type BlockedView,
  type GroupInfo,
  type SharedGroup,
} from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Dialog, iconSize } from '../../ui';
import { ERROR_LINE } from '../contacts/styles';

export interface BlockDialogApi {
  blockPreview(target: BlockTarget): Promise<BlockPreview>;
  blockIdentity(target: BlockTarget): Promise<BlockedView>;
  removeGroupMember(gid: string, ikSignPub: string): Promise<GroupInfo>;
  leaveGroup(gid: string): Promise<void>;
}

export interface BlockDialogProps {
  target: BlockTarget;
  /** How to call them until the backend answers. */
  name: string;
  api: BlockDialogApi;
  /** Blocked: the dialog's owner closes it and says so. */
  onBlocked(blocked: BlockedView): void;
  onClose(): void;
  /** You left a group from here. */
  onLeftGroup?(gid: string): void;
}

/** How the confirmation names them: "~name" for someone known only from a group. */
export function blockedName(preview: Pick<BlockPreview, 'label' | 'contact'>, fallback: string): string {
  if (preview.contact) return preview.contact;
  return preview.label ? `~${preview.label}` : fallback;
}

/** What happened to a group's offer: done, or failed. */
type GroupDone = Record<string, 'done' | 'failed' | 'busy'>;

export function BlockDialog({ target, name, api, onBlocked, onClose, onLeftGroup }: BlockDialogProps) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [preview, setPreview] = useState<BlockPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'failed' | 'clash' | null>(null);
  const [groups, setGroups] = useState<GroupDone>({});
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    apiRef.current.blockPreview(target).then(
      shown => {
        if (live) setPreview(shown);
      },
      () => {
        if (live) setError('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [target]);

  // A request names them as Solicitudes does ("~name" only when an admin wrote it).
  const shownName = preview && target.kind !== 'request' ? blockedName(preview, name) : name;
  const clash = preview?.clash === true || error === 'clash';

  const confirm = () => {
    if (busy || !preview) return;
    setBusy(true);
    setError(null);
    api.blockIdentity(target).then(onBlocked, (reason: unknown) => {
      setBusy(false);
      setError(isCommandError(reason) && reason.code === 'key_clash' ? 'clash' : 'failed');
    });
  };

  const groupAction = (group: SharedGroup) => {
    if (!preview || groups[group.gid] === 'busy') return;
    setGroups(current => ({ ...current, [group.gid]: 'busy' }));
    const run = group.i_administer
      ? api.removeGroupMember(group.gid, preview.ik_sign_pub).then(() => undefined)
      : api.leaveGroup(group.gid).then(() => onLeftGroup?.(group.gid));
    run.then(
      () => setGroups(current => ({ ...current, [group.gid]: 'done' })),
      () => setGroups(current => ({ ...current, [group.gid]: 'failed' })),
    );
  };

  const shared = preview?.shared_groups ?? [];
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('block.title', { name: shownName })}
      description={t('block.body')}
      initialFocusRef={cancelRef}
      closeOnEscape={!busy}
      size="sm"
    >
      {shared.length > 0 && !clash ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('block.groups')}</p>
          {shared
            .filter(group => group.i_administer || group.they_administer)
            .map(group => {
              const state = groups[group.gid];
              const vars = { group: group.name, name: shownName };
              return (
                <div key={group.gid} className="flex flex-col gap-2 rounded-ui border border-ui-line p-3">
                  <p className="m-0 text-ui-md leading-normal text-ui-ink">
                    {t(group.i_administer ? 'block.iAdminister' : 'block.theyAdminister', vars)}
                  </p>
                  {state === 'done' ? (
                    <p role="status" className="m-0 text-ui-md font-semibold text-ui-ink">
                      {t(group.i_administer ? 'block.removed' : 'block.left', vars)}
                    </p>
                  ) : (
                    <Button
                      className="self-start"
                      variant="danger"
                      loading={state === 'busy'}
                      leadingIcon={
                        group.i_administer ? (
                          <UserMinus {...iconSize('md')} aria-hidden="true" />
                        ) : (
                          <LogOut {...iconSize('md')} aria-hidden="true" />
                        )
                      }
                      onClick={() => groupAction(group)}
                    >
                      {t(group.i_administer ? 'block.removeFromGroup' : 'block.leaveGroup')}
                    </Button>
                  )}
                  {state === 'failed' ? <p className={ERROR_LINE}>{t('block.groupFailed')}</p> : null}
                </div>
              );
            })}
        </div>
      ) : null}
      {clash || error === 'failed' ? (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t(clash ? 'block.clash' : 'block.failed')}</span>
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button ref={cancelRef} onClick={onClose} disabled={busy}>
          {t('common2.cancel')}
        </Button>
        {preview && !clash ? (
          <Button
            variant="dangerSolid"
            leadingIcon={<Ban {...iconSize('md')} aria-hidden="true" />}
            loading={busy}
            onClick={confirm}
          >
            {t('block.confirm')}
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
