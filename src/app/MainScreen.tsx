/**
 * The chats (plan §4, I6; plan-cambios-11oct §7, I6): W2's ShellScreen,
 * with the screens of every other unit in its slots, where MainShell was.
 *
 * - The chat and the channel (W3); Contactos, Nuevo grupo, the group's
 *   details and "Nuevo chat" (W4); Settings in the main pane and a
 *   contact's details (W5); the contact's symbols, which offer the call
 *   that verifies (W6). The shell opens and closes them, and its slots get
 *   from here the backend and this device's preferences.
 * - The calls (W6 through src/app/calls.tsx): their bar above both panes,
 *   their layer over the shell, which goes inert under the call screen,
 *   and the gate App ends a call through before it locks, closes the
 *   window or quits. Who a call is with comes from the contacts the shell
 *   reads, and the calls are recorded in their chats (K13).
 * - A message that arrives where you are not looking: the notifier
 *   (src/app/notifier.ts), with the window's focus, which Tauri reports.
 * - Your profile, read at the start and again once Settings saved it; and
 *   the one-time notice about the verification marks of 0.1.0, once the
 *   contacts are read.
 * - What only App does goes up through MainProps: the lock (Ctrl+L too is
 *   App's), the wipe, a new auto-lock time and the calls' gate.
 *
 * Everything it takes from the outside is in `deps`, the real backend and
 * this device unless a test brings fakes.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadAnnouncementFeed, type AnnouncementFeed } from '../lib/announcements';
import {
  api,
  ensureNotifyPermission,
  notify,
  onCallLogged,
  onCallSignal,
  onConnectionChanged,
  onContactKeyMismatch,
  onFileMessage,
  onGroupInvite,
  onGroupMessage,
  onGroupRemoved,
  onGroupUpdated,
  onHandshakeNeeded,
  onMessageReceived,
  onProfileUpdated,
  onResyncNeeded,
  onSessionEstablished,
  openLink,
  type NodeInfo,
} from '../lib/api';
import { makeAvatar } from '../lib/avatar';
import { useT } from '../lib/i18n';
import { prefs as devicePrefs, type Prefs } from '../lib/prefs';
import { playMessageTone } from '../lib/sfx';
import type { CallSounds } from '../screens/call';
import { ChannelView, ChatPane } from '../screens/chat';
import { ContactDetailsPanel, type ContactDetailsApi } from '../screens/contact-details';
import { ContactsDialog, NewChatDialog, ShareCodePanel, type ContactsApi } from '../screens/contacts';
import { GroupPanel, NewGroupDialog, groupPrefs, type GroupApi } from '../screens/group';
import { SettingsScreen, type SettingsPlatform } from '../screens/settings';
import { ShellScreen, type ShellApi, type ShellEvents, type ShellScreenProps } from '../screens/shell';
import type { OnboardingIntent, ShellSlots } from '../screens/types';
import { VerifyContactDialog } from '../screens/verify';
import { capabilities as buildCapabilities, type Capabilities } from './capabilities';
import { useCalls, type CallGate, type CallsBackend } from './calls';
import { downloadBlob } from './download';
import { createNotifier } from './notifier';
import { platformOf, settingsBackend, type SettingsBackend } from './settings';
import { useLegacyMarksNotice } from './verification';

/** What App() gives the chats. */
export interface MainProps {
  /** How the first run ended: 'add-contact' opens Contactos on "Agregar", once. */
  intent: OnboardingIntent;
  /** "Bloquear": App asks first while a call holds the microphone. */
  onLock(): void;
  /** Settings saved a new auto-lock time: it applies at once. */
  onAutolockChanged(minutes: number): void;
  /** Settings erased the identity: what this device keeps goes too, and the first run starts. */
  onWiped(): void;
  /**
   * The chats hand App the gate of their calls as they open, and null as
   * they go: locking, closing the window and quitting from the tray end a
   * call through it.
   */
  onCallGate(gate: CallGate | null): void;
}

/** The backend commands of the chats and their dialogs: `api` of src/lib/api.ts. */
export type MainApi = ShellApi & ContactsApi & GroupApi & ContactDetailsApi & Pick<CallsBackend, 'recordCall'>;
/** The backend's events the shell and the calls listen to: the `on*` of src/lib/api.ts. */
export type MainEvents = ShellEvents & Pick<CallsBackend, 'onCallSignal'>;

