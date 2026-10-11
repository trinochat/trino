// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { StickerInfo } from '../../../lib/api';
import { createPrefs } from '../../../lib/prefs';
import type { StickerApi } from '../../types';
import { renderIn } from '../test-utils';
import { StickerPicker } from './StickerPicker';

afterEach(cleanup);

const sticker = (id: string, mime = 'image/webp'): StickerInfo => ({
  id,
  mime,
  data_url: `data:${mime};base64,${btoa(id)}`,
});

/** A sticker library in memory, like the backend's. */
function library(initial: StickerInfo[] = [sticker('gato'), sticker('perro'), sticker('loro', 'image/gif')]) {
  let stickers = [...initial];
  const api = {
    list: vi.fn(async (): Promise<StickerInfo[]> => [...stickers]),
    importFile: vi.fn(async (file: File) => {
      const added = sticker(file.name.replace(/\.\w+$/, ''));
      stickers = [...stickers, added];
      return added;
    }),
    remove: vi.fn(async (id: string) => {
      stickers = stickers.filter(s => s.id !== id);
    }),
  } satisfies StickerApi;
  return api;
}

/** Your recent stickers, kept in a storage of the test's own. */
function recents(ids: string[] = []) {
  const store = new Map<string, string>([['sticker-recents', JSON.stringify(ids)]]);
  return createPrefs({
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: key => void store.delete(key),
  });
}

const fileOf = (name: string, bytes: number, type = 'image/png') => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
};

describe('StickerPicker', () => {
  it('shows your stickers and sends the one you pick, which turns recent', async () => {
    const api = library();
    const prefs = recents();
    const onPick = vi.fn();
    renderIn(<StickerPicker api={api} onPick={onPick} recents={prefs} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enviar sticker 2' }));
    expect(onPick).toHaveBeenCalledWith(sticker('perro'));
    expect(prefs.getStickerRecents()).toEqual(['perro']);
  });

  it('opens on the recent ones, newest first, when there are any', async () => {
    renderIn(<StickerPicker api={library()} onPick={() => {}} recents={recents(['loro', 'gato'])} />);
    expect(screen.getByRole('tab', { name: 'Recientes' }).getAttribute('aria-selected')).toBe('true');
    const first = await screen.findByRole('button', { name: 'Enviar sticker 1' });
    expect(first.querySelector('img')?.getAttribute('src')).toBe(sticker('loro', 'image/gif').data_url);
    fireEvent.click(screen.getByRole('tab', { name: 'Todos' }));
    expect(await screen.findByRole('button', { name: 'Enviar sticker 3' })).toBeTruthy();
  });

  it('says what to add when the library is empty', async () => {
    renderIn(<StickerPicker api={library([])} onPick={() => {}} recents={recents()} />);
    expect(await screen.findByText(/Todavía no tienes stickers/)).toBeTruthy();
  });

  it('says so, as an alert, when your stickers cannot be loaded', async () => {
    const api = library();
    api.list.mockRejectedValueOnce(new Error('vault sealed'));
    renderIn(<StickerPicker api={api} onPick={() => {}} recents={recents()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudieron cargar tus stickers.');
  });

  it('adds pictures to the library, and refuses one over 5 MB', async () => {
    const api = library([]);
    renderIn(<StickerPicker api={api} onPick={() => {}} recents={recents()} />);
    await screen.findByText(/Todavía no tienes stickers/);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileOf('sol.png', 2048), fileOf('enorme.png', 6 * 1024 * 1024)] } });
    expect(await screen.findByRole('button', { name: 'Enviar sticker 1' })).toBeTruthy();
    expect(api.importFile).toHaveBeenCalledTimes(1);
    expect((await screen.findByRole('alert')).textContent).toContain('No se puede agregar enorme.png: pesa más de 5 MB.');
  });

  it('takes a sticker out of the library while editing', async () => {
    const api = library();
    renderIn(<StickerPicker api={api} onPick={() => {}} recents={recents()} />);
    await screen.findByRole('button', { name: 'Enviar sticker 1' });
    const edit = screen.getByRole('button', { name: 'Editar' });
    fireEvent.click(edit);
    expect(edit.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Quitar sticker 1' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('gato'));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Quitar sticker/ })).toHaveLength(2));
  });

  it('gives the focus a removed sticker held to the next one, else to Editar, else to Agregar stickers', async () => {
    renderIn(<StickerPicker api={library()} onPick={() => {}} recents={recents()} />);
    await screen.findByRole('button', { name: 'Enviar sticker 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Editar' }));
    const removeFromKeyboard = async (n: number, left: number) => {
      const button = screen.getByRole('button', { name: `Quitar sticker ${n}` });
      button.focus();
      fireEvent.click(button);
      await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Quitar sticker/ })).toHaveLength(left));
    };
    // gato goes, and perro takes its place and the focus.
    await removeFromKeyboard(1, 2);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Quitar sticker 1' })));
    // loro, the last, goes: no sticker follows it.
    await removeFromKeyboard(2, 1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Editar' })));
    // perro, the only one, goes: there is nothing left to edit.
    await removeFromKeyboard(1, 0);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agregar stickers' })));
    expect(screen.getByRole('button', { name: 'Editar' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('is one Tab stop, and the arrows move through the stickers', async () => {
    renderIn(<StickerPicker api={library()} onPick={() => {}} recents={recents()} />);
    const first = await screen.findByRole('button', { name: 'Enviar sticker 1' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Enviar sticker 2' }));
    const stops = screen.getAllByRole('button', { name: /^Enviar sticker/ }).filter(button => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
  });
});
