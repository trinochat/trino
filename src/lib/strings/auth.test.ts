import { describe, expect, it } from 'vitest';
import { auth } from './auth';
import { expectAreaContract } from './contract-test-utils';

// The contract with the first run (R3.5) and unlock (R3.6) screens. W1 owns
// this area: new keys go here, with the prefixes onb, unlock2, start and titlebar.
const KEYS = [
  'onb.stepOf', 'onb.welcomeTitle', 'onb.welcomeBody', 'onb.langLabel', 'onb.start',
  'onb.nameTitle', 'onb.nameBody', 'onb.nameLabel', 'onb.addPhoto', 'onb.errNameRequired',
  'onb.passTitle', 'onb.passBody', 'onb.passLabel', 'onb.pass2Label', 'onb.showPassword',
  'onb.hidePassword', 'onb.strength.weak', 'onb.strength.fair', 'onb.strength.good',
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
  'onb.errNameTooLong', 'onb.checking', 'onb.ageLabel', 'onb.privacyLabel', 'onb.privacyLink',
  'onb.errConsent', 'onb.errTotpBegin', 'onb.errCodeLength', 'onb.errTotpCheck',
  'onb.errTotpNotVerified', 'onb.qrTitle',
  'unlock2.title', 'unlock2.lockedIdle', 'unlock2.lockedIdleOne', 'unlock2.lockedManual',
  'unlock2.coldStart', 'unlock2.passLabel', 'unlock2.showPassword', 'unlock2.hidePassword',
  'unlock2.codeLabel', 'unlock2.codeHint', 'unlock2.codeRequired', 'unlock2.submit',
  'unlock2.unlocking', 'unlock2.errPass', 'unlock2.errPassOrCode', 'unlock2.errUnlock',
  'unlock2.forgot', 'unlock2.forgotBody', 'unlock2.forgotLoss', 'unlock2.wipe',
  'unlock2.wipeTitle', 'unlock2.wipeBody', 'unlock2.wipeConfirm', 'unlock2.wipeCancel',
  'unlock2.wiping', 'unlock2.errWipe',
  // R3.6: a vault from a newer Trino, no name to greet, an empty password.
  'unlock2.errUnsupported', 'unlock2.titleNoName', 'unlock2.errEmpty',
  // The start-up screen and the window bar.
  'start.loading', 'start.error', 'start.retry',
  'titlebar.minimize', 'titlebar.maximize', 'titlebar.restore', 'titlebar.close',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'onb.stepOf': ['n', 'total'],
  'onb.errTooShort': ['min'],
  'onb.errNameTooLong': ['max'],
  'unlock2.title': ['name'],
  'unlock2.lockedIdle': ['n'],
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

  // David, 11 Oct 2026: Trino is for people of 18 or more, asked with a box
  // and no birth date; and the data authorization of Ley 1581.
  it('asks for the age and the data authorization in the words David chose', () => {
    expect(auth.es['onb.ageLabel']).toBe('Tengo 18 años o más');
    expect(auth.es['onb.privacyLabel']).toBe('Leí y acepto cómo Trino trata mis datos');
    for (const lang of ['es', 'en', 'pt'] as const) {
      expect(auth[lang]['onb.ageLabel'], lang).toContain('18');
      expect(auth[lang]['onb.errConsent'], lang).toContain('18');
    }
  });
});

describe('auth strings', () => {
  it('have exactly the keys of the first run and unlock screens, with their placeholders', () => {
    expectAreaContract(auth, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
