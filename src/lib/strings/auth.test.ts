import { describe, it } from 'vitest';
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
  'unlock2.title', 'unlock2.lockedIdle', 'unlock2.lockedIdleOne', 'unlock2.lockedManual',
  'unlock2.coldStart', 'unlock2.passLabel', 'unlock2.showPassword', 'unlock2.hidePassword',
  'unlock2.codeLabel', 'unlock2.codeHint', 'unlock2.codeRequired', 'unlock2.submit',
  'unlock2.unlocking', 'unlock2.errPass', 'unlock2.errPassOrCode', 'unlock2.errUnlock',
  'unlock2.forgot', 'unlock2.forgotBody', 'unlock2.forgotLoss', 'unlock2.wipe',
  'unlock2.wipeTitle', 'unlock2.wipeBody', 'unlock2.wipeConfirm', 'unlock2.wipeCancel',
  'unlock2.wiping', 'unlock2.errWipe',
];

const PLACEHOLDERS: Record<string, string[]> = {
  'onb.stepOf': ['n', 'total'],
  'onb.errTooShort': ['min'],
  'unlock2.title': ['name'],
  'unlock2.lockedIdle': ['n'],
};

describe('auth strings', () => {
  it('have exactly the keys of the first run and unlock screens, with their placeholders', () => {
    expectAreaContract(auth, { keys: KEYS, placeholders: PLACEHOLDERS });
  });
});
