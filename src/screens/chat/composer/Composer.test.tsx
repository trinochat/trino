// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { StickerInfo } from '../../../lib/api';
import type { ProcessedFile } from '../../../lib/media';
import { createPrefs } from '../../../lib/prefs';
import type { ReplyRef, StickerApi } from '../../types';
import { deferred, renderIn } from '../test-utils';
import { Composer, type ComposerProps } from './Composer';
import { EMOJI_GROUPS } from './emoji-data';

afterEach(cleanup);

const PICTURE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const GATO: StickerInfo = { id: 'gato', mime: 'image/webp', data_url: 'data:image/webp;base64,Z2F0bw==' };
const REPLY: ReplyRef = { author: 'Ana Torres', preview: '¿Hablamos a las 4:40?' };

const stickers = (): StickerApi => ({ list: vi.fn(async () => [GATO]), importFile: vi.fn(), remove: vi.fn() });
const prepared = (file: File): ProcessedFile => ({
  name: file.name,
  mime: file.type,
  dataB64: 'AAAA',
  thumb: file.type.startsWith('image/') ? PICTURE : null,
});
const fileOf = (name: string, type: string, bytes = 1024) => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
};

type HarnessProps = Partial<ComposerProps> & { initial?: string; initialReply?: ReplyRef | null; otherReply?: ReplyRef };

/**
 * The composer with its draft and reply kept by the test, as the chat pane
 * keeps them; with `otherReply`, a button chooses that reply, as Responder does.
 */
function Harness({ initial = '', initialReply = null, otherReply, ...props }: HarnessProps) {
  const [draft, setDraft] = useState(initial);
  const [reply, setReply] = useState<ReplyRef | null>(initialReply);
  return (
    <>
      {otherReply && (
        <button type="button" onClick={() => setReply(otherReply)}>
          Responder a otro
        </button>
      )}
      <Composer
        recipient="Ana Torres"
        maxTextLength={1000}
        onSendText={() => {}}
        onSendFiles={async () => ({ failed: [] })}
        onSendSticker={async () => {}}
        stickers={stickers()}
        prepareFile={async file => prepared(file)}
        platform="other"
        stickerRecents={createPrefs({ getItem: () => null, setItem: () => {}, removeItem: () => {} })}
        {...props}
        draft={draft}
        onDraftChange={text => {
          setDraft(text);
          props.onDraftChange?.(text);
        }}
        reply={reply}
        onClearReply={() => {
          setReply(null);
          props.onClearReply?.();
        }}
      />
    </>
  );
}

const box = () => screen.getByRole('textbox', { name: 'Mensaje para Ana Torres' }) as HTMLTextAreaElement;
const chooseFiles = (files: File[]) =>
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files } });
/** Waits until every file in the tray is ready to go. */
const allPrepared = () => waitFor(() => expect(screen.queryByText('Preparando…')).toBeNull());
type Sent = { failed: readonly ProcessedFile[] };

