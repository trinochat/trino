// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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

// A picture becomes a PNG on a canvas, which jsdom does not draw.
vi.mock('../../lib/clipboard-image', async importOriginal => ({
  ...(await importOriginal<typeof import('../../lib/clipboard-image')>()),
  pngOf: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}));

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

/** The pane with its messages kept by the test: a deleted one leaves once the backend is done, as in the shell. */
function DeletingPane(p: ChatPaneProps) {
  const [messages, setMessages] = useState(p.messages);
  return (
    <Pane
      {...p}
      messages={messages}
      onDeleteForMe={async key => {
        await p.onDeleteForMe?.(key);
        setMessages(current => current.filter(msg => msg.key !== key));
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
/** The options button of message `key`. */
const optionsOf = (key: string) =>
  within(document.querySelector<HTMLElement>(`[data-message="${key}"]`)!).getByRole('button', { name: 'Opciones del mensaje' });
/** Opens the options of message `key` from its focused button, and picks `item`. */
const chooseOn = (key: string, item: string) => {
  optionsOf(key).focus();
  fireEvent.click(optionsOf(key));
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

  it('says a reply to your own message is to "tu mensaje", and still sends it as yours', () => {
    const p = show({ messages: [message('m1', at(2026, 10, 11, 10, 44), { side: 'me', text: 'Lo compro de camino' })] });
    choose('Responder');
    expect(screen.getByText('Respondiendo a tu mensaje')).toBeTruthy();
    expect(screen.queryByText('Respondiendo a Tú')).toBeNull();
    fireEvent.change(box()!, { target: { value: 'Y el pan' } });
    fireEvent.keyDown(box()!, { key: 'Enter' });
    expect(p.onSendText).toHaveBeenCalledWith('Y el pan', { author: 'Tú', preview: 'Lo compro de camino' });
  });

  it('offers no Responder where you cannot write: to a contact you blocked, or in a group you left', () => {
    const items = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
      return screen.getAllByRole('menuitem').map(item => item.textContent);
    };
    show({ header: { ...ANA, blocked: true } });
    expect(items()).toEqual(['Copiar', 'Reenviar', 'Borrar para mí']);
    cleanup();
    show({ convo: { kind: 'group', gid: 'g1' }, header: { ...FAMILIA, ended: true }, onCall: undefined });
    expect(items()).toEqual(['Copiar', 'Reenviar', 'Borrar para mí']);
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
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Borrar para mí' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo borrar el mensaje.');
    choose('Copiar');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo copiar el mensaje.'));
  });

  it('asks before deleting a message for you, starting on Cancelar, and deletes it only when you confirm', () => {
    const p = show();
    choose('Borrar para mí');
    const question = screen.getByRole('alertdialog', { name: '¿Borrar este mensaje para ti?' });
    const cancel = within(question).getByRole('button', { name: 'Cancelar' });
    expect(document.activeElement).toBe(cancel);
    const confirm = within(question).getByRole('button', { name: 'Borrar para mí' });
    expect(confirm.querySelector('svg.lucide-trash2')).not.toBeNull();
    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(p.onDeleteForMe).not.toHaveBeenCalled();

    choose('Borrar para mí');
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Borrar para mí' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(p.onDeleteForMe).toHaveBeenCalledWith('k1');
  });

  it('gives the focus to the next message once one is deleted, else to the one before, else to the log', async () => {
    const three = [
      message('k1', at(2026, 10, 11, 10, 40), { text: 'Primero' }),
      message('k2', at(2026, 10, 11, 10, 41), { text: 'Segundo' }),
      message('k3', at(2026, 10, 11, 10, 42), { side: 'me', text: 'Tercero' }),
    ];
    renderIn(<DeletingPane {...props({ messages: three })} />);
    const deleteFromKeyboard = async (key: string) => {
      chooseOn(key, 'Borrar para mí');
      await act(async () => {
        fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Borrar para mí' }));
      });
      expect(document.querySelector(`[data-message="${key}"]`)).toBeNull();
    };
    await deleteFromKeyboard('k2');
    expect(document.activeElement).toBe(optionsOf('k3'));
    await deleteFromKeyboard('k3');
    expect(document.activeElement).toBe(optionsOf('k1'));
    await deleteFromKeyboard('k1');
    expect(document.activeElement).toBe(screen.getByRole('log', { name: 'Mensajes' }));
  });

  it('leaves the focus on the message when it could not be deleted', async () => {
    renderIn(<DeletingPane {...props({ onDeleteForMe: vi.fn(async () => Promise.reject(new Error('io'))) })} />);
    chooseOn('k1', 'Borrar para mí');
    await act(async () => {
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Borrar para mí' }));
    });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo borrar el mensaje.');
    expect(document.activeElement).toBe(optionsOf('k1'));
  });

  it('says plainly that the message goes from this device only, for good, and others keep their copy', () => {
    const description = () => {
      const question = screen.getByRole('alertdialog');
      return document.getElementById(question.getAttribute('aria-describedby') ?? '')?.textContent;
    };
    show();
    choose('Borrar para mí');
    expect(description()).toBe('Se borra solo de este equipo, para siempre. Si Ana Torres ya lo tiene, conserva su copia.');
    cleanup();
    show({ convo: { kind: 'group', gid: 'g1' }, header: FAMILIA, onCall: undefined });
    choose('Borrar para mí');
    expect(description()).toBe('Se borra solo de este equipo, para siempre. Quienes ya lo tienen conservan su copia.');
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

describe('ChatPane, the right-click menu', () => {
  const FULL_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAA==';
  const PHOTO: Msg = message('f1', at(2026, 10, 11, 10, 55), {
    text: undefined,
    file: { url: 'u', key: 'k', sha256: 's', mime: 'image/jpeg', name: 'finca.jpg', size: 2048, thumb: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==' },
  });
  /** ClipboardItem as Chromium has it, keeping what it was given. */
  class FakeItem {
    static supports = (type: string): boolean => type === 'image/png';
    constructor(readonly items: Record<string, Promise<Blob>>) {}
  }
  const rightClick = (element: Element) => fireEvent.contextMenu(element, { clientX: 40, clientY: 50 });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'ClipboardItem');
    getSelection()?.removeAllRanges();
  });

  it('copies a link and marked text, and says which it copied', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    show({ messages: [message('k1', at(2026, 10, 11, 10, 50), { text: 'Ya salió https://trinochat.org/ hoy' })] });
    rightClick(screen.getByRole('link', { name: 'https://trinochat.org/' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar enlace' }));
    expect(writeText).toHaveBeenCalledWith('https://trinochat.org/');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Enlace copiado.'));

    const text = screen.getByText('Ya salió', { exact: false, selector: 'p' });
    const range = document.createRange();
    range.setStart(text.firstChild!, 3);
    range.setEnd(text.firstChild!, 8);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    rightClick(text);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar selección' }));
    expect(writeText).toHaveBeenLastCalledWith('salió');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Texto copiado.'));
  });

  it('opens a link from the menu outside the app', () => {
    const p = show({ messages: [message('k1', at(2026, 10, 11, 10, 50), { text: 'https://trinochat.org/' })] });
    rightClick(screen.getByRole('link', { name: 'https://trinochat.org/' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Abrir enlace' }));
    expect(p.onOpenLink).toHaveBeenCalledWith('https://trinochat.org/');
  });

  it('copies a photo as a PNG picture and says so, or says it could not', async () => {
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeItem });
    const write = vi.fn(async (_items: FakeItem[]) => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write, writeText: vi.fn() } });
    show({ messages: [PHOTO], fetchFile: vi.fn(async () => FULL_JPEG) });
    const preview = screen.getByRole('button', { name: 'Ver finca.jpg' });
    rightClick(preview);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar imagen' }));
    expect(write).toHaveBeenCalledTimes(1);
    const [[items]] = write.mock.calls;
    expect(Object.keys(items[0].items)).toEqual(['image/png']);
    await expect(items[0].items['image/png']).resolves.toBeInstanceOf(Blob);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Imagen copiada.'));

    write.mockImplementationOnce(async () => Promise.reject(new Error('NotAllowedError')));
    rightClick(preview);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copiar imagen' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('No se pudo copiar la imagen.'));
  });

  it('offers no Copiar imagen where the clipboard takes no pictures', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn() } });
    show({ messages: [PHOTO] });
    rightClick(screen.getByRole('button', { name: 'Ver finca.jpg' }));
    expect(screen.queryByRole('menuitem', { name: 'Copiar imagen' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Descargar' })).toBeTruthy();
  });

  it('asks before Borrar para mí from the menu too, and gives the focus back to the message', () => {
    const p = show();
    optionsOf('k1').focus();
    fireEvent.keyDown(optionsOf('k1'), { key: 'F10', shiftKey: true });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Borrar para mí' }));
    const question = screen.getByRole('alertdialog', { name: '¿Borrar este mensaje para ti?' });
    fireEvent.click(within(question).getByRole('button', { name: 'Cancelar' }));
    expect(p.onDeleteForMe).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(optionsOf('k1'));
  });
});

describe('NoChatSelected', () => {
  it('asks you to choose a chat', () => {
    renderIn(<NoChatSelected />);
    expect(screen.getByText('Elige un chat o un grupo para ver sus mensajes.')).toBeTruthy();
  });
});
