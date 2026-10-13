/**
 * Every copy of the app (cifrado local CL-6b, design §8): "Copiar" on a
 * message, a link, a selection or a contact code, "Copiar imagen", and
 * Ctrl + C, Ctrl + X and the text fields' own menu (src/app/copy-guard.ts).
 *
 * On Windows they go to the backend (src-tauri/src/clipboard.rs), which puts
 * them on the clipboard with the marks that keep them out of the clipboard
 * history (Win + V) and off the cloud clipboard; the web's clipboard has no
 * way to ask for that. With Protección reforzada, the backend also clears
 * the copy 30 seconds later, if nothing was copied after it (design §10).
 * Elsewhere, the webview's own clipboard, as before.
 *
 * This is the one module that touches `navigator.clipboard`; its test checks
 * that nothing else does.
 */
import { api } from './api';
import { prefs } from './prefs';
import { canCopyImages as webCanCopyImages, writeImage as webWriteImage, type ImageClipboardHost } from './clipboard-image';

export interface ClipboardDeps {
  /** Windows, where copies go through the backend. */
  isWindows(): boolean;
  /** The backend's copies (`clipboard_write_text`, `clipboard_write_image`). */
  backend: Pick<typeof api, 'clipboardWriteText' | 'clipboardWriteImage'>;
  /** The webview's own text copy, if it has one. */
  webText(): ((text: string) => Promise<void>) | undefined;
  /** The webview's own clipboard for pictures. */
  imageHost(): ImageClipboardHost;
  /** Whether the backend clears a copy 30 seconds later: Protección reforzada. */
  clearAfter(): boolean;
}

export interface Clipboard {
  /** Whether copies go through the backend, so Ctrl + C must too. */
  throughBackend(): boolean;
  copyText(text: string): Promise<void>;
  /** Whether "Copiar imagen" can be offered. */
  canCopyImages(): boolean;
  /** Copies a PNG, still on its way so the copy starts within the click. */
  copyImage(png: Promise<Blob>): Promise<void>;
}

/** A blob's bytes in base64, as the backend takes a picture. */
async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

export function createClipboard(deps: ClipboardDeps): Clipboard {
  return {
    throughBackend: () => deps.isWindows(),
    copyText: async text => {
      if (deps.isWindows()) return deps.backend.clipboardWriteText(text, deps.clearAfter());
      const write = deps.webText();
      if (!write) throw new Error('no clipboard');
      return write(text);
    },
    canCopyImages: () => deps.isWindows() || webCanCopyImages(deps.imageHost()),
    copyImage: async png => {
      if (deps.isWindows()) return deps.backend.clipboardWriteImage(await base64Of(await png), deps.clearAfter());
      return webWriteImage(png, deps.imageHost());
    },
  };
}

/** The webview's clipboard, read when it is used, so a test can set one first. */
function webClipboard(): Clipboard['copyText'] | undefined {
  const web = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return web?.writeText ? text => web.writeText(text) : undefined;
}

function windowImageHost(): ImageClipboardHost {
  return {
    ClipboardItem: (globalThis as { ClipboardItem?: ImageClipboardHost['ClipboardItem'] }).ClipboardItem,
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
  };
}

/** The app's clipboard. WebView2 says Windows in its user agent. */
export const clipboard: Clipboard = createClipboard({
  isWindows: () => typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent),
  backend: {
    clipboardWriteText: (text, clearAfter) => api.clipboardWriteText(text, clearAfter),
    clipboardWriteImage: (png, clearAfter) => api.clipboardWriteImage(png, clearAfter),
  },
  webText: webClipboard,
  imageHost: windowImageHost,
  clearAfter: () => prefs.getReinforced(),
});
