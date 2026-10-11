/**
 * "Invitaciones" in Contacts (Contacts:108-123): the group invitations
 * waiting for an answer, with "Unirme" and "Rechazar", on the backend that
 * exists (accept_group_invite, decline_group_invite). Nothing is joined until
 * you accept.
 *
 * The board's "Solicitud de mensaje" row is not built: a stranger's message
 * is dropped today, and all Trino knows is that someone tried
 * (`handshake-needed`, plan §1.2). So that is all it says.
 */
import { useId, useState } from 'react';
import { CircleAlert, Users } from 'lucide-react';
import { Avatar, Button, iconSize } from '../../ui';
import type { GroupInvite } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { groupPrefs as deviceGroupPrefs, type GroupPrefs } from '../group/group-prefs';
import type { ContactsApi } from './contacts-api';
import { CARD, ERROR_LINE } from './styles';

/**
 * What can wait in this panel, by kind: group invitations today. The seam for
 * the redeemed links and approvals of the invitations (plan-cambios-11oct
 * §8), which add their kinds and their cards.
 */
export type InviteItem = { kind: 'group'; invite: GroupInvite };

export interface InvitesPanelProps {
  api: Pick<ContactsApi, 'acceptGroupInvite' | 'declineGroupInvite'>;
  invites: readonly GroupInvite[];
  /** `handshake-needed` in this session, each pubkey counted once. */
  strangerAttempts: number;
  onGroupJoined(gid: string): void;
  /** An invitation was answered: read them again. */
  onInvitesChanged(): void;
  /** This device's group settings, for a group you join; tests pass their own. */
  groupPrefs?: GroupPrefs;
}

export function InvitesPanel({
  api,
  invites,
  strangerAttempts,
  onGroupJoined,
  onInvitesChanged,
  groupPrefs = deviceGroupPrefs(),
}: InvitesPanelProps) {
  const t = useT();
  const items: InviteItem[] = invites.map(invite => ({ kind: 'group', invite }));

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 && <p className="m-0 text-ui-base text-ui-muted">{t('contacts.invites.empty')}</p>}
      {items.map(item => {
        switch (item.kind) {
          case 'group':
            return (
              <GroupInviteCard
                key={item.invite.gid}
                invite={item.invite}
                api={api}
                onJoined={gid => {
                  groupPrefs.applyDefaults(gid);
                  onGroupJoined(gid);
                  onInvitesChanged();
                }}
                onDeclined={onInvitesChanged}
              />
            );
        }
      })}
      {strangerAttempts > 0 && (
        <div className="flex items-center gap-3 rounded-ui border border-ui-line px-4 py-3.5">
          <Avatar kind="request" size={40} />
          <p className="m-0 min-w-0 flex-1 text-ui-md leading-normal text-ui-ink">
            {strangerAttempts === 1
              ? t('contacts.invites.strangerOne')
              : t('contacts.invites.strangerMany', { n: strangerAttempts })}
          </p>
        </div>
      )}
    </div>
  );
}

interface GroupInviteCardProps {
  invite: GroupInvite;
  api: InvitesPanelProps['api'];
  onJoined(gid: string): void;
  onDeclined(): void;
}

function GroupInviteCard({ invite, api, onJoined, onDeclined }: GroupInviteCardProps) {
  const t = useT();
  const titleId = useId();
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null);
  const [failed, setFailed] = useState(false);

  const answer = (join: boolean) => {
    setBusy(join ? 'join' : 'decline');
    setFailed(false);
    const request = join ? api.acceptGroupInvite(invite.gid) : api.declineGroupInvite(invite.gid);
    request.then(
      () => {
        setBusy(null);
        if (join) onJoined(invite.gid);
        else onDeclined();
      },
      () => {
        setBusy(null);
        setFailed(true);
      },
    );
  };

  const from =
    invite.member_count === 1
      ? t('contacts.invites.fromOne', { name: invite.from_handle })
      : t('contacts.invites.from', { name: invite.from_handle, count: invite.member_count });

  return (
    <article aria-labelledby={titleId} className={CARD}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-ui bg-ui-accent-soft text-ui-accent-text"
        >
          <Users {...iconSize('xl')} aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="m-0 text-ui-lg font-bold text-ui-ink [overflow-wrap:anywhere]">
            {invite.name}
          </h3>
          <span className="text-ui-md text-ui-muted [overflow-wrap:anywhere]">{from}</span>
        </div>
      </div>
      <p className="m-0 text-ui-md leading-normal text-ui-muted">{t('contacts.invites.note')}</p>
      {failed && (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>{t('contacts.invites.failed')}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          aria-label={t('contacts.invites.joinLabel', { name: invite.name })}
          loading={busy === 'join'}
          disabled={busy !== null}
          onClick={() => answer(true)}
        >
          {t('contacts.invites.join')}
        </Button>
        <Button
          aria-label={t('contacts.invites.declineLabel', { name: invite.name })}
          loading={busy === 'decline'}
          disabled={busy !== null}
          onClick={() => answer(false)}
        >
          {t('contacts.invites.decline')}
        </Button>
      </div>
    </article>
  );
}
