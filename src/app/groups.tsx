/**
 * Groups in the old chats (plan §4, I4), until the redesigned shell (I6)
 * mounts W4's screens in its own slots.
 *
 * - The "+" of the groups list, and the button of the empty list, open
 *   "Nuevo grupo" (NewGroupDialog): a name and the contacts to add, one by
 *   one. A group created closes it, and so does answering a partial failure,
 *   since the group exists: the shell reads its groups again and opens it.
 * - "Detalles del grupo", in the header of the group on screen, where
 *   "agregar miembro" was, opens its details (GroupPanel): beside the chat
 *   from 70 rem, measured on the shell with the text size in effect
 *   (`layoutFor`, accesibilidad.md §4.7), and as a dialog below. Inviting
 *   goes through the details (InviteMembersDialog), which offer contacts by
 *   identity, never by the name in the roster. Beside the chat, the details
 *   take the focus as they open and give it back as they close; the dialog
 *   does both itself. Another conversation on screen closes them.
 * - The shell hears what changed: its groups are read again after a change
 *   made in the details and when the admin removes you or deletes the group
 *   (`group-removed`, K10), so the details say so; a group you left or
 *   deleted is forgotten by the backend, and the shell lets it go too;
 *   "Escribirle" opens that contact's chat.
 * - A group muted in its details neither sounds nor notifies: the shell's
 *   listeners ask `isMuted`, which reads this device's mark each time.
 * - By default the details show what this build's backend can do
 *   (src/app/capabilities.ts): the members (K9) and managing them (K10).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ROOT_PX } from '../design/apply';
import { layoutFor } from '../design/layout';
import { useAccessibility } from '../design/useAppearance';
import type { GroupInfo, GroupRemovedEvent, NodeInfo } from '../lib/api';
import { GroupPanel, NewGroupDialog, groupPrefs as deviceGroupPrefs, type GroupApi, type GroupPrefs } from '../screens/group';
import type { PanelLayout } from '../screens/types';
import { focusableWithin } from '../ui';
import { capabilities as buildCapabilities } from './capabilities';

/** The backend's events about groups, as src/lib/api.ts gives them. */
export interface GroupsEvents {
  /** The admin removed you from a group, or deleted it (K10): it is marked ended. */
  onGroupRemoved(cb: (event: GroupRemovedEvent) => void): Promise<() => void>;
}

export interface GroupsOptions {
  /** `api` of src/lib/api.ts fits it. */
  api: GroupApi;
  events: GroupsEvents;
  /** The shell's contacts: whom "Nuevo grupo" and "Invitar" offer. */
  contacts: readonly NodeInfo[];
  /** The group on screen: "Detalles del grupo" shows its details. */
  group: GroupInfo | undefined;
  /** A group was created, and "Nuevo grupo" closed: the shell reads its groups and opens it. */
  onCreated(gid: string): void;
  /** A member, the name or your place in a group changed: the shell reads its groups again. */
  onChanged(): void;
  /** "Escribirle" in the details, which closed: the shell opens that contact's chat. */
  onOpenContact(handle: string): void;
  /** You left the group or deleted it, and the backend forgot it: the shell forgets it too. */
  onLeft(gid: string): void;
  /** What this build's backend can do, unless a test says. */
  capabilities?: { members: boolean; manage: boolean };
  /** This device's group settings (mute and timer), unless a test brings its own. */
  groupPrefs?: GroupPrefs;
  /** Whether a contact is verified with this fingerprint; this device's marks unless a test says. */
  isVerified?(handle: string, fingerprint: string): boolean;
  /** The shell's width in px, unless it is measured (tests). */
  width?: number;
}

export interface Groups {
  /** Opens "Nuevo grupo". */
  openNew(): void;
  /** Opens the details of the group on screen. */
  openDetails(): void;
  /**
   * Whether `gid` is muted on this device, so its messages neither sound nor
   * notify. The same function on every render, reading the mark each time:
   * listeners set up once may keep it.
   */
  isMuted(gid: string): boolean;
  /** For the shell's root: its width decides where the details go. */
  shellRef: RefObject<HTMLDivElement | null>;
  /** The details beside the chat on a wide shell, else nothing. */
  aside: ReactNode;
  /** "Nuevo grupo", and the details as a dialog on a narrower shell. */
  dialogs: ReactNode;
}

/** This device's group settings, read from storage on every call. */
const DEVICE_GROUP_PREFS = deviceGroupPrefs();

/** The width of an element in px, followed while it changes; null before it is known. */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const measured = element.getBoundingClientRect().width;
    if (measured > 0) setWidth(measured);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return width;
}