describe('Composer', () => {
  it('is a text box for the message, kept by the draft', () => {
    const onDraftChange = vi.fn();
    renderIn(<Harness initial="Mañana te confirmo la hora" onDraftChange={onDraftChange} />);
    expect(box().value).toBe('Mañana te confirmo la hora');
    expect(box().getAttribute('placeholder')).toBe('Escribe un mensaje');
    fireEvent.change(box(), { target: { value: 'Mañana te confirmo' } });
    expect(onDraftChange).toHaveBeenCalledWith('Mañana te confirmo');
  });

  it('sends the text on Enter, with what it replies to, and empties the box', () => {
    const onSendText = vi.fn();
    renderIn(<Harness initial="  ¿El jueves a las 6?  " initialReply={REPLY} onSendText={onSendText} />);
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false);
    expect(onSendText).toHaveBeenCalledWith('¿El jueves a las 6?', REPLY);
    expect(box().value).toBe('');
    expect(screen.queryByText('Respondiendo a Ana Torres')).toBeNull();
  });

  it('leaves Shift+Enter to break the line, and an input method its Enter', () => {
    const onSendText = vi.fn();
    renderIn(<Harness initial="Hola" onSendText={onSendText} />);
    expect(fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })).toBe(true);
    expect(onSendText).not.toHaveBeenCalled();
  });

  it('sends nothing for a box with only spaces', () => {
    const onSendText = vi.fn();
    renderIn(<Harness initial={'   \n  '} onSendText={onSendText} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSendText).not.toHaveBeenCalled();
  });

  it('does not send a message over the limit, and says by how much', () => {
    const onSendText = vi.fn();
    renderIn(<Harness initial={'x'.repeat(12)} maxTextLength={10} onSendText={onSendText} />);
    expect(screen.getByRole('alert').textContent).toContain('El mensaje es demasiado largo: 12 de 10 caracteres.');
    expect(box().getAttribute('aria-invalid')).toBe('true');
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(onSendText).not.toHaveBeenCalled();
  });

  it('counts the characters as people see them: an emoji is one', () => {
    renderIn(<Harness initial={'😀'.repeat(10)} maxTextLength={10} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows what you reply to, and lets you take it back with its button or Escape', () => {
    const onClearReply = vi.fn();
    renderIn(<Harness initialReply={REPLY} onClearReply={onClearReply} />);
    expect(screen.getByText('Respondiendo a Ana Torres')).toBeTruthy();
    expect(screen.getByText('¿Hablamos a las 4:40?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar respuesta' }));
    expect(screen.queryByText('Respondiendo a Ana Torres')).toBeNull();
    cleanup();
    renderIn(<Harness initialReply={REPLY} onClearReply={onClearReply} />);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByText('Respondiendo a Ana Torres')).toBeNull();
    expect(onClearReply).toHaveBeenCalledTimes(2);
  });

  it('adds the files you choose to the tray, and takes them out', async () => {
    renderIn(<Harness />);
    chooseFiles([fileOf('foto.jpg', 'image/jpeg'), fileOf('informe.pdf', 'application/pdf')]);
    const tray = await screen.findByRole('list', { name: 'Archivos para enviar' });
    await waitFor(() => expect(tray.querySelectorAll('li')).toHaveLength(2));
    await waitFor(() => expect(tray.querySelector('img')?.getAttribute('src')).toBe(PICTURE));
    fireEvent.click(screen.getByRole('button', { name: 'Quitar foto.jpg' }));
    expect(tray.querySelectorAll('li')).toHaveLength(1);
    expect(screen.getByText('informe.pdf')).toBeTruthy();
    expect(box().getAttribute('placeholder')).toBe('Agrega un mensaje (opcional)');
  });

  it('sends the files first and then the text; what failed stays, and nothing else goes', async () => {
    const onSendText = vi.fn();
    const onSendFiles = vi.fn(async (files: readonly ProcessedFile[]) => ({ failed: files.filter(f => f.name === 'b.pdf') }));
    renderIn(<Harness initial="Aquí van" onSendText={onSendText} onSendFiles={onSendFiles} />);
    chooseFiles([fileOf('a.pdf', 'application/pdf'), fileOf('b.pdf', 'application/pdf')]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Quitar/ })).toHaveLength(2));
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    expect(onSendFiles).toHaveBeenCalledWith([expect.objectContaining({ name: 'a.pdf' }), expect.objectContaining({ name: 'b.pdf' })]);
    expect(onSendText).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('No se pudo enviar: b.pdf. Puedes intentarlo de nuevo.');
    expect(screen.getAllByRole('button', { name: /^Quitar/ }).map(b => b.getAttribute('aria-label'))).toEqual(['Quitar b.pdf']);

    onSendFiles.mockResolvedValueOnce({ failed: [] });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    });
    expect(onSendText).toHaveBeenCalledWith('Aquí van', undefined);
    expect(screen.queryByRole('list', { name: 'Archivos para enviar' })).toBeNull();
  });

  it('keeps what you type while the files go: only the text you sent leaves the box', async () => {
    const onSendText = vi.fn();
    const upload = deferred<Sent>();
    renderIn(<Harness initial="Aquí va el contrato" onSendText={onSendText} onSendFiles={() => upload.promise} />);
    chooseFiles([fileOf('contrato.pdf', 'application/pdf')]);
    await allPrepared();
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    fireEvent.change(box(), { target: { value: 'Aquí va el contrato. Y otra cosa importante' } });
    await act(async () => upload.resolve({ failed: [] }));
    expect(onSendText).toHaveBeenCalledWith('Aquí va el contrato', undefined);
    expect(box().value).toBe('. Y otra cosa importante');
  });

  it('sends the text with the reply it had, and keeps a reply you chose while the files went', async () => {
    const onSendText = vi.fn();
    const upload = deferred<Sent>();
    const other: ReplyRef = { author: 'Carlos', preview: 'Te paso la dirección' };
    renderIn(
      <Harness initial="Aquí va" initialReply={REPLY} otherReply={other} onSendText={onSendText} onSendFiles={() => upload.promise} />,
    );
    chooseFiles([fileOf('plano.pdf', 'application/pdf')]);
    await allPrepared();
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Responder a otro' }));
    await act(async () => upload.resolve({ failed: [] }));
    expect(onSendText).toHaveBeenCalledWith('Aquí va', REPLY);
    expect(screen.getByText('Respondiendo a Carlos')).toBeTruthy();
  });

  it('says which files did not go when their chat closed on the way, in a toast that stays', async () => {
    for (const [names, failing, text] of [
      [['a.pdf', 'b.pdf'], ['b.pdf'], 'No se pudo enviar b.pdf a Ana Torres. Para intentarlo de nuevo, vuelve a adjuntarlo en ese chat.'],
      [['a.pdf', 'b.pdf'], ['a.pdf', 'b.pdf'], 'No se pudieron enviar a.pdf y b.pdf a Ana Torres. Para intentarlo de nuevo, vuelve a adjuntarlos en ese chat.'],
    ] as const) {
      const onSendText = vi.fn();
      const upload = deferred<Sent>();
      const onSendFiles = vi.fn((_files: readonly ProcessedFile[]) => upload.promise);
      const view = renderIn(<Harness initial="Aquí van" onSendText={onSendText} onSendFiles={onSendFiles} />);
      chooseFiles(names.map(name => fileOf(name, 'application/pdf')));
      await allPrepared();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
      });
      // Another chat opens: the pane, its composer and the tray go.
      view.rerender(<p>Otro chat</p>);
      const failed = onSendFiles.mock.calls[0]![0].filter(file => (failing as readonly string[]).includes(file.name));
      await act(async () => upload.resolve({ failed }));
      expect((await screen.findByRole('alert')).textContent).toBe(text);
      expect(onSendText).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('says so in a toast when a sticker fails after its chat closed', async () => {
    const sending = deferred<void>();
    const view = renderIn(<Harness onSendSticker={() => sending.promise} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar sticker 1' }));
    view.rerender(<p>Otro chat</p>);
    await act(async () => sending.reject(new Error('upload_failed')));
    expect((await screen.findByRole('alert')).textContent).toBe('No se pudo enviar el sticker a Ana Torres.');
  });

  it('refuses a file over 25 MB before preparing it', () => {
    const prepareFile = vi.fn(async (file: File) => prepared(file));
    renderIn(<Harness prepareFile={prepareFile} />);
    chooseFiles([fileOf('enorme.mov', 'video/quicktime', 26 * 1024 * 1024)]);
    expect(screen.getByRole('alert').textContent).toContain('No se puede enviar enorme.mov: pesa más de 25 MB.');
    expect(prepareFile).not.toHaveBeenCalled();
  });

  it('says so when a file cannot be prepared', async () => {
    renderIn(<Harness prepareFile={async () => Promise.reject(new Error('decode'))} />);
    chooseFiles([fileOf('rara.heic', 'image/heic')]);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo preparar rara.heic. Prueba con otro archivo.');
    expect(screen.queryByRole('list', { name: 'Archivos para enviar' })).toBeNull();
  });

  it('takes the pictures pasted into the box', async () => {
    renderIn(<Harness />);
    const picture = fileOf('pegada.png', 'image/png');
    fireEvent.paste(box(), { clipboardData: { items: [{ type: 'image/png', getAsFile: () => picture }] } });
    expect(await screen.findByRole('button', { name: 'Quitar pegada.png' })).toBeTruthy();
  });

  it('puts an emoji where the cursor is', () => {
    renderIn(<Harness initial="Hola mundo" />);
    box().setSelectionRange(4, 4);
    fireEvent.click(screen.getByRole('button', { name: 'Emojis' }));
    const first = EMOJI_GROUPS[0]!.emojis[0]!;
    fireEvent.click(screen.getByRole('button', { name: first }));
    expect(box().value).toBe(`Hola${first} mundo`);
    expect(box().selectionStart).toBe(4 + first.length);
  });

  it('draws the sticker button with the sticker icon, and the emoji one with the face', () => {
    renderIn(<Harness />);
    const stickerButton = screen.getByRole('button', { name: 'Stickers' });
    expect(stickerButton.querySelector('svg.lucide-sticker')).not.toBeNull();
    expect(stickerButton.querySelector('svg.lucide-smile')).toBeNull();
    const emojiButton = screen.getByRole('button', { name: 'Emojis' });
    expect(emojiButton.querySelector('svg.lucide-smile')).not.toBeNull();
    fireEvent.click(emojiButton);
    expect(emojiButton.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('dialog', { name: 'Emojis' })).toBeTruthy();
  });

  it('sends the sticker you pick and closes the picker, or says it could not', async () => {
    const onSendSticker = vi.fn(async (_s: StickerInfo) => {});
    renderIn(<Harness onSendSticker={onSendSticker} />);
    const pickFirst = async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stickers' }));
      const first = await screen.findByRole('button', { name: 'Enviar sticker 1' });
      await act(async () => {
        fireEvent.click(first);
      });
    };
    await pickFirst();
    expect(onSendSticker).toHaveBeenCalledWith(GATO);
    expect(screen.queryByRole('dialog', { name: 'Stickers' })).toBeNull();

    onSendSticker.mockRejectedValueOnce(new Error('upload_failed'));
    await pickFirst();
    expect(screen.getByRole('alert').textContent).toContain('No se pudo enviar el sticker.');
  });

  it('closes a picker with Escape and gives the focus back to its button', () => {
    renderIn(<Harness />);
    const emojiButton = screen.getByRole('button', { name: 'Emojis' });
    fireEvent.click(emojiButton);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Emojis' })).toBeNull();
    expect(document.activeElement).toBe(emojiButton);
  });

  it('says how to send and how to break a line, and ties it to the box', () => {
    renderIn(<Harness />);
    const hint = screen.getByText('Enter envía · Shift+Enter, nueva línea');
    expect(box().getAttribute('aria-describedby')).toContain(hint.id);
  });
});
