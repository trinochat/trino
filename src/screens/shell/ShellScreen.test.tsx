// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AppearanceProvider } from '../../design/useAppearance';
import type { CallLogWire, GroupInfo, GroupInvite, NodeInfo } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import type {
  ChatPaneProps,
  ContactDetailsSlotProps,
  ContactsSlotProps,
  GroupPanelSlotProps,
  NewChatSlotProps,
  SettingsSlotProps,
  ShellSlots,
} from '../types';
import { ShellScreen, type ShellScreenProps } from './ShellScreen';
import { appearanceHost, fakeApi, fakeEvents, fakePrefs } from './test-fakes';

afterEach(cleanup);

const NOW = Math.floor(Date.now() / 1000);

const node = (handle: string, over: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: `fp-${handle}`,
  has_session: true,
  added_at: NOW - 100,
  ...over,
});

const FAMILIA: GroupInfo = { gid: 'g1', name: 'Familia', epoch: 1, is_admin: true, member_count: 3, members: [] };

/** A chat with state of its own, as the real one has its reply bar. */
function FakeChat(p: ChatPaneProps) {
  const [reply, setReply] = useState<string | null>(null);
  return (
    <section aria-label={`Chat con ${p.header.name}`}>
      <input aria-label="Mensaje" value={p.draft} onChange={event => p.onDraftChange(event.target.value)} />
      <button type="button" onClick={() => setReply('¿vienes?')}>
        Responder
      </button>
      {reply && <p>Respondiendo a: {reply}</p>}
      {p.onBack && (
        <button type="button" onClick={p.onBack}>
          Atrás
        </button>
      )}
      <button type="button" onClick={p.onOpenDetails}>
        Detalles
      </button>
    </section>
  );
}

function fakeSlots() {
  return {
    chat: vi.fn((p: ChatPaneProps) => <FakeChat {...p} />),
    channel: vi.fn(() => <section aria-label="Canal" />),
    contacts: vi.fn((p: ContactsSlotProps) => <div data-testid="contacts" data-tab={p.tab} />),
    newGroup: vi.fn(() => <div data-testid="new-group" />),
    groupPanel: vi.fn((p: GroupPanelSlotProps) => <div data-testid="group-panel" data-layout={p.layout} />),
    settings: vi.fn((p: SettingsSlotProps) => <div data-testid="settings" data-section={p.section} />),
    contactDetails: vi.fn((p: ContactDetailsSlotProps) => <div data-testid="contact-details" data-layout={p.layout} />),
    verifyContact: vi.fn(() => <div data-testid="verify" />),
    newChat: vi.fn((p: NewChatSlotProps) => <div data-testid="new-chat" data-purpose={p.purpose} />),
  } satisfies ShellSlots;
}

const lastProps = <T,>(slot: Mock<(p: T) => ReactElement>): T => slot.mock.lastCall![0];

function setup(
  over: Partial<ShellScreenProps> = {},
  { nodes = [node('Ana'), node('Bea')], calls = [] as CallLogWire[], invites = [] as GroupInvite[] } = {},
) {
  const api = fakeApi();
  api.listNodes.mockResolvedValue(nodes);
  api.listGroups.mockResolvedValue([FAMILIA]);
  api.listCallHistory.mockResolvedValue(calls);
  api.listGroupInvites.mockResolvedValue(invites);
  const { events, emit } = fakeEvents();
  const { prefs, storage } = fakePrefs();
  const slots = fakeSlots();
  const call = {
    bar: <div data-testid="call-bar" />,
    layer: <div data-testid="call-layer" />,
    start: vi.fn(),
    activePeer: null,
  };
  const props: ShellScreenProps = {
    me: { handle: 'rechita', avatar: null, fingerprint: 'fp-me', identityDigest: 'ab'.repeat(32) },
    api,
    events,
    slots,
    call,
    notifier: { message: vi.fn() },
    capabilities: { connection: true, sendAck: true, deleteForMe: true, callLog: true },
    onLock: vi.fn(),
    initialIntent: 'chats',
    openLink: vi.fn(),
    isWindowFocused: () => true,
    settings: {
      onIdentityWiped: vi.fn(),
      onProfileChanged: vi.fn(),
      onAutolockChanged: vi.fn(),
      renderShareCode: () => null,
    },
    prefs,
    loadFeed: async () => ({ announcements: [], source: 'bundled' }),
    width: 1024,
    rootPx: 16,
    ...over,
  };
  const ui = (p: ShellScreenProps) => (
    <AppearanceProvider host={appearanceHost()}>
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <ShellScreen {...p} />
        </I18nContext.Provider>
      </LangCtx.Provider>
    </AppearanceProvider>
  );
  const utils = render(ui(props));
  return { ...utils, props, api, emit, slots, call, storage, rerenderWith: (more: Partial<ShellScreenProps>) => utils.rerender(ui({ ...props, ...more })) };
}

