import { describe, expect, it } from 'vitest';
import { auth } from './auth';
import { expectAreaContract } from './contract-test-utils';

// The contract with the first run (R3.5) and unlock (R3.6) screens. W1 owns
// this area: new keys go here, with the prefixes onb, unlock2, start and titlebar.
const KEYS = [
  'onb.stepOf', 'onb.welcomeTitle', 'onb.welcomeBody', 'onb.langLabel', 'onb.start',
  'onb.nameTitle', 'onb.nameBody', 'onb.nameLabel', 'onb.addPhoto', 'onb.errNameRequired',
  // One name for the password toggle, whose state aria-pressed tells (PasswordInput).
  'onb.passTitle', 'onb.passBody', 'onb.passLabel', 'onb.pass2Label', 'onb.showPassword',
  'onb.strength.weak', 'onb.strength.fair', 'onb.strength.good',
  'onb.strength.strong', 'onb.errMismatch', 'onb.errTooShort', 'onb.errTooCommon',
  'onb.noRecoveryTitle', 'onb.noRecoveryBody', 'onb.styleTitle', 'onb.styleBody',
  'onb.calmaDesc', 'onb.terminalDesc', 'onb.previewIn', 'onb.previewOut', 'onb.twofaTitle',
  'onb.twofaBody', 'onb.twofaOn', 'onb.twofaLater', 'onb.twofaScan', 'onb.twofaQr',
  'onb.twofaManual', 'onb.twofaCode', 'onb.verify', 'onb.errCode', 'onb.twofaBack',
  'onb.creating', 'onb.errCreate', 'onb.doneTitle', 'onb.doneBody', 'onb.yourCode',
  'onb.copy', 'onb.copied', 'onb.showQr', 'onb.codeQr', 'onb.addFirst', 'onb.goChats',
  'onb.back', 'onb.next',
  // R3.5: the photo, the name's limit, the policy check, the copy with K12
  // (plan-cambios-11oct §6), the two boxes of the first step (age and data,
  // the parent's addendum), the 2FA errors and the QR dialog.
  'onb.nameBodySync', 'onb.changePhoto', 'onb.removePhoto', 'onb.errPhoto', 'onb.errPhotoSave',
  'onb.errNameTooLong', 'onb.checking', 'onb.privacyLabel', 'onb.privacyLink',
  // UR-10: the age question, under 16, and the end for 16 and 17.
  'onb.ageTitle', 'onb.ageBody', 'onb.ageUnder16', 'onb.ageMinor', 'onb.ageAdult', 'onb.ageNote', 'onb.ageMinorNote', 'onb.errAge', 'onb.youngTitle', 'onb.youngBody', 'onb.youngLater', 'onb.youngBack', 'onb.doneBodyMinor',
  'onb.errConsent', 'onb.errTotpBegin', 'onb.errCodeLength', 'onb.errTotpCheck',
  'onb.errTotpNotVerified', 'onb.qrTitle',
  'unlock2.lockedIdle', 'unlock2.lockedIdleOne', 'unlock2.lockedManual',
  'unlock2.coldStart', 'unlock2.passLabel', 'unlock2.showPassword',
  'unlock2.codeLabel', 'unlock2.codeHint', 'unlock2.codeRequired', 'unlock2.submit',
  'unlock2.unlocking', 'unlock2.errPass', 'unlock2.errPassOrCode', 'unlock2.errUnlock',
  'unlock2.forgot', 'unlock2.forgotBody', 'unlock2.forgotLoss', 'unlock2.wipe',
  'unlock2.wipeTitle', 'unlock2.wipeBody', 'unlock2.wipeConfirm', 'unlock2.wipeCancel',
  'unlock2.wiping', 'unlock2.errWipe',
  // R3.6: a vault from a newer Trino, no name to greet, an empty password.
  'unlock2.errUnsupported', 'unlock2.titleNoName', 'unlock2.errEmpty',
  // Cifrado local (design §11.3): why Trino locked with Windows (CL-6a). The
  // greeting with the name is gone: the unlock screen never shows one
  // (David's decision 1).
  'unlock2.lockedWindows', 'unlock2.lockedSuspend',
  // Cifrado local CL-2b (design §6.2, §11.4 and §11.5): the one dialog at
  // unlock when files changed, the files of an earlier version, and the one
  // note after the migration.
  'integrity.title', 'integrity.body', 'integrity.listLabel',
  'integrity.item.account', 'integrity.item.prefs', 'integrity.item.history', 'integrity.item.sessions',
  'integrity.item.profiles', 'integrity.item.stickers', 'integrity.item.index', 'integrity.item.vault',
  'integrity.item.store', 'integrity.item.requests', 'integrity.item.other',
  'integrity.askOlderOne', 'integrity.askOlderMany', 'integrity.askUnverified',
  'integrity.withoutOne', 'integrity.withoutMany', 'integrity.withoutUnverified',
  'integrity.risk.account', 'integrity.risk.prefs', 'integrity.risk.history', 'integrity.risk.profiles', 'integrity.risk.other',
  'integrity.loss.account', 'integrity.loss.prefs', 'integrity.loss.history', 'integrity.loss.profiles', 'integrity.loss.other',
  'integrity.skipOne', 'integrity.useOne', 'integrity.skipMany', 'integrity.useMany',
  'integrity.skipUnverified', 'integrity.useUnverified', 'integrity.used', 'integrity.skipped', 'integrity.errChoose',
  'integrity.notice.altered', 'integrity.notice.unlisted', 'integrity.notice.olderAside', 'integrity.notice.missing',
  'integrity.notice.missingPrefs', 'integrity.notice.missingStickers', 'integrity.notice.newSessions',
  'integrity.notice.unreadable', 'integrity.notice.held', 'integrity.notice.index', 'integrity.notice.vaultChanged', 'integrity.notice.totpFlag',
  'integrity.notice.otherAccount', 'integrity.notice.storeMissing',
  'integrity.plain.title', 'integrity.plain.body', 'integrity.plain.preview', 'integrity.plain.import',
  'integrity.plain.remove', 'integrity.plain.removeAsk', 'integrity.plain.removeYes', 'integrity.plain.removeNo',
  'integrity.plain.name', 'integrity.plain.contacts', 'integrity.plain.groups', 'integrity.plain.counts',
  'integrity.plain.unreadable', 'integrity.plain.imported', 'integrity.plain.removed', 'integrity.plain.err',
  'integrity.footer', 'integrity.whatToDo', 'integrity.whatToDoLock', 'integrity.whatToDoPass', 'integrity.done',
  'migrated.title', 'migrated.body', 'migrated.leftovers', 'migrated.copies', 'migrated.otherFolders', 'migrated.done',
  // The start-up screen and the window bar.
  'start.loading', 'start.error', 'start.retry',
  'titlebar.minimize', 'titlebar.maximize', 'titlebar.restore', 'titlebar.close',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'onb.stepOf': ['n', 'total'],
  'onb.errTooShort': ['min'],
  'onb.errNameTooLong': ['max'],
  'unlock2.lockedIdle': ['n'],
  'integrity.loss.account': ['without'],
  'integrity.loss.prefs': ['without'],
  'integrity.loss.history': ['without'],
  'integrity.loss.profiles': ['without'],
  'integrity.loss.other': ['without'],
  'integrity.plain.name': ['name'],
  'integrity.plain.contacts': ['n', 'names'],
  'integrity.plain.groups': ['n', 'names'],
  'integrity.plain.counts': ['chats', 'blocked', 'invites', 'stickers'],
  'integrity.plain.unreadable': ['files'],
  'migrated.body': ['contacts', 'groups', 'notes', 'stickers'],
};

