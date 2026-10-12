// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useLayoutEffect, useState, type ReactElement } from 'react';
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
  VerifyContactSlotProps,
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
    verifyContact: vi.fn((_p: VerifyContactSlotProps) => <div data-testid="verify" />),
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
    covering: false,
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
const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);

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

  // W3's composer clears what it sent itself and keeps what was typed
  // meanwhile, such as during an upload (its review fix): clearing the
  // draft here as well could wipe that text.
  it('leaves the draft to the chat when a text is sent', async () => {
    const { slots, api } = setup();
    fireEvent.click(await row('Ana'));
    fireEvent.change(message(), { target: { value: 'hola Ana' } });
    act(() => lastProps(slots.chat).onSendText('hola'));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('Ana', expect.any(String)));
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

  // W3's sticker picker reloads every sticker when its API object changes, and
  // the shell renders at least every 10 s and on every backend event.
  it('hands the chat the same sticker API on every render', async () => {
    const { slots, emit } = setup();
    fireEvent.click(await row('Ana'));
    const first = lastProps(slots.chat).stickers;
    const renders = slots.chat.mock.calls.length;
    act(() => emit.messageReceived({ from_handle: 'Bea', text: 'hola', timestamp: NOW }));
    expect(slots.chat.mock.calls.length).toBeGreaterThan(renders);
    expect(lastProps(slots.chat).stickers).toBe(first);
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

  // The sidebar and the main pane paint opaque backgrounds over all of the
  // shell, so lines on the shell's own background never showed, and the
  // Appearance switch (W5) had nothing to turn off (accesibilidad.md §2.2).
  it('draws the scan lines of Terminal over both panes, where nothing covers them', async () => {
    const { container } = setup();
    await row('Ana');
    const root = container.firstElementChild!;
    const lines = [...root.querySelectorAll('*')].filter(el => classesOf(el).includes('[background-image:var(--t-scan)]'));
    expect(lines).toHaveLength(1);
    expect(classesOf(root)).not.toContain('[background-image:var(--t-scan)]');
    const overlay = lines[0]!;
    // A layer of the shell itself, over all of it, that nothing reads or clicks.
    expect(overlay.parentElement).toBe(root);
    expect(classesOf(overlay)).toEqual(expect.arrayContaining(['pointer-events-none', 'absolute', 'inset-0']));
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    // Positioned after both panes, so it paints over them.
    for (const pane of [sidebar()!, screen.getByRole('main')]) {
      expect(pane.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(overlay.contains(pane)).toBe(false);
    }
    // The call screen still goes over everything.
    expect(overlay.compareDocumentPosition(screen.getByTestId('call-layer')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // W6's call layer is absolute and inset 0: the shell is the box it fills,
  // not the window with the title bar above the shell.
  it('is the positioned box the call layer fills', () => {
    const { container } = setup();
    const root = container.firstElementChild!;
    expect(classesOf(root)).toContain('relative');
    expect(screen.getByTestId('call-layer').parentElement).toBe(root);
  });
});

/**
 * W6's call screen covers the shell (`CallSlot.covering`, I5): nothing hidden
 * behind it may keep or take the focus. The panes, the banners, the call bar's
 * row and the details beside the chat go inert, never the call layer. The
 * shell's dialogs are portals above the call screen, where `inert` does not
 * reach: they close in the render the call screen comes up in.
 */
describe('ShellScreen: under the call screen', () => {
  const covering = (props: ShellScreenProps, on: boolean) => ({ call: { ...props.call, covering: on } });
  const inert = (element: Element) => element.closest('[inert]') !== null;

  it('makes the panes, the banners, the call bar and the details beside the chat inert while it covers them', async () => {
    const api = fakeApi();
    api.listNodes.mockResolvedValue([node('Ana')]);
    api.getHistory.mockRejectedValue(new Error('no history'));
    const { props, rerenderWith } = setup({ api, width: 1280 });
    fireEvent.click(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    const covered = [
      sidebar()!,
      screen.getByRole('main'),
      screen.getByRole('complementary', { name: 'Detalles del chat' }),
      await screen.findByText('No se pudo cargar el historial de tus chats.'),
      screen.getByTestId('call-bar'),
    ];
    expect(covered.filter(inert)).toEqual([]);

    rerenderWith(covering(props, true));
    expect(covered.filter(element => !inert(element))).toEqual([]);
    expect(inert(screen.getByTestId('call-layer'))).toBe(false);

    rerenderWith(covering(props, false));
    expect(covered.filter(inert)).toEqual([]);
  });

  it('closes its dialogs in the render the call screen comes up in, and they stay closed', async () => {
    /** Whether a commit ever had a dialog of the shell together with the call screen. */
    let overCall = false;
    function FakeDialog({ testId }: { testId: string }) {
      useLayoutEffect(() => {
        if (document.querySelector('[data-testid="call-layer"][data-covering="true"]')) overCall = true;
      });
      return <div role="dialog" data-testid={testId} />;
    }
    const slots = {
      ...fakeSlots(),
      newChat: vi.fn((p: NewChatSlotProps) => <FakeDialog testId={`new-chat-${p.purpose}`} />),
      contactDetails: vi.fn((p: ContactDetailsSlotProps) => <FakeDialog testId={`details-${p.layout}`} />),
    };
    const { props, rerenderWith } = setup({ slots, width: 1024 });
    const callWith = (on: boolean) => ({
      call: { ...props.call, covering: on, layer: <div data-testid="call-layer" data-covering={String(on)} /> },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Nuevo chat' }));
    expect(screen.getByTestId('new-chat-chat')).toBeTruthy();
    rerenderWith(callWith(true));
    expect(screen.queryByTestId('new-chat-chat')).toBeNull();
    rerenderWith(callWith(false));
    expect(screen.queryByTestId('new-chat-chat')).toBeNull();

    fireEvent.click(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    expect(screen.getByTestId('details-dialog')).toBeTruthy();
    rerenderWith(callWith(true));
    expect(screen.queryByTestId('details-dialog')).toBeNull();
    rerenderWith(callWith(false));
    expect(screen.queryByTestId('details-dialog')).toBeNull();

    expect(overCall).toBe(false);
  });

  // Ctrl+K would swap the panes hidden under the call screen and reach for
  // a search box that is inert.
  it('leaves Ctrl+K alone while it covers the shell', async () => {
    const { props, rerenderWith } = setup({ width: 759 });
    fireEvent.click(await row('Ana'));
    rerenderWith(covering(props, true));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(sidebar()).toBeNull();
    expect(screen.getByRole('main', { name: 'Ana' })).toBeTruthy();
  });

  // The call screen took the focus (W6); as it goes, without the bar or an
  // end card to take it, the focus would fall to the page.
  it('gives the focus to the conversation when the call screen goes and the focus fell to the page', async () => {
    const { props, rerenderWith } = setup({ width: 1024 });
    fireEvent.click(await row('Ana'));
    rerenderWith(covering(props, true));
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    rerenderWith(covering(props, false));
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Ana' }));
  });
});

/**
 * One pane swaps the list and the conversation, so the control that had the
 * focus leaves the page with its pane, and the focus falls to the body: a
 * screen reader says nothing, and the next Tab starts at the top. These
 * press the way a keyboard does, with the focus on the control first.
 */
describe('ShellScreen: where the focus goes', () => {
  const press = (element: HTMLElement) => {
    element.focus();
    fireEvent.click(element);
  };

  it('puts the focus in the conversation that one pane opens, named for it, and back on its row with Atrás', async () => {
    setup({ width: 759 });
    press(await row('Ana'));
    const main = screen.getByRole('main', { name: 'Ana' });
    expect(main.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(main);

    press(screen.getByRole('button', { name: 'Atrás' }));
    expect(document.activeElement).toBe(await row('Ana'));
  });

  it('gives the focus back to the call when the chat was opened from the log', async () => {
    const answered: CallLogWire = {
      peer: 'Bea',
      ts: NOW - 300,
      call: { id: 'b2b2b2b2b2b2b2b2', direction: 'incoming', video: false, outcome: 'answered', duration_sec: 60 },
    };
    setup({ width: 759 }, { calls: [answered] });
    await row('Ana');
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    const log = await screen.findByRole('list', { name: 'Historial de llamadas' });
    press(within(log).getByRole('button', { name: /^Bea/ }));
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Bea' }));

    press(screen.getByRole('button', { name: 'Atrás' }));
    const back = within(screen.getByRole('list', { name: 'Historial de llamadas' })).getByRole('button', { name: /^Bea/ });
    expect(document.activeElement).toBe(back);
  });

  it('takes the focus into Settings on one pane, and back to Ajustes when it closes', async () => {
    const { slots } = setup({ width: 759 });
    await row('Ana');
    press(screen.getByRole('button', { name: 'Ajustes' }));
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Ajustes' }));
    act(() => lastProps(slots.settings).onClose());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Ajustes' }));
  });

  it('gives the focus to the chat when the details beside it close', async () => {
    const slots = {
      ...fakeSlots(),
      contactDetails: vi.fn((p: ContactDetailsSlotProps) => (
        <button type="button" onClick={p.onClose}>
          Cerrar detalles
        </button>
      )),
    };
    setup({ width: 1120, slots });
    press(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    press(screen.getByRole('button', { name: 'Cerrar detalles' }));
    expect(screen.queryByRole('complementary', { name: 'Detalles del chat' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('main', { name: 'Ana' }));
  });

  it('leaves the focus on the sidebar when the open contact is removed', async () => {
    const { slots } = setup({ width: 759 });
    press(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    act(() => lastProps(slots.contactDetails).onRemoved());
    expect(document.activeElement).toBe(sidebar());
  });

  it('leaves the focus on the row it was on when both panes show', async () => {
    setup({ width: 1024 });
    const ana = await row('Ana');
    press(ana);
    expect(screen.getByRole('main', { name: 'Ana' })).toBeTruthy();
    expect(document.activeElement).toBe(ana);
  });

  it('keeps the open chat listed under "No leídos" until the chip or the chat changes', async () => {
    const { emit } = setup({ width: 1024 });
    await row('Ana');
    act(() => emit.messageReceived({ from_handle: 'Ana', text: 'hola', timestamp: NOW }));
    act(() => emit.messageReceived({ from_handle: 'Bea', text: '¿y tú?', timestamp: NOW + 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'No leídos' }));
    const unread = () => within(screen.getByRole('list', { name: 'Chats' }));

    const ana = unread().getByRole('button', { name: /^Ana/ });
    press(ana);
    // Read now, and still there, with the focus.
    expect(ana.textContent).not.toContain('Sin leer');
    expect(ana.isConnected).toBe(true);
    expect(document.activeElement).toBe(ana);

    // Another chat: Ana goes, Bea stays while open.
    press(unread().getByRole('button', { name: /^Bea/ }));
    expect(unread().queryByRole('button', { name: /^Ana/ })).toBeNull();
    expect(unread().getByRole('button', { name: /^Bea/ })).toBe(document.activeElement);

    // Another chip, and back: the read chat is no longer kept.
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    fireEvent.click(screen.getByRole('button', { name: 'No leídos' }));
    expect(screen.queryByRole('list', { name: 'Chats' })).toBeNull();
    expect(screen.getByText('No hay chats en este filtro.')).toBeTruthy();
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

  // App locks with Ctrl+L from anywhere in the chats, and asks first during
  // a call (I2). A second handler here would be one lock too many.
  it('leaves Ctrl+L to the app, which locks with it', () => {
    const { props } = setup();
    const press = new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(press);
    expect(props.onLock).not.toHaveBeenCalled();
    expect(press.defaultPrevented).toBe(false);
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

  // Bea's chat has disappearing messages: on the cleanup that drops the call
  // from her chat, and from the backend, it leaves the log and its count.
  it('drops a call from the log, and from "Llamadas · N", on the cleanup that drops it from its chat', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      const now = Math.floor(Date.now() / 1000);
      const fading: CallLogWire = {
        peer: 'Bea',
        ts: now - 5,
        call: { id: 'e1e1e1e1e1e1e1e1', direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0, ttl: 10 },
      };
      setup({}, { calls: [fading] });
      expect(await screen.findByRole('tab', { name: 'Llamadas, 1 perdida sin ver' })).toBeTruthy();
      act(() => vi.advanceTimersByTime(10_000));
      const calls = screen.getByRole('tab', { name: 'Llamadas' });
      fireEvent.click(calls);
      expect(screen.getByText('Todavía no hay llamadas.')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // remove_node deletes the contact's history, where the backend keeps its calls.
  it("forgets a removed contact's calls in the log and in its count", async () => {
    const missed = (peer: string, id: string): CallLogWire => ({
      peer,
      ts: NOW - 30,
      call: { id, direction: 'incoming', video: false, outcome: 'missed', duration_sec: 0 },
    });
    const { slots } = setup({}, { calls: [missed('Ana', 'a1a1a1a1a1a1a1a1'), missed('Bea', 'b1b1b1b1b1b1b1b1')] });
    expect(await screen.findByRole('tab', { name: 'Llamadas, 2 perdidas sin ver' })).toBeTruthy();
    fireEvent.click(await row('Ana'));
    fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
    act(() => lastProps(slots.contactDetails).onRemoved());

    const calls = screen.getByRole('tab', { name: 'Llamadas, 1 perdida sin ver' });
    fireEvent.click(calls);
    const log = screen.getByRole('list', { name: 'Historial de llamadas' });
    expect(within(log).queryByRole('button', { name: /^Ana/ })).toBeNull();
    expect(within(log).getByRole('button', { name: /^Bea/ })).toBeTruthy();
  });

  it('never opens a chat from the log for someone who is not a contact', async () => {
    const gone: CallLogWire = {
      peer: 'Zoe',
      ts: NOW - 60,
      call: { id: 'z1z1z1z1z1z1z1z1', direction: 'outgoing', video: false, outcome: 'answered', duration_sec: 30 },
    };
    const { slots } = setup({}, { calls: [gone] });
    await row('Ana');
    fireEvent.click(screen.getByRole('tab', { name: 'Llamadas' }));
    const log = await screen.findByRole('list', { name: 'Historial de llamadas' });
    fireEvent.click(within(log).getByRole('button', { name: /^Zoe/ }));
    expect(slots.chat).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Chat con Zoe' })).toBeNull();
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

  // Unblocking happens in Settings > Privacidad (W5): the chat of that
  // contact must not stay blocked until something else reads the contacts.
  it('reads the contacts again when Settings changed one', async () => {
    const { slots, api } = setup({}, { nodes: [node('Ana', { blocked: true }), node('Bea')] });
    await row('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    const reads = api.listNodes.mock.calls.length;
    api.listNodes.mockResolvedValue([node('Ana'), node('Bea')]);
    act(() => lastProps(slots.settings).onContactsChanged());
    await waitFor(() => expect(api.listNodes.mock.calls.length).toBe(reads + 1));
  });

  // The app keeps the calls and the notice about old verification marks,
  // which need the contacts the shell reads (I6).
  it('tells the app its contacts each time it reads them', async () => {
    const onContactsChange = vi.fn();
    const { slots, api } = setup({ onContactsChange });
    await waitFor(() => expect(onContactsChange).toHaveBeenLastCalledWith([node('Ana'), node('Bea')]));
    api.listNodes.mockResolvedValue([node('Bea')]);
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    act(() => lastProps(slots.settings).onContactsChanged());
    await waitFor(() => expect(onContactsChange).toHaveBeenLastCalledWith([node('Bea')]));
  });
});

describe('ShellScreen: verifying a contact', () => {
  // The verify slot says whether the contact is verified (I5, 0f3758b), so
  // its dialog tells a verified contact so instead of asking for a call
  // again. Only the mark of a call with the fingerprint the contact still
  // has counts (5fe6f70): a bare fingerprint of 0.1.0 does not.
  it('tells the verify dialog whether the contact is verified, by the mark of a call only', async () => {
    const { slots, storage } = setup();
    storage.setItem('verified:Ana', 'call:fp-Ana');
    storage.setItem('verified:Bea', 'fp-Bea');
    const verify = async (name: string) => {
      fireEvent.click(await row(name));
      fireEvent.click(screen.getByRole('button', { name: 'Detalles' }));
      act(() => lastProps(slots.contactDetails).onVerify());
      return lastProps(slots.verifyContact);
    };

    expect(await verify('Ana')).toMatchObject({ peer: { handle: 'Ana' }, verified: true });
    act(() => lastProps(slots.verifyContact).onClose());
    expect(await verify('Bea')).toMatchObject({ peer: { handle: 'Bea' }, verified: false });
  });
});