const row = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name}`) });
const sidebar = () => screen.queryByRole('navigation', { name: 'Chats y llamadas' });
const message = () => screen.getByRole('textbox', { name: 'Mensaje' }) as HTMLInputElement;

describe('ShellScreen: the chat of each conversation', () => {
  // App.tsx mounted one chat for every conversation, with no key: the draft
  // and the reply of one showed in the next (App.tsx:1649).
  it('keeps the draft and the reply of one chat out of another', async () => {
    setup();
    fireEvent.click(await row('Ana'));
    fireEvent.change(message(), { target: { value: 'hola Ana' } });
    fireEvent.click(screen.getByRole('button', { name: 'Responder' }));
    expect(screen.getByText('Respondiendo a: ¿vienes?')).toBeTruthy();

    fireEvent.click(await row('Bea'));
    expect(screen.getByRole('region', { name: 'Chat con Bea' })).toBeTruthy();
    expect(message().value).toBe('');
    expect(screen.queryByText(/Respondiendo a/)).toBeNull();

    fireEvent.click(await row('Ana'));
    expect(message().value).toBe('hola Ana');
  });

  it('gives the chat what it needs from the shell', async () => {
    const { slots, api } = setup({}, { nodes: [node('Ana'), node('Bea', { blocked: true })] });
    fireEvent.click(await row('Ana'));
    const ana = lastProps(slots.chat);
    expect(ana.convo).toEqual({ kind: 'contact', handle: 'Ana' });
    expect(ana.header).toMatchObject({ kind: 'contact', name: 'Ana', trust: 'unverified', blocked: false });
    expect(ana.onCall).toBeTypeOf('function');
    expect(ana.onDeleteForMe).toBeTypeOf('function');
    await ana.fetchFile({ url: 'u', key: 'k', sha256: 's', mime: 'image/png', name: 'a.png', size: 1 });
    expect(api.fetchFile).toHaveBeenCalledWith('u', 'k', 's', 'image/png');

    // No call buttons for a blocked contact.
    fireEvent.click(await row('Bea'));
    expect(lastProps(slots.chat).onCall).toBeUndefined();

    fireEvent.click(await row('Familia'));
    expect(lastProps(slots.chat).header).toMatchObject({ kind: 'group', name: 'Familia', memberCount: 3, ended: false });
    expect(lastProps(slots.chat).onCall).toBeUndefined();
  });

  it('leaves "Borrar para mí" out without the backend for it (K11)', async () => {
    const { slots } = setup({ capabilities: { connection: true, sendAck: true, deleteForMe: false, callLog: true } });
    fireEvent.click(await row('Ana'));
    expect(lastProps(slots.chat).onDeleteForMe).toBeUndefined();
  });

  it('opens the channel in the main pane', async () => {
    const { slots } = setup();
    fireEvent.click(await row('Novedades de Trino'));
    expect(screen.getByRole('region', { name: 'Canal' })).toBeTruthy();
    expect(lastProps(slots.channel as unknown as Mock<(p: unknown) => ReactElement>)).toMatchObject({ source: 'bundled' });
  });
});

describe('ShellScreen: layout', () => {
  it('shows one pane below 47.5 rem, with Atrás from the chat to the list', async () => {
    setup({ width: 759 });
    expect(sidebar()).not.toBeNull();
    expect(screen.queryByRole('main')).toBeNull();
    fireEvent.click(await row('Ana'));
    expect(sidebar()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Atrás' }));
    expect(sidebar()).not.toBeNull();
  });

  it('shows both panes from 47.5 rem, the chat with no Atrás', async () => {
    setup({ width: 760 });
    expect(sidebar()).not.toBeNull();
    expect(within(screen.getByRole('main')).getByText('Elige un chat para empezar a escribir.')).toBeTruthy();
    fireEvent.click(await row('Ana'));
    expect(sidebar()).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Atrás' })).toBeNull();
  });

  it('measures in rem of the root: at 125 % one pane until 950 px', async () => {
    const { rerenderWith } = setup({ width: 949, rootPx: 20 });
    expect(screen.queryByRole('main')).toBeNull();
    rerenderWith({ width: 950, rootPx: 20 });
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('puts the details beside the chat from 70 rem, and in a dialog below', async () => {
    const { slots, rerenderWith } = setup({ width: 1120 });
    fireEvent.click(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    expect(lastProps(slots.contactDetails).layout).toBe('aside');
    expect(within(screen.getByRole('complementary', { name: 'Detalles del chat' })).getByTestId('contact-details')).toBeTruthy();

    rerenderWith({ width: 1119 });
    expect(lastProps(slots.contactDetails).layout).toBe('dialog');
    expect(screen.queryByRole('complementary', { name: 'Detalles del chat' })).toBeNull();

    fireEvent.click(await row('Familia'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    expect(lastProps(slots.groupPanel)).toMatchObject({ layout: 'dialog', group: FAMILIA });
  });

  it('puts the call bar above both panes and the call layer over everything', async () => {
    setup();
    const bar = screen.getByTestId('call-bar');
    expect(bar.compareDocumentPosition(sidebar()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bar.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('call-layer')).toBeTruthy();
    await row('Ana');
  });

  it('draws the scan lines of Terminal on its background', () => {
    const { container } = setup();
    expect(container.firstElementChild?.className).toContain('[background-image:var(--t-scan)]');
  });
});

describe('ShellScreen: keyboard', () => {
  it('goes back to Chats and to the search with Ctrl+K', async () => {
    setup({ width: 759 });
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    expect(screen.getByRole('tab', { name: 'Llamadas' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('tab', { name: 'Chats' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Buscar chats' })));

    // From a chat on one pane, too.
    fireEvent.click(await row('Ana'));
    expect(sidebar()).toBeNull();
    fireEvent.keyDown(window, { key: 'K', ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Buscar chats' })));
  });

  it('locks with Ctrl+L', () => {
    const { props } = setup();
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true });
    expect(props.onLock).toHaveBeenCalledTimes(1);
  });
});

describe('ShellScreen: new chat, new call and the call log', () => {
  it('opens "Nuevo chat" and "Nueva llamada" through one slot, with their purpose', async () => {
    const { slots } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
    expect(screen.getByTestId('new-chat').getAttribute('data-purpose')).toBe('chat');
    await waitFor(() => expect(lastProps(slots.newChat).contacts.map(n => n.handle)).toEqual(['Ana', 'Bea']));
    act(() => lastProps(slots.newChat).onClose());
    expect(screen.queryByTestId('new-chat')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Nueva llamada' }));
    expect(screen.getByTestId('new-chat').getAttribute('data-purpose')).toBe('call');
  });

  it('follows the new chat dialog: a chat, a call, a new group or a code', async () => {
    const { slots, call } = setup();
    await row('Ana');
    const open = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
      return lastProps(slots.newChat);
    };
    const toChat = open();
    act(() => toChat.onOpenChat('Bea'));
    expect(screen.queryByTestId('new-chat')).toBeNull();
    expect(lastProps(slots.chat).convo).toEqual({ kind: 'contact', handle: 'Bea' });

    const toCall = open();
    act(() => toCall.onCall('Ana', true));
    expect(call.start).toHaveBeenCalledWith('Ana', true);
    expect(screen.queryByTestId('new-chat')).toBeNull();

    const toGroup = open();
    act(() => toGroup.onNewGroup());
    expect(screen.queryByTestId('new-chat')).toBeNull();
    expect(screen.getByTestId('new-group')).toBeTruthy();
    act(() => lastProps(slots.newGroup as unknown as Mock<(p: { onClose(): void }) => ReactElement>).onClose());

    const toCode = open();
    act(() => toCode.onAddWithCode());
    expect(screen.getByTestId('contacts').getAttribute('data-tab')).toBe('add');
  });

  it('counts the missed calls in the tab, and opening it marks them seen', async () => {
    const missed: CallLogWire = {
      peer: 'Ana',
      ts: NOW - 30,
      call: { id: 'm1m1m1m1m1m1m1m1', direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0 },
    };
    const { storage } = setup({}, { calls: [missed] });
    expect(await screen.findByRole('tab', { name: 'Llamadas, 1 perdida sin ver' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas, 1 perdida sin ver' }));
    expect(screen.getByRole('tab', { name: 'Llamadas' })).toBeTruthy();
    expect(Number(storage.data.get('trino.pref.callsSeenAt'))).toBeGreaterThanOrEqual(missed.ts);
  });

  it('opens the chat from the call log and stays on Calls; "Llamar a" calls with voice', async () => {
    const answered: CallLogWire = {
      peer: 'Ana',
      ts: NOW - 300,
      call: { id: 'a1a1a1a1a1a1a1a1', direction: 'outgoing', video: false, outcome: 'answered', duration_sec: 240 },
    };
    const { slots, call } = setup({}, { calls: [answered] });
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    const log = await screen.findByRole('list', { name: 'Historial de llamadas' });
    fireEvent.click(within(log).getByRole('button', { name: /^Ana/ }));
    expect(lastProps(slots.chat).convo).toEqual({ kind: 'contact', handle: 'Ana' });
    expect(screen.getByRole('tab', { name: 'Llamadas' }).getAttribute('aria-selected')).toBe('true');
    expect(within(log).getByRole('button', { name: /^Ana/ }).getAttribute('aria-current')).toBe('true');

    fireEvent.click(within(log).getByRole('button', { name: 'Llamar a Ana' }));
    expect(call.start).toHaveBeenCalledWith('Ana', false);
  });

  it('has only the chats when the calls are not recorded (no K13)', async () => {
    const { api } = setup({ capabilities: { connection: true, sendAck: true, deleteForMe: true, callLog: false } });
    await row('Ana');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(api.listCallHistory).not.toHaveBeenCalled();
  });
});

describe('ShellScreen: contacts, invitations and Settings', () => {
  it('opens Contacts on the add tab when the first run asked for it', async () => {
    const { slots } = setup({ initialIntent: 'add-contact' });
    expect(screen.getByTestId('contacts').getAttribute('data-tab')).toBe('add');
    act(() => lastProps(slots.contacts).onContactAdded('Carla'));
    expect(screen.queryByTestId('contacts')).toBeNull();
    expect(lastProps(slots.chat).convo).toEqual({ kind: 'contact', handle: 'Carla' });
  });

  it('tells of pending invitations, and "Ver" opens them in Contacts', async () => {
    const invite = { gid: 'g2', name: 'Trabajo', from_handle: 'Ana', member_count: 4, received_at: NOW };
    const { slots } = setup({}, { invites: [invite] });
    expect(await screen.findByText('Tienes invitaciones a grupos sin responder.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }));
    expect(lastProps(slots.contacts)).toMatchObject({ tab: 'invites', invites: [invite] });
  });

  it('tells once of a stranger who tried to write', async () => {
    const { emit, slots } = setup();
    await row('Ana');
    const notice = 'Alguien que no está en tus contactos intentó escribirte.';
    act(() => emit.handshakeNeeded({ from_pubkey: 'aa' }));
    expect(screen.getByText(notice)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }));
    expect(lastProps(slots.contacts)).toMatchObject({ tab: 'invites', strangerAttempts: 1 });
    act(() => lastProps(slots.contacts).onClose());
    expect(screen.queryByText(notice)).toBeNull();
  });

  it('opens Settings in the main pane and comes back', async () => {
    const { slots, props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(screen.getByTestId('settings').getAttribute('data-section')).toBe('profile');
    const settings = lastProps(slots.settings);
    act(() => settings.onSectionChange('privacy'));
    expect(screen.getByTestId('settings').getAttribute('data-section')).toBe('privacy');
    act(() => lastProps(slots.settings).onLockNow());
    expect(props.onLock).toHaveBeenCalled();
    act(() => lastProps(slots.settings).onClose());
    expect(screen.queryByTestId('settings')).toBeNull();
    await row('Ana');
  });

  it('shares your code from the foot, through Contacts', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Compartir mi código' }));
    expect(screen.getByTestId('contacts').getAttribute('data-tab')).toBe('share');
    await row('Ana');
  });
});