export function useGroups(options: GroupsOptions): Groups {
  // The handlers are read when they fire, so the shell may pass new ones on
  // every render without listening again.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { effective } = useAccessibility();
  const shellRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(shellRef, options.width === undefined);
  const layout: PanelLayout =
    layoutFor(options.width ?? measured ?? window.innerWidth, ROOT_PX * effective.textScale) === 'double-aside'
      ? 'aside'
      : 'dialog';

  const [newOpen, setNewOpen] = useState(false);
  /** The group whose details are open; they close when another conversation is on screen. */
  const [detailsOf, setDetailsOf] = useState<string | null>(null);
  /** Each "Detalles del grupo" sends the focus into the details beside the chat. */
  const [focusAsk, setFocusAsk] = useState(0);
  /** What had the focus when the details opened: it gets it back when they are closed. */
  const opener = useRef<Element | null>(null);
  const giveFocusBack = useRef(false);
  const asideRef = useRef<HTMLDivElement>(null);

  const group = options.group;
  const shown = detailsOf !== null && group?.gid === detailsOf ? group : undefined;
  const asideShown = shown !== undefined && layout === 'aside';

  // Another conversation, or none: the details close, and stay closed.
  useEffect(() => {
    if (detailsOf === null || group?.gid === detailsOf) return;
    opener.current = null;
    setDetailsOf(null);
  }, [detailsOf, group?.gid]);

  // A passive effect, so it runs after a dialog that just went away (the
  // details on a narrower window) gave the focus back to its opener.
  useEffect(() => {
    const aside = asideRef.current;
    if (!asideShown || !aside) return;
    (focusableWithin(aside)[0] ?? aside).focus();
  }, [asideShown, focusAsk]);

  // After the render that took the details away, so their opener is back.
  useEffect(() => {
    if (detailsOf !== null || !giveFocusBack.current) return;
    giveFocusBack.current = false;
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, [detailsOf]);

  // A group you were removed from stays, ended: read it again, so its
  // details say so (K10 tells only through `group-removed`).
  useEffect(() => {
    let active = true;
    let stop: (() => void) | undefined;
    latest.current.events.onGroupRemoved(() => latest.current.onChanged()).then(
      unlisten => {
        if (active) stop = unlisten;
        else unlisten();
      },
      (error: unknown) => console.error('listening to group-removed failed', error),
    );
    return () => {
      active = false;
      stop?.();
    };
  }, []);

  const openDetails = () => {
    const gid = latest.current.group?.gid;
    if (gid === undefined) return;
    if (detailsOf === null) opener.current = document.activeElement;
    setDetailsOf(gid);
    setFocusAsk(n => n + 1);
  };

  const isMuted = useCallback((gid: string) => (latest.current.groupPrefs ?? DEVICE_GROUP_PREFS).isMuted(gid), []);

  const groupPrefs = options.groupPrefs ?? DEVICE_GROUP_PREFS;
  const capabilities = options.capabilities ?? {
    members: buildCapabilities.groupMembers,
    manage: buildCapabilities.manageGroups,
  };

  const panel = shown ? (
    <GroupPanel
      group={shown}
      contacts={options.contacts}
      layout={layout}
      onClose={() => {
        giveFocusBack.current = true;
        setDetailsOf(null);
      }}
      onChanged={() => latest.current.onChanged()}
      onOpenContact={handle => {
        opener.current = null;
        setDetailsOf(null);
        latest.current.onOpenContact(handle);
      }}
      onLeft={() => {
        opener.current = null;
        setDetailsOf(null);
        latest.current.onLeft(shown.gid);
      }}
      api={options.api}
      capabilities={capabilities}
      groupPrefs={groupPrefs}
      {...(options.isVerified && { isVerified: options.isVerified })}
    />
  ) : null;

  const aside = asideShown ? (
    <div ref={asideRef} className="flex h-full min-h-0 w-[21.25rem] shrink-0 flex-col border-s border-ui-line">
      {panel}
    </div>
  ) : null;

  const dialogs = (
    <>
      {layout === 'dialog' && panel}
      {newOpen && (
        <NewGroupDialog
          contacts={options.contacts}
          api={options.api}
          groupPrefs={groupPrefs}
          onClose={() => setNewOpen(false)}
          onCreated={gid => {
            setNewOpen(false);
            latest.current.onCreated(gid);
          }}
        />
      )}
    </>
  );

  return { openNew: () => setNewOpen(true), openDetails, isMuted, shellRef, aside, dialogs };
}
