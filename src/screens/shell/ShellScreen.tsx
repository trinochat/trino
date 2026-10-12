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
 * Ctrl+K goes back to Chats and to the search. Ctrl+L, which locks, is the
 * app's (App.tsx), as is the lock itself.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { THEMES } from '../../design/tokens';
import { useAppearance } from '../../design/useAppearance';
import { loadAnnouncementFeed, type AnnouncementFeed } from '../../lib/announcements';
import type { NodeInfo } from '../../lib/api';
import { convoKey } from '../../lib/convo';
import { useT } from '../../lib/i18n';
import { prefs as devicePrefs } from '../../lib/prefs';
import { Banner, Button, cx } from '../../ui';
import { buildInboxItems } from '../inbox/inbox-model';
import type { CallFilter } from '../inbox/call-history-model';
import type { CallRowView } from '../inbox/CallRow';
import { InboxPanel } from '../inbox/InboxPanel';
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
import { useDrafts } from './drafts';
import { ForwardDialog } from './ForwardDialog';
import { useShellLayout } from './layout';
import { nowSeconds } from './listen';
import type { ShellApi, ShellCapabilities, ShellEvents, ShellPrefs } from './shell-api';
import { stickerApi } from './stickers';
import { useAnnouncements } from './useAnnouncements';
import { useCallLog } from './useCallLog';
import { useConnection } from './useConnection';
import { useConversations, type ShellError } from './useConversations';
import { useInvites } from './useInvites';
import { useStrangerAttempts } from './useStrangerAttempts';

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
  | { kind: 'forward'; from: ConvoRef; key: string };

/** Where the focus goes once a change took the control that had it off the page. */
type FocusTarget = 'main' | 'settings' | { row: string | null };

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
  const [main, setMain] = useState<'convo' | 'settings'>('convo');
  const [section, setSection] = useState<SettingsSectionId>('profile');
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
  const [strangersSeen, setStrangersSeen] = useState(0);
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
   * buttons along. Applied after the next render, and only if the focus fell
   * to the page: a dialog that gave it back to its opener keeps it there.
   */
  const focusNext = useRef<FocusTarget | null>(null);

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
  const channel = useAnnouncements(props.loadFeed ?? loadAnnouncementFeed, prefs);
  const strangers = useStrangerAttempts(events);
  const invites = useInvites(api, events);
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
    const target = focusNext.current;
    focusNext.current = null;
    if (!target) return;
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
  });

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
  const openConvo = (ref: ConvoRef) => {
    setOpen(ref);
    setMain('convo');
    setPane('main');
    setDetails(false);
    setFromCall(null);
    setKept(null);
    focusNext.current = 'main';
  };
  /** Atrás on one pane: the list, with the focus on the row of the conversation that was open. */
  const back = () => {
    setPane('list');
    focusNext.current = { row: tab === 'calls' && selectedCallKey ? selectedCallKey : openKey };
  };
  const forgetOpen = () => {
    setOpen(null);
    setDetails(false);
    setPane('list');
    focusNext.current = { row: null };
  };
  const closeDetails = () => {
    setDetails(false);
    focusNext.current = 'main';
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

  const mutedGroups = new Set(conv.groups.filter(group => prefs.getGroupMuted(group.gid)).map(group => group.gid));
  const items = buildInboxItems({
    nodes: conv.nodes,
    groups: conv.groups,
    channel: { latest: channel.latest, unread: channel.unread, muted: channel.muted },
    messages: conv.messages,
    unread: conv.unread,
    drafts,
    trust: conv.trust,
    mutedGroups,
    t,
  });
  const callRows: CallRowView[] | null = capabilities.callLog
    ? callLog.entries.map(entry => {
        const node = nodeOf(entry.peer);
        return {
          entry,
          name: entry.peer,
          ...(node?.avatar && { avatarSrc: node.avatar }),
          callable: node !== undefined && !node.blocked,
        };
      })
    : null;
  const notice =
    invites.invites.length > 0
      ? { text: t('inbox.invites.notice'), onAction: () => setOverlay({ kind: 'contacts', tab: 'invites' }) }
      : strangers > strangersSeen
        ? {
            text: t('inbox.stranger.notice'),
            onAction: () => {
              setStrangersSeen(strangers);
              setOverlay({ kind: 'contacts', tab: 'invites' });
            },
          }
        : null;

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
      fetchFile: file => api.fetchFile(file.url, file.key, file.sha256, file.mime),
      stickers,
    };
    chat = <Fragment key={key}>{slots.chat(chatProps)}</Fragment>;
  }

  const empty = <p className="m-auto max-w-[20rem] px-4 text-center text-ui-md text-ui-muted">{t('shell.empty')}</p>;
  const mainContent =
    main === 'settings'
      ? slots.settings({
          section,
          onSectionChange: setSection,
          onClose: () => {
            setMain('convo');
            if (single) setPane('list');
            focusNext.current = 'settings';
          },
          onLockNow: props.onLock,
          // A contact unblocked there is blocked no more in its chat.
          onContactsChanged: () => void conv.refreshNodes(),
          ...props.settings,
        })
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
        : (chat ?? empty);

  /** What the main pane shows: its name when it takes the focus. */
  const mainLabel =
    main === 'settings'
      ? t('inbox.profile.settings')
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
          onChanged: () => void conv.refreshNodes(),
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
              {error.kind === 'reconnect' ? t('shell.error.reconnect', { name: error.handle }) : t('shell.error.forward')}
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
            <InboxPanel
              wordmark={THEMES[`${appearance.style}-light`].wordmark}
              items={items}
              selectedKey={openKey}
              onSelect={ref => {
                openConvo(ref);
                setKept(convoKey(ref));
              }}
              keepKey={kept}
              filter={filter}
              onFilterChange={next => {
                setFilter(next);
                setKept(null);
              }}
              search={search}
              onSearchChange={setSearch}
              searchRef={searchRef}
              connection={connection}
              me={{ handle: props.me.handle, ...(props.me.avatar && { avatarSrc: props.me.avatar }) }}
              onNewChat={() => setOverlay({ kind: 'newChat', purpose: 'chat' })}
              onNewCall={() => setOverlay({ kind: 'newChat', purpose: 'call' })}
              tab={tab}
              onTabChange={setTab}
              calls={callRows}
              callFilter={callFilter}
              onCallFilterChange={setCallFilter}
              missedUnseen={callLog.missedUnseen}
              selectedCallKey={selectedCallKey}
              onCallBack={handle => call.start(handle, false)}
              onOpenCallChat={(handle, key) => {
                // A chat for someone who is no longer a contact could only fail to send.
                if (!nodeOf(handle)) return;
                openConvo({ kind: 'contact', handle });
                setFromCall({ key, peer: handle });
              }}
              onShareCode={() => setOverlay({ kind: 'contacts', tab: 'share' })}
              onOpenSettings={() => {
                setMain('settings');
                setPane('main');
                setDetails(false);
                focusNext.current = 'main';
              }}
              settingsRef={settingsRef}
              hasContacts={!conv.nodesLoaded || conv.nodes.length > 0 || conv.groups.length > 0}
              onAddContact={() => setOverlay({ kind: 'contacts', tab: 'add' })}
              notice={notice}
              now={conv.now}
            />
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
          <aside
            aria-label={t('shell.details')}
            className="flex min-h-0 w-[21.25rem] shrink-0 flex-col border-s border-ui-line bg-ui-surface"
          >
            {detailsPanel}
          </aside>
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
      {call.layer}
    </div>
  );
}