/** This window's focus, which says whether Trino is in front. */
export interface WindowFocus {
  isFocused(): Promise<boolean>;
  /** Resolves to the function that stops listening. */
  onFocusChanged(cb: (focused: boolean) => void): Promise<() => void>;
}

/** Everything the chats take from the outside. */
export interface MainDeps {
  api: MainApi;
  events: MainEvents;
  /** Settings' backend, with the code "Tu código QR" shares. */
  settings: SettingsBackend;
  /** A notification of the system. */
  notify(title: string, body: string): Promise<void>;
  /** Asks the system to let Trino notify, as the chats open. */
  ensureNotifyPermission(): Promise<boolean>;
  /** A link of a message, in the system's browser. */
  openLink(url: string): void;
  window: WindowFocus;
  /** The preferences of this device. */
  prefs: Prefs;
  /** The backend pieces this build has. */
  capabilities: Capabilities;
  platform: SettingsPlatform;
  /** The message tone. */
  tone(): void;
  /** The call's tones; sfx.ts unless a test brings its own (jsdom has no Web Audio). */
  sounds?: CallSounds;
  /** The announcements' feed. */
  loadFeed(): Promise<AnnouncementFeed>;
  /** Saves a file for the person: the QR code's PNG. */
  download(name: string, blob: Blob): void;
  /** Turns a picked file into the profile photo. */
  makeAvatar(file: File): Promise<string>;
}

/** This window through Tauri, asked for on each use, so that loading this module needs no Tauri. */
const TAURI_WINDOW_FOCUS: WindowFocus = {
  isFocused: () => getCurrentWindow().isFocused(),
  onFocusChanged: cb => getCurrentWindow().onFocusChanged(({ payload }) => cb(payload)),
};

/** The real backend and this device. */
const DEVICE_DEPS: MainDeps = {
  api,
  events: {
    onMessageReceived,
    onGroupMessage,
    onGroupUpdated,
    onGroupInvite,
    onFileMessage,
    onResyncNeeded,
    onSessionEstablished,
    onHandshakeNeeded,
    onConnectionChanged,
    onContactKeyMismatch,
    onGroupRemoved,
    onCallLogged,
    onProfileUpdated,
    onCallSignal,
  },
  settings: settingsBackend,
  notify,
  ensureNotifyPermission,
  openLink,
  window: TAURI_WINDOW_FOCUS,
  prefs: devicePrefs,
  capabilities: buildCapabilities,
  platform: platformOf(navigator.userAgent),
  tone: () => playMessageTone(),
  loadFeed: loadAnnouncementFeed,
  download: downloadBlob,
  makeAvatar,
};

export interface MainScreenProps extends MainProps {
  /** What the chats take from the outside; the real backend and this device for what is left out. */
  deps?: Partial<MainDeps>;
  /** For tests: the shell's width in px, measured otherwise. */
  width?: number;
  /** For tests: the root size in px, 16 times the text size otherwise. */
  rootPx?: number;
}

/** Your profile as the shell shows it, before it is read. */
const NO_PROFILE: ShellScreenProps['me'] = { handle: '', avatar: null, fingerprint: '', identityDigest: null };

