// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAutoLockHeld } from '../../../app/autolock-hold';
import { commandError, fakeApi, renderEs } from '../test-utils';
import type { SettingsApi } from '../types';
import { EmergencyKeyView, type EmergencyKeyViewProps } from './EmergencyKeyView';

afterEach(cleanup);

function setup(
  { totpEnabled = false, platform = 'windows', api: overrides = {} }: Partial<Pick<EmergencyKeyViewProps, 'totpEnabled' | 'platform'>> & {
    api?: Partial<SettingsApi>;
  } = {},
) {
  const api = fakeApi(overrides);
  const props: EmergencyKeyViewProps = {
    api,
    totpEnabled,
    platform,
    onBack: vi.fn(),
    onOpenReinforced: vi.fn(),
  };
  const view = renderEs(<EmergencyKeyView {...props} />);
  return { api, props, view };
}

const type = (label: string, value: string, root: HTMLElement = document.body) =>
  fireEvent.change(within(root).getByLabelText(label), { target: { value } });

const PASS = 'caballo correcto bateria';
const KEY = 'lluvia sobre el puente';

/** Walks the setup to its third step, with `PASS` (and `code`, if given). */
async function toKeyStep(code?: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Configurar o cambiar' }));
  await screen.findByRole('heading', { name: 'Configurar la clave de emergencia' });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Entiendo que no se puede deshacer.' }));
  fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));
  type('Tu contraseña', PASS);
  if (code !== undefined) type('Código de tu app autenticadora', code);
  fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));
  await screen.findByLabelText('Clave de emergencia');
}

function typeKey(key: string, repeat = key) {
  type('Clave de emergencia', key);
  type('Repite la clave de emergencia', repeat);
  fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
}