describe('the copy of the first run', () => {
  // The name step says what really reaches the contacts (plan-cambios-11oct
  // §6): with the shared profile (K12) the name and the photo travel
  // encrypted; without it, the photo stays on this device.
  it('has a name step body for each case, and only the one with K12 sends the photo', () => {
    expect(auth.es['onb.nameBodySync']).toBe(
      'Tu nombre va en tu código de contacto. Tu nombre y tu foto también les llegan cifrados a tus contactos.',
    );
    expect(auth.es['onb.nameBody']).toContain('tu foto solo se guarda en este equipo');
  });

  // David, 25 Oct 2026 (minimum of 16): one question with three answers, no
  // birth date; and the data authorization of Ley 1581.
  it('asks for the age and the data authorization in the words David chose', () => {
    expect(auth.es['onb.ageTitle']).toBe('¿Cuántos años tienes?');
    expect([auth.es['onb.ageUnder16'], auth.es['onb.ageMinor'], auth.es['onb.ageAdult']]).toEqual([
      'Menos de 16',
      '16 o 17',
      '18 o más',
    ]);
    expect(auth.es['onb.ageNote']).toBe('No te pedimos documento, fecha de nacimiento ni foto. Tu respuesta se queda en tus equipos.');
    expect(auth.es['onb.youngTitle']).toBe('Trino es para personas de 16 años o más');
    expect(auth.es['onb.privacyLabel']).toBe('Leí y acepto cómo Trino trata mis datos');
    for (const lang of ['es', 'en', 'pt'] as const) {
      expect(auth[lang]['onb.youngTitle'], lang).toContain('16');
      expect(auth[lang]['onb.errConsent'], lang).not.toContain('18');
    }
  });
});

