// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Msg } from '../types';
import { MessageItem, type MessageActions } from './MessageItem';
import { BUBBLE_ME_COLOUR, at, classesOf, colourClassesWithin, message, renderIn } from './test-utils';

afterEach(cleanup);

const NOW = at(2026, 10, 11, 18, 0);

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

function show(msg: Msg, extra: { actions?: MessageActions; sender?: string; authorName?: string } = {}) {
  const props = extra.actions ?? actions();
  renderIn(
    <MessageItem msg={msg} now={NOW} sender={extra.sender} authorName={extra.authorName ?? 'Ana Torres'} actions={props} />,
  );
  return props;
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
const menuItems = () => screen.getAllByRole('menuitem').map(item => item.textContent);
const mine = (key: string, extra: Partial<Msg> = {}) => message(key, at(2026, 10, 11, 10, 31), { side: 'me', ...extra });
const theirs = (key: string, extra: Partial<Msg> = {}) => message(key, at(2026, 10, 11, 10, 35), extra);

describe('MessageItem', () => {
  it('offers Responder, Copiar, Reenviar and Borrar para mí on your messages and on theirs', () => {
    for (const msg of [mine('Hola'), theirs('Hola')]) {
      show(msg);
      openMenu();
      expect(menuItems()).toEqual(['Responder', 'Copiar', 'Reenviar', 'Borrar para mí']);
      cleanup();
    }
  });

  it('never offers to delete for everyone, which does not exist', () => {
    show(mine('Hola'));
    openMenu();
    expect(screen.queryByText(/para todos/i)).toBeNull();
  });

  it('marks Borrar para mí as the dangerous one: it cannot be undone', () => {
    show(theirs('Hola'));
    openMenu();
    expect(classesOf(screen.getByRole('menuitem', { name: 'Borrar para mí' }))).toContain('text-ui-danger');
    expect(classesOf(screen.getByRole('menuitem', { name: 'Reenviar' }))).not.toContain('text-ui-danger');
  });

  it('leaves Borrar para mí out without the backend that keeps it deleted (K11)', () => {
    show(theirs('Hola'), { actions: actions({ onDeleteForMe: undefined }) });
    openMenu();
    expect(menuItems()).toEqual(['Responder', 'Copiar', 'Reenviar']);
  });

  it('leaves Copiar out of a message without text', () => {
    const file = { url: 'u', key: 'k', sha256: 's', mime: 'application/pdf', name: 'informe.pdf', size: 2048 };
    show(theirs('f', { text: undefined, file }));
    openMenu();
    expect(menuItems()).toEqual(['Responder', 'Reenviar', 'Borrar para mí']);
  });

  it('hands the message to the chat to reply, copy, forward or delete it', () => {
    const props = show(theirs('k1', { text: 'Perfecto, nos vemos el jueves' }));
    const choose = (name: string) => {
      openMenu();
      fireEvent.click(screen.getByRole('menuitem', { name }));
    };
    choose('Responder');
    expect(props.onReply).toHaveBeenCalledWith({ author: 'Ana Torres', preview: 'Perfecto, nos vemos el jueves' });
    choose('Copiar');
    expect(props.onCopy).toHaveBeenCalledWith('Perfecto, nos vemos el jueves');
    choose('Reenviar');
    expect(props.onForward).toHaveBeenCalledWith('k1');
    choose('Borrar para mí');
    expect(props.onDeleteForMe).toHaveBeenCalledWith('k1');
  });

  it('quotes your own message as yours, and a file by what it is', () => {
    const props = show(mine('Lo compro de camino'));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    expect(props.onReply).toHaveBeenCalledWith({ author: 'Tú', preview: 'Lo compro de camino' });
    cleanup();

    const sticker = { url: 'u', key: 'k', sha256: 's', mime: 'image/webp', name: 'sticker::abc.webp', size: 900 };
    const replies = show(theirs('s', { text: undefined, file: sticker }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Responder' }));
    expect(replies.onReply).toHaveBeenCalledWith({ author: 'Ana Torres', preview: 'Sticker' });
  });

  it('shows the clock of a disappearing message, with the time it has left', () => {
    show(theirs('Temporal', { ttl: 86_400, expiresAt: NOW + 3600 }));
    const clock = screen.getByText('Se borra en 1 hora');
    expect(clock.querySelector('svg.lucide-timer')).not.toBeNull();
  });

  it('underlines the links of a message and opens them outside the app', () => {
    const props = show(theirs('link', { text: 'Mira https://trino.chat/novedades' }));
    const link = screen.getByRole('link', { name: 'https://trino.chat/novedades' });
    expect(classesOf(link)).toContain('underline');
    fireEvent.click(link);
    expect(props.onOpenLink).toHaveBeenCalledWith('https://trino.chat/novedades');
  });

  // accentText on bubbleMe is 1.0:1 in Terminal light, where your bubble is the accent.
  it('draws everything inside your bubble in its own ink: the link, the quote and the clock', () => {
    show(
      mine('m', {
        text: 'Mira https://trino.chat',
        reply: { author: 'Ana Torres', preview: '¿Hablamos a las 4:40?' },
        ttl: 3600,
        expiresAt: NOW + 600,
        state: 'sent',
      }),
    );
    const bubble = document.querySelector('[data-direction="out"]')!;
    expect(colourClassesWithin(bubble).filter(name => !BUBBLE_ME_COLOUR.test(name))).toEqual([]);
    expect(within(bubble as HTMLElement).getByText('Ana Torres')).toBeTruthy();
  });

  it('tells screen readers how your message is doing', () => {
    show(mine('a', { state: 'sending' }));
    expect(screen.getByText('Enviando')).toBeTruthy();
    cleanup();
    show(mine('b', { state: 'sent' }));
    expect(screen.getByText('Enviado')).toBeTruthy();
  });

  it('says a message was not sent and why, and retries it', () => {
    const props = show(mine('k2', { state: 'failed', failure: { kind: 'offline' } }));
    expect(screen.getByText('No se envió: no hay conexión.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(props.onRetry).toHaveBeenCalledWith('k2');
    cleanup();
    show(mine('k3', { state: 'failed' }));
    expect(screen.getByText('No se envió.')).toBeTruthy();
  });

  it('names who a group message did not reach', () => {
    show(mine('k4', { state: 'failed', failure: { kind: 'partial', members: ['Ana', 'Luis'] } }));
    expect(screen.getByText('No les llegó a: Ana y Luis.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });

  it('does not offer to retry a message that is too long: it would fail again', () => {
    show(mine('k5', { state: 'failed', failure: { kind: 'too_long' } }));
    expect(screen.getByText('No se envió: es demasiado largo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
  });

  it('names who a quote is from, and the sender when they quoted themselves', () => {
    show(theirs('q1', { reply: { author: 'Carlos', preview: 'Te paso la dirección' } }));
    expect(screen.getByText('Carlos')).toBeTruthy();
    cleanup();
    // Their "Tú" is them: the author travels in the message as its sender wrote it.
    show(theirs('q2', { reply: { author: 'Tú', preview: 'Llego a las 7' } }), { authorName: 'Papá' });
    expect(screen.getByText('Papá')).toBeTruthy();
    expect(screen.queryByText('Tú')).toBeNull();
  });

  it('shows the name of a group member over the first of their messages', () => {
    show(theirs('g1', { text: '¿Quién trae el pan para la cena?', from: 'Mamá' }), { sender: 'Mamá' });
    expect(screen.getByText('Mamá')).toBeTruthy();
  });
});
