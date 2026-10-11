/**
 * "Invitaciones" in Contacts (Contacts:108-123): the group invitations
 * waiting for an answer, with "Unirme" and "Rechazar", on the backend that
 * exists (accept_group_invite, decline_group_invite). Nothing is joined until
 * you accept.
 *
 * Both answers take the invitation out on the backend first, and keep it out
 * when they fail (take_group_invite: "The invite is consumed either way"), so
 * a retry could only fail. After a failure the panel reads the invitations
 * again and says, above them, what is left to do: the card goes away with
 * its invitation, the message stays.
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
  /** An invitation was answered, or an answer failed: read them again. */
  onInvitesChanged(): void;
  /** This device's group settings, for a group you join; tests pass their own. */
  groupPrefs?: GroupPrefs;
}

/** An answer that failed, kept by the panel: its card goes away with the invitation. */
interface Failure {
  join: boolean;
  invite: GroupInvite;
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
  const [failure, setFailure] = useState<Failure | null>(null);
  const items: InviteItem[] = invites.map(invite => ({ kind: 'group', invite }));

  return (
    <div className="flex flex-col gap-3">
      {failure && (
        <p role="alert" className={ERROR_LINE}>
          <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
          <span>
            {failure.join
              ? t('contacts.invites.joinFailed', { name: failure.invite.name, from: failure.invite.from_handle })
              : t('contacts.invites.declineFailed', { name: failure.invite.name })}
          </span>
        </p>
      )}
      {items.length === 0 && <p className="m-0 text-ui-base text-ui-muted">{t('contacts.invites.empty')}</p>}
      {items.map(item => {
        switch (item.kind) {
          case 'group':
            return (
              <GroupInviteCard
                key={item.invite.gid}
                invite={item.invite}
                api={api}
                onAnswering={() => setFailure(null)}
                onJoined={gid => {
                  groupPrefs.applyDefaults(gid);
                  onGroupJoined(gid);
                  onInvitesChanged();
                }}
                onDeclined={onInvitesChanged}
                onFailed={join => {
                  setFailure({ join, invite: item.invite });
                  onInvitesChanged();
                }}
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
  /** An answer starts: what failed before no longer applies. */
  onAnswering(): void;
  onJoined(gid: string): void;
  onDeclined(): void;
  /** The answer failed, and the backend took the invitation out anyway. */
  onFailed(join: boolean): void;
}

function GroupInviteCard({ invite, api, onAnswering, onJoined, onDeclined, onFailed }: GroupInviteCardProps) {
  const t = useT();
  const titleId = useId();
  const [busy, setBusy] = useState<'join' | 'decline' | null>(null);

  const answer = (join: boolean) => {
    setBusy(join ? 'join' : 'decline');
    onAnswering();
    const request = join ? api.acceptGroupInvite(invite.gid) : api.declineGroupInvite(invite.gid);
    request.then(
      () => {
        setBusy(null);
        if (join) onJoined(invite.gid);
        else onDeclined();
      },
      () => {
        setBusy(null);
        onFailed(join);
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
