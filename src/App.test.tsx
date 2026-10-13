// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App, { type AppApi, type MainProps } from './App';
import type { CallGate } from './app/calls';
import type {
  ForgeResponse,
  IntegrityReport,
  LegacyPreview,
  SessionLockReason,
  StatusResponse,
  UnsealResponse,
} from './lib/api';
import { prefs } from './lib/prefs';
import { prefsSession, type PrefsImported, type PrefsMap } from './lib/prefs-session';
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
  prefs_import: 'done',
  custom_data_dir: false,
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
  /**
   * What the backend's `call-close-requested`, `call-quit-requested`,
   * `vault-locked` and `lock-requested` reach.
   */
  const requested: {
    close: (() => void) | null;
    quit: (() => void) | null;
    vaultLocked: ((reason: SessionLockReason) => void) | null;
    lock: (() => void) | null;
  } = { close: null, quit: null, vaultLocked: null, lock: null };
  const api = {
    status: vi.fn(() => {
      calls.push('status');
      const answer = answers[Math.min(next++, answers.length - 1)]!;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }),
    lockVault: vi.fn((_reason?: SessionLockReason) => {
      calls.push('lockVault');
      return Promise.resolve();
    }),
    setCallActive: vi.fn((_active: boolean) => Promise.resolve()),
    onCallCloseRequested: vi.fn((cb: () => void) => {
      requested.close = cb;
      return Promise.resolve(() => {});
    }),
    onCallQuitRequested: vi.fn((cb: () => void) => {
      requested.quit = cb;
      return Promise.resolve(() => {});
    }),
    onVaultLocked: vi.fn((cb: (reason: SessionLockReason) => void) => {
      requested.vaultLocked = cb;
      return Promise.resolve(() => {});
    }),
    onLockRequested: vi.fn((cb: () => void) => {
      requested.lock = cb;
      return Promise.resolve(() => {});
    }),
    checkPassphrase: vi.fn(() => Promise.resolve()),
    totpBegin: vi.fn(() => Promise.reject(new Error('2FA is not set up in these tests'))),
    totpVerify: vi.fn(() => Promise.resolve(false)),
    createIdentity: vi.fn(() => Promise.resolve(CREATED)),
    updateProfile: vi.fn(() => Promise.resolve()),
    unseal: vi.fn((_pass: string, _code?: string | null) => Promise.resolve(UNSEALED)),
    wipe: vi.fn(() => Promise.resolve()),
    prefsSave: vi.fn((_prefs: PrefsMap) => {
      calls.push('prefsSave');
      return Promise.resolve();
    }),
    prefsImport: vi.fn(
      (entries: PrefsMap): Promise<PrefsImported> => Promise.resolve({ taken: entries, saved: true, notes: 0 }),
    ),
    clearBrowsingData: vi.fn(() => Promise.resolve()),
    prefsGet: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    storeChoose: vi.fn((_file: string, _useIt: boolean): Promise<IntegrityReport> => Promise.resolve({ findings: [] })),
    legacyFilesPreview: vi.fn(
      (): Promise<LegacyPreview> =>
        Promise.resolve({ handle: null, contacts: [], blocked: 0, groups: [], invitations: 0, conversations: 0, stickers: 0, unreadable: [] }),
    ),
    legacyFilesImport: vi.fn((): Promise<IntegrityReport> => Promise.resolve({ findings: [] })),
    legacyFilesRemove: vi.fn((): Promise<IntegrityReport> => Promise.resolve({ findings: [] })),
  } satisfies AppApi;
  return { ...api, calls, requested };
}

const fakeWindow = (): WindowApi => ({
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(() => Promise.resolve(false)),
});

/** The gate of the chats' calls (src/app/calls.tsx) in the tests of a call in progress; null otherwise. */
let callGate: CallGate | null = null;

/**
 * The chats, as far as App is concerned: how the first run ended, the lock,
 * a new auto-lock time saved as Settings saves it, Settings' wipe once the
 * backend erased the identity, and the gate of their calls.
 */
