// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandError, CommandErrorCode, ForgeResponse, TotpBeginResponse } from '../../../lib/api';
import { toShareCode } from '../../../lib/contact-code';
import type { Lang } from '../../../lib/i18n';
import type { BridgesChecked, BridgesInfo, BridgesSet, FirstWay } from '../../../lib/net';
import type { OnboardingApi } from '../../types';
import { classesOf, fakeAppearanceHost, renderAuth, resetDocument } from '../test-harness';
import { CONSENT_STORAGE_KEY, PRIVACY_POLICY_URL, type ConsentStorage } from './consent';
import { OnboardingFlow } from './OnboardingFlow';

const PASS = 'caballo-correcto-bateria';
const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';
const NOW = Date.UTC(2026, 9, 11, 14, 3, 0);
const ENROLLMENT: TotpBeginResponse = {
  otpauth_uri: 'otpauth://totp/Trino:Rechita?secret=JBSWY3DPEHPK3PXP&issuer=Trino',
  secret_base32: 'JBSWY3DPEHPK3PXP',
};
const CREATED: ForgeResponse = {
  handle: 'Rechita',
  fingerprint: 'f1f2f3f4',
  nostr_pub: 'd'.repeat(64),
  relay_connection_started: true,
  prefs_import: 'pending',
  custom_data_dir: false,
  // A whole bundle, as forge returns it (own_bundle_json): a trino2 code
  // carries every key, so toShareCode gives '' for anything less (W4).
  bundle_json: JSON.stringify({
    handle: 'Rechita',
    idSig: 'd4'.repeat(64),
    ikDhPub: '8f'.repeat(32),
    ikSignPub: '3b'.repeat(32),
    nostrPub: 'a1'.repeat(32),
    opkId: null,
    opkPub: null,
    spkId: 7,
    spkPub: 'e7'.repeat(32),
    spkSig: '0f'.repeat(64),
  }),
};
const failure = (code: CommandErrorCode): CommandError => ({ code, message: 'for the log' });

function fakeApi(change: Partial<OnboardingApi> = {}): OnboardingApi {
  return {
    checkPassphrase: vi.fn(() => Promise.resolve()),
    totpBegin: vi.fn(() => Promise.resolve(ENROLLMENT)),
    totpVerify: vi.fn(() => Promise.resolve(true)),
    createIdentity: vi.fn(() => Promise.resolve(CREATED)),
    updateProfile: vi.fn(() => Promise.resolve()),
    ...change,
  };
}

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: ConsentStorage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
  return { storage, data };
}

interface SetupOptions {
  api?: OnboardingApi;
  profileSync?: boolean;
  makeAvatar?: (file: File) => Promise<string>;
  lang?: Lang;
}

function setup({ api = fakeApi(), profileSync, makeAvatar = vi.fn(() => Promise.resolve(PHOTO)), lang = 'es' }: SetupOptions = {}) {
  const consent = memoryStorage();
  const appearance = fakeAppearanceHost();
  const props = { onCreated: vi.fn(), onVaultExists: vi.fn(), openLink: vi.fn() };
  const view = renderAuth(
    <OnboardingFlow
      api={api}
      profileSync={profileSync}
      makeAvatar={makeAvatar}
      consentStorage={consent.storage}
      now={() => NOW}
      {...props}
    />,
    { lang, host: appearance.host },
  );
  return { api, makeAvatar, consent, appearance, container: view.container, ...props };
}

/** Lets the fake API's answers, and what they start, reach the screen. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
const heading = () => screen.getByRole('heading', { level: 1 });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const click = (name: string | RegExp) => fireEvent.click(button(name));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const tick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));
const alertText = () => screen.getByRole('alert').textContent;

function passWelcome() {
  tick('Tengo 18 años o más');
  tick('Leí y acepto cómo Trino trata mis datos');
  click('Empezar');
}
function passName(name = 'Rechita') {
  type('Nombre', name);
  click('Continuar');
}
async function passPassword() {
  type('Contraseña', PASS);
  type('Repite la contraseña', PASS);
  click('Continuar');
  await settle();
}
/** From the welcome step to the 2FA question. */
async function toTwofa() {
  passWelcome();
  passName();
  await passPassword();
  click('Continuar');
}

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDocument();
});

