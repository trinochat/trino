/**
 * The details of a group (Group:70-115), as an aside beside the chat or as a
 * dialog when the window is narrow (`layout`). "N miembros · Administra X",
 * silencing on this device, the time your messages last here, the members
 * with their trust, and what whoever administers can do: invite, remove,
 * rename and delete; a member can leave.
 *
 * What the canvas promised and this batch cannot do is not drawn: no group
 * call, and no "for the whole group" timer, since that would change the
 * signed bytes of the roster (plan §1.4). `capabilities` hides what needs
 * backend that has not landed: `members` the members and anything chosen by
 * them (K9), `manage` removing, renaming, leaving and deleting (K10).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bell, BellOff, CircleAlert, LogOut, Pencil, Trash2, UserPlus, X, type LucideIcon } from 'lucide-react';
import { Avatar, Banner, Button, Dialog, Field, IconButton, Select, cx, iconSize } from '../../ui';
import type { GroupMember } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { useLang } from '../../lib/i18n-context';
import { identityInitials } from '../../lib/initials';
import { prefs } from '../../lib/prefs';
import type { GroupPanelSlotProps } from '../types';
import { ERROR_LINE } from '../contacts/styles';
import { ConfirmGroupExitDialog } from './ConfirmGroupExitDialog';
import type { GroupApi } from './group-api';
import { buildMemberViews, type GroupMemberView } from './group-model';
import { GROUP_TTL_OPTIONS, groupPrefs as deviceGroupPrefs, type GroupPrefs } from './group-prefs';
import { GroupMemberRow } from './GroupMemberRow';
import { InviteMembersDialog } from './InviteMembersDialog';
import { RenameGroupDialog } from './RenameGroupDialog';

export type { GroupApi } from './group-api';

export type GroupPanelProps = GroupPanelSlotProps & {
  api: GroupApi;
  /** `members`: group_members (K9). `manage`: remove, rename, leave and delete (K10). */
  capabilities: { members: boolean; manage: boolean };
  /** Whether a contact is verified with this fingerprint; `prefs.isVerified` by default. */
  isVerified?: (handle: string, fingerprint: string) => boolean;
  /** This device's group settings; tests pass their own. */
  groupPrefs?: GroupPrefs;
};

/**
 * An action of whoever administers, in the members' header: a list, so the
 * invitations unit can add "Invitar con un enlace" (plan-cambios-11oct §8).
 */
export interface GroupAdminAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect(): void;
}

const TTL_LABELS: Readonly<Record<number, string>> = {
  0: 'groupPanel.ttlOff',
  30: 'groupPanel.ttl30s',
  300: 'groupPanel.ttl5m',
  3600: 'groupPanel.ttl1h',
  86400: 'groupPanel.ttl1d',
  604800: 'groupPanel.ttl1w',
};

/** Muted is a toggle: an icon of its own, bold, and the accent's border, also under forced colours. */
const PRESSED = 'border-ui-accent-text bg-ui-accent-soft font-bold text-ui-accent-text forced-colors:border-[color:Highlight]';

type Open =
  | null
  | { kind: 'invite' }
  | { kind: 'rename' }
  | { kind: 'leave' }
  | { kind: 'delete' }
  | { kind: 'remove'; member: GroupMemberView };

type Members = { status: 'off' } | { status: 'loading' } | { status: 'failed' } | { status: 'ready'; list: GroupMember[] };

