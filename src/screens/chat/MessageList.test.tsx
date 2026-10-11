// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Msg } from '../types';
import type { MessageActions } from './MessageItem';
import { MessageList, type MessageListProps } from './MessageList';
import { at, message, renderIn } from './test-utils';

const NOW = at(2026, 10, 11, 18, 0);
const scrollTo = vi.fn();

beforeEach(() => {
  scrollTo.mockClear();
  // jsdom lays nothing out and has no scrollTo.
  HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
});

function actions(overrides: Partial<MessageActions> = {}): MessageActions {
  return {
    onRetry: vi.fn(),
    onReply: vi.fn(),
    onCopy: vi.fn(),
    onForward: vi.fn(),
    onDeleteForMe: vi.fn(),
    onOpenLink: vi.fn(),
    fetchFile: vi.fn(async () => ''),
    ...overrides,
  };
}

const CONTACT: MessageListProps['peer'] = { kind: 'contact', name: 'Ana Torres' };

function list(messages: readonly Msg[], extra: Partial<MessageListProps> = {}) {
  const props: MessageListProps = { messages, now: NOW, peer: CONTACT, actions: actions(), ...extra };
  const view = renderIn(<MessageList {...props} />);
  // The wrapper of renderIn stays around the new tree.
  const rerender = (next: readonly Msg[], more: Partial<MessageListProps> = {}) =>
    view.rerender(<MessageList {...props} messages={next} {...more} />);
  return { ...view, props, rerender };
}

const log = () => screen.getByRole('log', { name: 'Mensajes' });
const missedCall = (key: string, ts: number): Msg => ({
  key: `call:${key}`,
  side: 'them',
  ts,
  call: { id: key, direction: 'incoming', video: false, outcome: 'missed', durationSec: 0 },
});

/** Lays the log out as if it were `scrollHeight` px of messages, `clientHeight` tall, scrolled to `scrollTop`. */
function layOut(element: HTMLElement, { scrollHeight, clientHeight, scrollTop }: Record<string, number>) {
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(element, 'scrollTop', { configurable: true, writable: true, value: scrollTop });
}

