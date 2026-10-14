// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import type { InboxItem } from '../types';
import type { InboxRowActions } from './InboxList';
import { InboxPanel, type InboxPanelProps } from './InboxPanel';

afterEach(cleanup);

const T0 = 1_760_000_000;

const ITEMS: InboxItem[] = [
  {
    ref: { kind: 'contact', handle: 'Ana' },
    key: 'Ana',
    name: 'Ana',
    avatar: { initials: 'AN', kind: 'person' },
    preview: 'Perfecto, nos vemos el jueves',
    lastTs: T0,
    unread: 1,
    trust: 'verified',
  },
  {
    ref: { kind: 'group', gid: 'g1' },
    key: 'grp:g1',
    name: 'Familia',
    avatar: { initials: 'FA', kind: 'group' },
    preview: 'Papá: Llego a las 7',
    lastTs: T0 - 60,
    unread: 3,
    muted: true,
  },
  {
    ref: { kind: 'contact', handle: 'Carlos' },
    key: 'Carlos',
    name: 'Carlos',
    avatar: { initials: 'CA', kind: 'person' },
    preview: 'Te envié el archivo',
    draft: 'Mañana te confirmo la hora',
    lastTs: T0 - 86_400,
    unread: 0,
    trust: 'keyChanged',
  },
  {
    ref: { kind: 'channel' },
    key: 'channel',
    name: 'Novedades de Trino',
    avatar: { initials: 'T', kind: 'person' },
    preview: 'Ya está la beta 2',
    unread: 0,
  },
];

function props(over: Partial<InboxPanelProps> = {}): InboxPanelProps {
  return {
    wordmark: 'Trino',
    items: ITEMS,
    selectedKey: null,
    onSelect: vi.fn(),
    filter: 'all',
    onFilterChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
    connection: { status: 'connected', up: 3, total: 3 },
    me: { handle: 'rechita' },
    onNewChat: vi.fn(),
    onNewCall: vi.fn(),
    tab: 'chats',
    onTabChange: vi.fn(),
    calls: [],
    callFilter: 'all',
    onCallFilterChange: vi.fn(),
    missedUnseen: 0,
    selectedCallKey: null,
    onCallBack: vi.fn(),
    onOpenCallChat: vi.fn(),
    onShareCode: vi.fn(),
    onOpenSettings: vi.fn(),
    hasContacts: true,
    onAddContact: vi.fn(),
    now: T0,
    ...over,
  };
}

function renderEs(ui: ReactElement) {
  return render(
    <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
      <I18nContext.Provider value={makeT('es')}>{ui}</I18nContext.Provider>
    </LangCtx.Provider>,
  );
}

const classesOf = (element: Element | null) => (element?.getAttribute('class') ?? '').split(/\s+/);
const rowNamed = (name: RegExp) => screen.getByRole('button', { name });

