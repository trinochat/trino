/**
 * Contactos in the old chats (plan §4, I3). ContactsDialog (W4) opens on
 * "Agregar" from the add buttons and, once, when the first run ended with
 * "Agregar un contacto"; on "Mi código" from the share button; and on
 * "Invitaciones" from the notice of waiting invitations. An invitation no
 * longer opens a dialog of its own as it arrives: it waits in Contactos
 * until it is answered.
 *
 * The shell hears what changed. A contact added and a group joined close
 * Contactos, and the shell reads its contacts or groups again and opens the
 * chat. Any answer to an invitation, a failed one too, may have changed the
 * groups: the backend takes the invitation out either way, and a join that
 * failed on a write may have joined the group in memory. So the invitations
 * are read again here, and the groups by the shell.
 *
 * I6 hands this to the redesigned shell, which keeps the invitations and the
 * strangers itself (ShellScreen) and mounts the same dialog in its slot.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { GroupInvite, HandshakeNeededEvent } from '../lib/api';
import { ContactsDialog, type ContactsApi } from '../screens/contacts';
import type { ContactsTab, OnboardingIntent } from '../screens/types';
import { downloadBlob } from './download';

/** What the contacts ask of the backend: `api` of src/lib/api.ts fits it. */
export interface ContactsBackend extends ContactsApi {
  listGroupInvites(): Promise<GroupInvite[]>;
}

/** The backend's events about contacts, as src/lib/api.ts gives them. */
export interface ContactsEvents {
  /** A contact invited you to a group. */
  onGroupInvite(cb: (invite: GroupInvite) => void): Promise<() => void>;
  /** Someone who is not a contact tried to write; the backend dropped it. */
  onHandshakeNeeded(cb: (event: HandshakeNeededEvent) => void): Promise<() => void>;
}

export interface ContactsOptions {
  api: ContactsBackend;
  events: ContactsEvents;
  /** How the first run ended: 'add-contact' opens Contactos on "Agregar", once. */
  intent: OnboardingIntent;
  /** A contact was added, and Contactos closed. */
  onContactAdded(handle: string): void;
  /** A group was joined, and Contactos closed. */
  onGroupJoined(gid: string): void;
  /** An invitation was answered, or an answer failed: the groups may have changed. */
  onGroupsChanged(): void;
  /** Saves the QR's PNG; the webview's download unless a test brings its own. */
  download?(name: string, blob: Blob): void;
}

export interface Contacts {
  /** Opens Contactos on a tab, or moves it there. */
  open(tab: ContactsTab): void;
  /** The group invitations waiting for an answer, for the shell's notice. */
  invites: readonly GroupInvite[];
  /** Contactos while it is open, else nothing. */
  dialog: ReactNode;
}

/**
 * Listens through a backend subscription, which answers with its unlisten
 * function later: the function returned stops it now, or once it is ready.
 */
function listen(subscription: Promise<() => void>): () => void {
  let active = true;
  let stop: (() => void) | undefined;
  subscription.then(
    unlisten => {
      if (active) stop = unlisten;
      else unlisten();
    },
    (error: unknown) => console.error('listening to a backend event failed', error),
  );
  return () => {
    active = false;
    stop?.();
  };
}

export function useContacts(options: ContactsOptions): Contacts {
  // The handlers are read when they fire, so the shell may pass new ones on
  // every render without listening again.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const [tab, setTab] = useState<ContactsTab | null>(() => (options.intent === 'add-contact' ? 'add' : null));
  const [invites, setInvites] = useState<readonly GroupInvite[]>([]);
  /** Each key that tried to write in this session, counted once; nothing is kept after locking. */
  const [strangers, setStrangers] = useState<ReadonlySet<string>>(() => new Set());

  const refreshInvites = useCallback(() => {
    latest.current.api
      .listGroupInvites()
      .then(setInvites, (error: unknown) => console.error('listGroupInvites failed', error));
  }, []);

  // Invitations can arrive before this listens (the catch-up after
  // unlocking), so the waiting ones are asked for as well.
  useEffect(() => {
    refreshInvites();
    const { events } = latest.current;
    const stops = [
      listen(
        events.onGroupInvite(invite =>
          setInvites(current => {
            const index = current.findIndex(other => other.gid === invite.gid);
            return index < 0 ? [...current, invite] : current.map((other, i) => (i === index ? invite : other));
          }),
        ),
      ),
      listen(
        events.onHandshakeNeeded(({ from_pubkey }) =>
          setStrangers(current => (current.has(from_pubkey) ? current : new Set(current).add(from_pubkey))),
        ),
      ),
    ];
    return () => stops.forEach(stop => stop());
  }, [refreshInvites]);

  const dialog =
    tab === null ? null : (
      <ContactsDialog
        api={options.api}
        download={options.download ?? downloadBlob}
        tab={tab}
        onTabChange={setTab}
        onClose={() => setTab(null)}
        invites={invites}
        strangerAttempts={strangers.size}
        onContactAdded={handle => {
          setTab(null);
          latest.current.onContactAdded(handle);
        }}
        onGroupJoined={gid => {
          setTab(null);
          latest.current.onGroupJoined(gid);
        }}
        onInvitesChanged={() => {
          refreshInvites();
          latest.current.onGroupsChanged();
        }}
      />
    );

  return { open: setTab, invites, dialog };
}
