import { describe, expect, it } from 'vitest';
import { settings } from './settings';
import { expectAreaContract, LANG_CODES } from './contract-test-utils';

// The texts of the settings (settings2.*) and of the contact details
// (contactInfo.*), the screens of W5. Each group follows its screen.

/** What a message notification says (notification-content.ts). */
const NOTIFICATION_CONTENT = [
  'settings2.notif.appName',
  'settings2.notif.newMessage',
  'settings2.notif.newFile',
  'settings2.notif.newSticker',
];

const KEYS: string[] = [...NOTIFICATION_CONTENT];

const PLACEHOLDERS: Record<string, string[]> = {};

describe('settings strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(settings, { keys: KEYS, placeholders: PLACEHOLDERS });
  });

  it('say in Spanish what a notification shows', () => {
    expect(settings.es['settings2.notif.appName']).toBe('Trino Chat');
    expect(settings.es['settings2.notif.newMessage']).toBe('Nuevo mensaje');
  });
});

// What this batch does not have stays out of the copy (plan-cambios-11oct
// §3.3 and §6): no @nombre, no "Apoyar a Trino", no Tor, no "pronto" (soon),
// and the short key is never what verifies a contact (§3.1).
describe.each(LANG_CODES)('the settings copy in %s', lang => {
  const texts = () => Object.entries(settings[lang]);

  it('names no @name, no support page, no Tor and nothing coming soon', () => {
    const promises = texts()
      .filter(([, text]) => /@|apoyar|support|apoiar|(?<!\p{L})tor(?!\p{L})|pronto|soon|em breve/iu.test(text))
      .map(([key]) => key);
    expect(promises).toEqual([]);
  });

  it('never says that comparing the key verifies someone', () => {
    const keyChecks = texts()
      .filter(([, text]) => /(clave|key|chave)[^.]*(verific)|(verific)[^.]*(clave|key|chave)/i.test(text))
      .map(([key]) => key);
    expect(keyChecks).toEqual([]);
  });
});