describe('InboxPanel: the chats', () => {
  it('shows one row per chat, drawn by ChatRow, with its preview, time and unread count', () => {
    renderEs(<InboxPanel {...props()} />);
    const list = screen.getByRole('list', { name: 'Chats' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(4);
    // ChatRow: 64 px tall, the selected one marked with aria-current.
    for (const row of rows) expect(classesOf(row)).toContain('min-h-16');
    const ana = rowNamed(/^Ana Verificado/);
    expect(ana.textContent).toContain('Perfecto, nos vemos el jueves');
    expect(ana.textContent).toContain('1 Sin leer');
  });

  it('marks the open chat', () => {
    renderEs(<InboxPanel {...props({ selectedKey: 'Carlos' })} />);
    expect(rowNamed(/^Carlos/).getAttribute('aria-current')).toBe('true');
    expect(rowNamed(/^Ana/).getAttribute('aria-current')).toBeNull();
  });

  it('sets an unread chat in bold, besides its count', () => {
    renderEs(<InboxPanel {...props()} />);
    expect(classesOf(rowNamed(/^Ana/))).toContain('font-bold');
    expect(classesOf(rowNamed(/^Carlos/))).not.toContain('font-bold');
  });

  it('gives a muted chat the BellOff icon and an outlined count, not only grey', () => {
    renderEs(<InboxPanel {...props()} />);
    const item = rowNamed(/^Familia/).closest('li')!;
    const bell = item.querySelector('svg.lucide-bell-off');
    expect(bell).not.toBeNull();
    // The word is in the row's own name (below), so the picture is decoration.
    expect(bell!.closest('[aria-hidden="true"]')).not.toBeNull();
    const badge = within(rowNamed(/^Familia/)).getByText('3').closest('span');
    expect(classesOf(badge)).toContain('border-ui-muted');
    expect(rowNamed(/^Ana/).closest('li')!.querySelector('svg.lucide-bell-off')).toBeNull();
  });

  // Tabbing through the chats reads each row's name only: an image beside the
  // button never reaches it, so "Silenciado" has to be inside the row.
  it('says "Silenciado" in the name of a muted row, read or not', () => {
    const quiet = { ...ITEMS[1]!, unread: 0 };
    const { rerender } = renderEs(<InboxPanel {...props()} />);
    expect(rowNamed(/^Familia.*Silenciado/)).toBeTruthy();
    expect(within(rowNamed(/^Familia/).closest('li')!).queryByRole('img')).toBeNull();
    expect(rowNamed(/^Ana/).textContent).not.toContain('Silenciado');

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ items: [quiet] })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(rowNamed(/^Familia.*Silenciado/)).toBeTruthy();
  });

  it('says in words which row is a group, since Terminal squares every avatar', () => {
    renderEs(<InboxPanel {...props()} />);
    expect(rowNamed(/^Familia/).textContent).toContain('Grupo · Papá: Llego a las 7');
  });

  it('keeps "Grupo" on a group row while it shows a draft', () => {
    const items = ITEMS.map(item => (item.key === 'grp:g1' ? { ...item, draft: 'Llego tarde' } : item));
    renderEs(<InboxPanel {...props({ items })} />);
    const familia = rowNamed(/^Familia/);
    expect(familia.textContent).toContain('Grupo · Borrador: Llego tarde');
    expect(within(familia).getByText('Grupo · Borrador:')).toBeTruthy();
    // A contact's draft has no group tag.
    expect(rowNamed(/^Carlos/).textContent).toContain('Borrador: Mañana te confirmo la hora');
    expect(rowNamed(/^Carlos/).textContent).not.toContain('Grupo');
  });

  it('shows a draft with its prefix, and the trust of a contact whose key changed', () => {
    renderEs(<InboxPanel {...props()} />);
    const carlos = rowNamed(/^Carlos/);
    expect(within(carlos).getByText('Borrador:')).toBeTruthy();
    expect(carlos.textContent).toContain('Mañana te confirmo la hora');
    expect(carlos.textContent).toContain('Su clave cambió');
  });

  it('opens a chat from its row', () => {
    const onSelect = vi.fn();
    renderEs(<InboxPanel {...props({ onSelect })} />);
    fireEvent.click(rowNamed(/^Familia/));
    expect(onSelect).toHaveBeenCalledWith({ kind: 'group', gid: 'g1' });
  });

  it('filters with chips: toggle buttons of 44 px, one Tab stop, the arrows, and the chosen one in bold', () => {
    const onFilterChange = vi.fn();
    renderEs(<InboxPanel {...props({ onFilterChange })} />);
    const group = screen.getByRole('group', { name: 'Filtrar chats' });
    const chips = within(group).getAllByRole('button');
    expect(chips.map(chip => chip.textContent)).toEqual(['Todos', 'No leídos', 'Grupos']);
    expect(chips.map(chip => chip.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(chips.map(chip => chip.tabIndex)).toEqual([0, -1, -1]);
    for (const chip of chips) expect(classesOf(chip)).toContain('min-h-11');
    // The chosen chip: weight and, with a Windows contrast theme, the system's highlight.
    const highlight = (chip: Element) => classesOf(chip).filter(name => /^forced-colors:(bg|text|border)-/.test(name));
    expect(classesOf(chips[0]!)).toContain('font-bold');
    expect(highlight(chips[0]!)).toEqual([
      'forced-colors:border-[color:Highlight]',
      'forced-colors:bg-[color:Highlight]',
      'forced-colors:text-[color:HighlightText]',
    ]);
    expect(classesOf(chips[1]!)).toContain('font-normal');
    expect(highlight(chips[1]!)).toEqual([]);

    chips[0]!.focus();
    fireEvent.keyDown(chips[0]!, { key: 'ArrowRight' });
    expect(onFilterChange).toHaveBeenCalledWith('unread');
    expect(document.activeElement).toBe(chips[1]);
    fireEvent.click(chips[2]!);
    expect(onFilterChange).toHaveBeenLastCalledWith('groups');
  });

  it('has no chip for message requests in this batch', () => {
    renderEs(<InboxPanel {...props()} />);
    expect(screen.queryByText(/solicitud/i)).toBeNull();
  });

  it('applies the chip and the search, and says when nothing is left', () => {
    const { rerender } = renderEs(<InboxPanel {...props({ filter: 'unread' })} />);
    expect(within(screen.getByRole('list', { name: 'Chats' })).getAllByRole('button')).toHaveLength(2);

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ items: ITEMS.filter(item => item.ref.kind !== 'group'), filter: 'groups' })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(screen.getByText('No hay chats en este filtro.')).toBeTruthy();

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ search: 'zzz' })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(screen.getByText('Ningún chat coincide con «zzz».')).toBeTruthy();
  });

  it('lists the chat the shell keeps under a chip it no longer matches', () => {
    renderEs(<InboxPanel {...props({ filter: 'unread', keepKey: 'Carlos', selectedKey: 'Carlos' })} />);
    const list = screen.getByRole('list', { name: 'Chats' });
    expect(within(list).getAllByRole('button')).toHaveLength(3);
    expect(within(list).getByRole('button', { name: /^Carlos/ }).getAttribute('aria-current')).toBe('true');
  });

  it('searches through a labelled field', () => {
    const onSearchChange = vi.fn();
    renderEs(<InboxPanel {...props({ onSearchChange })} />);
    const search = screen.getByRole('searchbox', { name: 'Buscar chats' });
    expect(search.getAttribute('placeholder')).toBe('Buscar');
    fireEvent.change(search, { target: { value: 'ana' } });
    expect(onSearchChange).toHaveBeenCalledWith('ana');
  });

  it('offers to add someone when there are no contacts yet', () => {
    const onAddContact = vi.fn();
    renderEs(<InboxPanel {...props({ hasContacts: false, onAddContact })} />);
    expect(screen.getByText('Todavía no tienes contactos. Agrega a alguien con su código para empezar.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar con código' }));
    expect(onAddContact).toHaveBeenCalled();
  });
});

