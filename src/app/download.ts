/**
 * Saves a file the app made for the person, such as the PNG of "Guardar QR"
 * (W4's `download`): the webview's own download, as the old file bubbles do,
 * through an <a download> that never enters the page. The object URL behind
 * it is let go a minute later, once the download has surely read it, since
 * letting it go at once can cancel the download.
 */

/** How long the file stays readable for the download, in ms. */
export const REVOKE_AFTER_MS = 60_000;

export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
