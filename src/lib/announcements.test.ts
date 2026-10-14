// @ts-expect-error Node's types are not installed; vitest runs the tests on Node.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_ANNOUNCEMENTS, loadAnnouncementFeed } from './announcements';

// The news are fetched and verified in Rust (Tor design §7, R-06): the
// WebView asks `news_fetch` and only paints what came back verified.
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const POST = {
  id: '2026-10-14-tor',
  title: 'Trino 0.2.0',
  body: 'Ya puedes usar Tor.',
  publishedAt: '2026-10-14T12:00:00-05:00',
  version: '0.2.0',
  url: 'https://trinochat.org/',
};

beforeEach(() => {
  invoke.mockReset();
});

describe('the bundled announcements', () => {
  // The bundled news are Spanish copy too: Latin American words, as in
  // strings (i18n.test.ts), which only checks the dictionaries.
  it('speak the Spanish of Latin America: "agregar", not "añadir"', () => {
    const copy = BUNDLED_ANNOUNCEMENTS.map(announcement => `${announcement.title} ${announcement.body}`).join('\n');
    expect(copy).not.toMatch(/añad/i);
  });
});

describe('loadAnnouncementFeed', () => {
  it('asks Rust, and shows the items of a verified feed with what it says of updates', async () => {
    invoke.mockResolvedValueOnce({
      status: 'verified',
      items: [POST],
      signerFingerprint: '4DE8E4BC5872E37566FA4114A62EE5607F666A6B',
      latest: '0.2.0',
      freeze: { kind: 'expired', days: 3 },
    });

    const feed = await loadAnnouncementFeed();

    expect(invoke).toHaveBeenCalledWith('news_fetch');
    expect(feed).toEqual({
      announcements: [POST],
      source: 'verified',
      signerFingerprint: '4DE8E4BC5872E37566FA4114A62EE5607F666A6B',
      latest: '0.2.0',
      freeze: { kind: 'expired', days: 3 },
    });
  });

  it('shows the bundled copy when no feed came, and says when one did not verify', async () => {
    for (const status of ['bundled', 'untrusted'] as const) {
      invoke.mockResolvedValueOnce({ status, items: [], signerFingerprint: null, latest: null, freeze: null });
      const feed = await loadAnnouncementFeed();
      expect(feed.source).toBe(status);
      expect(feed.announcements).toEqual(BUNDLED_ANNOUNCEMENTS);
      expect(feed.signerFingerprint).toBeUndefined();
    }
  });

  it('never paints items that Rust did not call verified', async () => {
    invoke.mockResolvedValueOnce({ status: 'untrusted', items: [POST], signerFingerprint: null, latest: null, freeze: null });
    const feed = await loadAnnouncementFeed();
    expect(feed.announcements).toEqual(BUNDLED_ANNOUNCEMENTS);
  });

  it('falls back to the bundled copy when the command fails', async () => {
    invoke.mockRejectedValueOnce(new Error('no backend'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const feed = await loadAnnouncementFeed();
    expect(feed).toEqual({ announcements: BUNDLED_ANNOUNCEMENTS, source: 'bundled' });
    warn.mockRestore();
  });
});

describe('openpgp.js', () => {
  it('is gone: no dependency, and no source imports it', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8') as string);
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('openpgp');
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain('openpgp');
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@openpgp/web-stream-tools');
    const announcements = readFileSync('src/lib/announcements.ts', 'utf8') as string;
    expect(announcements).not.toMatch(/openpgp|fetch\(/);
    const script = readFileSync('scripts/sign-announcement.mjs', 'utf8') as string;
    expect(script).not.toMatch(/from 'openpgp'/);
  });
});