describe('InboxPanel: the head and the foot', () => {
  // David, 12 Oct 2026: no line about the servers above the chats while all is well; a notice only when
  // no relay is up, read out politely, that goes away when the connection comes back.
  const OFFLINE = 'Sin conexión con los servidores. Trino sigue intentando conectarse.';
  const again = (rerender: (ui: ReactElement) => void, connection: InboxPanelProps['connection']) =>
    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ connection })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );

  it('says nothing about the connection while it is up, or still connecting', () => {
    const { container, rerender } = renderEs(<InboxPanel {...props()} />);
    expect(container.textContent).not.toMatch(/Conectad|servidores|Conectando/);
    expect(screen.getByRole('status').textContent).toBe('');
    again(rerender, { status: 'connecting' });
    expect(screen.getByRole('status').textContent).toBe('');
    again(rerender, null);
    expect(container.textContent).not.toMatch(/Sin conexión/);
  });

  it('tells when no server is reachable, and stops when it reconnects', () => {
    const { rerender } = renderEs(<InboxPanel {...props({ connection: { status: 'offline', up: 0, total: 3 } })} />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe(OFFLINE);
    expect(status.querySelector('svg')?.getAttribute('class')).toContain('lucide-wifi-off');
    again(rerender, { status: 'connected', up: 1, total: 3 });
    // The same live region, now empty: a screen reader hears the change, and nothing is left on screen.
    expect(screen.getByRole('status')).toBe(status);
    expect(status.textContent).toBe('');
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });

  // TOR-6, PropTorSimple card 2: Tor's state is one line of text in the same live region, no pill, no
  // dot, no panel; gone once connected. While it shows, it explains the servers being down too.
  it('shows the line of Tor in the same live region, as text with no panel', () => {
    renderEs(
      <InboxPanel
        {...props({
          tor: { text: 'Conectando de forma privada… 40 %', tone: 'muted' },
          connection: { status: 'offline', up: 0, total: 3 },
        })}
      />,
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Conectando de forma privada… 40 %');
    expect(classesOf(status)).not.toContain('bg-ui-warn-bg');
    expect(status.querySelector('svg')).toBeNull();
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(classesOf(status.firstElementChild)).toContain('text-ui-muted');
  });

  it('gives a line that needs you its action, and "Sin protección" as a warning', () => {
    const onAction = vi.fn();
    const { rerender } = renderEs(
      <InboxPanel {...props({ tor: { text: 'No se pudo conectar.', tone: 'alert', action: { label: 'Ver qué hacer', onAction } } })} />,
    );
    const status = screen.getByRole('status');
    fireEvent.click(within(status).getByRole('button', { name: 'Ver qué hacer' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(classesOf(status.firstElementChild)).toEqual(expect.arrayContaining(['text-ui-ink', 'font-semibold']));
    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ tor: { text: 'Sin protección', tone: 'warn' } })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(screen.getByRole('status').textContent).toBe('Sin protección');
    expect(classesOf(screen.getByRole('status').firstElementChild)).toEqual(expect.arrayContaining(['text-ui-warn', 'font-bold']));
  });

  it('shows a notice with its action', () => {
    const onAction = vi.fn();
    renderEs(<InboxPanel {...props({ notice: { text: 'Tienes invitaciones a grupos sin responder.', onAction } })} />);
    expect(screen.getByText('Tienes invitaciones a grupos sin responder.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }));
    expect(onAction).toHaveBeenCalled();
  });

  it('has your profile, your QR code and Settings at its foot, and no lock', () => {
    const onShareCode = vi.fn();
    const onOpenSettings = vi.fn();
    renderEs(<InboxPanel {...props({ onShareCode, onOpenSettings })} />);
    expect(screen.getByText('rechita')).toBeTruthy();
    expect(screen.getByText('Tu perfil')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Compartir mi código' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ajustes' }));
    expect(onShareCode).toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /bloquear|lock/i })).toBeNull();
  });

  it('opens "Nuevo chat" from the Chats tab and "Nueva llamada" from the Calls tab, never a menu', () => {
    const onNewChat = vi.fn();
    const onNewCall = vi.fn();
    const { rerender } = renderEs(<InboxPanel {...props({ onNewChat, onNewCall })} />);
    const newChat = screen.getByRole('button', { name: 'Nuevo chat' });
    expect(newChat.getAttribute('aria-haspopup')).toBeNull();
    expect(newChat.querySelector('svg.lucide-plus')).not.toBeNull();
    fireEvent.click(newChat);
    expect(onNewChat).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <InboxPanel {...props({ onNewChat, onNewCall, tab: 'calls' })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    const newCall = screen.getByRole('button', { name: 'Nueva llamada' });
    expect(newCall.querySelector('svg.lucide-phone-outgoing')).not.toBeNull();
    fireEvent.click(newCall);
    expect(onNewCall).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Nuevo chat' })).toBeNull();
  });
});

