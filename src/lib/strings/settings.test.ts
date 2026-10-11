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

/** Settings > Perfil (sections/ProfileSection.tsx). */
const PROFILE = [
  'settings2.profile.title',
  'settings2.profile.editPhoto',
  'settings2.profile.removePhoto',
  'settings2.profile.photoAlt',
  'settings2.profile.name',
  'settings2.profile.about',
  'settings2.profile.aboutCount',
  'settings2.profile.shared',
  'settings2.profile.sharedPending',
  'settings2.profile.sharedPendingOne',
  'settings2.profile.local',
  'settings2.profile.findYou',
  'settings2.profile.qrRow',
  'settings2.profile.qrRowBody',
  'settings2.profile.saved',
  'settings2.profile.errInvalid',
  'settings2.profile.errSave',
  'settings2.profile.errPhoto',
  'settings2.profile.errName',
];

/** "Tu código QR" (ProfileQrView.tsx). */
const QR = ['settings2.qr.title', 'settings2.qr.back'];

/** Settings > Privacidad and its blocked contacts (PrivacySection.tsx, BlockedContactsView.tsx). */
const PRIVACY = [
  'settings2.privacy.title',
  'settings2.privacy.blocked',
  'settings2.privacy.blockedNone',
  'settings2.privacy.blockedEmpty',
  'settings2.privacy.unblock',
  'settings2.privacy.unblockA11y',
  'settings2.privacy.errUnblock',
  'settings2.privacy.errLoad',
  'settings2.privacy.back',
  'settings2.privacy.callsLine',
];

/** Settings > Notificaciones (NotificationsSection.tsx). */
const NOTIFICATIONS = [
  'settings2.notif.title',
  'settings2.notif.level',
  'settings2.notif.full',
  'settings2.notif.fullBody',
  'settings2.notif.name',
  'settings2.notif.nameBody',
  'settings2.notif.none',
  'settings2.notif.noneBody',
  'settings2.notif.preview',
  'settings2.notif.previewA11y',
  'settings2.notif.sampleName',
  'settings2.notif.sampleText',
  'settings2.notif.test',
  'settings2.notif.sound',
  'settings2.notif.soundBody',
  'settings2.notif.callsHidden',
  'settings2.notif.callsHiddenBody',
  'settings2.notif.muteGroups',
  'settings2.notif.muteGroupsBody',
  'settings2.notif.ringtone',
  'settings2.notif.ringtoneBody',
  'settings2.notif.ringSoft',
  'settings2.notif.ringSilent',
  'settings2.notif.volume',
  'settings2.notif.volumeValue',
  'settings2.notif.autostart',
  'settings2.notif.autostartBody',
  'settings2.notif.errAutostart',
];

/** Settings > Cuenta y seguridad and its dialogs (SecuritySection.tsx, TotpDialog.tsx, ChangePassphraseDialog.tsx, WipeDialog.tsx). */
const SECURITY = [
  'settings2.security.title',
  'settings2.security.passphrase',
  'settings2.security.passphraseBody',
  'settings2.security.changePassphrase',
  'settings2.security.passphraseChanged',
  'settings2.security.showPassphrase',
  'settings2.security.totp',
  'settings2.security.totpOn',
  'settings2.security.totpOff',
  'settings2.security.totpUnknown',
  'settings2.security.enable',
  'settings2.security.disable',
  'settings2.security.autolock',
  'settings2.security.autolockBody',
  'settings2.security.autolockNever',
  'settings2.security.autolockMinute',
  'settings2.security.autolockMinutes',
  'settings2.security.autolockHour',
  'settings2.security.lockNow',
  'settings2.security.lockNowBody',
  'settings2.security.lock',
  'settings2.security.wipeTitle',
  'settings2.security.wipeBody',
  'settings2.security.wipe',
  'settings2.totp.enableTitle',
  'settings2.totp.disableTitle',
  'settings2.totp.starting',
  'settings2.totp.scan',
  'settings2.totp.qrA11y',
  'settings2.totp.secret',
  'settings2.totp.code',
  'settings2.totp.verify',
  'settings2.totp.confirmBody',
  'settings2.totp.disableBody',
  'settings2.totp.passphrase',
  'settings2.totp.errStart',
  'settings2.totp.errCodeFormat',
  'settings2.totp.errCode',
  'settings2.totp.errPassphrase',
  'settings2.totp.errGeneric',
  'settings2.passphrase.title',
  'settings2.passphrase.current',
  'settings2.passphrase.next',
  'settings2.passphrase.nextHint',
  'settings2.passphrase.repeat',
  'settings2.passphrase.code',
  'settings2.passphrase.errMismatch',
  'settings2.passphrase.errShort',
  'settings2.passphrase.errCommon',
  'settings2.passphrase.errWrong',
  'settings2.passphrase.errCode',
  'settings2.passphrase.errGeneric',
  'settings2.wipe.title',
  'settings2.wipe.body',
  'settings2.wipe.confirm',
  'settings2.wipe.error',
];

