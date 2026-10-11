/**
 * One member in the group panel (Group:95-109): the avatar, the name ("Tú"
 * for you) and a line with their part and their trust, in words, so no state
 * rests on colour alone. "Escribirle" opens the chat of someone who came
 * with a group, as the board offers it to people you did not add yourself;
 * whoever administers can remove anyone but themselves.
 */
import type { ReactNode } from 'react';
import { MessageSquare, UserMinus } from 'lucide-react';
import { Avatar, Button, IconButton, TrustBadge, iconSize } from '../../ui';
import { useT } from '../../lib/i18n';
import type { GroupMemberView } from './group-model';

export interface GroupMemberRowProps {
  member: GroupMemberView;
  /** Opens the chat with this contact; offered to members who came with a group. */
  onWrite?(handle: string): void;
  /** Asks to remove this member; whoever administers gets it, for everyone but themselves. */
  onRemove?(member: GroupMemberView): void;
}

export function GroupMemberRow({ member, onWrite, onRemove }: GroupMemberRowProps) {
  const t = useT();
  const name = member.isSelf ? t('groupPanel.you') : member.name;

  const parts: ReactNode[] = [];
  if (member.isSelf) {
    parts.push(member.isAdmin ? t('groupPanel.adminYou') : t('groupPanel.statusMember'));
  } else {
    if (member.isAdmin) parts.push(t('groupPanel.statusAdmin'));
    if (member.trust === 'verified') parts.push(<TrustBadge key="trust" kind="verified" label={t('groupPanel.verified')} />);
    else if (member.trust === 'unverified') parts.push(<TrustBadge key="trust" kind="unverified" label={t('groupPanel.unverified')} />);
    else if (member.localHandle !== null) parts.push(t('groupPanel.viaGroup'));
    else
      parts.push(
        <span key="trust" className="font-semibold text-ui-warn">
          {t('groupPanel.notContact')}
        </span>,
      );
  }

  const write = member.trust === 'viaGroup' && member.localHandle !== null && onWrite ? member.localHandle : null;
  return (
    <li className="flex min-h-14 items-center gap-2.5 px-1 py-1.5">
      <Avatar initials={member.initials} size={40} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-ui-base font-semibold text-ui-ink [overflow-wrap:anywhere]">{name}</span>
        <span className="flex flex-wrap items-center gap-x-1 text-ui-md text-ui-muted">
          {parts.map((part, index) => (
            <span key={index} className="inline-flex items-center gap-1">
              {index > 0 && <span aria-hidden="true">·</span>}
              {part}
            </span>
          ))}
        </span>
      </span>
      {write !== null && (
        <Button
          aria-label={t('groupPanel.writeTo', { name: member.name })}
          leadingIcon={<MessageSquare {...iconSize('md')} aria-hidden="true" />}
          onClick={() => onWrite?.(write)}
          className="shrink-0"
        >
          {t('groupPanel.write')}
        </Button>
      )}
      {onRemove && !member.isSelf && (
        <IconButton
          aria-label={t('groupPanel.remove', { name: member.name })}
          icon={<UserMinus {...iconSize('lg')} aria-hidden="true" />}
          variant="danger"
          onClick={() => onRemove(member)}
        />
      )}
    </li>
  );
}