describe('InboxPanel: the tabs', () => {
  it('has Chats and Calls in a tab list named "Ver"', () => {
    const onTabChange = vi.fn();
    renderEs(<InboxPanel {...props({ onTabChange })} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Ver' })).getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Chats', 'Llamadas']);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tabs[1]!);
    expect(onTabChange).toHaveBeenCalledWith('calls');
  });

  it('counts the missed calls not seen yet, with a name that says so, and never "· 0"', () => {
    const { rerender } = renderEs(<InboxPanel {...props({ missedUnseen: 2 })} />);
    const calls = () => within(screen.getByRole('tablist', { name: 'Ver' })).getAllByRole('tab')[1]!;
    expect(screen.getByRole('tab', { name: 'Llamadas, 2 perdidas sin ver' })).toBe(calls());
    expect(within(calls()).getByText('Llamadas · 2').getAttribute('aria-hidden')).toBe('true');

    const withMissed = (missedUnseen: number) =>
      rerender(
        <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
          <I18nContext.Provider value={makeT('es')}>
            <InboxPanel {...props({ missedUnseen })} />
          </I18nContext.Provider>
        </LangCtx.Provider>,
      );
    withMissed(1);
    expect(screen.getByRole('tab', { name: 'Llamadas, 1 perdida sin ver' })).toBe(calls());
    withMissed(0);
    expect(screen.getByRole('tab', { name: 'Llamadas' })).toBe(calls());
    expect(calls().textContent).not.toContain('·');
  });

  it('shows the call log in the Calls tab, with its own chips', () => {
    renderEs(<InboxPanel {...props({ tab: 'calls' })} />);
    expect(screen.getByRole('group', { name: 'Filtrar llamadas' })).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText('Todavía no hay llamadas.')).toBeTruthy();
  });

  it('shows only the chats, without tabs, when the calls are not recorded (no K13)', () => {
    renderEs(<InboxPanel {...props({ calls: null })} />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByRole('searchbox', { name: 'Buscar chats' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Chats' })).toBeTruthy();
  });
});

/**
 * At 200 % in the 640×480 window, or at 150 % with a notice, the head, the
 * notice, the tabs, the search, the chips and the foot are taller than the
 * sidebar. Edge measured the list squeezed to 0 px and the chips drawn over
 * the foot, since only the list could shrink and #root cuts off the rest
 * (accesibilidad.md §4.7, rule 9). jsdom lays nothing out, so these pin the
 * structure that keeps everything reachable: one scroll region between the
 * head and the foot, and lists that keep a height of their own inside it.
 */
describe('InboxPanel: room for large text', () => {
  const NOTICE = { text: 'Tienes invitaciones a grupos sin responder.', onAction: () => {} };
  /** The nearest ancestor that scrolls. */
  const scrollerOf = (element: Element): Element | null => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (classesOf(node).includes('overflow-y-auto')) return node;
    }
    return null;
  };
  /**
   * Nothing between a list and its region may let the list shrink to nothing.
   * Its basis is a length, not `flex-1`'s 0 %: a percentage of a height not
   * known yet counts the whole content, and Edge then grew the list to every
   * row and scrolled the region even at 100 %. With 0 px it adds only its 8 rem
   * to what the region must hold, and scrolls on its own while there is room.
   */
  const expectRoomFor = (list: Element, region: Element) => {
    expect(classesOf(list)).toEqual(expect.arrayContaining(['min-h-[8rem]', 'grow', 'basis-0', 'overflow-y-auto']));
    expect(classesOf(list)).not.toContain('min-h-0');
    expect(classesOf(list)).not.toContain('flex-1');
    for (let node = list.parentElement; node && node !== region; node = node.parentElement) {
      expect(classesOf(node)).not.toContain('min-h-0');
    }
  };

  it('scrolls everything between the head and the foot as one region, the chats keeping a height of their own', () => {
    renderEs(<InboxPanel {...props({ notice: NOTICE, connection: { status: 'offline', up: 0, total: 3 } })} />);
    const region = scrollerOf(screen.getByRole('tablist', { name: 'Ver' }));
    expect(region).not.toBeNull();
    expect(classesOf(region)).toEqual(expect.arrayContaining(['min-h-0', 'flex-1']));
    for (const part of [
      screen.getByText('Sin conexión con los servidores. Trino sigue intentando conectarse.'),
      screen.getByText(NOTICE.text),
      screen.getByRole('searchbox', { name: 'Buscar chats' }),
      screen.getByRole('group', { name: 'Filtrar chats' }),
    ]) {
      expect(scrollerOf(part)).toBe(region);
    }
    // The head and the foot stay in view, outside the region.
    const newChat = screen.getByRole('button', { name: 'Nuevo chat' });
    const settings = screen.getByRole('button', { name: 'Ajustes' });
    expect(region!.contains(newChat)).toBe(false);
    expect(region!.contains(settings)).toBe(false);
    expect(region!.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Chats' });
    expect(scrollerOf(list)).toBe(region);
    expectRoomFor(list, region!);
  });

  it('does the same in the Calls tab', () => {
    const calls = [
      {
        entry: {
          key: 'call:m1',
          peer: 'Ana',
          ts: T0,
          call: { id: 'm1', direction: 'incoming' as const, video: false, outcome: 'missed' as const, durationSec: 0 },
        },
        name: 'Ana',
        callable: true,
      },
    ];
    renderEs(<InboxPanel {...props({ notice: NOTICE, tab: 'calls', calls })} />);
    const region = scrollerOf(screen.getByRole('tablist', { name: 'Ver' }));
    expect(region).not.toBeNull();
    expect(scrollerOf(screen.getByRole('group', { name: 'Filtrar llamadas' }))).toBe(region);
    expect(scrollerOf(screen.getByText(NOTICE.text))).toBe(region);
    const list = screen.getByRole('list', { name: 'Historial de llamadas' });
    expect(scrollerOf(list)).toBe(region);
    expectRoomFor(list, region!);
    expect(region!.contains(screen.getByRole('button', { name: 'Ajustes' }))).toBe(false);
  });

  it('does the same without tabs (no K13)', () => {
    renderEs(<InboxPanel {...props({ calls: null, notice: NOTICE })} />);
    const list = screen.getByRole('list', { name: 'Chats' });
    const region = scrollerOf(list);
    expect(region).not.toBeNull();
    expect(scrollerOf(screen.getByRole('searchbox', { name: 'Buscar chats' }))).toBe(region);
    expect(scrollerOf(screen.getByText(NOTICE.text))).toBe(region);
    expectRoomFor(list, region!);
  });
});

