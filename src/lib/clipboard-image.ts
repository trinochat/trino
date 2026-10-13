/**
 * Copiar imagen (MC-2): a photo of a message to the system clipboard, as a
 * PNG, the one picture type the web's clipboard writes everywhere. WebView2,
 * like Chromium, has the async clipboard with `ClipboardItem`; where a
 * webview lacks it, or says it cannot take a PNG, the menu leaves the item
 * out instead of offering what would fail.
 *
 * The picture is drawn on a canvas from its data URL (the CSP lets <img>
 * read `data:`, and a picture drawn from one does not taint the canvas), so
 * a JPEG, a WebP or a GIF's first frame all become a PNG. Nothing leaves the
 * app: the clipboard is the person's own.
 */

/**
 * What the clipboard needs from the window: `window` and `navigator` in the
 * app, given by src/lib/clipboard.ts, which uses this off Windows; on
 * Windows the backend copies the picture without the clipboard history
 * (cifrado local CL-6b).
 */
export interface ImageClipboardHost {
  ClipboardItem?: {
    new (items: Record<string, Promise<Blob>>): unknown;
    /** Chromium 121 and later; older ones take PNG without saying so. */
    supports?(type: string): boolean;
  };
  clipboard?: { write?(items: unknown[]): Promise<void> };
}

/** Whether the clipboard takes a PNG picture. */
export function canCopyImages(host: ImageClipboardHost): boolean {
  const Item = host.ClipboardItem;
  if (typeof Item !== 'function' || typeof host.clipboard?.write !== 'function') return false;
  return typeof Item.supports === 'function' ? Item.supports('image/png') : true;
}

/**
 * Writes a PNG to the clipboard. It takes the PNG still on its way, so the
 * write starts within the click that asked for it, as a webview may require.
 */
export function writeImage(png: Promise<Blob>, host: ImageClipboardHost): Promise<void> {
  const Item = host.ClipboardItem;
  const clipboard = host.clipboard;
  if (typeof Item !== 'function' || typeof clipboard?.write !== 'function') {
    return Promise.reject(new Error('no image clipboard'));
  }
  return clipboard.write([new Item({ 'image/png': png })]);
}

/** A picture ready to draw, at its own size. */
export interface PngPicture {
  width: number;
  height: number;
  /** What the canvas draws; the tests' fake drawing has none. */
  source?: CanvasImageSource;
}

/** How a picture is read and drawn: on a canvas in the app; a fake in the tests. */
export interface PngDrawing {
  load(src: string): Promise<PngPicture>;
  draw(picture: PngPicture, type: string): Promise<Blob | null>;
}

/** The page's own canvas. */
const canvasDrawing: PngDrawing = {
  load: src =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, source: image });
      image.onerror = () => reject(new Error('the picture could not be read'));
      image.src = src;
    }),
  draw: (picture, type) =>
    new Promise(resolve => {
      const canvas = document.createElement('canvas');
      canvas.width = picture.width;
      canvas.height = picture.height;
      const context = canvas.getContext('2d');
      if (!context || !picture.source) return resolve(null);
      context.drawImage(picture.source, 0, 0);
      canvas.toBlob(resolve, type);
    }),
};

/** A picture's data URL as a PNG, drawn at its own size. */
export async function pngOf(src: string, drawing: PngDrawing = canvasDrawing): Promise<Blob> {
  const picture = await drawing.load(src);
  const png = await drawing.draw(picture, 'image/png');
  if (!png) throw new Error('the picture could not be drawn');
  return png;
}
