/**
 * The main screen of the redesign (W2): the sidebar and the conversation, and
 * the screens of the other units mounted through their slots (types.ts). The
 * call bar goes above both panes and the call layer over everything; the
 * chat is mounted with its conversation's key, so nothing of one chat (its
 * reply, its composer) shows in the next. Settings opens in the main pane;
 * the details of a contact or a group sit beside the chat from 70 rem and in
 * a dialog below. Under 47.5 rem there is one pane, with Atrás.
 *
 * While the call screen covers the shell (`call.covering`), all of it but the
 * call layer is inert: the bar's row, the banners, the panes and the details
 * beside the chat. The shell's dialogs close as the call screen comes up, and
 * as it goes the conversation takes a focus that fell to the page.
 *
 * The focus follows the panes. A pane that leaves takes its focused control
 * with it, so the conversation one pane opens takes the focus (the main
 * pane, named for what it shows), and Atrás gives it back to the row the
 * conversation came from. Under "No leídos" the chat just opened stays
 * listed, read, until the chip or the chat changes.
 *
 * Tor (TOR-6): with the network (`net`), the inbox shows its one line
 * (net-model.ts), "Ver qué hacer" opens "No se pudo conectar", and its
 * "Conectar sin protección…" asks first (card 5); nothing goes without Tor
 * on its own. A new version shows as a compact notice under the line (card
 * 8). When Arti is too old for the Tor network, "Trino necesita
 * actualizarse" (card 9) opens once by itself and then from "Ver qué hacer".
 *
 * What renders again (FIX-2): the inbox gets the same props for as long as
 * what it shows stays the same, so a dialog, a switch between sections of
 * Settings (whose section is SettingsPane's) or the details beside a chat
 * leave its list alone. Tor's state and the updater's are followed by what
 * shows them (ShellInbox, the dialogs, ObsoleteWatch), never by the shell.
 *
 * Ctrl+K goes back to Chats and to the search. Ctrl+L, which locks, is the
 * app's (App.tsx), as is the lock itself.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { THEMES } from '../../design/tokens';
import { useAppearance } from '../../design/useAppearance';
import { loadAnnouncementFeed, type AnnouncementFeed } from '../../lib/announcements';
import type { BlockTarget, NodeInfo } from '../../lib/api';
import type { NetStatus } from '../../lib/net';
import { convoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { prefs as devicePrefs } from '../../lib/prefs';
import { Banner, Button, cx } from '../../ui';
import { NoChatSelected } from '../chat/NoChatSelected';
import { buildInboxItems } from '../inbox/inbox-model';
import type { CallFilter } from '../inbox/call-history-model';
import type { CallRowView } from '../inbox/CallRow';
import type { InboxRowActions } from '../inbox/InboxList';
import type { InboxTab } from '../inbox/InboxTabs';
import type {
  CallSlot,
  ChatHeaderInfo,
  ChatPaneProps,
  ContactsTab,
  ConvoRef,
  InboxFilter,
  NewChatPurpose,
  Notifier,
  OnboardingIntent,
  PanelLayout,
  SettingsSectionId,
  SettingsSlotProps,
  ShellSlots,
} from '../types';
import { ShellInbox } from './ShellInbox';
import { useDrafts } from './drafts';
import { ForwardDialog } from './ForwardDialog';
import { useShellLayout } from './layout';
import { nowSeconds } from './listen';
import type { ShellApi, ShellCapabilities, ShellEvents, ShellPrefs } from './shell-api';
import { stickerApi } from './stickers';
import { useAnnouncements } from './useAnnouncements';
import { useCallLog } from './useCallLog';
import { useConnection } from './useConnection';
import { shellErrorText } from './shell-error';
import { useConversations, type ShellError } from './useConversations';
import { ConnectFailedDialog } from '../net/ConnectFailedDialog';
import type { NetScreensApi } from '../net/net-api';
import { useNetStatus } from '../net/useNetStatus';
import { UpdateNeededDialog } from '../net/UpdateNeededDialog';
import { WithoutTorDialog } from '../net/WithoutTorDialog';
import { useInvites } from './useInvites';
import { useStrangerAttempts } from './useStrangerAttempts';
import { BlockDialog, type BlockDialogApi } from '../block/BlockDialog';
import { RequestPane, RequestsList, useRequests, type RequestsApi } from '../requests';
import { ReportDialog, type ReportDialogApi } from '../report/ReportDialog';
import { candidatesOf, type ReportCandidate } from '../report/report-model';
import { clipboard } from '../../lib/clipboard';
import type { GroupMember } from '../../lib/api';
import type { Msg } from '../types';

/**
 * Reportar (UR-5): the dialog's backend, and the members of a group, to name
 * whoever wrote a message there by their key.
 */
export type ShellReportApi = ReportDialogApi & { groupMembers?(gid: string): Promise<GroupMember[]> };

/**
 * The longest text the composer sends, as it counts. The relays drop events
 * over 64 KB without a word, and the text grows on its way: the `trm1:`
 * envelope, then the encrypted payload. This keeps even text of 3 bytes per
 * character under that; the backend's `message_too_long` (K4) has the last word.
 */
export const MAX_TEXT_LENGTH = 6_000;

