import { describe, expect, it, vi } from 'vitest';
import { resolveTokens } from '../../design/appearance';
import { ACCENTS, RESOLVED_MODES, STYLES } from '../../design/tokens';
import { QR_PNG_COLORS, qrFileName, saveQrPng } from './qr';

/** A canvas whose toBlob answers with `blob`, or throws. */
const canvasWith = (blob: Blob | null | 'throws') =>
  ({
    toBlob: vi.fn((callback: BlobCallback, type?: string) => {
      if (blob === 'throws') throw new Error('tainted');
      expect(type).toBe('image/png');
      callback(blob);
    }),
  }) as unknown as HTMLCanvasElement;

describe('saveQrPng', () => {
  it('hands the canvas as a PNG to download, under the name given', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const download = vi.fn();
    await expect(saveQrPng(canvasWith(blob), 'trino-ana.png', download)).resolves.toBe(true);
    expect(download).toHaveBeenCalledWith('trino-ana.png', blob);
  });

  it('reports a failure, and downloads nothing, when there is no PNG', async () => {
    const download = vi.fn();
    await expect(saveQrPng(canvasWith(null), 'x.png', download)).resolves.toBe(false);
    await expect(saveQrPng(canvasWith('throws'), 'x.png', download)).resolves.toBe(false);
    await expect(saveQrPng(null, 'x.png', download)).resolves.toBe(false);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('qrFileName', () => {
  it('names the PNG after the person, in plain letters', () => {
    expect(qrFileName('Ana Torres')).toBe('trino-ana-torres.png');
    expect(qrFileName('María 🐦')).toBe('trino-maria.png');
    expect(qrFileName('  Ñandú__42 ')).toBe('trino-nandu-42.png');
  });

  it('falls back to a plain name when nothing is left', () => {
    expect(qrFileName('')).toBe('trino-qr.png');
    expect(qrFileName('🐦🐦')).toBe('trino-qr.png');
  });
});

describe('QR_PNG_COLORS', () => {
  // The PNG cannot follow CSS, so it takes the QR tokens, which are black on
  // white in every theme, accent and contrast.
  it('are the QR tokens of every theme', () => {
    for (const style of STYLES) {
      for (const mode of RESOLVED_MODES) {
        for (const accent of ACCENTS) {
          const tokens = resolveTokens(style, mode, accent, { vision: 'safe', contrast: 'more', scanLines: false });
          expect({ ink: tokens.qrInk, paper: tokens.qrPaper }, `${style}-${mode}-${accent}`).toEqual(QR_PNG_COLORS);
        }
      }
    }
    expect(QR_PNG_COLORS).toEqual({ ink: '#000000', paper: '#FFFFFF' });
  });
});
