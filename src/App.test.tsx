// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { type AppApi, type MainProps } from './App';
import type { ForgeResponse, StatusResponse, UnsealResponse } from './lib/api';
import type { WindowApi } from './screens/auth';

// How App() goes from reading the status to the chats and back (plan §4,
// I1): the phases of W1 with a fake backend and a stand-in for the chats.
// Nobody mocks `invoke`: App takes its backend, its window and its main
// screen as props, and the app passes the real ones.

const PASS = 'caballo-correcto-bateria';
const NO_VAULT: StatusResponse = {
  has_vault: false,
  is_unsealed: false,
  handle: null,
  nostr_pub: null,
  home_dir: 'C:/Users/rechita/.trino',
  totp_enabled: null,
};
const VAULT: StatusResponse = { ...NO_VAULT, has_vault: true, handle: 'Rechita', totp_enabled: false };
const UNSEALED: UnsealResponse = {
  handle: 'Rechita',
  fingerprint: 'f1f2f3f4',
  nostr_pub: 'c'.repeat(64),
  relay_connection_started: true,
};
const CREATED: ForgeResponse = { ...UNSEALED, bundle_json: JSON.stringify({ handle: 'Rechita', ik: 'AAAA', avatar: null }) };

/**
 * A backend whose `status` gives each answer in turn, an Error as a failure,
 * and the last one again once they run out. `calls` keeps the order of the
 * calls that matter for locking.
 */
function fakeApi(...answers: Array<StatusResponse | Error>) {
  const calls: string[] = [];
  let next = 0;
  const api = {
    status: vi.fn(() => {
      calls.push('status');
      const answer = answers[Math.min(next++, answers.length - 1)]!;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }),
    lockVault: vi.fn(() => {
      calls.push('lockVault');
      return Promise.resolve();
    }),
    setCallActive: vi.fn(() => Promise.resolve()),
    onCallCloseRequested: vi.fn(() => Promise.resolve(() => {})),
    onCallQuitRequested: vi.fn(() => Promise.resolve(() => {})),
    checkPassphrase: vi.fn(() => Promise.resolve()),
    totpBegin: vi.fn(() => Promise.reject(new Error('2FA is not set up in these tests'))),
    totpVerify: vi.fn(() => Promise.resolve(false)),
    createIdentity: vi.fn(() => Promise.resolve(CREATED)),
    updateProfile: vi.fn(() => Promise.resolve()),
    unseal: vi.fn(() => Promise.resolve(UNSEALED)),
    wipe: vi.fn(() => Promise.resolve()),
  } satisfies AppApi;
  return { ...api, calls };
}

const fakeWindow = (): WindowApi => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(() => Promise.resolve(false)),
});

/** The chats, as far as App is concerned: how the first run ended, and the lock. */
function FakeMain({ intent, onLock }: MainProps) {
  return (
    <section aria-label="Chats">
      <p>{`intent: ${intent}`}</p>
      <button type="button" onClick={onLock}>
        Bloquear ahora
      </button>
    </section>
  );
}

function renderApp(api: AppApi) {
  return render(<App api={api} windowApi={fakeWindow()} Main={FakeMain} />);
}

/** How long to wait for the next screen: generous, for a machine that builds Rust at the same time. */
const WAIT = { timeout: 5_000 };
const heading = (name: string) => screen.findByRole('heading', { level: 1, name }, WAIT);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function unlockWith(pass: string) {
  type('Contraseña', pass);
  click('Desbloquear');
  await screen.findByText('intent: chats', {}, WAIT);
}

