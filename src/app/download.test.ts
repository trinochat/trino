// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REVOKE_AFTER_MS, downloadBlob } from './download';

// "Guardar QR" (W4) hands the app a PNG to save. The app saves it the way the
// old file bubbles do: an <a download> that the webview turns into a download.
// jsdom has no object URLs and does not navigate, so both are stood in for.

const urlStatics = ['createObjectURL', 'revokeObjectURL'] as const;
const originals = urlStatics.map(name => [name, Object.getOwnPropertyDescriptor(URL, name)] as const);

let made: Blob[];
let revoked: string[];
let clicks: Array<{ href: string; download: string }>;

beforeEach(() => {
  vi.useFakeTimers();
  made = [];
  revoked = [];
  clicks = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      made.push(blob);
      return `blob:trino/${made.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: (url: string) => revoked.push(url),
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(URL, name, descriptor);
    else Reflect.deleteProperty(URL, name);
  }
});

describe('downloadBlob', () => {
  it('hands the file to the webview’s download under its name', () => {
    const png = new Blob(['png'], { type: 'image/png' });
    downloadBlob('trino-ana-torres.png', png);
    expect(made).toEqual([png]);
    expect(clicks).toEqual([{ href: 'blob:trino/1', download: 'trino-ana-torres.png' }]);
  });

  it('leaves nothing behind in the page', () => {
    downloadBlob('trino-ana-torres.png', new Blob(['png']));
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('lets the file go once the download has had time to take it', () => {
    downloadBlob('trino-ana-torres.png', new Blob(['png']));
    vi.advanceTimersByTime(REVOKE_AFTER_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:trino/1']);
  });
});