describe('MessageList', () => {
  it('is a polite live log named "Mensajes", which reads out only what is added', () => {
    list([message('Hola', at(2026, 10, 11, 10))]);
    expect(log().getAttribute('aria-live')).toBe('polite');
    expect(log().getAttribute('aria-relevant')).toBe('additions');
  });

  it('separates the days and shows the delivery state of your messages', () => {
    list([
      message('a', at(2026, 10, 10, 18, 20), { text: 'Te envié el archivo del contrato' }),
      message('b', at(2026, 10, 11, 10, 31), { side: 'me', text: '¿Te llegó?', state: 'sent' }),
      message('c', at(2026, 10, 11, 10, 38), { side: 'me', text: '¿El jueves a las 6?', state: 'sending' }),
    ]);
    const text = log().textContent ?? '';
    expect(text.indexOf('Ayer')).toBeLessThan(text.indexOf('Te envié'));
    expect(text.indexOf('Hoy')).toBeGreaterThan(text.indexOf('Te envié'));
    expect(text.indexOf('Hoy')).toBeLessThan(text.indexOf('¿Te llegó?'));
    expect(within(log()).getByText('Enviado')).toBeTruthy();
    expect(within(log()).getByText('Enviando')).toBeTruthy();
  });

  it('says a message was not sent and retries it', () => {
    const { props } = list([message('k1', at(2026, 10, 11, 18, 30), { side: 'me', text: 'Te paso la dirección luego', state: 'failed' })]);
    expect(screen.getByText('No se envió.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(props.actions.onRetry).toHaveBeenCalledWith('k1');
  });

  it('names who a group message did not reach, and a member over the first of their messages', () => {
    list(
      [
        message('g1', at(2026, 10, 11, 8, 50), { from: 'Mamá', text: '¿Quién trae el pan?' }),
        message('g2', at(2026, 10, 11, 8, 51), { from: 'Mamá', text: 'Para la cena' }),
        message('g3', at(2026, 10, 11, 8, 55), { side: 'me', text: 'Yo lo compro', state: 'failed', failure: { kind: 'partial', members: ['Papá'] } }),
        message('g4', at(2026, 10, 11, 9, 15), { from: 'Papá', text: 'Llego a las 7' }),
      ],
      { peer: { kind: 'group' } },
    );
    expect(screen.getByText('No les llegó a: Papá.')).toBeTruthy();
    expect(within(log()).getAllByText('Mamá')).toHaveLength(1);
    expect(within(log()).getByText('Papá', { selector: 'span' })).toBeTruthy();
  });

  it('puts a call in its place by the time it started, between the day separators', () => {
    list([
      message('later', at(2026, 10, 11, 16, 46), { text: 'Gracias, quedó todo claro.' }),
      missedCall('k13-missed-0123456789', at(2026, 10, 11, 16, 40)),
      message('yesterday', at(2026, 10, 10, 20), { text: 'Mañana te llamo' }),
    ]);
    const lines = Array.from(log().children).map(child => child.textContent ?? '');
    const at_ = (needle: string) => lines.findIndex(line => line.includes(needle));
    expect(at_('Ayer')).toBeLessThan(at_('Mañana te llamo'));
    expect(at_('Mañana te llamo')).toBeLessThan(at_('Hoy'));
    expect(at_('Hoy')).toBeLessThan(at_('Llamada perdida'));
    expect(at_('Llamada perdida')).toBeLessThan(at_('Gracias'));
  });

  it('gives a call no options: it cannot be answered, copied or deleted', () => {
    list(
      [
        message('m', at(2026, 10, 11, 16, 30), { text: 'Te llamo en 10 minutos' }),
        missedCall('k13-missed-0123456789', at(2026, 10, 11, 16, 40)),
      ],
      { onCall: () => {} },
    );
    const call = document.querySelector<HTMLElement>('[data-call-event]')!;
    // Its one button calls back; it has no menu of any name.
    expect(within(call).getAllByRole('button').map(button => button.textContent)).toEqual(['Devolver llamada']);
    expect(call.querySelector('[aria-haspopup]')).toBeNull();
    // The log's only options are the message's: opened, its items are outside the call.
    const options = within(log()).getAllByRole('button', { name: 'Opciones del mensaje' });
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]!);
    const menu = screen.getByRole('menu');
    expect(call.contains(menu)).toBe(false);
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
      'Responder',
      'Copiar',
      'Reenviar',
      'Borrar para mí',
    ]);
  });

  it('keeps every message mounted from one update to the next, so none is read out twice', () => {
    const first = [message('a', at(2026, 10, 11, 10)), message('b', at(2026, 10, 11, 11))];
    const { rerender } = list(first);
    const before = document.querySelector('[data-message="a"]');
    rerender([...first.map(m => ({ ...m })), message('c', at(2026, 10, 11, 12))]);
    expect(document.querySelector('[data-message="a"]')).toBe(before);
  });

  it('says so when there are no messages yet', () => {
    list([]);
    expect(within(log()).getByText('Todavía no hay mensajes.')).toBeTruthy();
  });

  describe('scrolling', () => {
    const first = [message('a', at(2026, 10, 11, 10)), message('b', at(2026, 10, 11, 11))];

    it('opens at the newest message', () => {
      list(first);
      expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'auto' });
    });

    it('follows a new message when you were at the end, smoothly', () => {
      const { rerender } = list(first);
      scrollTo.mockClear();
      rerender([...first, message('c', at(2026, 10, 11, 12))]);
      expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'smooth' });
    });

    it('stays where you were reading, and offers to go to the newest message', () => {
      const { rerender } = list(first);
      layOut(log(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
      fireEvent.scroll(log());
      scrollTo.mockClear();
      rerender([...first, message('c', at(2026, 10, 11, 12))]);
      expect(scrollTo).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Ir al mensaje más reciente' }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('gives the focus to the log when "Ir al mensaje más reciente" takes you there and goes away', () => {
      const { rerender } = list(first);
      layOut(log(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
      fireEvent.scroll(log());
      rerender([...first, message('c', at(2026, 10, 11, 12))]);
      const toLatest = screen.getByRole('button', { name: 'Ir al mensaje más reciente' });
      toLatest.focus();
      fireEvent.click(toLatest);
      expect(screen.queryByRole('button', { name: 'Ir al mensaje más reciente' })).toBeNull();
      expect(document.activeElement).toBe(log());
    });

    it('follows your own new message even when you were reading above', () => {
      const { rerender } = list(first);
      layOut(log(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
      fireEvent.scroll(log());
      scrollTo.mockClear();
      rerender([...first, message('mine', at(2026, 10, 11, 12), { side: 'me', state: 'sending' })]);
      expect(scrollTo).toHaveBeenCalledTimes(1);
    });

    it('jumps instead of gliding when motion is reduced', () => {
      document.documentElement.dataset.motion = 'reduce';
      const { rerender } = list(first);
      scrollTo.mockClear();
      rerender([...first, message('c', at(2026, 10, 11, 12))]);
      expect(scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: 'auto' });
    });

    it('takes the end of the log as the end, within a few lines', () => {
      const { rerender } = list(first);
      layOut(log(), { scrollHeight: 2000, clientHeight: 400, scrollTop: 1560 });
      fireEvent.scroll(log());
      scrollTo.mockClear();
      rerender([...first, message('c', at(2026, 10, 11, 12))]);
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Ir al mensaje más reciente' })).toBeNull();
    });
  });
});
