// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallEvent } from '../../lib/call-events';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { CallHistoryList, type CallHistoryListProps } from './CallHistoryList';
import type { CallRowView } from './CallRow';

afterEach(cleanup);

const T0 = 1_760_000_000;

function row(id: string, peer: string, call: Partial<CallEvent>, over: Partial<CallRowView> = {}): CallRowView {
  return {
    entry: {
      key: `call:${id}`,
      peer,
      ts: T0,
      call: { id, direction: 'incoming', video: false, outcome: 'missed', durationSec: 0, ...call },
    },
    name: peer,
    callable: true,
    ...over,
  };
}

const ROWS: CallRowView[] = [
  row('m1', 'Ana', {}),
  row('o1', 'Bea', { direction: 'outgoing', outcome: 'answered', durationSec: 240 }),
  row('i1', 'Dani', { outcome: 'answered', durationSec: 720 }),
  row('v1', 'Mateo', { outcome: 'answered', durationSec: 1500, video: true }),
  row('u1', 'Laura', { direction: 'outgoing', outcome: 'unanswered' }),
];

function props(over: Partial<CallHistoryListProps> = {}): CallHistoryListProps {
  return {
    rows: ROWS,
    filter: 'all',
    onFilterChange: vi.fn(),
    selectedKey: null,
    onCall: vi.fn(),
    onOpenChat: vi.fn(),
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
const list = () => screen.getByRole('list', { name: 'Historial de llamadas' });
const openRow = (name: string) => within(list()).getByRole('button', { name: new RegExp(`^${name}`) });

describe('CallHistoryList', () => {
  it('shows each call with the icon and the words of its direction', () => {
    renderEs(<CallHistoryList {...props()} />);
    const detail = (name: string) => {
      const line = openRow(name).querySelector('[data-call-detail]')!;
      const icon = line.querySelector('svg')!;
      return [line.textContent, classesOf(icon).find(c => c.startsWith('lucide-'))];
    };
    expect(detail('Ana')).toEqual(['Perdida', 'lucide-phone-missed']);
    expect(detail('Bea')).toEqual(['Saliente · 4 min', 'lucide-arrow-up-right']);
    expect(detail('Dani')).toEqual(['Entrante · 12 min', 'lucide-arrow-down-left']);
    expect(detail('Mateo')).toEqual(['Videollamada entrante · 25 min', 'lucide-arrow-down-left']);
    expect(detail('Laura')).toEqual(['Saliente · No contestó', 'lucide-arrow-up-right']);
  });

  it('sets a missed call apart by its icon, its words and its weight, not by colour alone', () => {
    renderEs(<CallHistoryList {...props()} />);
    const missed = openRow('Ana').querySelector('[data-call-detail]')!;
    const answered = openRow('Bea').querySelector('[data-call-detail]')!;
    expect(classesOf(missed)).toEqual(expect.arrayContaining(['text-ui-danger', 'font-semibold']));
    expect(classesOf(answered)).not.toContain('font-semibold');
    expect(classesOf(answered)).toContain('text-ui-muted');
  });

  it('calls back with voice from a button named for the contact', () => {
    const onCall = vi.fn();
    renderEs(<CallHistoryList {...props({ onCall })} />);
    const button = within(list()).getByRole('button', { name: 'Llamar a Ana' });
    expect(button.querySelector('svg.lucide-phone')).not.toBeNull();
    fireEvent.click(button);
    expect(onCall).toHaveBeenCalledWith('Ana');
  });

  it('has no call button for a contact that is blocked or no longer exists', () => {
    renderEs(<CallHistoryList {...props({ rows: [row('m1', 'Ana', {}, { callable: false }), ROWS[1]!] })} />);
    expect(within(list()).queryByRole('button', { name: 'Llamar a Ana' })).toBeNull();
    expect(within(list()).getByRole('button', { name: 'Llamar a Bea' })).toBeTruthy();
  });

  it('opens the chat from the row, and marks the row that is open', () => {
    const onOpenChat = vi.fn();
    renderEs(<CallHistoryList {...props({ onOpenChat, selectedKey: 'call:o1' })} />);
    fireEvent.click(openRow('Ana'));
    expect(onOpenChat).toHaveBeenCalledWith('Ana');
    expect(openRow('Bea').getAttribute('aria-current')).toBe('true');
    expect(openRow('Ana').getAttribute('aria-current')).toBeNull();
  });

  it('shows every call or only the missed ones, with toggle chips', () => {
    const onFilterChange = vi.fn();
    const { rerender } = renderEs(<CallHistoryList {...props({ onFilterChange })} />);
    const chips = within(screen.getByRole('group', { name: 'Filtrar llamadas' })).getAllByRole('button');
    expect(chips.map(chip => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
      ['Todas', 'true'],
      ['Perdidas', 'false'],
    ]);
    fireEvent.click(chips[1]!);
    expect(onFilterChange).toHaveBeenCalledWith('missed');

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <CallHistoryList {...props({ filter: 'missed' })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(within(list()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('says when there are no calls, or no missed ones, and always which calls appear', () => {
    const note = 'Solo aparecen las llamadas que entraron con Trino abierto y desbloqueado.';
    const { rerender } = renderEs(<CallHistoryList {...props({ rows: [] })} />);
    expect(screen.getByText('Todavía no hay llamadas.')).toBeTruthy();
    expect(screen.getByText(note)).toBeTruthy();

    rerender(
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <CallHistoryList {...props({ rows: [ROWS[1]!], filter: 'missed' })} />
        </I18nContext.Provider>
      </LangCtx.Provider>,
    );
    expect(screen.getByText('No tienes llamadas perdidas.')).toBeTruthy();
    expect(screen.getByText(note)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Historial de llamadas' })).toBeNull();
  });
});