/** Settings > Apariencia (AppearanceSection.tsx). */
const APPEARANCE = [
  'settings2.appearance.title',
  'settings2.appearance.style',
  'settings2.appearance.calma',
  'settings2.appearance.terminal',
  'settings2.appearance.sampleIn',
  'settings2.appearance.sampleMe',
  'settings2.appearance.mode',
  'settings2.appearance.light',
  'settings2.appearance.dark',
  'settings2.appearance.system',
  'settings2.appearance.accent',
  'settings2.appearance.accentBody',
  'settings2.appearance.accentChosen',
  'settings2.appearance.accentVerde',
  'settings2.appearance.accentAzul',
  'settings2.appearance.accentMorado',
  'settings2.appearance.accentNaranja',
  'settings2.appearance.previewIn',
  'settings2.appearance.previewMe',
  'settings2.appearance.previewButton',
  'settings2.appearance.scanLines',
  'settings2.appearance.scanLinesBody',
  'settings2.appearance.errSave',
];

const KEYS: string[] = [
  ...NOTIFICATION_CONTENT,
  ...PROFILE,
  ...QR,
  ...PRIVACY,
  ...NOTIFICATIONS,
  ...SECURITY,
  ...APPEARANCE,
];

const PLACEHOLDERS: Record<string, string[]> = {
  'settings2.profile.aboutCount': ['n'],
  'settings2.profile.sharedPending': ['n'],
  'settings2.privacy.unblockA11y': ['name'],
  'settings2.privacy.errUnblock': ['name'],
  'settings2.notif.volumeValue': ['n'],
  'settings2.security.autolockMinutes': ['n'],
  'settings2.passphrase.errShort': ['min'],
  'settings2.appearance.accentChosen': ['name'],
};

describe('settings strings', () => {
  it('have exactly the keys of their screens, in every language', () => {
    expectAreaContract(settings, { keys: KEYS, placeholders: PLACEHOLDERS });
  });

  it('say in Spanish what a notification shows', () => {
    expect(settings.es['settings2.notif.appName']).toBe('Trino Chat');
    expect(settings.es['settings2.notif.newMessage']).toBe('Nuevo mensaje');
  });

  // plan-cambios-11oct §6.1: the line of the board with the shared profile,
  // who does not get it yet, and the line of plan §1.5 without it.
  it('say in Spanish who gets your profile, as the plan fixed', () => {
    expect(settings.es['settings2.profile.shared']).toBe(
      'Tu nombre, tu foto y lo que escribas en «Sobre mí» les llegan cifrados a tus contactos y a tus grupos. Los servidores de Trino no los ven.',
    );
    expect(settings.es['settings2.profile.sharedPending']).toBe(
      'Todavía no les llega a {n} de tus contactos: les llegará cuando te escriban desde una versión nueva de Trino.',
    );
    expect(settings.es['settings2.profile.local']).toBe(
      'Tu foto y tu nombre se quedan en este equipo. Tus contactos te ven con el nombre que tenía tu código cuando te agregaron.',
    );
  });

  // plan §1.5: wipe asks no relay to delete anything.
  it('say in Spanish that what contacts got stays with them when you erase everything', () => {
    for (const key of ['settings2.security.wipeBody', 'settings2.wipe.body']) {
      expect(settings.es[key], key).toContain('Lo que tus contactos ya recibieron se queda en sus equipos.');
    }
  });

  // plan-cambios-11oct §4 W5 and §6.4: Privacidad names Cloudflare, which sees your IP.
  it('say in Spanish how calls protect your IP, as the plan fixed', () => {
    expect(settings.es['settings2.privacy.callsLine']).toBe(
      'Tus llamadas pasan por un servidor de Cloudflare: tu contacto no ve tu IP, pero Cloudflare sí. Si una llamada no se puede proteger, Trino te pregunta antes de llamar directo.',
    );
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
