import { describe, expect, it } from 'vitest';
import { DICTS } from '../i18n';
import { expectAreaContract, LANG_CODES } from './contract-test-utils';
import { emergency } from './emergency';

// The texts of the emergency key (CE-5, design §11), with the prefix
// emergency: the row and the page of Settings, configuring it, testing it,
// removing it and the network.
const KEYS: string[] = [
  // The row of Cuenta y seguridad, the same with a key or without one (CE-D6).
  'emergency.row.title',
  'emergency.row.body',
  // The page (card 2).
  'emergency.page.title',
  'emergency.page.back',
  'emergency.page.what',
  'emergency.page.totp',
  'emergency.page.setup',
  'emergency.page.test',
  'emergency.page.remove',
  'emergency.page.more',
  'emergency.page.network',
  'emergency.page.networkBody',
  // Configuring or changing it (card 3, §11.2).
  'emergency.setup.title',
  'emergency.setup.back',
  'emergency.setup.step',
  'emergency.setup.limits',
  'emergency.setup.undoTitle',
  'emergency.setup.undo',
  'emergency.setup.onlyUnlock',
  'emergency.setup.notTheirs',
  'emergency.setup.copies',
  'emergency.setup.otherDevices',
  'emergency.setup.forensic',
  'emergency.setup.installed',
  'emergency.setup.kit',
  'emergency.setup.memorize',
  'emergency.setup.understood',
  'emergency.setup.continue',
  'emergency.setup.passFirst',
  'emergency.setup.replaces',
  'emergency.setup.passphrase',
  'emergency.setup.showPassphrase',
  'emergency.setup.code',
  'emergency.setup.key',
  'emergency.setup.showKey',
  'emergency.setup.keyRule',
  'emergency.setup.repeat',
  'emergency.setup.save',
  'emergency.setup.saved',
  'emergency.setup.tryNow',
  'emergency.setup.tryButton',
  'emergency.setup.better',
  'emergency.setup.reinforced',
  'emergency.setup.reinforcedBody',
  'emergency.setup.networkBody',
  'emergency.setup.done',
  // The errors (§11.4).
  'emergency.err.short',
  'emergency.err.common',
  'emergency.err.same',
  'emergency.err.like',
  'emergency.err.another',
  'emergency.err.mismatch',
  'emergency.err.wrong',
  'emergency.err.wrongCode',
  'emergency.err.save',
  'emergency.err.test',
  'emergency.err.open',
  // Testing it without erasing (card 4, §8.4).
  'emergency.test.title',
  'emergency.test.body',
  'emergency.test.lockNote',
  'emergency.test.field',
  'emergency.test.run',
  'emergency.test.yes',
  'emergency.test.no',
  // Removing it (card 5).
  'emergency.remove.title',
  'emergency.remove.body',
  'emergency.remove.confirm',
  'emergency.remove.done',
  'emergency.remove.ok',
  // What happens on the network (card 6, §11.3; CE-D11: no relay deletion).
  'emergency.net.title',
  'emergency.net.locked',
  'emergency.net.intro',
  'emergency.net.none',
  'emergency.net.noneBody',
  'emergency.net.alert',
  'emergency.net.alertBody',
  // The warning to a trusted contact (CE-6, card 6, §7.2, §11.3).
  'emergency.net.who',
  'emergency.net.onlyReaders',
  'emergency.net.noReaders',
  'emergency.net.verified',
  'emergency.net.unverified',
  'emergency.net.notVerified',
  'emergency.net.waiting',
  'emergency.net.accepted',
  'emergency.net.declined',
  'emergency.net.message',
  'emergency.net.messageHint',
  'emergency.net.save',
  'emergency.net.saved',
  'emergency.net.closed',
  'emergency.net.saveFailed',
  // The contact's side (CE-6, cards 9 and 10, §11.6).
  'emergency.contact.title',
  'emergency.contact.ask',
  'emergency.contact.askNote',
  'emergency.contact.decline',
  'emergency.contact.accept',
  'emergency.contact.accepted',
  'emergency.contact.answerFailed',
  'emergency.contact.warning',
  'emergency.contact.quote',
  'emergency.contact.whatToDo',
  'emergency.contact.whatToDoBody',
  'emergency.contact.notification',
];

/**
 * What the texts never promise (design §11.7), in the three languages, and
 * no legal note (CE-D7).
 */
const NEVER = [
  /irrecuper/i,
  /unrecoverable/i,
  /sin rastro/i,
  /sem rastro/i,
  /no trace/i,
  /\bsegur[oa]\b/i,
  /\bsecure/i,
  /\bsafe/i,
  /plausible/i,
  /plausível/i,
  /454/,
  /\bley\b/i,
  /\blei\b/i,
  /\blaw\b/i,
  /legal/i,
  /delito/i,
  /crime/i,
];

describe('the texts of the emergency key', () => {
  it('have the same keys and placeholders in es, en and pt', () => {
    expectAreaContract(emergency, {
      keys: KEYS,
      placeholders: {
        'emergency.setup.step': ['n'],
        'emergency.setup.keyRule': ['min'],
        'emergency.err.short': ['min'],
        'emergency.net.notVerified': ['name'],
        'emergency.net.waiting': ['name'],
        'emergency.net.accepted': ['name'],
        'emergency.net.declined': ['name'],
        'emergency.contact.ask': ['name'],
        'emergency.contact.askNote': ['name'],
        'emergency.contact.accepted': ['name'],
        'emergency.contact.warning': ['name', 'date', 'time'],
        'emergency.contact.quote': ['message'],
        'emergency.contact.whatToDoBody': ['name'],
        'emergency.contact.notification': ['name'],
      },
    });
  });

  it('reach the app', () => {
    for (const lang of LANG_CODES) {
      for (const key of KEYS) expect(DICTS[lang][key], `${lang}: ${key}`).toBe(emergency[lang][key]);
    }
  });

  it('never promise what the key does not do, and carry no legal note', () => {
    const said = LANG_CODES.flatMap(lang =>
      Object.entries(emergency[lang]).flatMap(([key, text]) =>
        NEVER.filter(word => word.test(text)).map(word => `${lang} ${key}: ${String(word)}`),
      ),
    );
    expect(said).toEqual([]);
  });

  it('offer only "Ninguna" and the warning to a contact on the network (CE-D11)', () => {
    const net = Object.keys(emergency.es).filter(key => key.startsWith('emergency.net.'));
    expect(net.some(key => /relay|delete|vanish/i.test(key))).toBe(false);
    expect(emergency.es['emergency.net.none']).toBe('Ninguna');
  });

  it('say that "Quitar" tells the trusted contact, and never call the warning sure (§7.5, §11.6)', () => {
    expect(emergency.es['emergency.remove.body']).toBe(
      'Si tienes una, deja de servir. Si Trino iba a avisarle a un contacto de confianza, le dice que ya no lo hará.',
    );
    for (const lang of LANG_CODES) {
      expect(emergency[lang]['emergency.net.alertSoon'], lang).toBeUndefined();
      // The contact is told a warning may be false (RC-09).
      expect(emergency[lang]['emergency.contact.whatToDoBody'], lang).toMatch(/fals/i);
    }
  });

  it('speak Colombian Spanish with tú', () => {
    const voseo = Object.entries(emergency.es).filter(([, text]) => /\b(vosotros|podéis|tenéis|queréis|escribís)\b/i.test(text));
    expect(voseo).toEqual([]);
  });
});
