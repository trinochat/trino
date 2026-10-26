/**
 * The details of a contact (plan §3 W5): no board draws them, so they follow
 * the patterns of the group's panel (Group.dc.html). As an aside beside the
 * chat from 70 rem, as a dialog below (`layout`, from the shell).
 *
 * - Who: the photo the contact shares (`node.avatar`), the name you gave
 *   them, how much you trust them and "Verificar", which opens the
 *   verification of the call unit.
 * - What they share (K12): their "Sobre mí", and the name they gave
 *   themselves when it differs from yours, with "Usar este nombre" when a
 *   contact can have that name here (`isContactName`: not a group's or the
 *   channel's key, and not too long). Their name never replaces yours on
 *   its own (plan-cambios-11oct §10).
 * - Yours, on this device: a private note and the timer of your new
 *   messages in this chat, in the device's preferences.
 * - Block, after its confirmation (uso responsable UR-2, PropBloquear card
 *   3: `BlockDialog`), and unblock, which says what does not come back
 *   (R-24); and remove after an alert dialog.
 *
 * Renaming and removing move or forget what the preferences keep for the
 * contact (its note, timer and verification), then tell the shell.
 */
import { Ban, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { convoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';
import { prefs as devicePrefs, type Prefs } from '../../lib/prefs';
import { Avatar, Button, Dialog, Field, iconSize, IconButton, Select, Textarea, TrustBadge } from '../../ui';
import { BlockDialog, type BlockDialogApi } from '../block/BlockDialog';
import { ErrorLine } from '../settings/ErrorLine';
import type { ContactDetailsSlotProps, Trust } from '../types';
import { isContactName, RenameContactDialog, renameErrorOf } from './RenameContactDialog';

export interface ContactDetailsApi extends BlockDialogApi {
  renameNode(oldHandle: string, newHandle: string): Promise<void>;
  removeNode(handle: string): Promise<void>;
  /** Unblocking, by identity: every block that names this contact goes. */
  blockNode(handle: string, blocked: boolean): Promise<void>;
}

export type ContactDetailsPanelProps = ContactDetailsSlotProps & {
  api: ContactDetailsApi;
  /** The preferences of this device: the real ones unless a test passes its own. */
  prefs?: Prefs;
};

/** The timers of the old panel, in seconds; 0 is off. */
const TIMERS: ReadonlyArray<readonly [seconds: number, label: string]> = [
  [0, 'contactInfo.ttlOff'],
  [30, 'contactInfo.ttl30s'],
  [300, 'contactInfo.ttl5m'],
  [3600, 'contactInfo.ttl1h'],
  [86400, 'contactInfo.ttl1d'],
  [604800, 'contactInfo.ttl1w'],
];

const TRUST_LABELS: Record<Trust, string> = {
  verified: 'contactInfo.verified',
  unverified: 'contactInfo.unverified',
  keyChanged: 'contactInfo.keyChanged',
};

/** The old panel let a note grow this long. */
const NOTE_MAX = 500;

export function ContactDetailsPanel({
  node,
  trust,
  layout,
  api,
  prefs = devicePrefs,
  onClose,
  onVerify,
  onRenamed,
  onRemoved,
  onChanged,
}: ContactDetailsPanelProps) {
  const t = useT();
  const handle = node.handle;
  const key = convoKey({ kind: 'contact', handle });
  const nameId = useId();
  const timerId = useId();
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [note, setNote] = useState(() => prefs.getNote(handle));
  const [ttl, setTtl] = useState(() => prefs.getTtl(key));
  const [blocked, setBlocked] = useState(node.blocked === true);
  const [dialog, setDialog] = useState<'rename' | 'remove' | 'block' | null>(null);
  /** What blocking or unblocking just did, said once until another contact shows. */
  const [blockNote, setBlockNote] = useState<'block.done' | 'block.unblocked' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'block' | 'name' | 'remove' | null>(null);
  const [removeFailed, setRemoveFailed] = useState(false);
  const [shownFor, setShownFor] = useState(handle);

  // Another contact in the same panel (or this one renamed): read what this
  // device keeps for them now, before anything of the last one shows or is
  // written under their name.
  if (shownFor !== handle) {
    setShownFor(handle);
    setNote(prefs.getNote(handle));
    setTtl(prefs.getTtl(key));
    setBlocked(node.blocked === true);
    setDialog(null);
    setBlockNote(null);
    setError(null);
    setRemoveFailed(false);
  }

  // The shell sends the contact again after a change.
  useEffect(() => setBlocked(node.blocked === true), [node.blocked]);

  const renamed = async (oldName: string, newName: string) => {
    await api.renameNode(oldName, newName);
    prefs.renameContact(oldName, newName);
  };

  const adoptProfileName = async (profileName: string) => {
    setBusy('name');
    setError(null);
    try {
      await renamed(handle, profileName);
      onRenamed(profileName);
      // "Usar este nombre" goes away once the name is theirs.
      renameButton.current?.focus();
    } catch (cause) {
      setError(renameErrorOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const unblock = async () => {
    setBusy('block');
    setError(null);
    setBlockNote(null);
    try {
      await api.blockNode(handle, false);
      setBlocked(false);
      setBlockNote('block.unblocked');
      onChanged();
    } catch {
      setError('contactInfo.errBlock');
    } finally {
      setBusy(null);
    }
  };

  const blockedNow = () => {
    setDialog(null);
    setBlocked(true);
    setBlockNote('block.done');
    onChanged();
  };

  const remove = async () => {
    setBusy('remove');
    setRemoveFailed(false);
    try {
      await api.removeNode(handle);
      prefs.forgetContact(handle);
      onRemoved();
    } catch {
      setRemoveFailed(true);
      setBusy(null);
    }
  };

  const timerLabel = TIMERS.find(([seconds]) => seconds === ttl)?.[1];
  const profileName = node.profile_name?.trim();
  const about = node.about?.trim();

  const body = (
    <div className="flex flex-col gap-5 font-ui text-ui-ink">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar size={80} src={node.avatar ?? undefined} initials={identityInitials(handle)} />
        <h2 id={nameId} className="m-0 font-ui-display text-ui-title font-bold [overflow-wrap:anywhere]">
          {handle}
        </h2>
        <TrustBadge
          kind={trust}
          label={t(TRUST_LABELS[trust])}
          className="justify-center"
          action={
            <Button onClick={onVerify}>
              {t(trust === 'verified' ? 'contactInfo.viewVerification' : 'contactInfo.verify')}
            </Button>
          }
        />
      </div>

      {about ? (
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-ui-md font-semibold text-ui-muted">{t('contactInfo.about')}</h3>
          <p className="m-0 text-ui-base leading-normal [overflow-wrap:anywhere]">{about}</p>
        </div>
      ) : null}

      {profileName && profileName !== handle ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="m-0 min-w-0 flex-[1_1_12rem] text-ui-md text-ui-muted [overflow-wrap:anywhere]">
            {t('contactInfo.profileName', { name: profileName })}
          </p>
          {isContactName(profileName) ? (
            <Button loading={busy === 'name'} onClick={() => void adoptProfileName(profileName)}>
              {t('contactInfo.useProfileName')}
            </Button>
          ) : null}
        </div>
      ) : null}

      <Button
        ref={renameButton}
        className="self-start"
        leadingIcon={<Pencil {...iconSize('md')} />}
        onClick={() => setDialog('rename')}
      >
        {t('contactInfo.rename')}
      </Button>

      <Field label={t('contactInfo.note')} hint={t('contactInfo.noteHint')}>
        <Textarea
          minRows={2}
          maxRows={5}
          maxLength={NOTE_MAX}
          value={note}
          onChange={event => {
            setNote(event.target.value);
            prefs.setNote(handle, event.target.value);
          }}
        />
      </Field>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={timerId} className="flex-[1_1_8.75rem] text-ui-base font-semibold">
            {t('contactInfo.ttl')}
          </label>
          <Select
            id={timerId}
            aria-describedby={`${timerId}-body`}
            value={String(ttl)}
            onChange={event => {
              const seconds = Number(event.target.value);
              setTtl(seconds);
              prefs.setTtl(key, seconds);
              onChanged();
            }}
          >
            {TIMERS.map(([seconds, label]) => (
              <option key={seconds} value={String(seconds)}>
                {t(label)}
              </option>
            ))}
            {timerLabel === undefined ? <option value={String(ttl)}>{ttl}</option> : null}
          </Select>
        </div>
        <p id={`${timerId}-body`} className="m-0 text-ui-md text-ui-muted">
          {ttl > 0 && timerLabel
            ? t('contactInfo.ttlOn', { time: t(timerLabel) })
            : t('contactInfo.ttlOffBody')}
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-ui-line pt-4">
        <p className="m-0 text-ui-md text-ui-muted">
          {blocked ? t('contactInfo.blockedBody', { name: handle }) : t('contactInfo.blockBody')}
        </p>
        <Button
          className="self-start"
          leadingIcon={<Ban {...iconSize('md')} />}
          loading={busy === 'block'}
          onClick={() => {
            if (blocked) void unblock();
            else {
              setBlockNote(null);
              setDialog('block');
            }
          }}
        >
          {t(blocked ? 'contactInfo.unblock' : 'contactInfo.block')}
        </Button>
        {blockNote ? (
          <p role="status" className="m-0 text-ui-md leading-normal text-ui-ink">
            {t(blockNote, { name: handle })}
          </p>
        ) : null}
      </div>

      {error ? <ErrorLine>{t(error)}</ErrorLine> : null}

      <Button variant="danger" onClick={() => setDialog('remove')}>
        {t('contactInfo.remove')}
      </Button>

      {dialog === 'block' ? (
        <BlockDialog
          target={{ kind: 'contact', handle }}
          name={handle}
          api={api}
          onBlocked={blockedNow}
          onClose={() => setDialog(null)}
          onLeftGroup={() => onChanged()}
        />
      ) : null}
      {dialog === 'rename' ? (
        <RenameContactDialog
          name={handle}
          rename={renamed}
          onClose={() => setDialog(null)}
          onRenamed={newName => {
            setDialog(null);
            onRenamed(newName);
          }}
        />
      ) : null}
      {dialog === 'remove' ? (
        <Dialog
          open
          role="alertdialog"
          onClose={() => {
            if (busy !== 'remove') setDialog(null);
          }}
          initialFocusRef={cancelRemove}
          title={t('contactInfo.removeTitle', { name: handle })}
          description={t('contactInfo.removeBody')}
        >
          {removeFailed ? <ErrorLine>{t('contactInfo.errRemove')}</ErrorLine> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button ref={cancelRemove} disabled={busy === 'remove'} onClick={() => setDialog(null)}>
              {t('common2.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              leadingIcon={<Trash2 {...iconSize('md')} />}
              loading={busy === 'remove'}
              onClick={() => void remove()}
            >
              {t('contactInfo.remove')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );

  if (layout === 'dialog') {
    return (
      <Dialog open onClose={onClose} labelledBy={nameId} closeLabel={t('contactInfo.close')}>
        {body}
      </Dialog>
    );
  }
  return (
    <Aside labelledBy={nameId} closeLabel={t('contactInfo.close')} onClose={onClose}>
      {body}
    </Aside>
  );
}

/** The panel beside the chat (Group.dc.html:70): the side colour, its own scroll, a close button. */
function Aside({
  labelledBy,
  closeLabel,
  onClose,
  children,
}: {
  labelledBy: string;
  closeLabel: string;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <aside aria-labelledby={labelledBy} className="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-ui-side">
      <div className="flex justify-end px-3 pt-3">
        <IconButton aria-label={closeLabel} icon={<X {...iconSize('lg')} />} onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">{children}</div>
    </aside>
  );
}