export function MainScreen({ intent, onLock, onAutolockChanged, onWiped, onCallGate, deps, width, rootPx }: MainScreenProps) {
  const t = useT();
  const d = useMemo<MainDeps>(() => ({ ...DEVICE_DEPS, ...deps }), [deps]);
  const caps = d.capabilities;

  // Whether Trino is in front: the window's focus, which Tauri reports.
  // document.hasFocus() is unreliable in the webview (it can say focused while
  // minimized or in the tray).
  const inFront = useRef(true);
  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    d.window.isFocused().then(
      focused => {
        if (live) inFront.current = focused;
      },
      () => {},
    );
    d.window
      .onFocusChanged(focused => {
        inFront.current = focused;
      })
      .then(
        unlisten => {
          if (live) stop = unlisten;
          else unlisten();
        },
        () => {},
      );
    return () => {
      live = false;
      stop?.();
    };
  }, [d.window]);
  const isWindowFocused = useCallback(() => inFront.current, []);

  useEffect(() => {
    void d.ensureNotifyPermission().catch(() => false);
  }, [d]);

  // Your name, photo and identity digest (K7, the calls' SAS), read again
  // once Settings saved them.
  const [me, setMe] = useState(NO_PROFILE);
  const readMe = useCallback(
    () =>
      d.api.getProfile().then(
        profile =>
          setMe({
            handle: profile.handle ?? '',
            avatar: profile.avatar ?? null,
            fingerprint: profile.fingerprint,
            identityDigest: profile.identity_digest ?? null,
          }),
        (error: unknown) => console.error('getProfile failed', error),
      ),
    [d.api],
  );
  useEffect(() => {
    void readMe();
  }, [readMe]);

  // The contacts as the shell reads them: who a call is with, and who had a
  // verification mark of 0.1.0.
  const [contacts, setContacts] = useState<readonly NodeInfo[]>([]);

  const calls = useCalls({
    contacts,
    myIdentityDigest: me.identityDigest,
    isWindowVisible: isWindowFocused,
    callLog: caps.callLog,
    api: { notify: d.notify, recordCall: d.api.recordCall, onCallSignal: d.events.onCallSignal },
    prefs: d.prefs,
    ...(d.sounds && { sounds: d.sounds }),
  });
  useEffect(() => {
    onCallGate(calls.gate);
    return () => onCallGate(null);
  }, [calls.gate, onCallGate]);

  const legacyMarksNotice = useLegacyMarksNotice({ contacts, prefs: d.prefs });

  const notifier = useMemo(
    () => createNotifier({ prefs: d.prefs, t, notify: d.notify, tone: d.tone, isWindowFocused }),
    [d, t, isWindowFocused],
  );

  const devicePrefsOfGroups = useMemo(() => groupPrefs(d.prefs), [d.prefs]);
  const slots: ShellSlots = {
    chat: p => <ChatPane {...p} />,
    channel: p => <ChannelView {...p} />,
    contacts: p => <ContactsDialog {...p} api={d.api} download={d.download} groupPrefs={devicePrefsOfGroups} />,
    newGroup: p => <NewGroupDialog {...p} api={d.api} groupPrefs={devicePrefsOfGroups} />,
    groupPanel: p => (
      <GroupPanel
        {...p}
        api={d.api}
        capabilities={{ members: caps.groupMembers, manage: caps.manageGroups }}
        isVerified={d.prefs.isVerified}
        groupPrefs={devicePrefsOfGroups}
      />
    ),
    settings: p => (
      <SettingsScreen
        {...p}
        api={d.settings}
        platform={d.platform}
        capabilities={{
          totp: caps.totp,
          changePassphrase: caps.changePassphrase,
          relayStatus: caps.relayStatus,
          profileSync: caps.profileSync,
          diagnosticLog: caps.diagnosticLog,
        }}
        prefs={d.prefs}
        makeAvatar={d.makeAvatar}
      />
    ),
    // No key: it reads its contact's state again when the handle changes, and
    // a remount would lose the focus "Usar este nombre" hands over (W5).
    contactDetails: p => <ContactDetailsPanel {...p} api={d.api} prefs={d.prefs} />,
    verifyContact: p => <VerifyContactDialog {...p} />,
    newChat: p => <NewChatDialog {...p} />,
  };

  return (
    <>
      <ShellScreen
        me={me}
        api={d.api}
        events={d.events}
        slots={slots}
        call={calls.slot}
        notifier={notifier}
        capabilities={{
          connection: caps.relayStatus,
          sendAck: caps.sendAck,
          deleteForMe: caps.deleteForMe,
          callLog: caps.callLog,
        }}
        onLock={onLock}
        initialIntent={intent}
        openLink={d.openLink}
        isWindowFocused={isWindowFocused}
        settings={{
          onIdentityWiped: onWiped,
          onProfileChanged: () => void readMe(),
          onAutolockChanged,
          renderShareCode: () => <ShareCodePanel api={d.settings} download={d.download} />,
        }}
        onContactsChange={setContacts}
        prefs={d.prefs}
        loadFeed={d.loadFeed}
        {...(width !== undefined && { width })}
        {...(rootPx !== undefined && { rootPx })}
      />
      {legacyMarksNotice}
    </>
  );
}
