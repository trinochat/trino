// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdAccessibility, holdAppearance, holdScanLines } from '../design/apply';
import { AppearanceProvider } from '../design/useAppearance';
import type {
  CallEventWire,
  CallLogWire,
  CallSignalEvent,
  EmergencyAlertEvent,
  GroupInfo,
  HistItem,
  NodeInfo,
  ProfileResponse,
  SendReceipt,
} from '../lib/api';
import { FakePc, STUN, fakeStream, sdp, settle, turnOk } from '../lib/call-test-support';
import { I18nContext, makeT } from '../lib/i18n';
import { LangCtx } from '../lib/i18n-context';
import { encodeMeta } from '../lib/message-body';
import type { CallSounds } from '../screens/call';
import { fakeApi as fakeSettingsApi, fakeHost, memoryPrefs } from '../screens/settings/test-utils';
import { fakeApi as fakeShellApi, fakeEvents } from '../screens/shell/test-fakes';
import { ToastProvider } from '../ui';
import type { Capabilities } from './capabilities';
import type { EmergencyAlertsBackend } from './emergency-alerts';
import { MainScreen, type MainApi, type MainDeps, type MainProps } from './MainScreen';

// The chats of the redesign (plan §4, I6; plan-cambios-11oct §7, I6): W2's
// shell with the screens of every other unit in its slots, over a fake
// backend. The calls run the real call.ts against the fake
// RTCPeerConnection of call.test.ts (src/lib/call-test-support.ts).

// call.ts reaches the backend through lib/api's `api`.
const backend = vi.hoisted(() => ({
  getTurnServers: vi.fn(),
  getCallConfig: vi.fn(),
  sendCallSignal: vi.fn(),
  setCallActive: vi.fn(),
  devLog: vi.fn(),
}));
vi.mock('../lib/api', async importOriginal => {
  const original = await importOriginal<typeof import('../lib/api')>();
  return { ...original, api: { ...original.api, ...backend } };
});

const getUserMedia = vi.fn();

beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
  // "Tu código QR" draws the QR's PNG on a canvas, which jsdom does not have.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  FakePc.instances = [];
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.getTurnServers.mockResolvedValue(turnOk());
  backend.getCallConfig.mockResolvedValue({ ice_servers: [STUN] });
  backend.sendCallSignal.mockResolvedValue(undefined);
  backend.setCallActive.mockResolvedValue(undefined);
  backend.devLog.mockResolvedValue(undefined);
  getUserMedia.mockReset();
  getUserMedia.mockImplementation(async (constraints: { video: unknown }) => fakeStream(!!constraints.video));
  vi.stubGlobal('RTCPeerConnection', FakePc);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
});
afterEach(() => {
  // Unmounting hangs up: the call controller tears the call down.
  cleanup();
  delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NOW = Math.floor(Date.now() / 1000);
const PROFILE: ProfileResponse = {
  handle: 'rechita',
  avatar: null,
  fingerprint: '70a5.83c6.766d.aad7',
  nostr_pub: 'ab'.repeat(32),
  identity_digest: '1'.repeat(64),
  about: '',
  sync: 1,
};
const BUNDLE = JSON.stringify({
  handle: 'rechita',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});

const node = (handle: string, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: `fp-${handle}`,
  has_session: true,
  added_at: 0,
  identity_digest: handle === 'Ana' ? '2'.repeat(64) : '3'.repeat(64),
  ...extra,
});
const FAMILIA: GroupInfo = { gid: 'g1', name: 'Familia', epoch: 1, is_admin: true, member_count: 3, members: [] };

/** Every backend piece on, as this build has them. */
const ALL: Capabilities = {
  profileSync: true,
  callLog: true,
  relayStatus: true,
  sendAck: true,
  deleteForMe: true,
  totp: true,
  changePassphrase: true,
  emergencyKey: true,
  groupMembers: true,
  manageGroups: true,
  diagnosticLog: false,
  inviteLinks: false,
  messageRequests: false,
  names: false,
};

const quiet = (): CallSounds => ({
  startRingback: vi.fn(),
  startRingtone: vi.fn(),
  stopRinging: vi.fn(),
  blipConnect: vi.fn(),
  blipEnd: vi.fn(),
});

// call.ts lives on from test to test and remembers the calls that ended: each offer has its own id.
let offers = 0;
const newOfferId = () => `main${String(++offers).padStart(28, '0')}`;

interface SetupOptions {
  intent?: MainProps['intent'];
  /** The shell's width in px at 16 px a rem: 1280 puts the details beside the chat, 1024 in a dialog. */
  width?: number;
  nodes?: NodeInfo[];
  history?: Record<string, HistItem[]>;
  /** The call log as the backend keeps it (K13). */
  callLog?: CallLogWire[];
  /** What this device keeps: verification marks, settings. */
  stored?: Record<string, string>;
  capabilities?: Capabilities;
  /** Whether Trino is in front at the start. */
  inFront?: boolean;
  /** The warning to a trusted contact's side of the chats (CE-6); none by default. */
  alerts?: EmergencyAlertsBackend | null;
}

function setup({
  intent = 'chats',
  width = 1280,
  nodes = [node('Ana'), node('Bea')],
  history = {},
  callLog = [],
  stored = {},
  capabilities = ALL,
  inFront = true,
  alerts = null,
}: SetupOptions = {}) {
  let contacts = nodes;
  let profile = PROFILE;
  const shell = fakeShellApi();
  shell.listNodes.mockImplementation(async () => contacts);
  shell.listGroups.mockResolvedValue([FAMILIA]);
  shell.getHistory.mockResolvedValue(history);
  shell.listCallHistory.mockResolvedValue(callLog);
  const getProfile = vi.fn(async () => profile);
  const blockNode = vi.fn(async (handle: string, blocked: boolean) => {
    contacts = contacts.map(other => (other.handle === handle ? { ...other, blocked } : other));
  });
  const shareBundle = vi.fn(async () => BUNDLE);
  const api: MainApi = {
    ...shell,
    shareBundle,
    getProfile,
    previewContact: vi.fn(async () => {
      throw new Error('no codes in these tests');
    }),
    probeNode: vi.fn(async (_bundle: string, handle: string) => node(handle)),
    acceptGroupInvite: vi.fn(async () => FAMILIA),
    declineGroupInvite: vi.fn(async () => {}),
    createGroup: vi.fn(async (name: string) => ({ ...FAMILIA, gid: 'g2', name, member_count: 1 })),
    addGroupMember: vi.fn(async () => FAMILIA),
    groupMembers: vi.fn(async () => []),
    removeGroupMember: vi.fn(async () => FAMILIA),
    renameGroup: vi.fn(async () => FAMILIA),
    leaveGroup: vi.fn(async () => {}),
    deleteGroup: vi.fn(async () => {}),
    renameNode: vi.fn(async () => {}),
    removeNode: vi.fn(async () => {}),
    blockNode,
    recordCall: vi.fn(async (peer: string, call: CallEventWire, startedAt: number): Promise<CallLogWire> => ({
      peer,
      ts: startedAt,
      call,
    })),
  };
  const settings = {
    ...fakeSettingsApi({
      getProfile,
      updateProfile: vi.fn(async (handle: string, avatar: string | null, about?: string) => {
        profile = { ...profile, handle, avatar, about: about ?? profile.about ?? '' };
      }),
      listNodes: vi.fn(async () => contacts),
      blockNode,
    }),
    shareBundle,
  };
  const { events, emit } = fakeEvents();
  let heard: ((event: CallSignalEvent) => void) | null = null;
  const onCallSignal = vi.fn(async (cb: (event: CallSignalEvent) => void) => {
    heard = cb;
    return () => {
      heard = null;
    };
  });
  /** A call signal from `from` reaches this device. */
  const signal = (from: string, payload: object) =>
    act(async () => {
      heard!({ from_handle: from, payload: JSON.stringify(payload) });
      await settle();
    });
  const { prefs, storage } = memoryPrefs(stored);
  const front = { now: inFront, listeners: new Set<(focused: boolean) => void>() };
  const notify = vi.fn(async (_title: string, _body: string) => {});
  const tone = vi.fn();
  const deps: MainDeps = {
    api,
    events: { ...events, onCallSignal },
    settings,
    notify,
    ensureNotifyPermission: vi.fn(async () => true),
    links: { open: vi.fn(async () => ({ state: 'opened' as const, remembered: false })) },
    window: {
      isFocused: async () => front.now,
      onFocusChanged: async listener => {
        front.listeners.add(listener);
        return () => {
          front.listeners.delete(listener);
        };
      },
    },
    prefs,
    capabilities,
    platform: 'windows',
    tone,
    sounds: quiet(),
    loadFeed: async () => ({ announcements: [], source: 'bundled' }),
    download: vi.fn(),
    makeAvatar: async () => 'data:image/jpeg;base64,AAAA',
    // Tor's screens have tests of their own (src/screens/net).
    net: null,
    alerts,
  };
  const main = {
    intent,
    onLock: vi.fn(),
    onAutolockChanged: vi.fn<(minutes: number) => void>(),
    onWiped: vi.fn(),
    onCallGate: vi.fn(),
  } satisfies MainProps;
  const { host } = fakeHost();
  const ui = (shellWidth: number) => (
    <AppearanceProvider host={host}>
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <ToastProvider closeLabel="Cerrar">
            <MainScreen {...main} deps={deps} width={shellWidth} rootPx={16} />
          </ToastProvider>
        </I18nContext.Provider>
      </LangCtx.Provider>
    </AppearanceProvider>
  );
  const view = render(ui(width));
  /** Trino comes to the front, or goes behind other windows. */
  const setInFront = (focused: boolean) =>
    act(() => {
      front.now = focused;
      for (const listener of front.listeners) listener(focused);
    });
  return {
    ...view,
    api,
    shell,
    settings,
    main,
    emit,
    signal,
    storage,
    notify,
    tone,
    setInFront,
    resize: (shellWidth: number) => view.rerender(ui(shellWidth)),
  };
}

const row = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name}`) });
const sidebar = () => screen.getByRole('navigation', { name: 'Chats y llamadas' });
const composer = (name: string) => screen.findByRole<HTMLTextAreaElement>('textbox', { name: `Mensaje para ${name}` });
const log = () => screen.getByRole('log', { name: 'Mensajes' });
const callScreen = (name = 'Ana') => screen.queryByRole('region', { name: `Llamada en curso con ${name}` });
const press = (button: HTMLElement) =>
  act(async () => {
    fireEvent.click(button);
    await settle();
  });
const inert = (element: Element) => element.closest('[inert]') !== null;
/** Settings' sections, as its navigation lists them. */
const goTo = async (section: string) => {
  const nav = await screen.findByRole('navigation', { name: 'Secciones de ajustes' });
  fireEvent.click(within(nav).getByRole('button', { name: section }));
  return screen.findByRole('heading', { level: 2, name: section });
};
const openSettings = async () => {
  await row('Ana');
  fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
  return screen.getByRole('main', { name: 'Ajustes' });
};

describe('MainScreen: the chats', () => {
  // App.tsx mounted one chat for every conversation, without a key: the
  // reply of one showed in the next, and its draft too.
  it('opens each chat in a pane of its own, and keeps each draft to its chat', async () => {
    setup({ history: { Ana: [{ side: 'them', text: encodeMeta('¿Vienes?', {}), ts: NOW - 60 }] } });
    fireEvent.click(await row('Ana'));
    fireEvent.change(await composer('Ana'), { target: { value: 'hola Ana' } });
    fireEvent.click(await within(log()).findByRole('button', { name: 'Opciones del mensaje' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Responder' }));
    expect(screen.getByText('Respondiendo a Ana')).toBeTruthy();

    fireEvent.click(await row('Bea'));
    expect((await composer('Bea')).value).toBe('');
    expect(screen.queryByText(/^Respondiendo a/)).toBeNull();

    fireEvent.click(await row('Ana'));
    expect((await composer('Ana')).value).toBe('hola Ana');
    // A new pane: the reply went with the old one.
    expect(screen.queryByText(/^Respondiendo a/)).toBeNull();
  });

  it('shows a text at once as sending, and as sent once a relay took it', async () => {
    const { shell } = setup();
    let answer!: (receipt: SendReceipt) => void;
    shell.sendMessage.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)));
    fireEvent.click(await row('Ana'));
    const box = await composer('Ana');
    fireEvent.change(box, { target: { value: 'Llego a las 7' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    const sent = await within(log()).findByText('Llego a las 7');
    const message = sent.closest('[data-message]') as HTMLElement;
    expect(within(message).getByText('Enviando')).toBeTruthy();
    expect(box.value).toBe('');
    await waitFor(() => expect(shell.sendMessage).toHaveBeenCalledWith('Ana', expect.any(String)));
    await act(async () => answer({ ts: NOW, accepted_by: ['wss://relay.example'] }));
    expect(within(message).getByText('Enviado')).toBeTruthy();
  });

  it('opens Contactos on "Agregar" when the first run asked to add a contact', async () => {
    setup({ intent: 'add-contact' });
    const contacts = await screen.findByRole('dialog', { name: 'Contactos' });
    expect(within(contacts).getByRole('tab', { name: 'Agregar' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows a group’s details beside the chat on a wide window, and as a dialog on a narrower one', async () => {
    const { resize } = setup({ width: 1280 });
    fireEvent.click(await row('Familia'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles del grupo' }));
    // One landmark beside the chat, the panel's own, named for the group.
    const asides = screen.getAllByRole('complementary');
    expect(asides).toEqual([screen.getByRole('complementary', { name: 'Familia' })]);

    resize(1024);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(await screen.findByRole('dialog', { name: 'Familia' })).toBeTruthy();
  });

  it('reads the contacts again when a contact’s profile changed', async () => {
    const { shell, emit } = setup();
    await row('Ana');
    const reads = shell.listNodes.mock.calls.length;
    act(() => emit.profileUpdated({ handle: 'Ana' }));
    await waitFor(() => expect(shell.listNodes.mock.calls.length).toBeGreaterThan(reads));
  });

  it('tells once about the verification marks of 0.1.0, naming those contacts', async () => {
    const { storage } = setup({ stored: { 'verified:Ana': 'fp-Ana' } });
    const notice = await screen.findByRole('dialog', { name: 'Vuelve a verificar a tus contactos' });
    expect(within(notice).getByText('Ana')).toBeTruthy();
    fireEvent.click(within(notice).getByRole('button', { name: 'Entendido' }));
    expect(storage.data.has('verified:Ana')).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Vuelve a verificar a tus contactos' })).toBeNull();
  });
});

// CE-6: the warning to a trusted contact, in the chats.
describe('MainScreen: the warning to a trusted contact', () => {
  function alertsOf(asks: string[]) {
    let heard: ((event: EmergencyAlertEvent) => void) | null = null;
    let state = { asks, warnings: [] as { handle: string; at: number; message: string }[] };
    const backend: EmergencyAlertsBackend = {
      emergencyAlerts: vi.fn(async () => state),
      answerEmergencyAlert: vi.fn(async (handle: string) => {
        state = { ...state, asks: state.asks.filter(ask => ask !== handle) };
      }),
      onEmergencyAlert: vi.fn(async (cb: (event: EmergencyAlertEvent) => void) => {
        heard = cb;
        return () => {};
      }),
    };
    const warn = (handle: string) =>
      act(async () => {
        state = { ...state, warnings: [{ handle, at: NOW, message: 'ya sabes' }] };
        heard?.({ handle, what: 'warned' });
      });
    return { backend, warn };
  }

  it('asks in the chat of the contact who asks, and the answer goes to the backend', async () => {
    const { backend } = alertsOf(['Ana']);
    setup({ alerts: backend });
    fireEvent.click(await row('Bea'));
    await composer('Bea');
    expect(screen.queryByRole('dialog', { name: 'Contacto de confianza' })).toBeNull();
    fireEvent.click(await row('Ana'));
    const dialog = await screen.findByRole('dialog', { name: 'Contacto de confianza' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Aceptar' }));
    await waitFor(() => expect(backend.answerEmergencyAlert).toHaveBeenCalledWith('Ana', true));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Contacto de confianza' })).toBeNull());
    expect(await screen.findByText('Aceptaste. Si Ana usa su clave de emergencia, verás un aviso en este chat.')).toBeTruthy();
  });

  it('tells of a warning that came as of a message, and shows its strip in the chat', async () => {
    const { backend, warn } = alertsOf([]);
    const { notify } = setup({ alerts: backend, inFront: false });
    fireEvent.click(await row('Ana'));
    await composer('Ana');
    await waitFor(() => expect(backend.onEmergencyAlert).toHaveBeenCalled());
    await warn('Ana');
    expect(notify.mock.calls.map(call => call[0])).toContain('Ana');
    expect((await screen.findByRole('note')).textContent).toMatch(/^Ana usó su clave de emergencia en uno de sus equipos\./);
  });
});

describe('MainScreen: telling of a message', () => {
  it('notifies the system while Trino is behind, and plays the tone while it is in front', async () => {
    const { emit, notify, tone, setInFront } = setup({ inFront: false });
    fireEvent.click(await row('Ana'));
    act(() => emit.messageReceived({ from_handle: 'Bea', text: encodeMeta('hola', {}), timestamp: NOW }));
    expect(notify).toHaveBeenCalledWith('Bea', 'Nuevo mensaje');
    expect(tone).not.toHaveBeenCalled();

    setInFront(true);
    act(() => emit.messageReceived({ from_handle: 'Bea', text: encodeMeta('¿sigues?', {}), timestamp: NOW + 1 }));
    expect(tone).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('MainScreen: new chat, new call and the call log', () => {
  it('opens the chat of the contact picked in "Nuevo chat"', async () => {
    setup();
    await row('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nuevo chat' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^Bea/ }));
    expect(screen.queryByRole('dialog', { name: 'Nuevo chat' })).toBeNull();
    expect(await composer('Bea')).toBeTruthy();
  });

  it('goes from "Nuevo chat" to "Nuevo grupo" or to adding with a code', async () => {
    setup();
    await row('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Nuevo chat' })).getByRole('button', { name: 'Nuevo grupo' }));
    expect(screen.queryByRole('dialog', { name: 'Nuevo chat' })).toBeNull();
    const group = await screen.findByRole('dialog', { name: 'Nuevo grupo' });
    fireEvent.keyDown(group, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nuevo grupo' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Nuevo chat' })).getByRole('button', { name: 'Agregar con código o QR' }),
    );
    const contacts = await screen.findByRole('dialog', { name: 'Contactos' });
    expect(within(contacts).getByRole('tab', { name: 'Agregar' }).getAttribute('aria-selected')).toBe('true');
  });

  it('calls the contact picked in "Nueva llamada"', async () => {
    setup();
    await row('Ana');
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nueva llamada' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nueva llamada' });
    await press(within(dialog).getByRole('button', { name: 'Llamar a Ana' }));
    expect(screen.queryByRole('dialog', { name: 'Nueva llamada' })).toBeNull();
    expect(callScreen()).not.toBeNull();
    expect(backend.sendCallSignal).toHaveBeenCalledWith('Ana', expect.stringContaining('"t":"offer"'));
  });

  // The log as the backend keeps it (listCallHistory), and a call that ends
  // meanwhile (call-logged): both in Llamadas, and each in its chat.
  it('shows a call in its chat, and in Llamadas with the count of missed calls', async () => {
    const missedBy = (peer: string, id: string, ago: number): CallLogWire => ({
      peer,
      ts: NOW - ago,
      call: { id, direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0 },
    });
    const { emit } = setup({ callLog: [missedBy('Bea', 'beef'.repeat(4), 600)] });
    expect(await screen.findByRole('tab', { name: 'Llamadas, 1 perdida sin ver' })).toBeTruthy();
    act(() => emit.callLogged(missedBy('Ana', 'f00d'.repeat(4), 30)));
    expect(await screen.findByRole('tab', { name: 'Llamadas, 2 perdidas sin ver' })).toBeTruthy();

    fireEvent.click(await row('Ana'));
    expect(within(log()).getByText('Llamada perdida')).toBeTruthy();
    expect(within(log()).getByRole('button', { name: 'Devolver llamada' })).toBeTruthy();
  });
});

describe('MainScreen: calls over the shell', () => {
  it('covers the shell with the call screen, and minimizes it to the bar above both panes', async () => {
    setup();
    fireEvent.click(await row('Ana'));
    const nav = sidebar();
    const main = screen.getByRole('main', { name: 'Ana' });
    await press(screen.getByRole('button', { name: 'Llamada de voz' }));
    const call = callScreen()!;
    expect(call).not.toBeNull();
    expect(inert(nav)).toBe(true);
    expect(inert(main)).toBe(true);
    expect(inert(call)).toBe(false);
    expect(call.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(callScreen()).toBeNull();
    const bar = screen.getByRole('region', { name: 'Llamada en curso' });
    expect(bar.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inert(nav)).toBe(false);
    expect(document.activeElement).toBe(within(bar).getByRole('button', { name: 'Volver a la llamada' }));
  });

  // The notice about the marks of 0.1.0 is a dialog over the window, where
  // the shell's `inert` does not reach: it waits while the call screen
  // covers the shell, and comes back with the call minimized, still unread.
  it('keeps the notice about old marks out of the call screen’s way until it goes', async () => {
    const { signal, storage } = setup({ stored: { 'verified:Bea': 'fp-Bea' } });
    const title = 'Vuelve a verificar a tus contactos';
    expect(await screen.findByRole('dialog', { name: title })).toBeTruthy();
    await signal('Ana', { t: 'offer', callId: newOfferId(), sdp: sdp('offer', false), video: false });
    await press(within(screen.getByRole('alertdialog', { name: 'Ana' })).getByRole('button', { name: 'Contestar' }));
    expect(callScreen()).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: title })).toBeNull();

    fireEvent.keyDown(within(callScreen()!).getByRole('heading', { name: 'Ana' }), { key: 'Escape' });
    expect(await screen.findByRole('dialog', { name: title })).toBeTruthy();
    // Shown again, not closed: the mark goes once it is read.
    expect(storage.data.get('verified:Bea')).toBe('fp-Bea');
  });

  it('rings over Settings, covers it once answered, and keeps the minimized call’s bar above it', async () => {
    const { signal } = setup();
    const settings = await openSettings();
    await signal('Ana', { t: 'offer', callId: newOfferId(), sdp: sdp('offer', false), video: false });
    const ringing = screen.getByRole('alertdialog', { name: 'Ana', description: 'Llamada entrante' });
    expect(inert(ringing)).toBe(false);

    await press(within(ringing).getByRole('button', { name: 'Contestar' }));
    const call = callScreen()!;
    expect(call).not.toBeNull();
    expect(inert(settings)).toBe(true);
    expect(settings.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.keyDown(within(call).getByRole('heading', { name: 'Ana' }), { key: 'Escape' });
    const bar = screen.getByRole('region', { name: 'Llamada en curso' });
    expect(inert(settings)).toBe(false);
    expect(settings.contains(bar)).toBe(false);
    expect(bar.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('verifies a contact through a call, from the contact’s symbols', async () => {
    setup({ stored: { 'verified:Ana': 'call:fp-Ana' } });
    fireEvent.click(await row('Bea'));
    fireEvent.click(screen.getByRole('button', { name: 'Verificar' }));
    const bea = await screen.findByRole('dialog', { name: 'Verificar a Bea' });
    expect(within(bea).getByText('Para verificar a Bea, llámale y comparen los símbolos de la llamada.')).toBeTruthy();
    await press(within(bea).getByRole('button', { name: 'Llamar' }));
    expect(screen.queryByRole('dialog', { name: 'Verificar a Bea' })).toBeNull();
    expect(callScreen('Bea')).not.toBeNull();
    fireEvent.click(within(callScreen('Bea')!).getByRole('button', { name: 'Colgar' }));
    await act(settle);

    // Ana was verified in a call: the dialog says so, and offers no call to verify again.
    fireEvent.click(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles del chat' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver la verificación' }));
    const ana = await screen.findByRole('dialog', { name: 'Verificar a Ana' });
    expect(within(ana).getByText('Verificaste a Ana en una llamada.')).toBeTruthy();
    expect(within(ana).queryByRole('button', { name: 'Llamar' })).toBeNull();
  });

  it('hands App the gate of its calls while it is open', async () => {
    const { main, unmount } = setup();
    await waitFor(() =>
      expect(main.onCallGate).toHaveBeenCalledWith(expect.objectContaining({ confirmEnd: expect.any(Function) })),
    );
    unmount();
    expect(main.onCallGate).toHaveBeenLastCalledWith(null);
  });
});

describe('MainScreen: Settings in the main pane', () => {
  it('opens Settings in the main pane, with the share panel of Contactos as "Tu código QR"', async () => {
    const { settings } = setup();
    const pane = await openSettings();
    expect(within(sidebar()).getByRole('button', { name: 'Ajustes' })).toBeTruthy();
    fireEvent.click(await within(pane).findByRole('button', { name: 'Mostrar tu código QR' }));
    expect(await within(pane).findByText(/^trino2:/)).toBeTruthy();
    expect(settings.shareBundle).toHaveBeenCalled();
  });

  it('reads the contacts again once Settings unblocked one, so its chat is no longer blocked', async () => {
    setup({ nodes: [node('Ana', { blocked: true }), node('Bea')] });
    fireEvent.click(await row('Ana'));
    expect(screen.queryByRole('textbox', { name: 'Mensaje para Ana' })).toBeNull();
    await openSettings();
    await goTo('Privacidad');
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a Ana' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Desbloquear a Ana' })).toBeNull());

    fireEvent.click(await row('Ana'));
    expect(await composer('Ana')).toBeTruthy();
  });

  it('hands App the lock and a new auto-lock time', async () => {
    const { main } = setup();
    await openSettings();
    await goTo('Cuenta y seguridad');
    fireEvent.change(screen.getByLabelText('Bloqueo automático'), { target: { value: '1' } });
    expect(main.onAutolockChanged).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(main.onLock).toHaveBeenCalledTimes(1);
  });

  it('hands over to App’s wipe once everything is erased', async () => {
    const { settings, main } = setup();
    await openSettings();
    await goTo('Cuenta y seguridad');
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo de este equipo' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Borrar todo de este equipo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar todo' }));
    await waitFor(() => expect(main.onWiped).toHaveBeenCalledTimes(1));
    expect(settings.wipe).toHaveBeenCalledTimes(1);
  });

  it('reads your profile again once Settings saved it, for the foot of the sidebar', async () => {
    const { settings } = setup();
    await openSettings();
    // Settings opens on Perfil.
    expect(await screen.findByRole('heading', { level: 2, name: 'Perfil' })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Nombre'), { target: { value: 'rechi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(settings.updateProfile).toHaveBeenCalledWith('rechi', null, ''));
    expect(await within(sidebar()).findByText('rechi')).toBeTruthy();
  });

  it('shows in Settings what this build’s backend can do, and nothing it cannot', async () => {
    setup({ capabilities: { ...ALL, changePassphrase: false, emergencyKey: false } });
    await openSettings();
    await goTo('Cuenta y seguridad');
    expect(screen.queryByRole('button', { name: 'Cambiar contraseña' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Clave de emergencia/ })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Activar' })).toBeTruthy();
  });

  it('opens the emergency key from Cuenta y seguridad when this build has it', async () => {
    setup();
    await openSettings();
    await goTo('Cuenta y seguridad');
    fireEvent.click(await screen.findByRole('button', { name: /^Clave de emergencia/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Clave de emergencia' })).toBeTruthy();
  });
});