export interface ShellScreenProps {
  me: { handle: string; avatar: string | null; fingerprint: string; identityDigest: string | null };
  api: ShellApi;
  /** Blocking from a row's menu (UR-2) and from a request (UR-4); without it neither offers Bloquear. */
  block?: BlockDialogApi;
  /** Solicitudes (UR-4); without it there is no row of them and nothing is asked. */
  requests?: RequestsApi;
  /** Reportar (UR-5); without it nothing offers Reportar. */
  report?: ShellReportApi;
  events: ShellEvents;
  slots: ShellSlots;
  call: CallSlot;
  notifier: Notifier;
  capabilities: ShellCapabilities;
  onLock(): void;
  initialIntent: OnboardingIntent;
  openLink(url: string): void;
  isWindowFocused(): boolean;
  /** What only the app does for Settings: after a wipe or a profile change, the auto-lock, and the QR panel of W4. */
  settings: Pick<SettingsSlotProps, 'onIdentityWiped' | 'onProfileChanged' | 'onAutolockChanged' | 'renderShareCode'>;
  /**
   * The contacts, each time the shell reads them: the app keeps the calls,
   * which need to know who a call is with, and the notice about old
   * verification marks.
   */
  onContactsChange?(contacts: readonly NodeInfo[]): void;
  /** The preferences of this device; lib/prefs by default. */
  prefs?: ShellPrefs;
  /** The announcements feed; lib/announcements by default. */
  loadFeed?(): Promise<AnnouncementFeed>;
  /** Tor's state and commands (TOR-6); without it nothing of Tor shows. */
  net?: NetScreensApi;
  /** For tests: the shell's width in px, measured otherwise. */
  width?: number;
  /** For tests: the root size in px, 16 times the text size otherwise. */
  rootPx?: number;
}

type Overlay =
  | { kind: 'contacts'; tab: ContactsTab }
  | { kind: 'newGroup' }
  | { kind: 'newChat'; purpose: NewChatPurpose }
  | { kind: 'verify'; handle: string }
  | { kind: 'forward'; from: ConvoRef; key: string }
  /** "No se pudo conectar" (card 3), then its question (card 5). */
  | { kind: 'torFailed' }
  | { kind: 'withoutTor' }
  /** "Trino necesita actualizarse" (card 9): Arti too old for the Tor network. */
  | { kind: 'updateNeeded' }
  /**
   * The confirmation to block someone (UR-2, PropBloquear card 1): a contact
   * from its row's menu, or whoever sent a request (UR-4).
   */
  | { kind: 'block'; target: BlockTarget; name: string }
  /**
   * The report (UR-5, PropReportar): of a contact, a member or whoever sent
   * a request, with what of their chat may go; `mustBlock` from the block's
   * "Reportar también".
   */
  | {
      kind: 'report';
      target: BlockTarget;
      name: string;
      candidates: readonly ReportCandidate[];
      initial?: string;
      mustBlock?: boolean;
    };

/** Where the focus goes once a change took the control that had it off the page. */
type FocusTarget = 'main' | 'settings' | { row: string | null };

/**
 * The same function on every render, which calls the latest `fn`: for the
 * props of the memoized inbox, whose handlers read the shell's state of the
 * render they were made in.
 */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

/**
 * Settings in the main pane, with its section: held here, so a switch
 * between sections renders Settings alone and not the shell (FIX-2). The
 * shell keeps the last one in `remember`, and Settings opens there again.
 */
function SettingsPane({
  slot,
  remember,
  ...props
}: Omit<SettingsSlotProps, 'section' | 'onSectionChange'> & {
  slot: ShellSlots['settings'];
  remember: MutableRefObject<SettingsSectionId>;
}) {
  const [section, setSection] = useState(remember.current);
  const onSectionChange = useCallback(
    (id: SettingsSectionId) => {
      remember.current = id;
      setSection(id);
    },
    [remember],
  );
  return slot({ section, onSectionChange, ...props });
}

/**
 * Tells the shell whether Arti is too old for the Tor network (card 9), and
 * shows nothing: the shell renders again only when that changes, not on
 * each `net-changed`.
 */
function ObsoleteWatch({ net, onChange }: { net: NetScreensApi; onChange(obsolete: boolean): void }) {
  const obsolete = useNetStatus(net)?.state === 'obsolete';
  useEffect(() => onChange(obsolete), [obsolete, onChange]);
  return null;
}

/** A dialog that shows Tor's state follows it itself, not through the shell. */
function WithNetStatus({ net, children }: { net: NetScreensApi; children(status: NetStatus | null): ReactNode }) {
  return <>{children(useNetStatus(net))}</>;
}

