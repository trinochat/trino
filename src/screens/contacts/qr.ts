/**
 * "Guardar QR" (Contacts:97): the QR code as a PNG file. The screen draws a
 * QRCodeCanvas off screen at PNG resolution; this turns it into a file and
 * hands it to the shell's `download`.
 */
import { resolveTokens } from '../../design/appearance';

/**
 * The colours of the PNG. A file cannot follow CSS, so it takes the QR
 * tokens, which are black on white in every theme, accent and contrast.
 */
export const QR_PNG_COLORS: Readonly<{ ink: string; paper: string }> = (() => {
  const { qrInk, qrPaper } = resolveTokens('calma', 'light', 'verde');
  return Object.freeze({ ink: qrInk, paper: qrPaper });
})();

/** Width and height of the PNG in px, before the screen's pixel ratio. */
export const QR_PNG_SIZE = 1024;

/** Quiet zone around the PNG's modules, which scanners need: 4, as the QR spec asks. */
export const QR_PNG_MARGIN = 4;

/** "trino-ana-torres.png": the person's name in plain letters, or "trino-qr.png". */
export function qrFileName(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `trino-${slug || 'qr'}.png`;
}

/** Hands the canvas to `download` as a PNG; false when no PNG could be made. */
export function saveQrPng(
  canvas: HTMLCanvasElement | null,
  name: string,
  download: (name: string, blob: Blob) => void,
): Promise<boolean> {
  return new Promise(resolve => {
    if (!canvas) {
      resolve(false);
      return;
    }
    try {
      canvas.toBlob(blob => {
        if (!blob) {
          resolve(false);
          return;
        }
        download(name, blob);
        resolve(true);
      }, 'image/png');
    } catch {
      resolve(false);
    }
  });
}