describe('OnboardingFlow, the whole way', () => {
  it('creates an identity without 2FA, step by step (Onboarding:56-200)', async () => {
    const { api, onCreated } = setup();
    expect(heading().textContent).toBe('Te damos la bienvenida a Trino');
    expect(screen.getByText('Paso 1 de 5')).toBeTruthy();
    passWelcome();
    expect(heading().textContent).toBe('¿Cómo quieres que te vean?');
    expect(screen.getByText('Paso 2 de 5')).toBeTruthy();
    passName();
    expect(heading().textContent).toBe('Crea una contraseña');
    await passPassword();
    expect(api.checkPassphrase).toHaveBeenCalledWith(PASS);
    expect(heading().textContent).toBe('Elige cómo se ve Trino');
    click('Continuar');
    expect(heading().textContent).toBe('Verificación en dos pasos (opcional)');
    expect(screen.getByText('Paso 5 de 5')).toBeTruthy();
    click('Ahora no');
    await settle();
    expect(api.createIdentity).toHaveBeenCalledWith('Rechita', PASS, false);
    expect(heading().textContent).toBe('Todo listo');
    expect(screen.queryByText(/^Paso/)).toBeNull();
    const code = toShareCode(CREATED.bundle_json);
    expect(code.startsWith('trino2:')).toBe(true);
    expect(screen.getByText(code)).toBeTruthy();
    expect(api.updateProfile).not.toHaveBeenCalled();
    click('Ir a mis chats');
    expect(onCreated).toHaveBeenCalledWith(CREATED, 'chats');
  });

  it('creates an identity with 2FA after a wrong code and a right one', async () => {
    const api = fakeApi({ totpVerify: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    const { onCreated } = setup({ api });
    await toTwofa();
    click('Activar');
    await settle();
    expect(api.totpBegin).toHaveBeenCalledWith('Rechita');
    const qr = screen.getByRole('img', { name: 'Código QR para tu app autenticadora' });
    expect(classesOf(qr)).toEqual(expect.arrayContaining(['bg-ui-qr-paper', 'text-ui-qr-ink', '[forced-color-adjust:none]']));
    expect(qr.querySelector('svg')).not.toBeNull();
    type('Código de 6 dígitos', '000 000');
    click('Comprobar');
    await settle();
    expect(api.totpVerify).toHaveBeenCalledWith('000000');
    expect(alertText()).toBe('El código no es correcto. Prueba con el que muestra ahora tu app.');
    expect(document.activeElement).toBe(screen.getByLabelText('Código de 6 dígitos'));
    type('Código de 6 dígitos', '482913');
    click('Comprobar');
    await settle();
    expect(api.createIdentity).toHaveBeenCalledWith('Rechita', PASS, true);
    expect(heading().textContent).toBe('Todo listo');
    click('Agregar un contacto');
    expect(onCreated).toHaveBeenCalledWith(CREATED, 'add-contact');
  });

  // The code the person scanned stays valid when they go back and come again.
  it('starts the 2FA enrollment once, and offers the key to type when scanning is not possible', async () => {
    const { api } = setup();
    await toTwofa();
    click('Activar');
    await settle();
    click('Volver sin activarla');
    expect(button('Activar')).toBeTruthy();
    click('Activar');
    await settle();
    expect(api.totpBegin).toHaveBeenCalledTimes(1);
    const manual = button('¿No puedes escanear? Escribe esta clave');
    expect(manual.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(manual);
    expect(manual.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(manual.getAttribute('aria-controls') ?? '')?.textContent).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('can go back from the 2FA question to the style (plan §1.8, 8), and from each step', async () => {
    setup();
    await toTwofa();
    click('Atrás');
    expect(heading().textContent).toBe('Elige cómo se ve Trino');
    click('Atrás');
    click('Atrás');
    click('Atrás');
    expect(heading().textContent).toBe('Te damos la bienvenida a Trino');
  });
});

describe('the two boxes of the welcome step', () => {
  // The parent's addendum: no account without "Tengo 18 años o más" and the
  // data authorization, both unticked at first.
  it('start unticked, and nothing goes on until both are ticked', () => {
    const { api } = setup();
    const age = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Tengo 18 años o más' });
    const privacy = screen.getByRole<HTMLInputElement>('checkbox', { name: 'Leí y acepto cómo Trino trata mis datos' });
    expect([age.checked, privacy.checked]).toEqual([false, false]);
    click('Empezar');
    expect(heading().textContent).toBe('Te damos la bienvenida a Trino');
    expect(alertText()).toBe('Para empezar, confirma que tienes 18 años o más y acepta cómo Trino trata tus datos.');
    expect(document.activeElement).toBe(age);
    expect([age.getAttribute('aria-invalid'), privacy.getAttribute('aria-invalid')]).toEqual(['true', 'true']);
    tick('Tengo 18 años o más');
    click('Empezar');
    expect(heading().textContent).toBe('Te damos la bienvenida a Trino');
    expect(document.activeElement).toBe(privacy);
    tick('Leí y acepto cómo Trino trata mis datos');
    expect(screen.queryByRole('alert')).toBeNull();
    click('Empezar');
    expect(heading().textContent).toBe('¿Cómo quieres que te vean?');
    expect(api.createIdentity).not.toHaveBeenCalled();
  });

  // Without an href (Tor design §4, R-10): the WebView has nothing to
  // resolve or follow; the browser opens it through openLink, which asks.
  it('link to the public document, opened in the system browser', () => {
    const { openLink } = setup();
    const link = screen.getByRole('link', { name: 'Leer cómo Trino trata tus datos' });
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.tabIndex).toBe(0);
    fireEvent.click(link);
    expect(openLink).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
    fireEvent.keyDown(link, { key: 'Enter' });
    expect(openLink).toHaveBeenCalledTimes(2);
  });

  it('leave a record with the date, the versions and the new public key', async () => {
    const { consent } = setup();
    await toTwofa();
    expect(consent.data.size).toBe(0);
    click('Ahora no');
    await settle();
    expect(JSON.parse(consent.data.get(CONSENT_STORAGE_KEY) ?? 'null')).toEqual({
      format: 1,
      acceptedAt: '2026-10-11T14:03:00.000Z',
      publicKey: CREATED.nostr_pub,
      lang: 'es',
      age: { minimum: 18, version: 1 },
      privacyPolicy: { version: 1, url: PRIVACY_POLICY_URL },
    });
  });
});

describe('the name and the photo', () => {
  it('takes 40 characters at most', () => {
    setup();
    passWelcome();
    type('Nombre', 'a'.repeat(41));
    click('Continuar');
    expect(heading().textContent).toBe('¿Cómo quieres que te vean?');
    expect(alertText()).toBe('Usa 40 caracteres como máximo.');
    expect(document.activeElement).toBe(screen.getByLabelText('Nombre'));
  });

  it('says how far the name and the photo go, with and without the shared profile (§6)', () => {
    setup();
    passWelcome();
    expect(screen.getByText(/Por ahora, tu foto solo se guarda en este equipo\./)).toBeTruthy();
    cleanup();
    setup({ profileSync: true });
    passWelcome();
    expect(
      screen.getByText('Tu nombre va en tu código de contacto. Tu nombre y tu foto también les llegan cifrados a tus contactos.'),
    ).toBeTruthy();
  });

  // makeAvatar (E0c) shrinks the picture to what the contacts can receive.
  it('passes the picture through makeAvatar, and saves it once the identity exists', async () => {
    const { api, makeAvatar, container } = setup();
    passWelcome();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/*');
    const file = new File(['x'], 'yo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });
    await settle();
    expect(makeAvatar).toHaveBeenCalledWith(file);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PHOTO);
    expect(button('Cambiar foto')).toBeTruthy();
    expect(button('Quitar foto')).toBeTruthy();
    passName();
    await passPassword();
    click('Continuar');
    click('Ahora no');
    await settle();
    expect(api.updateProfile).toHaveBeenCalledWith('Rechita', PHOTO);
  });

  // "Quitar foto" goes away with the photo it removes: the focus must not
  // fall to the page, where the next Tab starts again at the window bar.
  it('removes the photo, and hands the focus to "Agregar foto", which takes its place', async () => {
    const { container } = setup();
    passWelcome();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await settle();
    button('Quitar foto').focus();
    click('Quitar foto');
    expect(container.querySelector('img')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Quitar foto' })).toBeNull();
    expect(document.activeElement).toBe(button('Agregar foto'));
  });

  it('says when a picture cannot be used, and lets the person go on', async () => {
    const { container } = setup({ makeAvatar: vi.fn(() => Promise.reject(new Error('avatar: not a picture'))) });
    passWelcome();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    await settle();
    expect(alertText()).toBe('No se pudo usar esa imagen. Prueba con otra.');
    passName();
    expect(heading().textContent).toBe('Crea una contraseña');
  });

  it('says when the photo could not be saved, without blocking the way on', async () => {
    const api = fakeApi({ updateProfile: vi.fn(() => Promise.reject('vault sealed')) });
    const { container, onCreated } = setup({ api });
    passWelcome();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await settle();
    passName();
    await passPassword();
    click('Continuar');
    click('Ahora no');
    await settle();
    expect(heading().textContent).toBe('Todo listo');
    expect(screen.getByText(/no se pudo guardar tu foto/).closest('[role="status"]')).not.toBeNull();
    click('Ir a mis chats');
    expect(onCreated).toHaveBeenCalledWith(CREATED, 'chats');
  });
});

describe('the password', () => {
  it('rates the password in words and with a number of bars', () => {
    setup();
    passWelcome();
    passName();
    type('Contraseña', 'a'.repeat(15));
    const meter = screen.getByText('Fortaleza: buena');
    const bars = meter.parentElement?.querySelectorAll('[data-filled]') ?? [];
    expect(bars.length).toBe(3);
    expect(meter.parentElement?.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('stays on the step with the policy error, the meter weak', async () => {
    setup({ api: fakeApi({ checkPassphrase: vi.fn(() => Promise.reject(failure('passphrase_too_common'))) }) });
    passWelcome();
    passName();
    await passPassword();
    expect(heading().textContent).toBe('Crea una contraseña');
    expect(alertText()).toBe('Esa contraseña es muy común. Elige otra.');
    expect(screen.getByText('Fortaleza: débil')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Contraseña'));
  });

  it('says when the two passwords differ', async () => {
    setup();
    passWelcome();
    passName();
    type('Contraseña', PASS);
    type('Repite la contraseña', `${PASS}!`);
    click('Continuar');
    await settle();
    expect(alertText()).toBe('Las contraseñas no coinciden.');
    expect(document.activeElement).toBe(screen.getByLabelText('Repite la contraseña'));
  });
});

describe('what applies at once', () => {
  it('changes the language as soon as it is picked', () => {
    setup();
    fireEvent.click(screen.getByRole('radio', { name: 'English' }));
    expect(heading().textContent).toBe('Welcome to Trino');
    expect(screen.getByRole('checkbox', { name: 'I am 18 or older' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'English' }).getAttribute('lang')).toBe('en');
  });

  it('changes the style as soon as it is picked, and keeps it', async () => {
    const { appearance } = setup();
    passWelcome();
    passName();
    await passPassword();
    const terminal = screen.getByRole('radio', { name: 'Terminal' });
    expect(screen.getByRole('radiogroup', { name: 'Elige cómo se ve Trino' })).toBeTruthy();
    fireEvent.click(terminal);
    expect(terminal.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset.style).toBe('terminal');
    expect(JSON.parse(appearance.data.get('trino.appearance') ?? '{}').style).toBe('terminal');
  });

  it('moves the focus to the heading of each new step', () => {
    setup();
    expect(document.activeElement).toBe(heading());
    passWelcome();
    expect(document.activeElement).toBe(heading());
    click('Atrás');
    expect(document.activeElement).toBe(heading());
  });
});

describe('when creating the identity fails', () => {
  it('hands an identity that exists already to the parent', async () => {
    const { onVaultExists } = setup({ api: fakeApi({ createIdentity: vi.fn(() => Promise.reject(failure('vault_exists'))) }) });
    await toTwofa();
    click('Ahora no');
    await settle();
    expect(onVaultExists).toHaveBeenCalledTimes(1);
  });

  // A command that throws before it answers must not leave the flow waiting.
  it('treats a command that throws at once as a failed one', async () => {
    const createIdentity = vi.fn(() => {
      throw new Error('no backend');
    });
    setup({ api: fakeApi({ createIdentity }) });
    await toTwofa();
    click('Ahora no');
    await settle();
    expect(alertText()).toBe('No se pudo crear tu identidad. Inténtalo de nuevo.');
    expect((button('Ahora no') as HTMLButtonElement).disabled).toBe(false);
  });

  it('lets the person try again right there', async () => {
    const api = fakeApi({ createIdentity: vi.fn().mockRejectedValueOnce(failure('io')).mockResolvedValueOnce(CREATED) });
    setup({ api });
    await toTwofa();
    click('Ahora no');
    await settle();
    expect(alertText()).toBe('No se pudo crear tu identidad. Inténtalo de nuevo.');
    click('Ahora no');
    await settle();
    expect(heading().textContent).toBe('Todo listo');
  });
});

/**
 * Presses a button from the keyboard and leaves the focus where WebView2
 * does: the flow disables the button while it waits for the backend, and
 * Chromium then moves the focus off it to the page. jsdom keeps the focus on
 * a disabled control and cannot blur one, so the button is blurred just
 * before it is pressed.
 */
function pressAndLoseFocus(name: string) {
  const control = button(name) as HTMLButtonElement;
  control.focus();
  control.blur();
  fireEvent.click(control);
  expect(control.disabled).toBe(true);
  expect(document.activeElement).toBe(document.body);
}

/** The focus is on the message itself: an element that holds the alert and nothing else. */
function expectFocusOnMessage(message: string) {
  const alert = screen.getByRole('alert');
  expect(alert.textContent).toBe(message);
  const focused = document.activeElement;
  expect(focused).not.toBe(document.body);
  expect(focused?.contains(alert)).toBe(true);
  expect(focused?.textContent).toBe(message);
  expect(focused?.getAttribute('tabindex')).toBe('-1');
}

describe('after a failure about the whole step', () => {
  it('takes the focus to the message when "Ahora no" cannot create the identity', async () => {
    setup({ api: fakeApi({ createIdentity: vi.fn(() => Promise.reject(failure('io'))) }) });
    await toTwofa();
    pressAndLoseFocus('Ahora no');
    await settle();
    expectFocusOnMessage('No se pudo crear tu identidad. Inténtalo de nuevo.');
  });

  it('takes the focus to the message when "Activar" cannot set up two-step verification', async () => {
    setup({ api: fakeApi({ totpBegin: vi.fn(() => Promise.reject(failure('internal'))) }) });
    await toTwofa();
    pressAndLoseFocus('Activar');
    await settle();
    expectFocusOnMessage('No se pudo preparar la verificación en dos pasos. Inténtalo de nuevo.');
  });

  it('takes the focus to the message when the identity cannot be created after "Comprobar"', async () => {
    const { api } = setup({ api: fakeApi({ createIdentity: vi.fn(() => Promise.reject(failure('io'))) }) });
    await toTwofa();
    click('Activar');
    await settle();
    type('Código de 6 dígitos', '482913');
    pressAndLoseFocus('Comprobar');
    await settle();
    expect(api.createIdentity).toHaveBeenCalledWith('Rechita', PASS, true);
    expectFocusOnMessage('No se pudo crear tu identidad. Inténtalo de nuevo.');
  });

  // Choosing a picture disables nothing: the button that chose it keeps the focus.
  it('leaves the focus on the photo button when a picture cannot be used', async () => {
    const { container } = setup({ makeAvatar: vi.fn(() => Promise.reject(new Error('avatar: not a picture'))) });
    passWelcome();
    button('Agregar foto').focus();
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.gif', { type: 'image/gif' })] } });
    await settle();
    expect(alertText()).toBe('No se pudo usar esa imagen. Prueba con otra.');
    expect(document.activeElement).toBe(button('Agregar foto'));
  });
});

describe('"Todo listo"', () => {
  async function done() {
    setup();
    await toTwofa();
    click('Ahora no');
    await settle();
  }

  it('shows the code as a QR in a dialog, black on white in every theme', async () => {
    await done();
    click('Mostrar QR');
    const dialog = screen.getByRole('dialog', { name: 'Tu código QR' });
    const qr = within(dialog).getByRole('img', { name: 'Código QR de tu código de contacto' });
    expect(classesOf(qr)).toEqual(expect.arrayContaining(['bg-ui-qr-paper', '[forced-color-adjust:none]']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('copies the code', async () => {
    await done();
    click('Copiar');
    await settle();
    expect(writeText).toHaveBeenCalledWith(toShareCode(CREATED.bundle_json));
    expect(button('Copiado')).toBeTruthy();
  });
});

it('never writes the password to the console', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  const api = fakeApi({
    checkPassphrase: vi.fn().mockRejectedValueOnce(failure('passphrase_too_common')).mockResolvedValue(undefined),
    createIdentity: vi.fn().mockRejectedValueOnce(failure('internal')).mockResolvedValueOnce(CREATED),
  });
  setup({ api });
  passWelcome();
  passName();
  await passPassword();
  await passPassword();
  click('Continuar');
  click('Ahora no');
  await settle();
  click('Ahora no');
  await settle();
  const written = spies.flatMap(spy => spy.mock.calls.flat().map(value => JSON.stringify(value) ?? String(value)));
  expect(written.filter(text => text.includes(PASS))).toEqual([]);
  expect(heading().textContent).toBe('Todo listo');
});

// TOR-6 (PropTorSimple, card 1; design test 50): Tor starts only from the
// "Conexión" step, after the welcome, with the provider option if ticked.
describe('OnboardingFlow: the connection step', () => {
  const OPTION = 'No quiero que mi proveedor note que uso Trino';

  it('comes after the welcome, explains Tor once, and starts it only on "Continuar"', async () => {
    const startConnection = vi.fn((_way: FirstWay) => Promise.resolve());
    setup({ api: fakeApi({ startConnection }) });
    expect(screen.getByText('Paso 1 de 6')).toBeTruthy();
    passWelcome();
    expect(heading().textContent).toBe('Trino se conecta de forma privada');
    expect(document.activeElement).toBe(heading());
    expect(screen.getByText('Paso 2 de 6')).toBeTruthy();
    expect(
      screen.getByText(
        'Usa Tor: tus mensajes dan varias vueltas por internet antes de llegar, para que los servidores no vean desde dónde te conectas. La primera vez puede tardar un poco.',
      ),
    ).toBeTruthy();
    const option = screen.getByRole('checkbox', {
      name: OPTION,
      description: 'Trino entra por otra puerta, más difícil de notar. Conectarse tarda más: de 1 a 2 minutos la primera vez.',
    }) as HTMLInputElement;
    expect(option.checked).toBe(false);
    expect(startConnection).not.toHaveBeenCalled();

    click('Continuar');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'none' }]]);
    expect(heading().textContent).not.toBe('Trino se conecta de forma privada');
    expect(screen.getByText('Paso 3 de 6')).toBeTruthy();
  });

  it('starts it through the hidden way when the person asks for it', async () => {
    const startConnection = vi.fn((_way: FirstWay) => Promise.resolve());
    setup({ api: fakeApi({ startConnection }) });
    passWelcome();
    tick(OPTION);
    click('Continuar');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'builtin', transport: 'snowflake' }]]);
  });

  it('says so when it could not start, and stays on the step', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const startConnection = vi.fn((_way: FirstWay) => Promise.reject(failure('internal')));
    setup({ api: fakeApi({ startConnection }) });
    passWelcome();
    click('Continuar');
    await settle();
    expect(alertText()).toBe('No se pudo empezar a conectar. Vuelve a intentar.');
    expect(heading().textContent).toBe('Trino se conecta de forma privada');
  });

  it('goes back to the welcome', () => {
    setup({ api: fakeApi({ startConnection: vi.fn(() => Promise.resolve()) }) });
    passWelcome();
    expect(screen.queryByRole('button', { name: 'En mi red bloquean Tor' })).toBeNull();
    click('Atrás');
    expect(screen.getByRole('checkbox', { name: 'Tengo 18 años o más' })).toBeTruthy();
  });
});

// TOR-8 (PropTorSimple, cards 1 and 4): "En mi red bloquean Tor" opens the
// other ways inside the step. A way chosen there is what "Continuar"
// starts, and the provider option follows it; the search starts at once.
describe('OnboardingFlow: the other ways from the connection step', () => {
  const OPTION = 'No quiero que mi proveedor note que uso Trino';
  const INFO: BridgesInfo = { transport: 'none', private: null, lines: 0, start: 'open', program: true, builtin: ['snowflake', 'obfs4'] };

  function withBridges() {
    const startConnection = vi.fn((_way: FirstWay) => Promise.resolve());
    const bridges = {
      info: vi.fn(async () => INFO),
      check: vi.fn(async (_text: string): Promise<BridgesChecked> => ({ lines: 1, errors: [] })),
      keepCode: vi.fn(async (_text: string): Promise<BridgesSet> => ({ saved: true, errors: [], status: { state: 'off' } })),
    };
    setup({ api: fakeApi({ startConnection, bridges }) });
    passWelcome();
    return { startConnection, bridges };
  }

  async function openWays() {
    click('En mi red bloquean Tor');
    await settle();
    expect(heading().textContent).toBe('Otra forma de conectarse');
    expect(document.activeElement).toBe(heading());
  }

  it('opens them in the step, closed under "Opciones avanzadas", and goes back to the step', async () => {
    const { startConnection } = withBridges();
    await openWays();
    expect(screen.getByRole('button', { name: 'Buscar una forma que funcione aquí' })).toBeTruthy();
    expect(button('Opciones avanzadas').getAttribute('aria-expanded')).toBe('false');
    click('Volver');
    expect(heading().textContent).toBe('Trino se conecta de forma privada');
    expect(document.activeElement).toBe(heading());
    await openWays();
    click('Atrás');
    expect(heading().textContent).toBe('Trino se conecta de forma privada');
    expect(startConnection).not.toHaveBeenCalled();
  });

  it('starts nothing while a way is chosen, then "Continuar" starts that way, with the option ticked', async () => {
    const { startConnection, bridges } = withBridges();
    await openWays();
    click('Opciones avanzadas');
    fireEvent.click(screen.getByRole('radio', { name: 'obfs4 (integrado)' }));
    expect(startConnection).not.toHaveBeenCalled();
    expect(bridges.keepCode).not.toHaveBeenCalled();
    click('Volver');
    expect((screen.getByRole('checkbox', { name: OPTION }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Forma elegida: obfs4.')).toBeTruthy();
    click('Continuar');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'builtin', transport: 'obfs4' }]]);
  });

  it('unticking the option goes back to no bridge', async () => {
    const { startConnection } = withBridges();
    await openWays();
    click('Opciones avanzadas');
    fireEvent.click(screen.getByRole('radio', { name: 'obfs4 (integrado)' }));
    click('Volver');
    tick(OPTION);
    expect(screen.queryByText('Forma elegida: obfs4.')).toBeNull();
    click('Continuar');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'none' }]]);
  });

  it('keeps a pasted code for the first connection, then starts with it', async () => {
    const { startConnection, bridges } = withBridges();
    await openWays();
    click('Opciones avanzadas');
    fireEvent.click(screen.getByRole('radio', { name: 'Tengo un código de conexión que me dieron' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pega aquí el código' }), { target: { value: 'obfs4 192.0.2.10:443 …' } });
    click('Usar este código');
    await settle();
    expect(bridges.keepCode.mock.calls).toEqual([['obfs4 192.0.2.10:443 …']]);
    expect(screen.getByText('Código guardado.')).toBeTruthy();
    click('Volver');
    expect(screen.getByText('Forma elegida: Con un código.')).toBeTruthy();
    click('Continuar');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'private' }]]);
  });

  it('"Buscar una forma que funcione aquí" starts the search at once and goes on to the name', async () => {
    const { startConnection } = withBridges();
    await openWays();
    click('Buscar una forma que funcione aquí');
    await settle();
    expect(startConnection.mock.calls).toEqual([[{ kind: 'search' }]]);
    expect(screen.getByText('Paso 3 de 6')).toBeTruthy();
  });
});
