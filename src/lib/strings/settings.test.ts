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

const KEYS: string[] = [...NOTIFICATION_CONTENT, ...PROFILE, ...QR, ...PRIVACY];

const PLACEHOLDERS: Record<string, string[]> = {
  'settings2.profile.aboutCount': ['n'],
  'settings2.profile.sharedPending': ['n'],
  'settings2.privacy.unblockA11y': ['name'],
  'settings2.privacy.errUnblock': ['name'],
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
