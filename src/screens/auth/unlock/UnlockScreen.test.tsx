// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandError, CommandErrorCode, UnsealResponse } from '../../../lib/api';
import type { Lang } from '../../../lib/i18n';
import type { UnlockApi, UnlockScreenProps } from '../../types';
import { classesOf, renderAuth, resetDocument } from '../test-harness';
import { UnlockScreen } from './UnlockScreen';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDocument();
});

const PASS = 'caballo-correcto-bateria';
const UNSEALED: UnsealResponse = { handle: 'rechita', fingerprint: 'f1f2', nostr_pub: 'c'.repeat(64), relay_connection_started: true };
const failure = (code: CommandErrorCode): CommandError => ({ code, message: 'for the log' });

/** An unseal that answers when the test says. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup(props: Partial<UnlockScreenProps> = {}, lang?: Lang) {
  const api: UnlockApi = props.api ?? {
    unseal: vi.fn(() => Promise.resolve(UNSEALED)),
    wipe: vi.fn(() => Promise.resolve()),
  };
  const handlers = { onUnlocked: vi.fn(), onNoVault: vi.fn(), onWiped: vi.fn() };
  renderAuth(
    <UnlockScreen
      handle="rechita"
      totpEnabled={false}
      reason={{ kind: 'idle', minutes: 5 }}
      {...handlers}
      {...props}
      api={api}
    />,
    { lang },
  );
  return { api, ...handlers };
}

const password = () => screen.getByLabelText<HTMLInputElement>('Contraseña');
const codeField = () => screen.queryByLabelText<HTMLInputElement>('Código de tu app autenticadora');
const type = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const unlock = () => fireEvent.click(screen.getByRole('button', { name: 'Desbloquear' }));
/** Lets a rejected or resolved unseal reach the screen. */
const settle = () => act(async () => {});
const alertText = () => screen.getByRole('alert').textContent;

/** Types the password, tries to unlock and lets the answer arrive. */
async function unlockWith(pass: string, code?: string) {
  type(password(), pass);
  if (code !== undefined) type(codeField()!, code);
  unlock();
  await settle();
}