export function GroupPanel({
  group,
  contacts,
  layout,
  onClose,
  onChanged,
  onOpenContact,
  onLeft,
  api,
  capabilities,
  isVerified = (handle, fingerprint) => prefs.isVerified(handle, fingerprint),
  groupPrefs = deviceGroupPrefs(),
}: GroupPanelProps) {
  const t = useT();
  const { lang } = useLang();
  const titleId = useId();
  const membersId = useId();
  const [open, setOpen] = useState<Open>(null);
  const [reload, setReload] = useState(0);
  const [members, setMembers] = useState<Members>({ status: capabilities.members ? 'loading' : 'off' });
  const [muted, setMuted] = useState(() => groupPrefs.isMuted(group.gid));
  const [ttl, setTtl] = useState(() => groupPrefs.getTtl(group.gid));

  const gid = group.gid;
  // The members are read again for another group, a new roster or a retry,
  // not because the shell passed the same API in a new object.
  const apiRef = useRef(api);
  useLayoutEffect(() => {
    apiRef.current = api;
  });
  // Read again for another group only: the settings object may be new on each render.
  const readSettings = () => {
    setMuted(groupPrefs.isMuted(gid));
    setTtl(groupPrefs.getTtl(gid));
  };
  useEffect(readSettings, [gid]);

  useEffect(() => {
    if (!capabilities.members) {
      setMembers({ status: 'off' });
      return;
    }
    let live = true;
    setMembers({ status: 'loading' });
    apiRef.current.groupMembers(gid).then(
      list => live && setMembers({ status: 'ready', list }),
      () => live && setMembers({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [gid, group.epoch, capabilities.members, reload]);

  const views = members.status === 'ready' ? buildMemberViews(members.list, isVerified, lang) : null;
  const ended = group.ended === true;
  const isAdmin = group.is_admin && !ended;
  const canInvite = isAdmin && members.status === 'ready';
  const canRemove = isAdmin && capabilities.manage && members.status === 'ready';
  const canRename = isAdmin && capabilities.manage;
  const canDelete = isAdmin && capabilities.manage;
  const canLeave = capabilities.manage && (!group.is_admin || ended);

  const count = views?.length ?? group.member_count;
  const admin = views?.find(view => view.isAdmin);
  const summary = [
    count === 1 ? t('groupPanel.memberCountOne') : t('groupPanel.memberCount', { n: count }),
    admin ? (admin.isSelf ? t('groupPanel.adminYou') : t('groupPanel.adminIs', { name: admin.name })) : null,
    !views && group.is_admin && !ended ? t('groupPanel.adminYou') : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const adminActions: GroupAdminAction[] = canInvite
    ? [{ id: 'invite', label: t('groupPanel.invite'), icon: UserPlus, onSelect: () => setOpen({ kind: 'invite' }) }]
    : [];

  const toggleMute = () => {
    const next = !muted;
    groupPrefs.setMuted(gid, next);
    setMuted(next);
  };
  const changeTtl = (seconds: number) => {
    groupPrefs.setTtl(gid, seconds);
    setTtl(seconds);
  };
  const refresh = () => {
    onChanged();
    setReload(n => n + 1);
  };
  // A time stored by another screen that is not among the options still shows as it is.
  const ttlOptions: readonly number[] = (GROUP_TTL_OPTIONS as readonly number[]).includes(ttl)
    ? GROUP_TTL_OPTIONS
    : [...GROUP_TTL_OPTIONS, ttl].sort((a, b) => a - b);
  const ttlLabel = (seconds: number) =>
    TTL_LABELS[seconds] !== undefined
      ? t(TTL_LABELS[seconds])
      : new Intl.NumberFormat(lang, { style: 'unit', unit: 'second', unitDisplay: 'long' }).format(seconds);

  const body = (
    <>
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar kind="group" initials={identityInitials(group.name)} size={80} />
        <div className="flex max-w-full items-center justify-center gap-1">
          <h2 id={titleId} className="m-0 min-w-0 font-ui-display text-ui-title font-bold text-ui-ink [overflow-wrap:anywhere]">
            {group.name}
          </h2>
          {canRename && (
            <IconButton
              aria-label={t('groupPanel.rename')}
              icon={<Pencil {...iconSize('md')} aria-hidden="true" />}
              variant="muted"
              onClick={() => setOpen({ kind: 'rename' })}
            />
          )}
        </div>
        <span className="text-ui-md text-ui-muted">{summary}</span>
      </div>

      {ended && <Banner tone="warn">{t('groupPanel.ended')}</Banner>}

      <div className="flex flex-wrap gap-2">
        <Button
          aria-pressed={muted}
          leadingIcon={muted ? <BellOff {...iconSize('md')} aria-hidden="true" /> : <Bell {...iconSize('md')} aria-hidden="true" />}
          onClick={toggleMute}
          className={cx('flex-[1_1_7.5rem]', muted && PRESSED)}
        >
          {t('groupPanel.mute')}
        </Button>
      </div>

      {!ended && (
        <div className="flex flex-col gap-1.5">
          <Field label={t('groupPanel.ttl')}>
            <Select value={String(ttl)} onChange={event => changeTtl(Number(event.target.value))} className="w-full">
              {ttlOptions.map(seconds => (
                <option key={seconds} value={String(seconds)}>
                  {ttlLabel(seconds)}
                </option>
              ))}
            </Select>
          </Field>
          <p className="m-0 text-ui-sm leading-normal text-ui-muted">
            {ttl > 0 ? t('groupPanel.ttlOn', { time: ttlLabel(ttl) }) : t('groupPanel.ttlOffNote')}
          </p>
        </div>
      )}

      {members.status !== 'off' && (
        <section aria-labelledby={membersId} className="flex flex-col gap-1">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h3 id={membersId} className="m-0 text-ui-lg font-bold text-ui-ink">
              {t('groupPanel.members')}
            </h3>
            {adminActions.map(action => {
              const Icon = action.icon;
              return (
                <Button
                  key={action.id}
                  variant="primary"
                  leadingIcon={<Icon {...iconSize('md')} aria-hidden="true" />}
                  onClick={() => action.onSelect()}
                >
                  {action.label}
                </Button>
              );
            })}
          </div>
          {members.status === 'loading' && (
            <p role="status" className="m-0 text-ui-md text-ui-muted">
              {t('groupPanel.membersLoading')}
            </p>
          )}
          {members.status === 'failed' && (
            <div className="flex flex-wrap items-center gap-3">
              <p role="alert" className={ERROR_LINE}>
                <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
                <span>{t('groupPanel.membersFailed')}</span>
              </p>
              <Button onClick={() => setReload(n => n + 1)}>{t('common2.retry')}</Button>
            </div>
          )}
          {views && (
            <ul aria-labelledby={membersId} className="m-0 flex list-none flex-col p-0">
              {views.map(view => (
                <GroupMemberRow
                  key={view.key}
                  member={view}
                  onWrite={onOpenContact}
                  onRemove={canRemove ? member => setOpen({ kind: 'remove', member }) : undefined}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="m-0 rounded-ui bg-ui-accent-soft px-3.5 py-3 text-ui-sm leading-normal text-ui-ink">
        {t('groupPanel.signed')}
      </p>

      {canLeave && (
        <Button
          variant="danger"
          fullWidth
          leadingIcon={<LogOut {...iconSize('md')} aria-hidden="true" />}
          onClick={() => setOpen({ kind: 'leave' })}
        >
          {t('groupPanel.leave')}
        </Button>
      )}
      {canDelete && (
        <Button
          variant="danger"
          fullWidth
          leadingIcon={<Trash2 {...iconSize('md')} aria-hidden="true" />}
          onClick={() => setOpen({ kind: 'delete' })}
        >
          {t('groupPanel.delete')}
        </Button>
      )}

      {open && renderOpen(open)}
    </>
  );

  function renderOpen(current: Exclude<Open, null>): ReactNode {
    const close = () => setOpen(null);
    switch (current.kind) {
      case 'invite':
        return (
          <InviteMembersDialog
            group={group}
            members={members.status === 'ready' ? members.list : []}
            contacts={contacts}
            api={api}
            onClose={close}
            onInvited={refresh}
          />
        );
      case 'rename':
        return (
          <RenameGroupDialog
            group={group}
            api={api}
            onClose={close}
            onRenamed={() => {
              close();
              onChanged();
            }}
          />
        );
      case 'leave':
      case 'delete':
        return (
          <ConfirmGroupExitDialog
            kind={current.kind}
            groupName={group.name}
            onCancel={close}
            onConfirm={async () => {
              await (current.kind === 'leave' ? api.leaveGroup(gid) : api.deleteGroup(gid));
              close();
              onLeft();
            }}
          />
        );
      case 'remove':
        return (
          <ConfirmGroupExitDialog
            kind="remove"
            groupName={group.name}
            memberName={current.member.name}
            onCancel={close}
            onConfirm={async () => {
              await api.removeGroupMember(gid, current.member.key);
              close();
              refresh();
            }}
          />
        );
    }
  }

  if (layout === 'dialog') {
    return (
      <Dialog open onClose={onClose} labelledBy={titleId} closeLabel={t('common2.close')}>
        <div className="flex flex-col gap-5">{body}</div>
      </Dialog>
    );
  }
  return (
    <aside
      aria-labelledby={titleId}
      className="relative flex h-full min-h-0 w-full flex-col gap-5 overflow-y-auto bg-ui-side px-5 py-6 font-ui text-ui-ink"
    >
      <IconButton
        aria-label={t('common2.close')}
        icon={<X {...iconSize('lg')} aria-hidden="true" />}
        onClick={onClose}
        className="absolute right-3 top-3"
      />
      {body}
    </aside>
  );
}
