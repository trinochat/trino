// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { FileRef } from '../../../lib/api';
import { BUBBLE_ME_COLOUR, colourClasses, colourClassesWithin, renderIn } from '../test-utils';
import { Attachment } from './Attachment';

const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const FULL_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAA==';
const WEBP = 'data:image/webp;base64,UklGRiQAAABXRUJQ';

const fileRef = (extra: Partial<FileRef> = {}): FileRef => ({
  url: 'https://blossom.example/abc',
  key: 'k',
  sha256: 's',
  mime: 'image/jpeg',
  name: 'foto.jpg',
  size: 2048,
  thumb: JPEG,
  ...extra,
});

let downloads: Array<{ href: string; download: string }> = [];

beforeEach(() => {
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(file: FileRef, fetchFile = vi.fn(async (_f: FileRef) => FULL_JPEG), mine = false) {
  renderIn(<Attachment file={file} mine={mine} fetchFile={fetchFile} />);
  return fetchFile;
}

describe('Attachment', () => {
  it('shows the preview of a picture and opens the picture when asked', async () => {
    const fetchFile = show(fileRef());
    const view = screen.getByRole('button', { name: 'Ver foto.jpg' });
    expect(view.querySelector('img')?.getAttribute('src')).toBe(JPEG);
    fireEvent.click(view);
    const dialog = await screen.findByRole('dialog', { name: 'foto.jpg' });
    expect(fetchFile).toHaveBeenCalledWith(fileRef());
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(FULL_JPEG);
  });

  it('shows no preview that is not a safe inline picture', () => {
    show(fileRef({ thumb: 'data:image/svg+xml;base64,PHN2Zz4=' }));
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Descargar foto.jpg' })).toBeTruthy();
  });

  it('downloads a file through fetchFile, with its own name', async () => {
    const fetchFile = show(fileRef({ mime: 'application/pdf', name: 'informe.pdf', size: 150 * 1024, thumb: null }), vi.fn(async () => 'data:application/pdf;base64,JVBERi0='));
    expect(screen.getByText('informe.pdf')).toBeTruthy();
    expect(screen.getByText('150 kB')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Descargar informe.pdf' }));
    await waitFor(() => expect(downloads).toEqual([{ href: 'data:application/pdf;base64,JVBERi0=', download: 'informe.pdf' }]));
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  // TRN-APP-03: a right-to-left override made "factura\u202Efdp.exe" read as
  // "facturaexe.pdf". The card shows and saves the name without it, and shows
  // the real extension on its own.
  it('TRN-APP-03: shows a file name without bidi controls, with its real extension', async () => {
    show(fileRef({ mime: 'application/octet-stream', name: 'factura\u202Efdp.exe', thumb: null }), vi.fn(async () => 'data:application/octet-stream;base64,TVo='));
    const card = document.querySelector('[data-attachment]');
    expect(card?.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
    expect(screen.getByText('facturafdp.exe')).toBeTruthy();
    expect(screen.getByText('EXE')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Descargar facturafdp.exe' }));
    await waitFor(() => expect(downloads.map(saved => saved.download)).toEqual(['facturafdp.exe']));
  });

  it('TRN-APP-03: gives a file whose name shows nothing a name to show and save', () => {
    show(fileRef({ mime: 'application/pdf', name: '\u202E\u2066', thumb: null }));
    expect(screen.getByRole('button', { name: 'Descargar archivo' })).toBeTruthy();
  });

  it('fetches a file once, however often it is opened or saved', async () => {
    const fetchFile = show(fileRef());
    fireEvent.click(screen.getByRole('button', { name: 'Descargar foto.jpg' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto.jpg' }));
    await screen.findByRole('dialog');
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('says so, as an alert, when a download fails', async () => {
    show(fileRef(), vi.fn(async () => Promise.reject(new Error('offline'))));
    fireEvent.click(screen.getByRole('button', { name: 'Descargar foto.jpg' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo descargar el archivo.');
    expect(downloads).toEqual([]);
  });

  it('opens no picture whose file is not a safe one, and offers the download instead', async () => {
    show(fileRef(), vi.fn(async () => 'data:text/html;base64,PGgxPg=='));
    fireEvent.click(screen.getByRole('button', { name: 'Ver foto.jpg' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Este formato no se puede abrir aquí de forma segura.');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws a sticker from its inline picture, without a file card', () => {
    show(fileRef({ mime: 'image/webp', name: 'sticker::abc.webp', thumb: WEBP }));
    expect(screen.getByRole('img', { name: 'Sticker' }).getAttribute('src')).toBe(WEBP);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('downloads a sticker that came without an inline picture', async () => {
    const fetchFile = show(fileRef({ mime: 'image/webp', name: 'sticker::abc.webp', thumb: null }), vi.fn(async () => WEBP));
    expect((await screen.findByRole('img', { name: 'Sticker' })).getAttribute('src')).toBe(WEBP);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it('says it when a sticker cannot be shown', async () => {
    show(fileRef({ mime: 'image/webp', name: 'sticker::abc.webp', thumb: null }), vi.fn(async () => Promise.reject(new Error('gone'))));
    expect(await screen.findByText('No se pudo mostrar el sticker.')).toBeTruthy();
  });

  it('keeps everything inside your bubble in its ink, and the size in its muted tone', () => {
    const { container } = renderIn(
      <Attachment file={fileRef({ mime: 'application/pdf', name: 'informe.pdf', thumb: null })} mine fetchFile={vi.fn()} />,
    );
    expect(colourClasses(screen.getByText('2 kB'))).toEqual(['text-ui-bubble-me-muted']);
    expect(colourClassesWithin(container).filter(name => !BUBBLE_ME_COLOUR.test(name))).toEqual([]);
  });
});
