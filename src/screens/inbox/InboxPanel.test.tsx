// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import type { InboxItem } from '../types';
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
    expect(item.querySelector('svg.lucide-bell-off')).not.toBeNull();
    expect(within(item).getByRole('img', { name: 'Silenciado' })).toBeTruthy();
    const badge = within(rowNamed(/^Familia/)).getByText('3').closest('span');
    expect(classesOf(badge)).toContain('border-ui-muted');
    expect(rowNamed(/^Ana/).closest('li')!.querySelector('svg.lucide-bell-off')).toBeNull();
  });

  it('says in words which row is a group, since Terminal squares every avatar', () => {
    renderEs(<InboxPanel {...props()} />);
    expect(rowNamed(/^Familia/).textContent).toContain('Grupo · Papá: Llego a las 7');
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
  it('labels the connection starting with its state', () => {
    const { rerender } = renderEs(<InboxPanel {...props()} />);
    expect(screen.getByRole('status').textContent).toBe('Conectado · 3 de 3 servidores');
    const again = (connection: InboxPanelProps['connection']) =>
      rerender(
        <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
          <I18nContext.Provider value={makeT('es')}>
            <InboxPanel {...props({ connection })} />
          </I18nContext.Provider>
        </LangCtx.Provider>,
      );
    again({ status: 'connecting' });
    expect(screen.getByRole('status').textContent).toBe('Conectando…');
    again({ status: 'offline', up: 0, total: 3 });
    expect(screen.getByRole('status').textContent).toBe('Sin conexión · reintentando');
    again(null);
    expect(screen.queryByRole('status')).toBeNull();
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
