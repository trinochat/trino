import { describe, expect, it, vi } from 'vitest';
import { createClipboard, type ClipboardDeps } from './clipboard';
import type { ImageClipboardHost } from './clipboard-image';

/** ClipboardItem as Chromium has it. */
class FakeItem {
  static supports = (type: string): boolean => type === 'image/png';
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function deps(windows: boolean, extra: Partial<ClipboardDeps> = {}, reinforced = false) {
  const backend = {
    clipboardWriteText: vi.fn(async (_text: string) => {}),
    clipboardWriteImage: vi.fn(async (_png: string) => {}),
  };
  const webWriteText = vi.fn(async (_text: string) => {});
  const webWrite = vi.fn(async (_items: unknown[]) => {});
  const imageHost: ImageClipboardHost = {
    ClipboardItem: FakeItem as unknown as ImageClipboardHost['ClipboardItem'],
    clipboard: { write: webWrite },
  };
  const all: ClipboardDeps = {
    isWindows: () => windows,
    backend,
    webText: () => webWriteText,
    imageHost: () => imageHost,
    clearAfter: () => reinforced,
    ...extra,
  };
  return { all, backend, webWriteText, webWrite };
}

// Cifrado local CL-6b (design §8): on Windows every copy goes to the backend,
// which keeps it out of the clipboard history; elsewhere the webview's own.
describe('the clipboard on Windows', () => {
  it('copies a text through the backend, never the webview', async () => {
    const { all, backend, webWriteText } = deps(true);
    await createClipboard(all).copyText('hola');
    expect(backend.clipboardWriteText).toHaveBeenCalledWith('hola', false);
    expect(webWriteText).not.toHaveBeenCalled();
  });

  it('copies a picture through the backend, as its PNG in base64', async () => {
    const { all, backend, webWrite } = deps(true);
    const clipboard = createClipboard(all);
    expect(clipboard.canCopyImages()).toBe(true);
    await clipboard.copyImage(Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' })));
    expect(backend.clipboardWriteImage).toHaveBeenCalledWith('iVBORw==', false);
    expect(webWrite).not.toHaveBeenCalled();
  });

  it('can copy pictures even where the webview could not', () => {
    const { all } = deps(true, { imageHost: () => ({}) });
    expect(createClipboard(all).canCopyImages()).toBe(true);
  });

  it('fails when the backend could not copy', async () => {
    const { all, backend } = deps(true);
    backend.clipboardWriteText.mockRejectedValueOnce(new Error('the clipboard is busy'));
    await expect(createClipboard(all).copyText('hola')).rejects.toThrow('busy');
  });

  // Design §10: with Protección reforzada the backend clears the copy 30
  // seconds later, if nothing was copied after it.
  it('asks the backend to clear the copy later with Protección reforzada', async () => {
    const { all, backend } = deps(true, {}, true);
    const clipboard = createClipboard(all);
    await clipboard.copyText('hola');
    await clipboard.copyImage(Promise.resolve(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])])));
    expect(backend.clipboardWriteText).toHaveBeenCalledWith('hola', true);
    expect(backend.clipboardWriteImage).toHaveBeenCalledWith('iVBORw==', true);
  });

  it('says it copies through the backend', () => {
    expect(createClipboard(deps(true).all).throughBackend()).toBe(true);
    expect(createClipboard(deps(false).all).throughBackend()).toBe(false);
  });
});

describe('the clipboard elsewhere', () => {
  it('copies a text with the webview, never the backend', async () => {
    const { all, backend, webWriteText } = deps(false);
    await createClipboard(all).copyText('hola');
    expect(webWriteText).toHaveBeenCalledWith('hola');
    expect(backend.clipboardWriteText).not.toHaveBeenCalled();
  });

  it('copies a picture with the webview, where it takes a PNG', async () => {
    const { all, backend, webWrite } = deps(false);
    const clipboard = createClipboard(all);
    expect(clipboard.canCopyImages()).toBe(true);
    await clipboard.copyImage(Promise.resolve(new Blob(['png'])));
    expect(webWrite).toHaveBeenCalledTimes(1);
    expect(backend.clipboardWriteImage).not.toHaveBeenCalled();
  });

  it('fails without a clipboard, and offers no pictures', async () => {
    const { all } = deps(false, { webText: () => undefined, imageHost: () => ({}) });
    const clipboard = createClipboard(all);
    await expect(clipboard.copyText('hola')).rejects.toThrow();
    expect(clipboard.canCopyImages()).toBe(false);
  });
});

// Design test 46: nothing copies with the webview's clipboard but this module.
describe('the copies of the app', () => {
  it('go through src/lib/clipboard.ts, never navigator.clipboard', () => {
    const sources = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    const users = Object.entries(sources)
      .filter(([, source]) => /navigator\.clipboard/.test(source))
      .map(([path]) => path);
    expect(users).toEqual(['./clipboard.ts']);
  });
});