function FakeMain({ intent, onLock, onAutolockChanged, onWiped, onCallGate }: MainProps) {
  useEffect(() => {
    onCallGate?.(callGate);
    return () => onCallGate?.(null);
  }, [onCallGate]);
  // What the chats read as they open: the first message's timer and the
  // first notification's level (design §12.5, test 65).
  const [first] = useState(() => `ttl: ${prefs.getTtl('Ana')}, preview: ${prefs.getNotifPreview()}`);
  return (
    <section aria-label="Chats">
      <p>{`intent: ${intent}`}</p>
      <p>{first}</p>
      <button type="button" onClick={() => prefs.setNote('Ana', 'Vecina del 3')}>
        Guardar nota
      </button>
      <button type="button" onClick={onLock}>
        Bloquear ahora
      </button>
      <button type="button" onClick={() => onWiped?.()}>
        Borrar todo de este equipo
      </button>
      <button
        type="button"
        onClick={() => {
          prefs.setAutolockMinutes(1);
          onAutolockChanged?.(1);
        }}
      >
        Bloqueo automático al minuto
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

/** The chats are on screen, and their effects ran, as they have before anyone can click. */
async function chatsOpen() {
  await screen.findByText('intent: chats', {}, WAIT);
  await act(async () => {});
}

async function unlockWith(pass: string) {
  type('Contraseña', pass);
  click('Desbloquear');
  await chatsOpen();
}

const MINUTE = 60_000;
/**
 * Fake clocks for the auto-lock, which still move with real time so the
 * screens' promises and the waits of these tests go on as usual.
 */
const fakeClock = () =>
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true });
/** Minutes go by without anybody touching the app. */
const idle = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  localStorage.setItem('lang', 'es');
});
afterEach(() => {
  cleanup();
  prefsSession.discard();
  callGate = null;
  vi.useRealTimers();
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

  // David's decision 1 (design §11.3, test 43): "Hola de nuevo" without the
  // name, even when the status has one, as after a reload of the window.
  it('goes to the unlock screen when there is one, greeting without a name, with its code field', async () => {
    renderApp(fakeApi({ ...VAULT, is_unsealed: true, totp_enabled: true }));
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Rechita|RE/);
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

  // The unlock screen shows the code field as it is after the lock, so the
  // status is read again once the vault is locked.
  it('locks the vault and reads the status again on locking', async () => {
    const api = fakeApi(VAULT, { ...VAULT, handle: 'Rechi' });
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);
    expect(api.unseal).toHaveBeenCalledWith(PASS, null);

    click('Bloquear ahora');
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Bloqueaste Trino.')).toBeTruthy();
    expect(screen.queryByText('intent: chats')).toBeNull();
    expect(api.calls).toEqual(['status', 'lockVault', 'status']);
    // The backend keeps why, for the window it opens after the lock (CL-6a).
    expect(api.lockVault).toHaveBeenCalledWith({ kind: 'manual' });
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
    await heading('Hola de nuevo');
    click('¿Olvidaste la contraseña?');
    click('Borrar identidad y empezar de cero');
    const dialog = await screen.findByRole('alertdialog', {}, WAIT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar identidad y empezar de cero' }));

    expect(await heading('Te damos la bienvenida a Trino')).toBeTruthy();
    expect(api.wipe).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('trino.consent')).toBeNull();
    expect(localStorage.getItem('verified:ana')).toBeNull();
  });

  // Settings > "Borrar todo de este equipo" (I2) with the chats open: the
  // backend erased the identity, and App clears what this device keeps, as
  // the old settings modal did, then starts the first run.
  it('starts the first run once Settings erased the identity, without this device’s data', async () => {
    localStorage.setItem('trino.consent', '{"format":1}');
    localStorage.setItem('verified:ana', 'ab12cd34');
    localStorage.setItem('note:ana', 'la del trabajo');
    const api = fakeApi(VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    click('Borrar todo de este equipo');
    expect(await heading('Te damos la bienvenida a Trino')).toBeTruthy();
    expect(screen.queryByText('intent: chats')).toBeNull();
    expect(localStorage.getItem('trino.consent')).toBeNull();
    expect(localStorage.getItem('verified:ana')).toBeNull();
    expect(localStorage.getItem('note:ana')).toBeNull();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  // Settings says "También con Ctrl + L." and lists the shortcut. It locks
  // from anywhere in the chats, asking first during a call like "Bloquear".
  it('locks with Ctrl+L from the chats', async () => {
    const api = fakeApi(VAULT, { ...VAULT, handle: 'Rechi' });
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    expect(fireEvent.keyDown(screen.getByText('intent: chats'), { key: 'l', ctrlKey: true })).toBe(false);
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Bloqueaste Trino.')).toBeTruthy();
    expect(api.calls).toEqual(['status', 'lockVault', 'status']);
  });

  // The redesigned shell (I6) has a Ctrl+L of its own, and AltGr is Ctrl+Alt.
  it('leaves Ctrl+L alone before the chats, once a screen took it, and with Alt', async () => {
    const api = fakeApi(VAULT);
    renderApp(api);
    const title = await heading('Hola de nuevo');
    fireEvent.keyDown(title, { key: 'l', ctrlKey: true });
    await unlockWith(PASS);

    const chats = screen.getByText('intent: chats');
    const taken = (event: KeyboardEvent) => event.preventDefault();
    chats.addEventListener('keydown', taken);
    fireEvent.keyDown(chats, { key: 'l', ctrlKey: true });
    chats.removeEventListener('keydown', taken);
    fireEvent.keyDown(chats, { key: 'l', ctrlKey: true, altKey: true });
    fireEvent.keyDown(chats, { key: 'l' });

    expect(screen.getByText('intent: chats')).toBeTruthy();
    expect(api.lockVault).not.toHaveBeenCalled();
  });

  // The auto-lock (useAutoLock): src/app/useAutoLock.test.ts has its cases.
  // The minutes are the account's, in the store (CL-2a).
  it('locks after the minutes saved for the account, and says why', async () => {
    fakeClock();
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({ ...UNSEALED, prefs: { autolock: '1' } });
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    await idle(MINUTE);
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Trino se bloqueó tras 1 minuto sin actividad.')).toBeTruthy();
    expect(api.lockVault).toHaveBeenCalledWith({ kind: 'idle', minutes: 1 });
  });

  // A beta tester: "automatic lock... no funciona". App read the setting only
  // when the chats opened, so a new time waited for the next unlock.
  it('applies a new auto-lock time at once, without locking and unlocking', async () => {
    fakeClock();
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({ ...UNSEALED, prefs: { autolock: '15' } });
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    click('Bloqueo automático al minuto');
    await idle(MINUTE);
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Trino se bloqueó tras 1 minuto sin actividad.')).toBeTruthy();
  });

  it('goes back to the 5 minutes of a new device after a wipe', async () => {
    fakeClock();
    localStorage.setItem('autolock', '1');
    renderApp(fakeApi(VAULT));
    await heading('Hola de nuevo');
    click('¿Olvidaste la contraseña?');
    click('Borrar identidad y empezar de cero');
    const dialog = await screen.findByRole('alertdialog', {}, WAIT);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar identidad y empezar de cero' }));
    await heading('Te damos la bienvenida a Trino');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tengo 18 años o más' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leí y acepto cómo Trino trata mis datos' }));
    click('Empezar');
    type('Nombre', 'Rechita');
    click('Continuar');
    type('Contraseña', PASS);
    type('Repite la contraseña', PASS);
    click('Continuar');
    await heading('Elige cómo se ve Trino');
    click('Continuar');
    click('Ahora no');
    await heading('Todo listo');
    click('Ir a mis chats');
    await chatsOpen();

    await idle(4 * MINUTE);
    expect(screen.getByText('intent: chats')).toBeTruthy();
    await idle(MINUTE);
    expect(await screen.findByText('Trino se bloqueó tras 5 minutos sin actividad.', {}, WAIT)).toBeTruthy();
  });

  // MC-1 (David, 11 Oct): no browser menu outside the text fields and none of
  // the browser's shortcuts, from the first screen on, and nothing left behind
  // once the app is gone. The cases are in src/app/browser-chrome.test.ts.
  it('takes the browser’s menu and shortcuts away, and keeps the menu of the text fields', async () => {
    const { unmount } = renderApp(fakeApi(VAULT));
    const title = await heading('Hola de nuevo');
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

  // I7: the old theme is gone with the old screens. <html> takes the app's
  // language before the first paint and, besides it, only what the redesign's
  // appearance puts there (src/design/apply.ts): never the old data-theme or
  // its --color-* variables, which nothing reads any more.
  it('puts its language on <html>, and nothing of the old theme', async () => {
    const root = document.documentElement;
    root.removeAttribute('data-theme');
    root.removeAttribute('style');
    root.setAttribute('lang', 'en'); // what index.html ships
    renderApp(fakeApi(NO_VAULT));
    await heading('Te damos la bienvenida a Trino');
    expect(root.getAttribute('lang')).toBe('es');
    expect(root.hasAttribute('data-theme')).toBe(false);
    const variables = Array.from({ length: root.style.length }, (_, index) => root.style.item(index));
    expect(variables.filter(name => name.startsWith('--color-'))).toEqual([]);
  });
});

// Cifrado local CL-2a (design §5.3 and §12.5): the account's preferences come
// with the unlock, before the chats, and go back to the store.
describe("App and the account's preferences", () => {
  // Design §12.5, test 65: no message leaves without its timer and no
  // notification has the default level because the chats came first.
  it('opens the chats with the preferences of the unlock answer already in place', async () => {
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({ ...UNSEALED, prefs: { 'ttl:Ana': '30', 'trino.pref.notifPreview': 'none' } });
    renderApp(api);
    await heading('Hola de nuevo');

    await unlockWith(PASS);

    expect(screen.getByText('ttl: 30, preview: none')).toBeTruthy();
  });

  // Design §12.5, tests 40 and 41: the import waits for the store before the
  // chats, and the WebView keeps only the screen's own settings.
  it('imports the WebView’s copy before the chats show, then clears it', async () => {
    localStorage.setItem('ttl:Ana', '60');
    localStorage.setItem('note:Ana', 'Vecina del 3');
    localStorage.setItem('trino.appearance', '{"style":"calma"}');
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({ ...UNSEALED, prefs_import: 'pending' });
    let answer: (imported: PrefsImported) => void = () => {};
    api.prefsImport.mockImplementation(() => new Promise(resolve => (answer = resolve)));
    renderApp(api);
    await heading('Hola de nuevo');

    type('Contraseña', PASS);
    click('Desbloquear');
    await vi.waitFor(() => expect(api.prefsImport).toHaveBeenCalledTimes(1), WAIT);
    expect(api.prefsImport).toHaveBeenCalledWith({ 'ttl:Ana': '60', 'note:Ana': 'Vecina del 3' });
    expect(screen.queryByText('intent: chats')).toBeNull();
    await act(async () => answer({ taken: { 'ttl:Ana': '60', 'note:Ana': 'Vecina del 3' }, saved: true, notes: 1 }));
    await chatsOpen();

    expect(screen.getByText('ttl: 60, preview: name')).toBeTruthy();
    expect(prefs.getNote('Ana')).toBe('Vecina del 3');
    expect(localStorage.getItem('ttl:Ana')).toBeNull();
    expect(localStorage.getItem('note:Ana')).toBeNull();
    await vi.waitFor(() => expect(api.clearBrowsingData).toHaveBeenCalledTimes(1), WAIT);
    expect(localStorage.getItem('lang')).toBe('es');
    expect(localStorage.getItem('trino.appearance')).toBe('{"style":"calma"}');
  });

  // Part 1's error path: an account whose migration stopped before its commit.
  it('keeps them in the WebView for an account that has not moved to the store yet', async () => {
    localStorage.setItem('ttl:Ana', '30');
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({ ...UNSEALED, prefs_import: 'unavailable' });
    renderApp(api);
    await heading('Hola de nuevo');

    await unlockWith(PASS);
    click('Guardar nota');

    expect(screen.getByText('ttl: 30, preview: name')).toBeTruthy();
    expect(localStorage.getItem('note:Ana')).toBe('Vecina del 3');
    expect(api.prefsImport).not.toHaveBeenCalled();
    expect(api.prefsSave).not.toHaveBeenCalled();
  });

  it('sends a change before the vault locks, then forgets them', async () => {
    const api = fakeApi(VAULT, VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    click('Guardar nota');
    click('Bloquear ahora');
    await heading('Hola de nuevo');

    expect(api.calls).toEqual(['status', 'prefsSave', 'lockVault', 'status']);
    expect(api.prefsSave).toHaveBeenCalledWith({ 'note:Ana': 'Vecina del 3' });
    expect(prefs.getNote('Ana')).toBe('');
    expect(localStorage.getItem('note:Ana')).toBeNull();
  });

  it('forgets them without saving once Settings erased the identity', async () => {
    const api = fakeApi(VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    click('Guardar nota');
    click('Borrar todo de este equipo');
    await heading('Te damos la bienvenida a Trino');
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(api.prefsSave).not.toHaveBeenCalled();
    expect(prefs.getNote('Ana')).toBe('');
  });

  // Design §12.5, test 42 (H5): the record of the two boxes, with the new
  // identity's key, goes to the store with the account's preferences.
  it('keeps the record of the two boxes with the account, not in the WebView', async () => {
    const api = fakeApi(NO_VAULT);
    api.createIdentity.mockResolvedValue({ ...CREATED, prefs_import: 'pending' });
    renderApp(api);
    await heading('Te damos la bienvenida a Trino');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Tengo 18 años o más' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Leí y acepto cómo Trino trata mis datos' }));
    click('Empezar');
    type('Nombre', 'Rechita');
    click('Continuar');
    type('Contraseña', PASS);
    type('Repite la contraseña', PASS);
    click('Continuar');
    await heading('Elige cómo se ve Trino');
    click('Continuar');
    click('Ahora no');
    await heading('Todo listo');

    expect(localStorage.getItem('trino.consent')).toBeNull();
    await vi.waitFor(() => expect(api.prefsSave).toHaveBeenCalled(), WAIT);
    const saved = api.prefsSave.mock.calls[api.prefsSave.mock.calls.length - 1]![0];
    expect(JSON.parse(saved['trino.consent']!)).toMatchObject({ format: 1, publicKey: CREATED.nostr_pub });
  });
});

// Cifrado local CL-2b (design §6.2 and §11.5): the one dialog at unlock and
// the one note after the migration come before the chats.
describe('App and what the store found', () => {
  const OLDER_ACCOUNT: UnsealResponse = {
    ...UNSEALED,
    integrity: { findings: [{ file: 'account', what: 'olderCopy', action: 'ask' }] },
  };

  it('asks about a file that changed before the chats, and opens them once answered', async () => {
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue(OLDER_ACCOUNT);
    renderApp(api);
    await heading('Hola de nuevo');
    type('Contraseña', PASS);
    click('Desbloquear');

    expect(await heading('Algunos archivos de Trino cambiaron')).toBeTruthy();
    expect(screen.queryByText('intent: chats')).toBeNull();
    expect(api.storeChoose).not.toHaveBeenCalled();
    click('Usar esa copia');
    await vi.waitFor(() => expect(api.storeChoose).toHaveBeenCalledWith('account', true), WAIT);
    fireEvent.click(await screen.findByRole('button', { name: 'Entendido' }, WAIT));
    await chatsOpen();
  });

  // "Usar esa copia" for prefs.bin: the chats open with the copy chosen.
  it('opens the chats with the preferences chosen in the dialog', async () => {
    const api = fakeApi(VAULT);
    api.unseal.mockResolvedValue({
      ...UNSEALED,
      integrity: { findings: [{ file: 'prefs', what: 'olderCopy', action: 'ask' }] },
    });
    api.prefsGet.mockResolvedValue({ 'ttl:Ana': '30', 'trino.pref.notifPreview': 'none' });
    renderApp(api);
    await heading('Hola de nuevo');
    type('Contraseña', PASS);
    click('Desbloquear');
    await heading('Algunos archivos de Trino cambiaron');

    click('Usar esa copia');
    fireEvent.click(await screen.findByRole('button', { name: 'Entendido' }, WAIT));
    await chatsOpen();
    expect(screen.getByText('ttl: 30, preview: none')).toBeTruthy();
  });

  // Design test 45: once, with the notes the import of the WebView took.
  it('shows the note after the migration once, with what it encrypted', async () => {
    localStorage.setItem('note:Ana', 'Vecina del 3');
    const api = fakeApi(VAULT, VAULT);
    api.unseal
      .mockResolvedValueOnce({ ...UNSEALED, prefs_import: 'pending', migration: { contacts: 2, groups: 1, stickers: 0 } })
      .mockResolvedValue(UNSEALED);
    api.prefsImport.mockImplementation(entries => Promise.resolve({ taken: entries, saved: true, notes: 1 }));
    renderApp(api);
    await heading('Hola de nuevo');
    type('Contraseña', PASS);
    click('Desbloquear');

    expect(await heading('Tus datos en este equipo ya están cifrados')).toBeTruthy();
    expect(
      screen.getByText(
        'Trino cifró con tu contraseña tu perfil, tus contactos (2), tus grupos (1), tus notas (1) y tus stickers (0), como ya hacía con tus chats.',
      ),
    ).toBeTruthy();
    click('Entendido');
    await chatsOpen();

    click('Bloquear ahora');
    await heading('Hola de nuevo');
    await unlockWith(PASS);
    expect(screen.queryByText('Tus datos en este equipo ya están cifrados')).toBeNull();
  });

  // The session is open while the dialog waits: Ctrl+L and the auto-lock
  // close it as they do from the chats.
  it('locks from the dialog, as from the chats', async () => {
    const api = fakeApi(VAULT, VAULT);
    api.unseal.mockResolvedValue(OLDER_ACCOUNT);
    renderApp(api);
    await heading('Hola de nuevo');
    type('Contraseña', PASS);
    click('Desbloquear');
    const title = await heading('Algunos archivos de Trino cambiaron');

    fireEvent.keyDown(title, { key: 'l', ctrlKey: true });
    await heading('Hola de nuevo');
    expect(screen.getByText('Bloqueaste Trino.')).toBeTruthy();
    expect(api.calls).toEqual(['status', 'lockVault', 'status']);
    expect(api.storeChoose).not.toHaveBeenCalled();
  });

  it('locks after the minutes saved for the account while the dialog waits', async () => {
    fakeClock();
    const api = fakeApi(VAULT, VAULT);
    api.unseal.mockResolvedValue({ ...OLDER_ACCOUNT, prefs: { autolock: '1' } });
    renderApp(api);
    await heading('Hola de nuevo');
    type('Contraseña', PASS);
    click('Desbloquear');
    await heading('Algunos archivos de Trino cambiaron');

    await idle(MINUTE + 20_000);
    await heading('Hola de nuevo');
    expect(screen.getByText('Trino se bloqueó tras 1 minuto sin actividad.')).toBeTruthy();
  });
});

// Cifrado local CL-6a (design §7.2): every lock renews the window, so the
// one that opens after it reads why from the status; and the backend locks
// by itself when Windows locks or sleeps, or from the tray.
describe('App and the locks of the backend', () => {
  it.each([
    [{ kind: 'system', cause: 'session' }, 'Trino se bloqueó porque bloqueaste Windows.'],
    [{ kind: 'system', cause: 'suspend' }, 'Trino se bloqueó porque el computador se suspendió.'],
    [{ kind: 'manual' }, 'Bloqueaste Trino.'],
    [{ kind: 'idle', minutes: 5 }, 'Trino se bloqueó tras 5 minutos sin actividad.'],
  ] as const)('opens after a lock saying why, %j', async (reason, text) => {
    renderApp(fakeApi({ ...VAULT, lock_reason: reason }));
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('goes to the unlock screen when the backend locked, without saving what waited', async () => {
    const api = fakeApi(VAULT, VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);
    click('Guardar nota');

    act(() => api.requested.vaultLocked?.({ kind: 'system', cause: 'suspend' }));
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Trino se bloqueó porque el computador se suspendió.')).toBeTruthy();
    expect(screen.queryByText('intent: chats')).toBeNull();
    // The vault is locked already, and the session with it.
    expect(api.calls).toEqual(['status', 'status']);
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    expect(api.prefsSave).not.toHaveBeenCalled();
    expect(prefs.getNote('Ana')).toBe('');
  });

  it('leaves the screens before the chats alone when the backend says it locked', async () => {
    const api = fakeApi(VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    act(() => api.requested.vaultLocked?.({ kind: 'system', cause: 'session' }));
    expect(screen.getByText('Escribe tu contraseña para abrir tus chats.')).toBeTruthy();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it('locks from the tray as "Bloquear" does', async () => {
    const api = fakeApi(VAULT, VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    act(() => api.requested.lock?.());
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(screen.getByText('Bloqueaste Trino.')).toBeTruthy();
    expect(api.lockVault).toHaveBeenCalledWith({ kind: 'manual' });
  });
});

// The chats hand App the gate of their calls (src/app/calls.tsx): locking,
// closing the window and quitting from the tray end a call through it, so
// the call asks first, sends its bye and keeps its record (plan §4, I5).
describe('App during a call', () => {
  /** A call is on: each question the gate gets waits for the test's answer. */
  function callInProgress() {
    const asked: { reason: string; answer(ok: boolean): Promise<void> }[] = [];
    const confirmEnd = vi.fn(
      (reason: 'lock' | 'close' | 'quit') =>
        new Promise<boolean>(resolve => {
          asked.push({ reason, answer: ok => act(async () => resolve(ok)) });
        }),
    );
    callGate = { confirmEnd };
    return { asked, confirmEnd };
  }

  it('asks the call before locking, from "Bloquear" and from Ctrl+L, and locks only on yes', async () => {
    const { asked } = callInProgress();
    const api = fakeApi(VAULT, { ...VAULT, handle: 'Rechi' });
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    click('Bloquear ahora');
    expect(asked.map(question => question.reason)).toEqual(['lock']);
    await asked[0]!.answer(false);
    expect(screen.getByText('intent: chats')).toBeTruthy();
    expect(api.lockVault).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByText('intent: chats'), { key: 'l', ctrlKey: true });
    expect(asked.map(question => question.reason)).toEqual(['lock', 'lock']);
    await asked[1]!.answer(true);
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(api.calls).toEqual(['status', 'lockVault', 'status']);
  });

  // "Bloquear" in the tray during a call: the backend asks the frontend,
  // which asks the call first, as its own "Bloquear" does (CL-6a).
  it('asks the call before locking from the tray, and locks only on yes', async () => {
    const { asked } = callInProgress();
    const api = fakeApi(VAULT, VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);

    act(() => api.requested.lock?.());
    expect(asked.map(question => question.reason)).toEqual(['lock']);
    await asked[0]!.answer(false);
    expect(screen.getByText('intent: chats')).toBeTruthy();
    expect(api.lockVault).not.toHaveBeenCalled();

    act(() => api.requested.lock?.());
    await asked[1]!.answer(true);
    expect(await heading('Hola de nuevo')).toBeTruthy();
    expect(api.lockVault).toHaveBeenCalledWith({ kind: 'manual' });
  });

  it('closes the window during a call only once the call lets it, after clearing the call flag', async () => {
    const { asked } = callInProgress();
    const api = fakeApi(VAULT);
    const windowApi = fakeWindow();
    render(<App api={api} windowApi={windowApi} Main={FakeMain} />);
    await heading('Hola de nuevo');
    await unlockWith(PASS);
    api.setCallActive.mockClear();

    act(() => api.requested.close!());
    expect(asked.map(question => question.reason)).toEqual(['close']);
    await asked[0]!.answer(false);
    expect(windowApi.close).not.toHaveBeenCalled();
    expect(api.setCallActive).not.toHaveBeenCalled();

    act(() => api.requested.close!());
    await asked[1]!.answer(true);
    expect(api.setCallActive).toHaveBeenCalledWith(false);
    expect(windowApi.close).toHaveBeenCalledTimes(1);
  });

  it('hangs the call up before quitting from the tray, then clears the call flag', async () => {
    const { asked } = callInProgress();
    const api = fakeApi(VAULT);
    renderApp(api);
    await heading('Hola de nuevo');
    await unlockWith(PASS);
    api.setCallActive.mockClear();

    act(() => api.requested.quit!());
    expect(asked.map(question => question.reason)).toEqual(['quit']);
    expect(api.setCallActive).not.toHaveBeenCalled();
    await asked[0]!.answer(true);
    expect(api.setCallActive).toHaveBeenCalledWith(false);
  });

  // Locked, the chats and their calls are gone: a close request (a flag left behind) just closes.
  it('closes at once when the chats are not open', async () => {
    const { confirmEnd } = callInProgress();
    const api = fakeApi(VAULT);
    const windowApi = fakeWindow();
    render(<App api={api} windowApi={windowApi} Main={FakeMain} />);
    await heading('Hola de nuevo');

    await act(async () => api.requested.close!());
    expect(confirmEnd).not.toHaveBeenCalled();
    expect(api.setCallActive).toHaveBeenLastCalledWith(false);
    expect(windowApi.close).toHaveBeenCalledTimes(1);
  });
});
