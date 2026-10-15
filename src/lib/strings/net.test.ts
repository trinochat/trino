import { describe, expect, it } from 'vitest';
import { expectAreaContract, LANG_CODES } from './contract-test-utils';
import { net } from './net';

// The texts of Tor in the app (TOR-6, PropTorSimple), with the prefix net:
// the plain words everyone sees, and the technical ones behind "Opciones
// avanzadas". One app, not two modes.
const KEYS: string[] = [
  // The first run's "Conexión" step (card 1), and the option to hide Trino from the provider.
  'net.welcome.title',
  'net.welcome.body',
  'net.welcome.hidden',
  'net.welcome.hiddenBody',
  'net.welcome.error',
  // The line under the wordmark of the inbox (card 2): gone while connected.
  'net.line.starting',
  'net.line.waitingInternet',
  'net.line.failed',
  'net.line.seeWhat',
  'net.line.unprotected',
  // "No se pudo conectar" (card 3).
  'net.failed.title',
  'net.failed.blocked',
  'net.failed.slow',
  'net.failed.clock',
  'net.failed.antivirus',
  'net.failed.obsolete',
  'net.failed.tryOther',
  'net.failed.trying',
  'net.failed.tryingNote',
  'net.failed.retry',
  'net.failed.meanwhile',
  'net.failed.escape',
  'net.failed.error',
  // "Conectar sin protección" (card 5).
  'net.escape.title',
  'net.escape.body',
  'net.escape.confirm',
  'net.escape.error',
  // Ajustes › Privacidad › Conexión (card 6).
  'net.settings.title',
  'net.settings.back',
  'net.settings.private',
  'net.settings.connecting',
  'net.settings.failed',
  'net.settings.unprotected',
  'net.settings.backToTor',
  'net.settings.seen',
  'net.settings.daily',
  'net.settings.dailyBody',
  'net.settings.dailyUnprotected',
  'net.settings.advanced',
  'net.settings.onUnlock',
  'net.settings.onUnlockBody',
  'net.settings.onUnlockFixed',
  'net.settings.escape',
  'net.settings.errSave',
  // "Qué ven los demás" (card 7).
  'net.seen.title',
  'net.seen.back',
  'net.seen.servers',
  'net.seen.provider',
  'net.seen.calls',
  'net.seen.note',
  'net.seen.bridges',
  'net.seen.microsoft',
  'net.seen.folder',
  // A new version, in the inbox (card 8), and TOR-10's freeze.
  'net.update.region',
  'net.update.ready',
  'net.update.install',
  'net.update.later',
  'net.update.waitingForCall',
  'net.update.installing',
  'net.update.installFailed',
  'net.update.notDownloaded',
  'net.update.tryAgain',
  'net.update.unchecked',
  'net.update.uncheckedRecent',
  'net.update.checkNow',
  'net.update.saved',
  // "Trino necesita actualizarse" (card 9): Tor Browser first.
  'net.old.title',
  'net.old.titleMaybe',
  'net.old.body',
  'net.old.howTo',
  'net.old.direct',
  'net.old.step1',
  'net.old.step2',
  'net.old.step3',
  'net.old.copy',
  'net.old.copied',
  'net.old.notCopied',
  'net.old.signature',
  'net.old.directBody',
  'net.old.download',
  'net.old.checking',
  'net.old.downloading',
  'net.old.ready',
  'net.old.none',
  'net.old.failed',
  'net.old.close',
  // Opening a link in the browser (card 10).
  'net.link.body',
  'net.link.dontAsk',
  'net.link.open',
  'net.link.error',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'net.line.starting': ['pct'],
  'net.update.unchecked': ['n'],
};

describe('net strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(net, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});

/**
 * Design test 49 (Tor design §10, R-19): no text promises what Tor does
 * not give. Never "anónimo", "nadie puede" or "100 %"; "invisible" only to
 * say that Trino does not make you so (card 7's last line).
 */
describe.each(LANG_CODES)('the Tor copy in %s', lang => {
  const texts = Object.entries(net[lang]);

  it('never promises anonymity, that nobody can see, or a hundred percent', () => {
    const promises = texts
      .filter(([, text]) => /an[oóô]nim|anonym|nadie puede|nobody can|no one can|ningu[ée]m pode|100\s?%/i.test(text))
      .map(([key]) => key);
    expect(promises).toEqual([]);
  });

  it('says "invisible" only to deny it', () => {
    const invisible = texts
      .filter(([, text]) => /invis[ií]ve?l/i.test(text))
      .filter(([, text]) => !/(no te hace|doesn[’']t make you|não te deixa) invis[ií]ve?l/i.test(text))
      .map(([key]) => key);
    expect(invisible).toEqual([]);
  });

  it('says what the provider sees: Tor, and without another way in, that it is not Tor Browser', () => {
    expect(net[lang]['net.seen.provider']).toMatch(/Tor Browser/);
    expect(net[lang]['net.escape.body']).toMatch(/Trino/);
  });

  it('says that calls show where you connect from to Cloudflare, and the servers whom you write to', () => {
    expect(net[lang]['net.seen.calls']).toMatch(/Cloudflare/);
    expect(net[lang]['net.seen.servers']).not.toBe('');
  });

  it('gives the hidden way in its cost, in one line', () => {
    expect(net[lang]['net.welcome.hiddenBody']).toMatch(/1.{1,8}2/);
    expect(net[lang]['net.welcome.hiddenBody']).not.toMatch(/\n/);
  });
});

describe('the Spanish of Colombia', () => {
  it('speaks with tú and Colombian words, never vosotros', () => {
    const all = Object.values(net.es).join(' ');
    expect(all).not.toMatch(/\b(vosotros|vuestr[oa]s?|ordenador|habéis|podéis|tenéis)\b/i);
    expect(all).toMatch(/computador/);
  });
});
