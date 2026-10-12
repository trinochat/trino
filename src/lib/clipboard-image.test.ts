import { describe, expect, it, vi } from 'vitest';
import { canCopyImages, pngOf, writeImage, type ImageClipboardHost, type PngDrawing } from './clipboard-image';

/** ClipboardItem as Chromium has it, keeping what it was given. */
class FakeItem {
  static supports = (type: string): boolean => type === 'image/png';
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

const host = (extra: Partial<ImageClipboardHost> = {}): ImageClipboardHost => ({
  ClipboardItem: FakeItem as unknown as ImageClipboardHost['ClipboardItem'],
  clipboard: { write: vi.fn(async () => {}) },
  ...extra,
});

describe('canCopyImages', () => {
  it('is true where the clipboard takes a PNG, as in WebView2', () => {
    expect(canCopyImages(host())).toBe(true);
  });

  it('is false without ClipboardItem, without clipboard.write, or when PNG is not supported', () => {
    expect(canCopyImages(host({ ClipboardItem: undefined }))).toBe(false);
    expect(canCopyImages(host({ clipboard: undefined }))).toBe(false);
    expect(canCopyImages(host({ clipboard: {} as ImageClipboardHost['clipboard'] }))).toBe(false);
    class NoPng extends FakeItem {
      static supports = () => false;
    }
    expect(canCopyImages(host({ ClipboardItem: NoPng as unknown as ImageClipboardHost['ClipboardItem'] }))).toBe(false);
  });

  it('trusts a ClipboardItem that cannot say what it supports, as before Chromium 121', () => {
    class Older {
      constructor(readonly items: unknown) {}
    }
    expect(canCopyImages(host({ ClipboardItem: Older as unknown as ImageClipboardHost['ClipboardItem'] }))).toBe(true);
  });
});

describe('writeImage', () => {
  it('writes one item with the PNG still on its way, so the write starts while the click counts', async () => {
    const h = host();
    const png = Promise.resolve(new Blob(['png'], { type: 'image/png' }));
    await writeImage(png, h);
    const [[items]] = vi.mocked(h.clipboard!.write!).mock.calls as unknown as [[FakeItem[]]];
    expect(items).toHaveLength(1);
    expect(items[0].items['image/png']).toBe(png);
  });

  it('fails when the clipboard refuses it', async () => {
    const h = host({ clipboard: { write: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) } });
    await expect(writeImage(Promise.resolve(new Blob()), h)).rejects.toThrow('NotAllowedError');
  });
});

describe('pngOf', () => {
  /** A drawing surface that records what it was asked to draw. */
  function drawing(blob: Blob | null = new Blob(['png'], { type: 'image/png' }), loads = true) {
    const drawn: Array<{ width: number; height: number }> = [];
    const surface: PngDrawing = {
      load: src =>
        loads
          ? Promise.resolve({ width: 640, height: 480, src })
          : Promise.reject(new Error('decode')),
      draw: (picture, type) => {
        drawn.push({ width: picture.width, height: picture.height });
        return Promise.resolve(type === 'image/png' ? blob : null);
      },
    };
    return { surface, drawn };
  }

  it('draws the picture at its own size and gives it back as a PNG', async () => {
    const { surface, drawn } = drawing();
    const png = await pngOf('data:image/jpeg;base64,AAAA', surface);
    expect(png.type).toBe('image/png');
    expect(drawn).toEqual([{ width: 640, height: 480 }]);
  });

  it('fails when the picture cannot be read or drawn', async () => {
    await expect(pngOf('data:image/jpeg;base64,AAAA', drawing(undefined, false).surface)).rejects.toThrow();
    await expect(pngOf('data:image/jpeg;base64,AAAA', drawing(null).surface)).rejects.toThrow();
  });
});