export function ShellScreen(props: ShellScreenProps) {
  const { api, events, slots, call, capabilities } = props;
  const prefs = props.prefs ?? devicePrefs;
  const t = useT();
  const { appearance } = useAppearance();
  const rootRef = useRef<HTMLDivElement>(null);
  const layout = useShellLayout(rootRef, props.width, props.rootPx);
  const single = layout === 'single';
  const latest = useRef(props);
  latest.current = props;

  const [open, setOpen] = useState<ConvoRef | null>(null);
  const [main, setMain] = useState<'convo' | 'settings' | 'request'>('convo');
  /** What the sidebar lists: the chats, or Solicitudes in their place (UR-4). */
  const [side, setSide] = useState<'chats' | 'requests'>('chats');
  /** The request open in the main pane, by its key. */
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  /** What the main pane says once a request went: deleted, or its sender blocked. */
  const [requestDone, setRequestDone] = useState<string | null>(null);
  /** The section Settings was on: SettingsPane's, kept here for when it opens again. */
  const section = useRef<SettingsSectionId>('profile');
  const [pane, setPane] = useState<'list' | 'main'>('list');
  const [details, setDetails] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | null>(() =>
    props.initialIntent === 'add-contact' ? { kind: 'contacts', tab: 'add' } : null,
  );
  const [tab, setTab] = useState<InboxTab>('chats');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [search, setSearch] = useState('');
  const [callFilter, setCallFilter] = useState<CallFilter>('all');
  /** The call whose chat was opened from the log, to keep its row marked. */
  const [fromCall, setFromCall] = useState<{ key: string; peer: string } | null>(null);
  const [error, setError] = useState<ShellError | null>(null);
  /** "Intentó escribirte" was seen this session: it does not come back (R-30). */
  const [strangersTold, setStrangersTold] = useState(false);
  /** Groups muted from the inbox's menu: each one renders the shell again, which reads the marks anew. */
  const [, setMutes] = useState(0);
  const [searchFocus, setSearchFocus] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  /** The chat opened from the list: listed under any chip until the chip or the chat changes. */
  const [kept, setKept] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const settingsRef = useRef<HTMLButtonElement>(null);
  /**
   * Set by a change that can take the focused control off the page: one pane
   * swaps the list and the conversation, and a closing panel takes its
   * buttons along. Applied after the render that makes the change, and only
   * if the focus fell to the page: a dialog that gave it back to its opener
   * keeps it there. It is state, a new object each time, so only the effect
   * of that render applies it. React runs any effects still pending from an
   * earlier render (one that took longer than its slice) before it renders
   * a click; as a ref, the request was taken there, with the control still
   * on the page, and the focus then fell to the page.
   */
  const [focusNext, setFocusNext] = useState<{ target: FocusTarget } | null>(null);
  const moveFocus = (target: FocusTarget) => setFocusNext({ target });

  // The call screen came up over the shell (W6): the shell's dialogs and
  // the details shown as a dialog close in this very render. They are
  // portals above the call screen, where `inert` does not reach, and closed
  // any later they would show over it and give the focus back behind it.
  // The details beside the chat stay, inert with the panes.
  const [covered, setCovered] = useState(call.covering);
  if (covered !== call.covering) {
    setCovered(call.covering);
    if (call.covering) {
      setOverlay(null);
      if (layout !== 'double-aside') setDetails(false);
    }
  }

  const openKey = open ? convoKey(open) : null;
  const listShown = !single || pane === 'list';
  const mainShown = !single || pane === 'main';
  /** The conversation on screen: what arrives there is read as it comes. */
  const shownKey = mainShown && main === 'convo' ? openKey : null;
  const logShown = capabilities.callLog && listShown && tab === 'calls';
  const logShownRef = useRef(logShown);
  logShownRef.current = logShown;
  const shownKeyRef = useRef(shownKey);
  shownKeyRef.current = shownKey;

  const conv = useConversations({
    api,
    events,
    prefs,
    notifier: props.notifier,
    capabilities,
    isWindowFocused: props.isWindowFocused,
    openKey: shownKey,
    t,
    onError: setError,
  });
  const { drafts, setDraft, moveDraft } = useDrafts();
  const connection = useConnection(api, events, capabilities.connection);
  const net = props.net ?? null;
  /** Arti too old for the Tor network, as ObsoleteWatch tells. */
  const [obsolete, setObsolete] = useState(false);
  /** The update state "Más tarde" was pressed on (card 8), which ShellInbox leaves hidden. */
  const [updateLater, setUpdateLater] = useState<string | null>(null);
  const channel = useAnnouncements(props.loadFeed ?? loadAnnouncementFeed, prefs);
  const strangers = useStrangerAttempts(events);
  const invites = useInvites(api, events);
  const reqs = useRequests(props.requests ?? null);
  const callLog = useCallLog({
    api,
    events,
    prefs,
    enabled: capabilities.callLog,
    watching: () => logShownRef.current && latest.current.isWindowFocused(),
    // The chats' cleanup clock: a call leaves the log when it leaves its chat.
    now: conv.now,
  });
  // One object for as long as the API is the same: the chat's sticker picker
  // reloads every sticker whenever it gets a new one.
  const stickers = useMemo(() => stickerApi(api), [api]);

  // The app hears the contacts once they are read, and after each read.
  const { nodes: contacts, nodesLoaded: contactsRead } = conv;
  useEffect(() => {
    if (contactsRead) latest.current.onContactsChange?.(contacts);
  }, [contacts, contactsRead]);

  // What is on screen is read: the chat that opens, and the call log.
  const { markRead } = conv;
  const { opened: channelOpened } = channel;
  useEffect(() => {
    if (!shownKey) return;
    markRead(shownKey);
    if (shownKey === 'channel') channelOpened();
    // Once each time a conversation comes on screen: channelOpened is new on
    // every render, and reading the channel must not run this again.
  }, [shownKey, markRead]);
  const { markSeen } = callLog;
  useEffect(() => {
    if (logShown) markSeen(nowSeconds());
  }, [logShown, markSeen]);
  // Back to the window: what waited on screen is read now.
  useEffect(() => {
    const onFocus = () => {
      if (shownKeyRef.current) markRead(shownKeyRef.current);
      if (logShownRef.current) markSeen(nowSeconds());
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [markRead, markSeen]);

  // Ctrl+K, from anywhere. It leaves an open dialog alone, which keeps the
  // keyboard, and the call screen, under which the panes are inert. Ctrl+L
  // is App's: it locks from anywhere in the chats, asking first during a call.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() === 'k' && !latest.current.call.covering && !document.querySelector('[aria-modal="true"]')) {
        event.preventDefault();
        setTab('chats');
        setSide('chats');
        setPane('list');
        setSearchFocus(count => count + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  useEffect(() => {
    if (searchFocus > 0) searchRef.current?.focus();
  }, [searchFocus]);

  // A focus that fell with its pane goes where you are now: into the
  // conversation that one pane opened, back to the row it came from, or
  // back to Ajustes. A row that is gone leaves it on the sidebar itself.
  useEffect(() => {
    if (!focusNext) return;
    const { target } = focusNext;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    const nav = navRef.current;
    if (target === 'main') {
      mainRef.current?.focus();
    } else if (target === 'settings') {
      (settingsRef.current ?? nav)?.focus();
    } else {
      const row = [...(nav?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find(
        item => target.row !== null && item.dataset.rowKey === target.row,
      );
      (row?.querySelector('button') ?? nav)?.focus();
    }
  }, [focusNext]);

  // The call screen went, minimized or ended. The bar of a minimized call
  // and an end card take the focus as they show (W6, child effects that ran
  // first); when neither did, it fell to the page: the conversation takes it.
  const wasCovering = useRef(call.covering);
  useEffect(() => {
    const was = wasCovering.current;
    wasCovering.current = call.covering;
    if (!was || call.covering) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    (mainRef.current ?? navRef.current)?.focus();
  }, [call.covering]);

  const nodeOf = (handle: string) => conv.nodes.find(node => node.handle === handle);
  const groupOf = (gid: string) => conv.groups.find(group => group.gid === gid);
  const callable = (handle: string) => {
    const node = nodeOf(handle);
    return node !== undefined && !node.blocked;
  };

  /** The call whose chat is open, opened from the log: its row stays marked. */
  const selectedCallKey = fromCall && open?.kind === 'contact' && open.handle === fromCall.peer ? fromCall.key : null;

  const closeOverlay = () => setOverlay(null);
  // Arti too old for the Tor network (card 9): said once, as soon as it is known, over nothing else;
  // afterwards from "Ver qué hacer".
  const updateNeededShown = useRef(false);
  useEffect(() => {
    if (!obsolete || updateNeededShown.current || overlay) return;
    updateNeededShown.current = true;
    setOverlay({ kind: 'updateNeeded' });
  }, [obsolete, overlay]);
  const openConvo = (ref: ConvoRef) => {
    setOpen(ref);
    setMain('convo');
    setPane('main');
    setDetails(false);
    setFromCall(null);
    setKept(null);
    moveFocus('main');
  };
  /** Atrás on one pane: the list, with the focus on the row of the conversation that was open. */
  const back = () => {
    setPane('list');
    moveFocus({ row: tab === 'calls' && selectedCallKey ? selectedCallKey : openKey });
  };
  const forgetOpen = () => {
    setOpen(null);
    setDetails(false);
    setPane('list');
    moveFocus({ row: null });
  };
  const closeDetails = () => {
    setDetails(false);
    moveFocus('main');
  };

  // Solicitudes (UR-4): the list takes the chats' place, a request opens
  // where a chat goes, and an answer leaves the main pane saying what it did.
  const onOpenRequests = useStable(() => {
    setSide('requests');
    setPane('list');
    void reqs.refresh();
  });
  const backToChats = () => {
    setSide('chats');
    if (main === 'request') setMain('convo');
    setOpenRequest(null);
    setRequestDone(null);
    moveFocus({ row: openKey });
  };
  const openRequestPane = (key: string) => {
    setOpenRequest(key);
    setRequestDone(null);
    setMain('request');
    setPane('main');
    setDetails(false);
    moveFocus('main');
  };
  /**
   * The report of whoever wrote the message `msgKey` (UR-5), with it marked:
   * the contact of a chat, or the member of a group, found by their key.
   */
  const reportMessage = async (ref: ConvoRef, msgKey: string) => {
    if (ref.kind === 'contact') return reportContact(ref.handle, false, msgKey);
    if (ref.kind !== 'group') return;
    const from = conv.messages[convoKey(ref)]?.find(message => message.key === msgKey)?.from;
    const members = await props.report?.groupMembers?.(ref.gid).catch(() => []);
    const member = members?.find(candidate => from !== undefined && candidate.local_handle === from);
    if (!member || from === undefined) return;
    reportMember(ref.gid, member.ik_sign_pub, from, from, false, msgKey);
  };

  /** The request went: the list reads again, and the main pane says `done`. */
  const requestGone = (done: string) => {
    setOpenRequest(null);
    setRequestDone(done);
    void reqs.refresh();
  };

  const renameContact = (from: string, to: string) => {
    conv.renamed(from, to);
    moveDraft(from, to);
    callLog.renamed(from, to);
    if (open?.kind === 'contact' && open.handle === from) setOpen({ kind: 'contact', handle: to });
  };
  const removeContact = (handle: string) => {
    conv.removed(handle);
    setDraft(handle, '');
    callLog.removed(handle);
    prefs.forgetContact(handle);
    if (open?.kind === 'contact' && open.handle === handle) forgetOpen();
  };
  const leaveGroup = (gid: string) => {
    const key = convoKey({ kind: 'group', gid });
    conv.removed(key);
    setDraft(key, '');
    if (open?.kind === 'group' && open.gid === gid) forgetOpen();
  };

  /**
   * The actions of a row's right-click menu (MC-2). A group's mute is a mark
   * on this device that the inbox reads as it renders, so muting one renders
   * the shell again; Novedades keeps its own.
   */
  const onToggleMuted = useStable((ref: ConvoRef) => {
    if (ref.kind === 'channel') {
      channel.toggleMuted();
    } else if (ref.kind === 'group') {
      prefs.setGroupMuted(ref.gid, !prefs.getGroupMuted(ref.gid));
      setMutes(count => count + 1);
    }
  });
  const onOpenDetails = useStable((ref: ConvoRef) => {
    openConvo(ref);
    setDetails(true);
  });
  const canCall = useStable(callable);
  const onCallFromRow = useStable((handle: string, video: boolean) => call.start(handle, video));
  const canBlock = useStable((handle: string) => {
    const node = nodeOf(handle);
    return props.block !== undefined && node !== undefined && !node.blocked;
  });
  const onBlockFromRow = useStable((handle: string) =>
    setOverlay({ kind: 'block', target: { kind: 'contact', handle }, name: handle }),
  );
  /** The report of a contact (UR-5), with their chat to choose from. */
  const reportContact = (handle: string, mustBlock = false, initial?: string) =>
    setOverlay({
      kind: 'report',
      target: { kind: 'contact', handle },
      name: handle,
      candidates: candidatesOf(conv.messages[convoKey({ kind: 'contact', handle })] ?? [], null),
      ...(initial !== undefined && { initial }),
      mustBlock,
    });
  /** The report of a member of `gid` (UR-5): only theirs and yours of the group's chat. */
  const reportMember = (gid: string, key: string, name: string, handle: string | null, mustBlock = false, initial?: string) =>
    setOverlay({
      kind: 'report',
      target: { kind: 'member', gid, ik_sign_pub: key },
      name,
      candidates: handle === null ? [] : candidatesOf(conv.messages[convoKey({ kind: 'group', gid })] ?? [], handle),
      ...(initial !== undefined && { initial }),
      mustBlock,
    });
  const onReportFromRow = useStable((handle: string) => reportContact(handle));
  const reporting = props.report !== undefined;
  const rowActions: InboxRowActions = useMemo(
    () => ({
      onToggleMuted,
      onOpenDetails,
      canCall,
      onCall: onCallFromRow,
      canBlock,
      onBlock: onBlockFromRow,
      ...(reporting && { onReport: onReportFromRow }),
    }),
    [onToggleMuted, onOpenDetails, canCall, onCallFromRow, canBlock, onBlockFromRow, reporting, onReportFromRow],
  );

  // The marks are read on every render, as before; the chats are built again only when one changed.
  const mutedKey = conv.groups
    .filter(group => prefs.getGroupMuted(group.gid))
    .map(group => group.gid)
    .join('\n');
  const { nodes, groups, messages, unread: unreadCounts, trust } = conv;
  const { latest: channelLatest, unread: channelUnread, muted: channelMuted } = channel;
  const items = useMemo(
    () =>
      buildInboxItems({
        nodes,
        groups,
        channel: { latest: channelLatest, unread: channelUnread, muted: channelMuted },
        messages,
        unread: unreadCounts,
        drafts,
        trust,
        mutedGroups: new Set(mutedKey ? mutedKey.split('\n') : []),
        t,
      }),
    [nodes, groups, channelLatest, channelUnread, channelMuted, messages, unreadCounts, drafts, trust, mutedKey, t],
  );
  const callEntries = callLog.entries;
  const callRows: CallRowView[] | null = useMemo(
    () =>
      capabilities.callLog
        ? callEntries.map(entry => {
            const node = nodes.find(candidate => candidate.handle === entry.peer);
            return {
              entry,
              name: entry.peer,
              ...(node?.avatar && { avatarSrc: node.avatar }),
              callable: node !== undefined && !node.blocked,
            };
          })
        : null,
    [capabilities.callLog, callEntries, nodes],
  );
  const hasInvites = invites.invites.length > 0;
  const notice = useMemo(
    () =>
      hasInvites
        ? { text: t('inbox.invites.notice'), onAction: () => setOverlay({ kind: 'contacts', tab: 'invites' }) }
        : strangers > 0 && !strangersTold
          ? {
              text: t('inbox.stranger.notice'),
              onAction: () => {
                setStrangersTold(true);
                setOverlay({ kind: 'contacts', tab: 'invites' });
              },
            }
          : null,
    [hasInvites, strangers, strangersTold, t],
  );
  const requestCount = reqs.requests.length;
  const hasRequests = props.requests !== undefined;
  const requestsRow = useMemo(
    () => (hasRequests ? { count: requestCount, onOpen: onOpenRequests } : null),
    [hasRequests, requestCount, onOpenRequests],
  );
  const { handle: myHandle, avatar: myAvatar } = props.me;
  const me = useMemo(() => ({ handle: myHandle, ...(myAvatar && { avatarSrc: myAvatar }) }), [myHandle, myAvatar]);
  const onSelect = useStable((ref: ConvoRef) => {
    openConvo(ref);
    setKept(convoKey(ref));
  });
  const onFilterChange = useStable((next: InboxFilter) => {
    setFilter(next);
    setKept(null);
  });
  const onSeeWhat = useStable((kind: 'torFailed' | 'updateNeeded') => setOverlay({ kind }));
  const onUpdateLater = useStable((key: string | null) => {
    // The notice goes with its button: the focus goes back to the list.
    setUpdateLater(key);
    moveFocus({ row: openKey });
  });
  const onNewChat = useStable(() => setOverlay({ kind: 'newChat', purpose: 'chat' }));
  const onNewCall = useStable(() => setOverlay({ kind: 'newChat', purpose: 'call' }));
  const onCallBack = useStable((handle: string) => call.start(handle, false));
  const onOpenCallChat = useStable((handle: string, key: string) => {
    // A chat for someone who is no longer a contact could only fail to send.
    if (!nodeOf(handle)) return;
    openConvo({ kind: 'contact', handle });
    setFromCall({ key, peer: handle });
  });
  const onShareCode = useStable(() => setOverlay({ kind: 'contacts', tab: 'share' }));
  const onOpenSettings = useStable(() => {
    setMain('settings');
    setPane('main');
    setDetails(false);
    moveFocus('main');
  });
  const onAddContact = useStable(() => setOverlay({ kind: 'contacts', tab: 'add' }));

  let chat: ReactNode = null;
  if (open && open.kind !== 'channel') {
    const ref = open;
    const key = convoKey(ref);
    const contact = ref.kind === 'contact' ? nodeOf(ref.handle) : undefined;
    const group = ref.kind === 'group' ? groupOf(ref.gid) : undefined;
    const header: ChatHeaderInfo =
      ref.kind === 'contact'
        ? {
            kind: 'contact',
            name: ref.handle,
            ...(contact?.avatar && { avatarSrc: contact.avatar }),
            trust: conv.trust[ref.handle] ?? 'unverified',
            ttlSeconds: prefs.getTtl(key),
            blocked: contact?.blocked ?? false,
          }
        : {
            kind: 'group',
            name: group?.name ?? '',
            memberCount: group?.member_count ?? 0,
            ended: group?.ended ?? false,
            ttlSeconds: prefs.getTtl(key),
            hasBlocked: group?.has_blocked === true,
            limited: group?.limited ?? [],
          };
    const chatProps: ChatPaneProps = {
      convo: ref,
      header,
      messages: conv.messages[key] ?? [],
      now: conv.now,
      maxTextLength: MAX_TEXT_LENGTH,
      draft: drafts.get(key) ?? '',
      onDraftChange: text => setDraft(key, text),
      // The composer clears what it sent, and keeps what was typed meanwhile (W3).
      onSendText: (text, reply) => conv.sendText(ref, text, reply),
      onRetry: msgKey => conv.retry(ref, msgKey),
      onSendFiles: files => conv.sendFiles(ref, files),
      onSendSticker: sticker => conv.sendSticker(ref, sticker),
      ...(capabilities.deleteForMe && { onDeleteForMe: (msgKey: string) => conv.deleteForMe(ref, msgKey) }),
      onForward: msgKey => setOverlay({ kind: 'forward', from: ref, key: msgKey }),
      onOpenLink: props.openLink,
      ...(ref.kind === 'contact' &&
        callable(ref.handle) && { onCall: (video: boolean) => call.start(ref.handle, video) }),
      onOpenDetails: () => setDetails(true),
      ...(ref.kind === 'contact' && { onVerify: () => setOverlay({ kind: 'verify', handle: ref.handle }) }),
      ...(ref.kind === 'contact' &&
        header.kind === 'contact' &&
        header.trust === 'keyChanged' && { onAcknowledgeKeyChange: () => void conv.acknowledgeKeyChange(ref.handle) }),
      ...(single && { onBack: back }),
      ...(props.report && { onReport: (msgKey: string) => void reportMessage(ref, msgKey) }),
      fetchFile: (file, maxBytes) =>
        maxBytes === undefined
          ? api.fetchFile(file.url, file.key, file.sha256, file.mime)
          : api.fetchFile(file.url, file.key, file.sha256, file.mime, maxBytes),
      stickers,
    };
    chat = <Fragment key={key}>{slots.chat(chatProps)}</Fragment>;
  }

  /** The request open in the main pane, or what an answer to it did. */
  function requestPane(): ReactNode {
    const shown = openRequest ? reqs.requests.find(view => view.key === openRequest) : undefined;
    const requestsApi = props.requests;
    if (shown && requestsApi) {
      const name = shown.by_admin ? `~${shown.name}` : shown.name;
      return (
        <RequestPane
          key={shown.key}
          request={shown}
          onAccept={async () => {
            const { handle } = await requestsApi.acceptRequest(shown.key);
            void reqs.refresh();
            await conv.refreshNodes();
            setSide('chats');
            setOpenRequest(null);
            openConvo({ kind: 'contact', handle });
          }}
          onDelete={async () => {
            await requestsApi.deleteRequest(shown.key);
            requestGone(t('requests.deleted'));
          }}
          onBlock={() => setOverlay({ kind: 'block', target: { kind: 'request', ik_sign_pub: shown.key }, name })}
          {...(props.report && {
            onReport: () =>
              setOverlay({
                kind: 'report',
                target: { kind: 'request', ik_sign_pub: shown.key },
                name,
                candidates: candidatesOf(requestMessages(shown.items), null),
              }),
          })}
          {...(single && { onBack: back })}
        />
      );
    }
    if (requestDone) {
      return (
        <div className="flex flex-1 flex-col items-start gap-3 px-6 py-6">
          <p role="status" className="m-0 max-w-prose text-ui-base leading-normal text-ui-ink">
            {requestDone}
          </p>
          {single ? <Button onClick={back}>{t('requests.backToList')}</Button> : null}
        </div>
      );
    }
    return <NoChatSelected />;
  }

  const mainContent =
    main === 'settings'
      ? (
          <SettingsPane
            slot={slots.settings}
            remember={section}
            onClose={() => {
              setMain('convo');
              if (single) setPane('list');
              moveFocus('settings');
            }}
            onLockNow={props.onLock}
            // A contact unblocked there is blocked no more in its chat.
            onContactsChanged={() => void conv.refreshNodes()}
            {...props.settings}
          />
        )
      : open?.kind === 'channel'
        ? slots.channel({
            announcements: channel.announcements,
            source: channel.source,
            lastReadId: channel.lastReadId,
            muted: channel.muted,
            onToggleMuted: channel.toggleMuted,
            onOpenLink: props.openLink,
            ...(single && { onBack: back }),
            now: conv.now,
          })
        : main === 'request'
          ? requestPane()
          : // No chat open: the chat's own empty pane (W3).
            (chat ?? <NoChatSelected />);

  /** What the main pane shows: its name when it takes the focus. */
  const mainLabel =
    main === 'settings'
      ? t('inbox.profile.settings')
      : main === 'request'
        ? t('requests.title')
      : open?.kind === 'channel'
        ? t('inbox.channel')
        : open?.kind === 'contact'
          ? open.handle
          : open?.kind === 'group'
            ? groupOf(open.gid)?.name || undefined
            : undefined;

  const detailsLayout: PanelLayout = layout === 'double-aside' ? 'aside' : 'dialog';
  let detailsPanel: ReactNode = null;
  // A dialog never shows over the call screen, not even one the layout turned the aside into.
  if (details && open && main === 'convo' && mainShown && !(call.covering && detailsLayout === 'dialog')) {
    if (open.kind === 'contact') {
      const node = nodeOf(open.handle);
      if (node) {
        detailsPanel = slots.contactDetails({
          node,
          trust: conv.trust[node.handle] ?? 'unverified',
          layout: detailsLayout,
          onClose: closeDetails,
          onVerify: () => setOverlay({ kind: 'verify', handle: node.handle }),
          onRenamed: to => renameContact(node.handle, to),
          onRemoved: () => removeContact(node.handle),
          // A block changes the contacts and the groups that say someone blocked is in them.
          onChanged: () => {
            void conv.refreshNodes();
            void conv.refreshGroups();
          },
          ...(props.report && { onReport: (mustBlock: boolean) => reportContact(node.handle, mustBlock) }),
        });
      }
    } else if (open.kind === 'group') {
      const group = groupOf(open.gid);
      if (group) {
        detailsPanel = slots.groupPanel({
          group,
          contacts: conv.nodes,
          layout: detailsLayout,
          onClose: closeDetails,
          onChanged: () => {
            void conv.refreshGroups();
            void conv.refreshNodes();
          },
          onOpenContact: handle => openConvo({ kind: 'contact', handle }),
          onLeft: () => leaveGroup(group.gid),
          ...(props.report && {
            onReportMember: (member, mustBlock) =>
              reportMember(group.gid, member.key, member.name, member.localHandle, mustBlock),
          }),
        });
      }
    }
  }

  let overlayContent: ReactNode = null;
  /** The shell's dialog on screen: none under the call screen. */
  const shown = call.covering ? null : overlay;
  if (shown?.kind === 'contacts') {
    overlayContent = slots.contacts({
      tab: shown.tab,
      onTabChange: next => setOverlay({ kind: 'contacts', tab: next }),
      onClose: closeOverlay,
      onContactAdded: handle => {
        closeOverlay();
        void conv.refreshNodes();
        openConvo({ kind: 'contact', handle });
      },
      onGroupJoined: gid => {
        closeOverlay();
        void conv.refreshGroups();
        void conv.refreshNodes();
        void invites.refresh();
        openConvo({ kind: 'group', gid });
      },
      invites: invites.invites,
      onInvitesChanged: () => {
        void invites.refresh();
        void conv.refreshGroups();
      },
      strangerAttempts: strangers,
    });
  } else if (shown?.kind === 'newGroup') {
    overlayContent = slots.newGroup({
      contacts: conv.nodes,
      onClose: closeOverlay,
      onCreated: gid => {
        closeOverlay();
        void conv.refreshGroups();
        openConvo({ kind: 'group', gid });
      },
    });
  } else if (shown?.kind === 'newChat') {
    overlayContent = slots.newChat({
      purpose: shown.purpose,
      contacts: conv.nodes,
      trust: conv.trust,
      onClose: closeOverlay,
      onOpenChat: handle => {
        closeOverlay();
        openConvo({ kind: 'contact', handle });
      },
      onCall: (handle, video) => {
        closeOverlay();
        call.start(handle, video);
      },
      onNewGroup: () => setOverlay({ kind: 'newGroup' }),
      onAddWithCode: () => setOverlay({ kind: 'contacts', tab: 'add' }),
    });
  } else if (shown?.kind === 'verify') {
    const peer = nodeOf(shown.handle);
    if (peer) {
      overlayContent = slots.verifyContact({
        peer,
        // Without K7 there is no full fingerprint: the dialog shows no symbols then.
        myIdentityDigest: props.me.identityDigest ?? '',
        // The mark of a call with the fingerprint the contact still has, and no key change since.
        verified: conv.trust[peer.handle] === 'verified',
        onClose: closeOverlay,
        ...(callable(peer.handle) && {
          onCall: () => {
            closeOverlay();
            call.start(peer.handle, false);
          },
        }),
      });
    }
  } else if ((shown?.kind === 'torFailed' || shown?.kind === 'withoutTor' || shown?.kind === 'updateNeeded') && net) {
    // "Ver qué hacer" goes with the line once it changes: the focus that
    // fell with it goes back to the list.
    const closeTor = () => {
      closeOverlay();
      moveFocus({ row: openKey });
    };
    overlayContent =
      shown.kind === 'updateNeeded' ? (
        <WithNetStatus net={net}>{status => <UpdateNeededDialog status={status} api={net} onClose={closeTor} />}</WithNetStatus>
      ) : shown.kind === 'torFailed' ? (
        <WithNetStatus net={net}>
          {status => (
            <ConnectFailedDialog
              status={status}
              api={net}
              onClose={closeTor}
              onEscape={() => setOverlay({ kind: 'withoutTor' })}
            />
          )}
        </WithNetStatus>
      ) : (
        <WithoutTorDialog api={net} onClose={closeTor} onDone={closeTor} />
      );
  } else if (shown?.kind === 'block' && props.block) {
    const { target, name } = shown;
    const refreshAll = () => {
      void conv.refreshNodes();
      void conv.refreshGroups();
    };
    overlayContent = (
      <BlockDialog
        target={target}
        name={name}
        api={props.block}
        onClose={closeOverlay}
        onBlocked={() => {
          closeOverlay();
          refreshAll();
          // Their request went with the block (UR-4).
          if (target.kind === 'request') requestGone(t('block.done', { name }));
        }}
        onLeftGroup={gid => {
          refreshAll();
          if (open?.kind === 'group' && open.gid === gid) leaveGroup(gid);
        }}
        {...(props.report && {
          onReport: () => {
            if (target.kind === 'contact') return reportContact(target.handle, true);
            const request = reqs.requests.find(view => target.kind === 'request' && view.key === target.ik_sign_pub);
            setOverlay({
              kind: 'report',
              target,
              name,
              candidates: request ? candidatesOf(requestMessages(request.items), null) : [],
              mustBlock: true,
            });
          },
        })}
      />
    );
  } else if (shown?.kind === 'report' && props.report) {
    const { target, name, candidates, initial, mustBlock } = shown;
    overlayContent = (
      <ReportDialog
        target={target}
        name={name}
        candidates={candidates}
        {...(initial !== undefined && { initial })}
        mustBlock={mustBlock === true}
        api={props.report}
        openLink={props.openLink}
        copyText={text => clipboard.copyText(text)}
        onClose={closeOverlay}
        onBlocked={() => {
          void conv.refreshNodes();
          void conv.refreshGroups();
          // Their request went with the block (UR-4).
          if (target.kind === 'request') requestGone(t('block.done', { name }));
        }}
      />
    );
  } else if (shown?.kind === 'forward') {
    const { from, key } = shown;
    overlayContent = (
      <ForwardDialog
        open
        targets={items.filter(item =>
          item.ref.kind === 'contact'
            ? callable(item.ref.handle)
            : item.ref.kind === 'group' && !groupOf(item.ref.gid)?.ended,
        )}
        onPick={to => {
          closeOverlay();
          void conv.forward(from, key, to);
        }}
        onClose={closeOverlay}
      />
    );
  }

  return (
    // Relative: the call layer (W6) is absolute and fills the shell, not the window under the title bar.
    // While the call screen covers the shell, everything else in it is inert: never the layer, and never
    // the window's title bar, which is outside the shell.
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col bg-ui-bg font-ui text-ui-ink">
      {call.bar ? <div inert={call.covering}>{call.bar}</div> : null}
      {(conv.historyFailed || error) && (
        <div inert={call.covering} className="flex flex-col gap-2 px-3 pt-3">
          {conv.historyFailed && (
            <Banner tone="danger" action={<Button onClick={() => void conv.reloadHistory()}>{t('common2.retry')}</Button>}>
              {t('shell.error.history')}
            </Banner>
          )}
          {error && (
            <Banner
              tone="danger"
              action={
                <Button variant="ghost" onClick={() => setError(null)}>
                  {t('common2.close')}
                </Button>
              }
            >
              {shellErrorText(t, error)}
            </Banner>
          )}
        </div>
      )}
      <div inert={call.covering} className="flex min-h-0 flex-1">
        {listShown && (
          <nav
            ref={navRef}
            aria-label={t('shell.nav')}
            // Where the focus waits when the row it should go back to is gone.
            tabIndex={-1}
            className={cx(
              'flex min-h-0 flex-col border-e border-ui-line outline-none',
              single ? 'min-w-0 flex-1' : 'w-[20rem] shrink-0',
            )}
          >
            {side === 'requests' && props.requests ? (
              <div className="flex h-full min-h-0 flex-col gap-3 bg-ui-side px-3 py-4 text-ui-ink">
                <RequestsList
                  requests={reqs.requests}
                  overflow={reqs.overflow}
                  onlyLinks={reqs.onlyLinks}
                  failed={reqs.failed}
                  selectedKey={main === 'request' ? openRequest : null}
                  now={conv.now}
                  onOpen={openRequestPane}
                  onBack={backToChats}
                  onRetry={() => void reqs.refresh()}
                />
              </div>
            ) : (
              <ShellInbox
                net={net}
                updateLater={updateLater}
                onSeeWhat={onSeeWhat}
                onUpdateLater={onUpdateLater}
                wordmark={THEMES[`${appearance.style}-light`].wordmark}
                items={items}
                selectedKey={openKey}
                onSelect={onSelect}
                keepKey={kept}
                filter={filter}
                onFilterChange={onFilterChange}
                search={search}
                onSearchChange={setSearch}
                searchRef={searchRef}
                connection={connection}
                me={me}
                onNewChat={onNewChat}
                onNewCall={onNewCall}
                tab={tab}
                onTabChange={setTab}
                calls={callRows}
                callFilter={callFilter}
                onCallFilterChange={setCallFilter}
                missedUnseen={callLog.missedUnseen}
                selectedCallKey={selectedCallKey}
                onCallBack={onCallBack}
                onOpenCallChat={onOpenCallChat}
                onShareCode={onShareCode}
                onOpenSettings={onOpenSettings}
                settingsRef={settingsRef}
                hasContacts={!conv.nodesLoaded || conv.nodes.length > 0 || conv.groups.length > 0}
                onAddContact={onAddContact}
                notice={notice}
                now={conv.now}
                rowActions={rowActions}
                requests={requestsRow}
              />
            )}
          </nav>
        )}
        {mainShown && (
          <main
            ref={mainRef}
            // Takes the focus when one pane opens it, so a screen reader names what opened.
            tabIndex={-1}
            aria-label={mainLabel}
            className="flex min-h-0 min-w-0 flex-1 flex-col bg-ui-surface outline-none"
          >
            {mainContent}
          </main>
        )}
        {detailsLayout === 'aside' && detailsPanel && (
          // A column, no landmark: the panel beside the chat is one itself, an
          // <aside> named for the contact or the group (W4, W5).
          <div className="flex min-h-0 w-[21.25rem] shrink-0 flex-col border-s border-ui-line bg-ui-surface">
            {detailsPanel}
          </div>
        )}
      </div>
      {/*
        Terminal dark's scan lines (--t-scan, none elsewhere or when switched
        off), over both panes: their opaque backgrounds hid lines drawn on the
        shell's own. Under the dialogs and the call layer.
      */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 [background-image:var(--t-scan)]" />
      {detailsLayout === 'dialog' && detailsPanel}
      {overlayContent}
      {net && <ObsoleteWatch net={net} onChange={setObsolete} />}
      {call.layer}
    </div>
  );
}

/** What a request held, as a chat's messages: its texts (UR-5). */
function requestMessages(items: readonly { kind: string; text?: string; at: number }[]): Msg[] {
  return items.flatMap((item, index) =>
    item.kind === 'text' && item.text !== undefined
      ? [{ key: `request:${index}`, side: 'them' as const, ts: item.at, text: item.text }]
      : [],
  );
}
