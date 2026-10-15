/**
 * The inbox as the shell shows it: InboxPanel with Tor's line (TOR-6,
 * PropTorSimple card 2) and the notice of a new version (card 8).
 *
 * It follows the network itself, so a `net-changed` or an `update-changed`
 * renders this and the panel, which show them, and never the shell or the
 * list of chats (FIX-2: before, each one rendered the whole shell, every row
 * of the inbox with it). Memoized: the shell hands it the same props for as
 * long as what it shows stays the same.
 */
import { memo } from 'react';
import { useT } from '../../lib/i18n';
import { InboxPanel, type InboxPanelProps, type TorLineView, type UpdateNoticeView } from '../inbox/InboxPanel';
import type { NetScreensApi } from '../net/net-api';
import { torLineOf } from '../net/net-model';
import { updateNoticeOf } from '../net/update-model';
import { useNetStatus } from '../net/useNetStatus';
import { useUpdateInfo } from '../net/useUpdateInfo';

export interface ShellInboxProps extends Omit<InboxPanelProps, 'tor' | 'update'> {
  /** Tor's state and commands; without it nothing of Tor shows. */
  net: NetScreensApi | null;
  /** The update state "Más tarde" was pressed on: its notice stays hidden until another comes. */
  updateLater: string | null;
  /** "Ver qué hacer": "Trino necesita actualizarse" when Arti is too old, "No se pudo conectar" otherwise. */
  onSeeWhat(kind: 'torFailed' | 'updateNeeded'): void;
  /** "Más tarde" on the notice of this update state. */
  onUpdateLater(key: string | null): void;
}

export const ShellInbox = memo(function ShellInbox({ net, updateLater, onSeeWhat, onUpdateLater, ...panel }: ShellInboxProps) {
  const t = useT();
  const netStatus = useNetStatus(net);
  const torLine = torLineOf(netStatus);
  // A new version (card 8): "Más tarde" hides the state it was pressed on, until another comes.
  const updateInfo = useUpdateInfo(net);
  const updateNotice = updateNoticeOf(updateInfo);
  const updateKey = updateInfo ? JSON.stringify([updateInfo.state, updateInfo.freeze]) : null;
  const runUpdate = (run: 'install' | 'checkNow') => {
    if (!net) return;
    const command = run === 'install' ? net.installUpdate : net.checkUpdateNow;
    command().catch(error => console.error(run === 'install' ? 'update_install failed' : 'update_check_now failed', error));
  };

  const tor: TorLineView | null =
    torLine && {
      text: t(torLine.key, torLine.vars),
      tone: torLine.tone,
      ...(torLine.action && {
        action: {
          label: t('net.line.seeWhat'),
          onAction: () => onSeeWhat(netStatus?.state === 'obsolete' ? 'updateNeeded' : 'torFailed'),
        },
      }),
    };
  const update: UpdateNoticeView | null =
    updateNotice && updateKey !== updateLater
      ? {
          text: t(updateNotice.key, updateNotice.vars),
          ...(updateNotice.action && {
            action: {
              label: t(updateNotice.action.key),
              onAction: () => runUpdate(updateNotice.action!.run),
            },
          }),
          ...(updateNotice.later && {
            later: {
              label: t('net.update.later'),
              onAction: () => onUpdateLater(updateKey),
            },
          }),
        }
      : null;

  return <InboxPanel {...panel} tor={tor} update={update} />;
});