// Settings › Cuenta y seguridad › Clave de emergencia (CE-5, design §8;
// PropClaveEmergencia cards 2 to 6).
describe('EmergencyKeyView', () => {
  // Test 45 (CE-D6): the page asks the backend nothing, and shows the same
  // with a key or without one: the explanation, the three buttons and the
  // row of the network, which says nothing of what was chosen.
  it('looks the same with or without a key, and asks the backend nothing to show itself', () => {
    // React's ids (useId) differ from one mount to the next; nothing else may.
    const html = (container: HTMLElement) => container.innerHTML.replace(/_r_\w+_/g, 'id');
    const withKey = setup({ api: { testEmergencyKey: vi.fn(async () => true) } });
    const first = html(withKey.view.container);
    cleanup();
    const without = setup({ api: { testEmergencyKey: vi.fn(async () => false) } });
    expect(html(without.view.container)).toBe(first);
    for (const call of ['setEmergencyKey', 'testEmergencyKey', 'removeEmergencyKey', 'emergencyNetwork', 'status'] as const) {
      expect(without.api[call]).not.toHaveBeenCalled();
    }
    expect(screen.getByRole('heading', { name: 'Clave de emergencia' })).toBeTruthy();
    expect(screen.getByText(/^Es una segunda contraseña para cuando alguien te obligue a abrir Trino\./)).toBeTruthy();
    for (const name of ['Configurar o cambiar', 'Probar', 'Quitar']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Qué pasa en la red/ }).textContent).toContain('Pide tu contraseña antes de mostrar nada.');
    expect(document.body.textContent).not.toMatch(/Activada|Desactivada|Ninguna/);
  });

  it('goes back to Cuenta y seguridad', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Cuenta y seguridad' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  it('configures the key in four steps: the limits and the box, the password, the key twice, and done', async () => {
    const { api } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Configurar o cambiar' }));
    expect(await screen.findByText('Paso 1 de 4')).toBeTruthy();
    const limits = screen.getByRole('list', { name: 'Antes de configurarla' });
    expect(within(limits).getAllByRole('listitem')).toHaveLength(9);
    expect(limits.textContent).toContain('No se puede deshacer.');
    expect(limits.textContent).toContain('no la guardes en un gestor de contraseñas');

    // "Seguir" waits for the box.
    const next = screen.getByRole('button', { name: 'Seguir' });
    expect(next.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(next);
    expect(screen.getByText('Paso 1 de 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Entiendo que no se puede deshacer.' }));
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));

    expect(screen.getByText('Paso 2 de 4')).toBeTruthy();
    expect(screen.getByText('Si ya tenías una clave de emergencia, la nueva la reemplaza. No hace falta que recuerdes la anterior.')).toBeTruthy();
    expect(screen.queryByLabelText('Código de tu app autenticadora')).toBeNull();
    type('Tu contraseña', PASS);
    fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));

    expect(screen.getByText('Paso 3 de 4')).toBeTruthy();
    expect(screen.getByText('Al menos 10 caracteres. Distinta de tu contraseña, y que no se le parezca.')).toBeTruthy();
    // Not offered to a password manager that would type it by itself (RC-14).
    expect(screen.getByLabelText('Clave de emergencia').getAttribute('autocomplete')).toBe('off');
    typeKey(KEY);
    await waitFor(() => expect(api.setEmergencyKey).toHaveBeenCalledWith(PASS, KEY, null));

    expect(await screen.findByText('Paso 4 de 4')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Tu clave de emergencia quedó guardada.');
    expect(screen.getByText('Pruébala ahora, sin borrar nada, para comprobar que la recuerdas.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Probar sin borrar' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Listo' }));
    expect(await screen.findByRole('heading', { name: 'Clave de emergencia' })).toBeTruthy();
  });

  it('takes the code of the authenticator app when two-step verification is on', async () => {
    const { api } = setup({ totpEnabled: true });
    await toKeyStep('123 456');
    typeKey(KEY);
    await waitFor(() => expect(api.setEmergencyKey).toHaveBeenCalledWith(PASS, KEY, '123456'));
  });

  // Test 46: the rules live in Rust (passphrase.rs); each refusal gets its own text.
  it('says why a key is refused, and that the two must match, before asking the backend', async () => {
    const setEmergencyKey = vi
      .fn<SettingsApi['setEmergencyKey']>()
      .mockRejectedValueOnce(commandError('same_as_passphrase'))
      .mockRejectedValueOnce(commandError('like_passphrase'))
      .mockRejectedValueOnce(commandError('passphrase_too_short', { min: 10 }))
      .mockRejectedValueOnce(commandError('passphrase_too_common'))
      .mockRejectedValueOnce(commandError('choose_another'));
    setup({ api: { setEmergencyKey } });
    await toKeyStep();
    typeKey(KEY, 'otra cosa distinta');
    expect((await screen.findByRole('alert')).textContent).toBe('Las dos no coinciden. Escríbela otra vez.');
    expect(setEmergencyKey).not.toHaveBeenCalled();
    for (const text of [
      'Tiene que ser distinta de tu contraseña.',
      'Se parece demasiado a tu contraseña: podrías escribirla sin querer.',
      'La clave de emergencia necesita al menos 10 caracteres.',
      'Esa clave es muy común o muy simple. Elige otra.',
      'Elige otra clave de emergencia.',
    ]) {
      typeKey(KEY);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
      expect(screen.getByText('Paso 3 de 4')).toBeTruthy();
    }
  });

  it('goes back to the password with its error when the password or the code is wrong', async () => {
    setup({
      totpEnabled: true,
      api: { setEmergencyKey: vi.fn(async () => Promise.reject(commandError('invalid_totp'))) },
    });
    await toKeyStep('000000');
    typeKey(KEY);
    expect((await screen.findByRole('alert')).textContent).toBe('La contraseña o el código no son correctos.');
    expect(screen.getByText('Paso 2 de 4')).toBeTruthy();
  });

  it('suggests Protección reforzada on Windows and the network, and leaves out what this build does not have', async () => {
    const { props } = setup();
    await toKeyStep();
    typeKey(KEY);
    const better = await screen.findByRole('list', { name: 'Para que te proteja mejor' });
    expect(within(better).queryByText(/Usar el kit/)).toBeNull();
    fireEvent.click(within(better).getByRole('button', { name: /Protección reforzada/ }));
    expect(props.onOpenReinforced).toHaveBeenCalledTimes(1);
    fireEvent.click(within(better).getByRole('button', { name: /Qué pasa en la red/ }));
    expect(await screen.findByRole('heading', { name: 'Qué pasa en la red' })).toBeTruthy();
  });

  it('has no Protección reforzada to suggest where Trino has none', async () => {
    setup({ platform: 'linux' });
    await toKeyStep();
    typeKey(KEY);
    const better = await screen.findByRole('list', { name: 'Para que te proteja mejor' });
    expect(within(better).queryByText('Protección reforzada')).toBeNull();
  });

  // Design §8.4, RC-16 and RC-17.
  describe('Probar sin borrar', () => {
    it('says whether it matches, without writing, and the field empties when it closes', async () => {
      const testEmergencyKey = vi.fn<SettingsApi['testEmergencyKey']>().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const { api } = setup({ api: { testEmergencyKey } });
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Probar mi clave de emergencia' });
      expect(within(dialog).getByText('Si Trino se bloquea mientras pruebas, no escribas la clave de emergencia en la pantalla de desbloqueo.')).toBeTruthy();
      type('Clave que quieres probar', KEY, dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Probar' }));
      await waitFor(() =>
        expect(within(dialog).getByRole('status').textContent).toBe('Esa es tu clave de emergencia. En la pantalla de desbloqueo borraría todo.'),
      );
      type('Clave que quieres probar', 'otra cualquiera', dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Probar' }));
      await waitFor(() => expect(within(dialog).getByRole('status').textContent).toBe('No coincide con tu clave de emergencia.'));
      expect(testEmergencyKey.mock.calls).toEqual([[KEY], ['otra cualquiera']]);
      expect(api.setEmergencyKey).not.toHaveBeenCalled();
      expect(api.removeEmergencyKey).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      const again = await screen.findByRole('dialog', { name: 'Probar mi clave de emergencia' });
      expect((within(again).getByLabelText('Clave que quieres probar') as HTMLInputElement).value).toBe('');
      expect(within(again).queryByRole('status')?.textContent ?? '').toBe('');
    });

    // RC-17: the field shares neither the name nor the shape of the unlock
    // screen's, so a habit does not carry it there.
    it('has a field unlike the unlock screen’s', async () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      const field = (await screen.findByLabelText('Clave que quieres probar')) as HTMLInputElement;
      expect(field.getAttribute('autocomplete')).toBe('off');
      expect(field.getAttribute('autocomplete')).not.toBe('current-password');
      expect(field.name).toBe('emergency-trial');
      expect(field.className).toContain('border-dashed');
      expect(field.className).toContain('font-ui-mono');
    });

    // Test 59 (RC-17): the idle lock waits while the test is open.
    it('holds the idle lock while it is open, and lets it go when it closes', async () => {
      setup();
      expect(isAutoLockHeld()).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Probar mi clave de emergencia' });
      expect(isAutoLockHeld()).toBe(true);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(isAutoLockHeld()).toBe(false);
    });

    it('lets the idle lock go when the whole view goes away', async () => {
      const { view } = setup();
      fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
      await screen.findByRole('dialog');
      expect(isAutoLockHeld()).toBe(true);
      view.unmount();
      expect(isAutoLockHeld()).toBe(false);
    });
  });

  // Test 47: the test lives only inside the open account.
  it('never puts the test on the unlock screen', () => {
    const auth = import.meta.glob<string>(['../../auth/**/*.{ts,tsx}', '!../../auth/**/*.test.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(auth).length).toBeGreaterThan(10);
    const naming = Object.entries(auth)
      .filter(([, source]) => /testEmergencyKey|emergency\.test\.|EmergencyKeyView|test_emergency_key/.test(source))
      .map(([path]) => path);
    expect(naming).toEqual([]);
  });

  describe('Quitar', () => {
    it('asks for the password, and says the same whether there was a key or not', async () => {
      const { api } = setup();
      fireEvent.click(screen.getByRole('button', { name: 'Quitar' }));
      const dialog = await screen.findByRole('alertdialog', { name: '¿Quitar la clave de emergencia?' });
      expect(within(dialog).getByText('Si tienes una, deja de servir.')).toBeTruthy();
      expect(document.activeElement).toBe(within(dialog).getByLabelText('Tu contraseña'));
      type('Tu contraseña', PASS, dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Quitar' }));
      await waitFor(() => expect(api.removeEmergencyKey).toHaveBeenCalledWith(PASS, null));
      expect((await screen.findByRole('status')).textContent).toContain('Listo. Si tenías una clave de emergencia, ya no sirve.');
      fireEvent.click(screen.getByRole('button', { name: 'Entendido' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    });

    it('stays open with the error when the password is wrong', async () => {
      setup({ api: { removeEmergencyKey: vi.fn(async () => Promise.reject(commandError('wrong_passphrase'))) } });
      fireEvent.click(screen.getByRole('button', { name: 'Quitar' }));
      const dialog = await screen.findByRole('alertdialog');
      type('Tu contraseña', 'otra', dialog);
      fireEvent.click(within(dialog).getByRole('button', { name: 'Quitar' }));
      expect((await within(dialog).findByRole('alert')).textContent).toBe('La contraseña no es correcta.');
    });
  });

  // Test 49 and CE-D11: behind the password; "Ninguna" and the warning to a
  // contact only, the warning not yet open (CE-6).
  describe('Qué pasa en la red', () => {
    it('shows nothing of the choice before the password opens it', async () => {
      const emergencyNetwork = vi
        .fn<SettingsApi['emergencyNetwork']>()
        .mockRejectedValueOnce(commandError('wrong_passphrase'))
        .mockResolvedValueOnce({ action: 'none' });
      setup({ api: { emergencyNetwork } });
      fireEvent.click(screen.getByRole('button', { name: /Qué pasa en la red/ }));
      expect(await screen.findByText('Escribe tu contraseña para ver y cambiar esto.')).toBeTruthy();
      expect(screen.queryByRole('checkbox')).toBeNull();
      type('Tu contraseña', 'otra');
      fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));
      expect((await screen.findByRole('alert')).textContent).toBe('La contraseña no es correcta.');
      expect(screen.queryByRole('checkbox')).toBeNull();

      type('Tu contraseña', PASS);
      fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));
      const none = await screen.findByRole('checkbox', { name: 'Ninguna' });
      expect(emergencyNetwork).toHaveBeenLastCalledWith(PASS, null);
      expect((none as HTMLInputElement).checked).toBe(true);
      const alert = screen.getByRole('checkbox', { name: 'Avisar a un contacto de confianza' }) as HTMLInputElement;
      expect(alert.checked).toBe(false);
      expect(alert.disabled).toBe(true);
      expect(screen.getByText(/^Todavía no se puede elegir/)).toBeTruthy();
      expect(screen.queryByLabelText(/Tu contraseña/)).toBeNull();
      expect(document.body.textContent).not.toMatch(/relays que borren/);
    });

    it('takes the code too when two-step verification is on', async () => {
      const { api } = setup({ totpEnabled: true });
      fireEvent.click(screen.getByRole('button', { name: /Qué pasa en la red/ }));
      type('Tu contraseña', PASS);
      type('Código de tu app autenticadora', '654 321');
      fireEvent.click(screen.getByRole('button', { name: 'Seguir' }));
      await waitFor(() => expect(api.emergencyNetwork).toHaveBeenCalledWith(PASS, '654321'));
    });
  });
});