describe('UnlockScreen', () => {
  it('greets the identity by name and says why Trino is locked (Unlock:52-56)', () => {
    setup();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hola de nuevo, rechita');
    expect(screen.getByText('Trino se bloqueó tras 5 minutos sin actividad.')).toBeTruthy();
    expect(screen.getByRole('main', { name: 'Hola de nuevo, rechita' })).toBeTruthy();
  });

  it('greets without a name when the status has none, in the language of the app', () => {
    setup({ handle: null, reason: { kind: 'manual' } }, 'en');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome back');
    expect(screen.getByText('You locked Trino.')).toBeTruthy();
  });

  it('starts in the password field', () => {
    setup();
    expect(document.activeElement).toBe(password());
  });

  it('asks for the code only when the vault has two-step verification', () => {
    setup({ totpEnabled: false });
    expect(codeField()).toBeNull();
    cleanup();
    setup({ totpEnabled: null });
    expect(codeField()).toBeNull();
    cleanup();
    setup({ totpEnabled: true });
    const code = codeField()!;
    const hint = document.getElementById(code.getAttribute('aria-describedby')?.split(' ')[0] ?? '');
    expect(hint?.textContent).toBe('El código cambia cada 30 segundos.');
    expect(code.getAttribute('inputmode')).toBe('numeric');
  });

  it('unlocks with the password alone, or with the code too', async () => {
    const plain = setup();
    await unlockWith(PASS);
    expect(plain.api.unseal).toHaveBeenCalledWith(PASS, null);
    expect(plain.onUnlocked).toHaveBeenCalledWith(UNSEALED);
    cleanup();
    const withCode = setup({ totpEnabled: true });
    await unlockWith(PASS, '482 913');
    expect(withCode.api.unseal).toHaveBeenCalledWith(PASS, '482913');
    expect(withCode.onUnlocked).toHaveBeenCalledWith(UNSEALED);
  });

  it('shows that it is unlocking, and never asks twice at once', async () => {
    const answer = deferred<UnsealResponse>();
    const { api, onUnlocked } = setup({ api: { unseal: vi.fn(() => answer.promise), wipe: vi.fn() } });
    type(password(), PASS);
    unlock();
    const busy = screen.getByRole('button', { name: 'Desbloqueando…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.submit(busy.closest('form')!);
    expect(api.unseal).toHaveBeenCalledTimes(1);
    answer.resolve(UNSEALED);
    await settle();
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  });

  it('asks for the password, or the code, before trying', () => {
    const { api } = setup({ totpEnabled: true });
    unlock();
    expect(alertText()).toBe('Escribe tu contraseña.');
    expect(document.activeElement).toBe(password());
    type(password(), PASS);
    unlock();
    expect(alertText()).toBe('Escribe también el código de tu app autenticadora.');
    expect(document.activeElement).toBe(codeField());
    expect(api.unseal).not.toHaveBeenCalled();
  });

  it('says the password is wrong in an alert tied to the field, and goes back to it', async () => {
    setup({ api: { unseal: vi.fn(() => Promise.reject(failure('wrong_passphrase'))), wipe: vi.fn() } });
    await unlockWith(PASS);
    expect(alertText()).toBe('La contraseña no es correcta. Inténtalo de nuevo.');
    expect(password().getAttribute('aria-invalid')).toBe('true');
    const described = (password().getAttribute('aria-describedby') ?? '').split(' ');
    expect(described.map(id => document.getElementById(id)?.textContent)).toContain(alertText());
    expect(document.activeElement).toBe(password());
  });

  // Two-step verification protects against whoever uses the computer:
  // the message never tells them that the password was right.
  it('with 2FA, names both fields whichever one was wrong', async () => {
    for (const code of ['wrong_passphrase', 'invalid_totp'] as const) {
      setup({ totpEnabled: true, api: { unseal: vi.fn(() => Promise.reject(failure(code))), wipe: vi.fn() } });
      await unlockWith(PASS, '482913');
      expect(alertText(), code).toBe('La contraseña o el código no son correctos. Revisa los dos e inténtalo de nuevo.');
      expect(codeField()!.value, code).toBe('');
      cleanup();
    }
  });

  it('shows and focuses the code field when the vault asks for a code', async () => {
    const unseal = vi.fn((_: string, code?: string | null) =>
      code ? Promise.resolve(UNSEALED) : Promise.reject(failure('totp_required')),
    );
    const { onUnlocked } = setup({ totpEnabled: null, api: { unseal, wipe: vi.fn() } });
    await unlockWith(PASS);
    expect(document.activeElement).toBe(codeField());
    expect(alertText()).toBe('Escribe también el código de tu app autenticadora.');
    type(codeField()!, '482913');
    unlock();
    await settle();
    expect(unseal).toHaveBeenLastCalledWith(PASS, '482913');
    expect(onUnlocked).toHaveBeenCalledWith(UNSEALED);
  });

  it('hands an identity that is gone to the parent', async () => {
    const { onNoVault } = setup({ api: { unseal: vi.fn(() => Promise.reject(failure('no_vault'))), wipe: vi.fn() } });
    await unlockWith(PASS);
    expect(onNoVault).toHaveBeenCalledTimes(1);
  });

  it('says when the identity comes from a newer Trino, and when anything else failed', async () => {
    setup({ api: { unseal: vi.fn(() => Promise.reject(failure('unsupported_vault'))), wipe: vi.fn() } });
    await unlockWith(PASS);
    expect(alertText()).toBe('Esta identidad se creó con una versión más nueva de Trino. Actualiza Trino para abrirla.');
    cleanup();
    for (const error of [failure('io'), failure('internal'), 'vault sealed']) {
      setup({ api: { unseal: vi.fn(() => Promise.reject(error)), wipe: vi.fn() } });
      await unlockWith(PASS);
      expect(alertText()).toBe('No se pudo desbloquear Trino. Inténtalo de nuevo.');
      expect(screen.getByRole('button', { name: 'Desbloquear' })).toBeTruthy();
      cleanup();
    }
  });

  it('never writes the password to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    setup({ api: { unseal: vi.fn(() => Promise.reject(failure('wrong_passphrase'))), wipe: vi.fn() } });
    await unlockWith(PASS);
    const written = spies.flatMap(spy => spy.mock.calls.flat().map(value => JSON.stringify(value) ?? String(value)));
    expect(written.filter(text => text.includes(PASS))).toEqual([]);
  });
});

describe('forgetting the password', () => {
  const forgot = () => screen.getByRole('button', { name: '¿Olvidaste la contraseña?' });

  it('explains behind a toggle that nobody can recover it, and what wiping loses', () => {
    setup();
    expect(forgot().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/nadie más tiene una copia/)).toBeNull();
    fireEvent.click(forgot());
    expect(forgot().getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(forgot().getAttribute('aria-controls') ?? '')!;
    expect(panel.textContent).toContain('Trino no puede recuperarla: nadie más tiene una copia.');
    expect(panel.textContent).toContain('Perderás tus chats y tus contactos de este equipo.');
    fireEvent.click(forgot());
    expect(forgot().getAttribute('aria-expanded')).toBe('false');
  });

  /** Opens the panel and the confirmation, and returns the dialog. */
  function openWipe() {
    fireEvent.click(forgot());
    fireEvent.click(screen.getByRole('button', { name: 'Borrar identidad y empezar de cero' }));
    return screen.getByRole('alertdialog', { name: '¿Borrar esta identidad?' });
  }

  it('asks before wiping, in an alertdialog with Cancelar focused', () => {
    const { api } = setup();
    const dialog = openWipe();
    const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(
      'Se borrarán de este equipo tu identidad, tus chats y tus contactos. No se puede deshacer.',
    );
    const cancel = within(dialog).getByRole('button', { name: 'Cancelar' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.wipe).not.toHaveBeenCalled();
  });

  // A solid red button sits beside green ones: it always carries an icon (E0b).
  it('wipes from a solid danger button with an icon, and hands over', async () => {
    const { api, onWiped } = setup();
    const confirm = within(openWipe()).getByRole('button', { name: 'Borrar identidad y empezar de cero' });
    expect(classesOf(confirm)).toContain('bg-ui-danger');
    expect(confirm.querySelector('svg')).not.toBeNull();
    fireEvent.click(confirm);
    await settle();
    expect(api.wipe).toHaveBeenCalledTimes(1);
    expect(onWiped).toHaveBeenCalledTimes(1);
  });

  it('stays open with an alert when wiping fails', async () => {
    const { onWiped } = setup({
      api: { unseal: vi.fn(), wipe: vi.fn(() => Promise.reject('some files could not be deleted')) },
    });
    const dialog = openWipe();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar identidad y empezar de cero' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toBe('No se pudo borrar la identidad. Inténtalo de nuevo.');
    expect(onWiped).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });
});
