// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProfileResponse } from '../../lib/api';
import { toShareCode } from '../../lib/contact-code';
import { I18nContext, makeT } from '../../lib/i18n';
import { ShareCodePanel, type ShareCodePanelProps } from './ShareCodePanel';

const BUNDLE = JSON.stringify({
  avatar: 'data:image/png;base64,iVBORw0KGgo=',
  handle: 'Ana Torres',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});
const CODE = toShareCode(BUNDLE);
const PROFILE: ProfileResponse = {
  handle: 'Ana Torres',
  avatar: null,
  fingerprint: '70a5.83c6.766d.aad7',
  nostr_pub: 'a1'.repeat(32),
};

const writeText = vi.fn(async (_text: string) => {});
const toBlob = vi.fn((callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })));

beforeEach(() => {
  writeText.mockClear();
  toBlob.mockClear();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  // jsdom has no canvas: QRCodeCanvas gets no context and draws nothing, and toBlob is ours.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(toBlob);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(props: Partial<ShareCodePanelProps> = {}, failing: { bundle?: boolean; profile?: boolean } = {}) {
  const api = {
    shareBundle: vi.fn(async () => BUNDLE),
    getProfile: vi.fn(async () => PROFILE),
  };
  if (failing.bundle) api.shareBundle.mockRejectedValueOnce(new Error('vault sealed'));
  if (failing.profile) api.getProfile.mockRejectedValueOnce(new Error('io'));
  const download = vi.fn();
  const result = render(
    <I18nContext.Provider value={makeT('es')}>
      <ShareCodePanel api={api} download={download} {...props} />
    </I18nContext.Provider>,
  );
  return { api, download, ...result };
}

describe('ShareCodePanel', () => {
  it('shows your trino2 code as a QR code in the QR frame, black on white from the tokens', async () => {
    mount();
    const qr = await screen.findByRole('img', { name: 'Tu código QR' });
    expect(qr.className).toContain('bg-ui-qr-paper');
    expect(qr.className).toContain('text-ui-qr-ink');
    expect(qr.className).toContain('[forced-color-adjust:none]');
    const svg = qr.querySelector('svg')!;
    expect(svg.getAttribute('class')).toBe('h-full w-full');
    expect(svg.querySelector('path[fill="currentColor"]')).not.toBeNull();
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(CODE.startsWith('trino2:')).toBe(true);
  });

  it('copies the code', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar código' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
    expect((await screen.findByRole('status')).textContent).toBe('Código copiado.');
  });

  it('says so when the code cannot be copied', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Copiar código' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo copiar.');
  });

  it('saves the QR code as a PNG through download, named after you', async () => {
    const { download } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar QR' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [name, blob] = download.mock.calls[0]!;
    expect(name).toBe('trino-ana-torres.png');
    expect((blob as Blob).type).toBe('image/png');
  });

  it('says so when the PNG cannot be made', async () => {
    toBlob.mockImplementationOnce((callback: BlobCallback) => callback(null));
    const { download } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Guardar QR' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo crear la imagen del QR.');
    expect(download).not.toHaveBeenCalled();
  });

  it('shows your key in capitals and groups, and says how a contact verifies you', async () => {
    mount();
    expect(await screen.findByText('70A5 83C6 766D AAD7')).toBeTruthy();
    expect(screen.getByText('Tu clave')).toBeTruthy();
    expect(screen.getByText('Para verificarte, tus contactos comparan contigo los símbolos de una llamada.')).toBeTruthy();
    expect(screen.getByText('Para hablar, los dos tienen que agregarse con su código.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/solicitud/i);
  });

  it('works on its own, outside any dialog, as Settings mounts it', async () => {
    mount();
    await screen.findByRole('img', { name: 'Tu código QR' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('draws nothing for the extra actions it is not given', async () => {
    const { container } = mount();
    await screen.findByRole('img', { name: 'Tu código QR' });
    expect(container.querySelector('[data-extra-actions]')).toBeNull();
  });

  it('puts the extra actions under Copiar and Guardar QR', async () => {
    const { container } = mount({ extraActions: <button type="button">Crear enlace</button> });
    const extra = await screen.findByRole('button', { name: 'Crear enlace' });
    expect(container.querySelector('[data-extra-actions]')?.contains(extra)).toBe(true);
    const save = screen.getByRole('button', { name: 'Guardar QR' });
    expect(save.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says so when your code cannot be made, and tries again', async () => {
    const { api } = mount({}, { bundle: true });
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo crear tu código.');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('img', { name: 'Tu código QR' })).toBeTruthy();
    expect(api.shareBundle).toHaveBeenCalledTimes(2);
  });

  it('still shows the code when your key cannot be read', async () => {
    mount({}, { profile: true });
    expect(await screen.findByRole('img', { name: 'Tu código QR' })).toBeTruthy();
    expect(screen.queryByText('Tu clave')).toBeNull();
  });
});