describe('the copy of the unlock screen', () => {
  // David, 12 Oct 2026 (decision 1): "Hola de nuevo", without the name,
  // which nothing in clear may give before unlocking (design H1).
  it('greets without a name in every language', () => {
    expect(auth.es['unlock2.titleNoName']).toBe('Hola de nuevo');
    for (const lang of ['es', 'en', 'pt'] as const) {
      const unlock = Object.entries(auth[lang]).filter(([key]) => key.startsWith('unlock2.'));
      expect(unlock.filter(([, text]) => text.includes('{name}')), lang).toEqual([]);
    }
  });
});

// Design test 47: the texts about what Trino keeps on this device promise
// nothing it cannot keep.
describe('the copy about the data on this device', () => {
  const PROMISES = /irrecuperable|sin rastro|segur[oa]s?|unrecoverable|no trace|secure|safe|irrecuper[aá]vel|sem rastro/i;

  it('never promises "irrecuperable", "sin rastro" or "seguro"', () => {
    for (const lang of ['es', 'en', 'pt'] as const) {
      const texts = Object.entries(auth[lang]).filter(([key]) => key.startsWith('integrity.') || key.startsWith('migrated.'));
      expect(texts.length, lang).toBeGreaterThan(0);
      expect(texts.filter(([, text]) => PROMISES.test(text)).map(([key]) => key), lang).toEqual([]);
    }
  });

  // Investigación §3: BitLocker protects the leftovers only while the
  // computer is off (design §11.5).
  it('says when BitLocker protects the leftovers', () => {
    expect(auth.es['migrated.leftovers']).toContain('BitLocker los protege solo con el computador apagado.');
  });

  // David's decision 3: the two answers to an old copy, in the design's words.
  it('names both choices of an old copy as the design does', () => {
    expect([auth.es['integrity.skipOne'], auth.es['integrity.useOne']]).toEqual(['Seguir sin ella', 'Usar esa copia']);
    expect([auth.es['integrity.skipUnverified'], auth.es['integrity.useUnverified']]).toEqual(['Seguir sin ellos', 'Usarlos']);
  });
});

describe('auth strings', () => {
  it('have exactly the keys of the first run and unlock screens, with their placeholders', () => {
    expectAreaContract(auth, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
