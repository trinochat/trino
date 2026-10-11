// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ChatHeaderInfo, ChatPaneProps, Msg } from '../types';
import { ChatPane } from './ChatPane';
import { NoChatSelected } from './NoChatSelected';
import { at, message, renderIn } from './test-utils';

const NOW = at(2026, 10, 11, 18, 0);
const ANA: ChatHeaderInfo = { kind: 'contact', name: 'Ana Torres', trust: 'verified', ttlSeconds: 0, blocked: false };
const FAMILIA: ChatHeaderInfo = { kind: 'group', name: 'Familia', memberCount: 4, ended: false, ttlSeconds: 0 };
const MESSAGES: Msg[] = [message('k1', at(2026, 10, 11, 10, 42), { text: 'Perfecto, nos vemos el jueves' })];

const realResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = realResizeObserver;
  Reflect.deleteProperty(navigator, 'clipboard');
});

function props(overrides: Partial<ChatPaneProps> = {}): ChatPaneProps {
  return {
    convo: { kind: 'contact', handle: 'ana' },
    header: ANA,
    messages: MESSAGES,
    now: NOW,
    maxTextLength: 4000,
    draft: '',
    onDraftChange: vi.fn(),
    onSendText: vi.fn(),
    onRetry: vi.fn(),
    onSendFiles: vi.fn(async () => ({ failed: [] })),
    onSendSticker: vi.fn(async () => {}),
    onDeleteForMe: vi.fn(async () => {}),
    onForward: vi.fn(),
    onOpenLink: vi.fn(),
    onCall: vi.fn(),
    onOpenDetails: vi.fn(),
    onVerify: vi.fn(),
    onAcknowledgeKeyChange: vi.fn(),
    fetchFile: vi.fn(async () => ''),
    stickers: { list: vi.fn(async () => []), importFile: vi.fn(), remove: vi.fn() },
    ...overrides,
  };
}

/** The pane with its draft kept by the test, as the shell keeps it. */
function Pane(p: ChatPaneProps) {
  const [draft, setDraft] = useState(p.draft);
  return (
    <ChatPane
      {...p}
      draft={draft}
      onDraftChange={text => {
        setDraft(text);
        p.onDraftChange(text);
      }}
    />
  );
}

function show(overrides: Partial<ChatPaneProps> = {}) {
  const p = props(overrides);
  renderIn(<Pane {...p} />);
  return p;
}

const box = () => screen.queryByRole('textbox', { name: /^Mensaje para/ }) as HTMLTextAreaElement | null;
const choose = (item: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('ChatPane', () => {
  it('brings the header, the conversation and the composer of a chat together', () => {
    show();
    expect(screen.getByRole('region', { name: 'Ana Torres' })).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Mensajes' }).textContent).toContain('Perfecto, nos vemos el jueves');
    expect(box()).not.toBeNull();
  });

  it('replies to a message: the bar shows it, the focus goes to the box and the reply goes with the text', () => {
    const p = show();
    choose('Responder');
    expect(screen.getByText('Respondiendo a Ana Torres')).toBeTruthy();
    expect(document.activeElement).toBe(box());
    fireEvent.change(box()!, { target: { value: '¡Claro!' } });
    fireEvent.keyDown(box()!, { key: 'Enter' });
    expect(p.onSendText).toHaveBeenCalledWith('¡Claro!', { author: 'Ana Torres', preview: 'Perfecto, nos vemos el jueves' });
    expect(screen.queryByText('Respondiendo a Ana Torres')).toBeNull();
  });

  it('copies a message and says so', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show();
    choose('Copiar');
    expect(writeText).toHaveBeenCalledWith('Perfecto, nos vemos el jueves');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Mensaje copiado.'));
  });

  it('says so, as an alert, when a message cannot be copied or deleted', async () => {
    show({ onDeleteForMe: vi.fn(async () => Promise.reject(new Error('not_found'))) });
    choose('Borrar para mí');
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo borrar el mensaje.');
    choose('Copiar');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo copiar el mensaje.'));
  });

  it('warns when the security code changed, with Verificar and Entendido', () => {
    const p = show({ header: { ...ANA, trust: 'keyChanged' } });
    expect(screen.getByText(/El código de seguridad de Ana Torres cambió/)).toBeTruthy();
    const verify = screen.getAllByRole('button', { name: 'Verificar' });
    fireEvent.click(verify[verify.length - 1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
    expect(p.onVerify).toHaveBeenCalled();
    expect(p.onAcknowledgeKeyChange).toHaveBeenCalledTimes(1);
  });

  it('lets you write to nobody you blocked, says why, and calls nobody back', () => {
    const missed: Msg = {
      key: 'call:k13-missed-0123456789',
      side: 'them',
      ts: at(2026, 10, 11, 16, 40),
      call: { id: 'k13-missed-0123456789', direction: 'incoming', video: false, outcome: 'missed', durationSec: 0 },
    };
    const p = show({ header: { ...ANA, blocked: true }, messages: [...MESSAGES, missed] });
    expect(box()).toBeNull();
    expect(screen.getByText('Bloqueaste a este contacto: sus mensajes no te llegan. Para escribirle, desbloquéalo en sus detalles.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalles' }));
    expect(p.onOpenDetails).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Llamada de voz' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Devolver llamada' })).toBeNull();
  });

  it('calls back a missed call from the conversation', () => {
    const missed: Msg = {
      key: 'call:k13-missed-0123456789',
      side: 'them',
      ts: at(2026, 10, 11, 16, 40),
      call: { id: 'k13-missed-0123456789', direction: 'incoming', video: true, outcome: 'missed', durationSec: 0 },
    };
    const p = show({ messages: [...MESSAGES, missed] });
    fireEvent.click(screen.getByRole('button', { name: 'Devolver llamada' }));
    expect(p.onCall).toHaveBeenCalledWith(false);
  });

  it('has no composer in a group you are no longer in, and says why', () => {
    show({ convo: { kind: 'group', gid: 'g1' }, header: { ...FAMILIA, ended: true }, onCall: undefined });
    expect(box()).toBeNull();
    expect(screen.getByText(/Ya no eres parte de este grupo: no puedes escribir en él/)).toBeTruthy();
  });

  it('names a group member over their message, and writes to the group', () => {
    show({
      convo: { kind: 'group', gid: 'g1' },
      header: FAMILIA,
      onCall: undefined,
      messages: [message('g1', at(2026, 10, 11, 9, 15), { from: 'Papá', text: 'Llego a las 7' })],
    });
    expect(screen.getByText('Papá')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Mensaje para Familia' })).toBeTruthy();
  });

  // accesibilidad.md §4.7, rule 6: under 22 rem of height the composer shows up to 3 lines.
  it('gives the composer fewer lines before it scrolls when the window is short', () => {
    const observers: Array<() => void> = [];
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(() => callback([], this as unknown as ResizeObserver));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    show({ draft: 'a\nb\nc\nd\ne\nf\ng\nh' });
    expect(box()!.rows).toBe(6);
    const pane = screen.getByRole('region', { name: 'Ana Torres' });
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 15 * 16 });
    act(() => observers.forEach(notify => notify()));
    expect(box()!.rows).toBe(3);
    Object.defineProperty(pane, 'clientHeight', { configurable: true, value: 40 * 16 });
    act(() => observers.forEach(notify => notify()));
    expect(box()!.rows).toBe(6);
  });
});

describe('NoChatSelected', () => {
  it('asks you to choose a chat', () => {
    renderIn(<NoChatSelected />);
    expect(screen.getByText('Elige un chat o un grupo para ver sus mensajes.')).toBeTruthy();
  });
});