describe('InboxPanel: the right-click menu of a row', () => {
  const actions = (over: Partial<InboxRowActions> = {}): InboxRowActions => ({
    onToggleMuted: vi.fn(),
    onOpenDetails: vi.fn(),
    canCall: handle => handle === 'Ana',
    onCall: vi.fn(),
    ...over,
  });
  const rightClick = (element: Element) => fireEvent.contextMenu(element, { clientX: 40, clientY: 50 });
  const listed = () => screen.getAllByRole('menuitem').map(item => item.textContent);

  it('offers Activar sonido and Ver detalles on a muted group, each with an icon', () => {
    const rowActions = actions();
    renderEs(<InboxPanel {...props({ rowActions })} />);
    expect(rightClick(rowNamed(/^Familia/))).toBe(false);
    expect(screen.getByRole('menu', { name: 'Opciones de Familia' })).toBeTruthy();
    expect(listed()).toEqual(['Activar sonido', 'Ver detalles']);
    for (const item of screen.getAllByRole('menuitem')) expect(item.querySelector('svg')).not.toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Activar sonido' }));
    expect(rowActions.onToggleMuted).toHaveBeenCalledWith({ kind: 'group', gid: 'g1' });
    rightClick(rowNamed(/^Familia/));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ver detalles' }));
    expect(rowActions.onOpenDetails).toHaveBeenCalledWith({ kind: 'group', gid: 'g1' });
  });

  it('offers Silenciar on a group that is not muted, and on Novedades only that', () => {
    const items = ITEMS.map(item => (item.key === 'grp:g1' ? { ...item, muted: false } : item));
    renderEs(<InboxPanel {...props({ items, rowActions: actions() })} />);
    rightClick(rowNamed(/^Familia/));
    expect(listed()).toEqual(['Silenciar', 'Ver detalles']);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    rightClick(rowNamed(/^Novedades de Trino/));
    expect(listed()).toEqual(['Silenciar']);
  });

  it('offers the calls and Ver detalles on a contact you can call, and only Ver detalles on one you cannot', () => {
    const rowActions = actions();
    renderEs(<InboxPanel {...props({ rowActions })} />);
    rightClick(rowNamed(/^Ana/));
    expect(screen.getByRole('menu', { name: 'Opciones de Ana' })).toBeTruthy();
    expect(listed()).toEqual(['Llamada de voz', 'Videollamada', 'Ver detalles']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Videollamada' }));
    expect(rowActions.onCall).toHaveBeenCalledWith('Ana', true);
    rightClick(rowNamed(/^Ana/));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Llamada de voz' }));
    expect(rowActions.onCall).toHaveBeenLastCalledWith('Ana', false);
    rightClick(rowNamed(/^Carlos/));
    expect(listed()).toEqual(['Ver detalles']);
  });

  it('marks the row while its menu is open, and gives the focus back to it', () => {
    renderEs(<InboxPanel {...props({ rowActions: actions() })} />);
    const familia = rowNamed(/^Familia/);
    familia.focus();
    fireEvent.keyDown(familia, { key: 'F10', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Activar sonido' }));
    expect(classesOf(familia)).toContain('bg-ui-raised');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(classesOf(familia)).not.toContain('bg-ui-raised');
    expect(document.activeElement).toBe(familia);
  });

  it('opens nothing on the blank list, nor without the actions', () => {
    renderEs(<InboxPanel {...props({ rowActions: actions() })} />);
    expect(rightClick(screen.getByRole('list', { name: 'Chats' }))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    cleanup();
    renderEs(<InboxPanel {...props()} />);
    expect(rightClick(rowNamed(/^Familia/))).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