beforeEach(() => {
  localStorage.setItem('lang', 'es');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('App', () => {
  it('goes to the first run when there is no identity on this device', async () => {
    const api = fakeApi(NO_VAULT);
    renderApp(api);
    expect(await heading('Te damos la bienvenida a Trino')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Minimizar' })).toBeTruthy();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('goes to the unlock screen when there is one, with its name and its code field', async () => {
    renderApp(fakeApi({ ...VAULT, totp_enabled: true }));
    expect(await heading('Hola de nuevo, Rechita')).toBeTruthy();
    expect(screen.getByText('Escribe tu contraseña para abrir tus chats.')).toBeTruthy();
    expect(screen.getByLabelText('Código de tu app autenticadora')).toBeTruthy();
  });

  it('shows the start-up error when the status cannot be read, and reads it again on retry', async () => {
    const api = fakeApi(new Error('the status could not be read'), NO_VAULT);
    renderApp(api);
    const alert = await screen.findByRole('alert', {}, WAIT);
    expect(alert.textContent).toBe('No se pudo abrir Trino. Inténtalo de nuevo.');
    click('Reintentar');
    expect(await heading('Te damos la bienvenida a Trino')).toBeTruthy();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  // The unlock screen shows the name and the code field as they are after
  // the lock, so the status is read again once the vault is locked.
  it('locks the vault and reads the status again on locking', async () => {
    const api = fakeApi(VAULT, { ...VAULT, handle: 'Rechi' });
    renderApp(api);
    await heading('Hola de nuevo, Rechita');
    await unlockWith(PASS);
    expect(api.unseal).toHaveBeenCalledWith(PASS, null);

    click('Bloquear ahora');
    expect(await heading('Hola de nuevo, Rechi')).toBeTruthy();
    expect(screen.getByText('Bloqueaste Trino.')).toBeTruthy();
    expect(screen.queryByText('intent: chats')).toBeNull();
    expect(api.calls).toEqual(['status', 'lockVault', 'status']);
  });

  it('opens the chats with the intent the first run ended with, without asking to unlock', async () => {
    const api = fakeApi(NO_VAULT);
    renderApp(api);
    await heading('Te damos la bienvenida a Trino');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tengo 18 años o más' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leí y acepto cómo Trino trata mis datos' }));
    click('Empezar');
    // The profile reaches the contacts (K12 is in), and the first run says so.
    expect(
      screen.getByText('Tu nombre va en tu código de contacto. Tu nombre y tu foto también les llegan cifrados a tus contactos.'),
    ).toBeTruthy();
    type('Nombre', 'Rechita');
    click('Continuar');
    type('Contraseña', PASS);
    type('Repite la contraseña', PASS);
    click('Continuar');
    await heading('Elige cómo se ve Trino');
    click('Continuar');
    click('Ahora no');
    await heading('Todo listo');
    expect(api.createIdentity).toHaveBeenCalledWith('Rechita', PASS, false);

    click('Agregar un contacto');
    expect(await screen.findByText('intent: add-contact', {}, WAIT)).toBeTruthy();
    expect(api.status).toHaveBeenCalledTimes(1);
    expect(api.unseal).not.toHaveBeenCalled();
  });

  it('wipes the identity and this device’s data, then starts the first run', async () => {
    localStorage.setItem('trino.consent', '{"format":1}');
    localStorage.setItem('verified:ana', 'ab12cd34');
    const api = fakeApi(VAULT);
    renderApp(api);
    await heading('Hola de nuevo, Rechita');
    click('¿Olvidaste la contraseña?');
    click('Borrar identidad y empezar de cero');
    const dialog = await screen.findByRole('alertdialog', {}, WAIT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar identidad y empezar de cero' }));

    expect(await heading('Te damos la bienvenida a Trino')).toBeTruthy();
    expect(api.wipe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('trino.consent')).toBeNull();
    expect(localStorage.getItem('verified:ana')).toBeNull();
  });

  // MC-1 (David, 11 Oct): no browser menu outside the text fields and none of
  // the browser's shortcuts, from the first screen on, and nothing left behind
  // once the app is gone. The cases are in src/app/browser-chrome.test.ts.
  it('takes the browser’s menu and shortcuts away, and keeps the menu of the text fields', async () => {
    const { unmount } = renderApp(fakeApi(VAULT));
    const title = await heading('Hola de nuevo, Rechita');
    const password = screen.getByLabelText('Contraseña');
    // fireEvent answers false once a listener cancelled what the browser does.
    expect(fireEvent.contextMenu(title)).toBe(false);
    expect(fireEvent.contextMenu(password)).toBe(true);
    expect(fireEvent.keyDown(password, { key: 'F5' })).toBe(false);
    expect(fireEvent.keyDown(title, { key: 'r', ctrlKey: true })).toBe(false);

    unmount();
    expect(fireEvent.contextMenu(document.body)).toBe(true);
    expect(fireEvent.keyDown(document.body, { key: 'F5' })).toBe(true);
  });
});
