// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commandError, fakeApi, memoryPrefs, PROFILE, renderEs } from '../test-utils';
import type { SettingsApi, SettingsCapabilities } from '../types';
import { SecuritySection, type SecuritySectionProps } from './SecuritySection';

afterEach(cleanup);

function setup(
  {
    totpEnabled = false,
    capabilities = { totp: true, changePassphrase: true },
    api: overrides = {},
  }: {
    totpEnabled?: boolean;
    capabilities?: Pick<SettingsCapabilities, 'totp' | 'changePassphrase'>;
    api?: Partial<SettingsApi>;
  } = {},
) {
  let enabled = totpEnabled;
  const api = fakeApi({
    status: vi.fn(async () => ({
      has_vault: true,
      is_unsealed: true,
      handle: PROFILE.handle,
      nostr_pub: PROFILE.nostr_pub,
      home_dir: '',
      totp_enabled: enabled,
    })),
    totpEnable: vi.fn(async () => {
      enabled = true;
    }),
    totpDisable: vi.fn(async () => {
      enabled = false;
    }),
    ...overrides,
  });
  const { prefs } = memoryPrefs();
  const props: SecuritySectionProps = {
    api,
    prefs,
    capabilities,
    identityName: 'rechita',
    onLockNow: vi.fn(),
    onIdentityWiped: vi.fn(),
    onAutolockChanged: vi.fn(),
  };
  renderEs(<SecuritySection {...props} />);
  return { api, prefs, props };
}

const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

// Settings > Cuenta y seguridad (Settings:173-197, plan §1.5).
describe('SecuritySection', () => {
  it('is titled "Cuenta y seguridad"', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Cuenta y seguridad' })).toBeTruthy();
  });

  it('turns two-step verification on: a new secret, a code that checks, the password, then totpEnable', async () => {
    const { api } = setup();
    expect(await screen.findByText(/^Desactivada\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Activar' }));

    const dialog = await screen.findByRole('dialog', { name: 'Activar la verificación en dos pasos' });
    await waitFor(() => expect(api.totpBegin).toHaveBeenCalledWith('rechita'));
    expect(within(dialog).getByRole('img', { name: 'Código QR para tu app autenticadora' })).toBeTruthy();
    expect(within(dialog).getByText('JBSW Y3DP EHPK 3PXP')).toBeTruthy();

    type('Código de 6 dígitos', '123 456');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verificar código' }));
    await waitFor(() => expect(api.totpVerify).toHaveBeenCalledWith('123456'));

    type('Tu contraseña', 'una frase bastante larga');
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Activar' }));
    await waitFor(() => expect(api.totpEnable).toHaveBeenCalledWith('una frase bastante larga'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText(/^Activada\./)).toBeTruthy();
    expect(vi.mocked(api.totpVerify).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.totpEnable).mock.invocationCallOrder[0]!,
    );
  });

  it('does not ask for the password while the code does not check', async () => {
    const { api } = setup({ api: { totpVerify: vi.fn(async () => false) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Activar' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(api.totpBegin).toHaveBeenCalled());
    type('Código de 6 dígitos', '000000');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Verificar código' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('El código no es correcto');
    expect(within(dialog).queryByLabelText('Tu contraseña')).toBeNull();
    expect(api.totpEnable).not.toHaveBeenCalled();
  });

  it('turns it off with the password and a code', async () => {
    const { api } = setup({ totpEnabled: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desactivar la verificación en dos pasos' });
    type('Tu contraseña', 'una frase bastante larga');
    type('Código de 6 dígitos', '654321');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar' }));
    await waitFor(() => expect(api.totpDisable).toHaveBeenCalledWith('una frase bastante larga', '654321'));
    expect(await screen.findByText(/^Desactivada\./)).toBeTruthy();
  });

  it('says which part was wrong when turning it off fails', async () => {
    setup({ totpEnabled: true, api: { totpDisable: vi.fn(async () => Promise.reject(commandError('wrong_passphrase'))) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Desactivar' }));
    const dialog = await screen.findByRole('dialog');
    type('Tu contraseña', 'otra');
    type('Código de 6 dígitos', '654321');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Desactivar' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('La contraseña no es correcta.');
  });

  it('changes the password, checking that both new ones match, then the policy and the errors', async () => {
    const changePassphrase = vi
      .fn<SettingsApi['changePassphrase']>()
      .mockRejectedValueOnce(commandError('passphrase_too_short', { min: 10 }))
      .mockRejectedValueOnce(commandError('passphrase_too_common'))
      .mockRejectedValueOnce(commandError('wrong_passphrase'))
      .mockResolvedValueOnce(undefined);
    setup({ api: { changePassphrase } });
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar contraseña' });
    const submit = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar contraseña' }));

    type('Contraseña actual', 'vieja frase larga');
    type('Contraseña nueva', 'corta');
    type('Repite la contraseña nueva', 'otra');
    submit();
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Las contraseñas no coinciden.');
    expect(changePassphrase).not.toHaveBeenCalled();

    type('Repite la contraseña nueva', 'corta');
    submit();
    expect((await within(dialog).findByRole('alert')).textContent).toContain('usa al menos 10 caracteres');
    submit();
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('muy común'));
    submit();
    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toContain('La contraseña actual no es correcta.'));
    submit();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(changePassphrase).toHaveBeenLastCalledWith('vieja frase larga', 'corta', null);
    expect(await screen.findByText('Contraseña cambiada.')).toBeTruthy();
  });

  // CE-5 (design §8.3, §11.4, RC-15): a new password that another slot of
  // the vault takes says "choose another", not "too common"; and everyone,
  // with an emergency key or without one, reads the same line about it.
  it('asks for another password when the new one cannot be used, and says the same line to everyone', async () => {
    const changePassphrase = vi.fn<SettingsApi['changePassphrase']>().mockRejectedValueOnce(commandError('choose_another'));
    setup({ api: { changePassphrase } });
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar contraseña' });
    expect(within(dialog).getByText('Que no se parezca a tu clave de emergencia, si tienes una.')).toBeTruthy();
    type('Contraseña actual', 'vieja frase larga');
    type('Contraseña nueva', 'nueva frase larga');
    type('Repite la contraseña nueva', 'nueva frase larga');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar contraseña' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Elige otra contraseña.');
  });

  it('asks for a code of the authenticator app to change the password when 2FA is on', async () => {
    const { api } = setup({ totpEnabled: true });
    await screen.findByText(/^Activada\./);
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cambiar contraseña' });
    type('Contraseña actual', 'vieja frase larga');
    type('Contraseña nueva', 'nueva frase larga');
    type('Repite la contraseña nueva', 'nueva frase larga');
    type('Código de tu app autenticadora', '112233');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cambiar contraseña' }));
    await waitFor(() => expect(api.changePassphrase).toHaveBeenCalledWith('vieja frase larga', 'nueva frase larga', '112233'));
  });

  it('keeps the auto-lock and tells the shell, "Nunca" included', () => {
    const { prefs, props } = setup();
    const autolock = screen.getByRole('combobox', { name: 'Bloqueo automático' }) as HTMLSelectElement;
    expect(autolock.value).toBe('5');
    expect(screen.getByText('Nunca se bloquea durante una llamada.')).toBeTruthy();
    fireEvent.change(autolock, { target: { value: '15' } });
    expect(prefs.getAutolockMinutes()).toBe(15);
    expect(props.onAutolockChanged).toHaveBeenLastCalledWith(15);
    fireEvent.change(autolock, { target: { value: '0' } });
    expect(prefs.getAutolockMinutes()).toBe(0);
    expect(props.onAutolockChanged).toHaveBeenLastCalledWith(0);
    expect(Array.from(autolock.options).map(option => option.textContent)).toEqual([
      'Nunca',
      'Al minuto',
      'A los 5 minutos',
      'A los 15 minutos',
      'A los 30 minutos',
      'A la hora',
    ]);
  });

  it('locks now', () => {
    const { props } = setup();
    expect(screen.getByText('También con Ctrl + L.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(props.onLockNow).toHaveBeenCalledTimes(1);
  });

  it('erases everything only after an alert dialog that starts on Cancel, and says what stays with contacts', async () => {
    const { api, props } = setup();
    expect(screen.getAllByText(/Lo que tus contactos ya recibieron se queda en sus equipos\./).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo de este equipo' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Borrar todo de este equipo?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancelar' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    expect(api.wipe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo de este equipo' }));
    const again = await screen.findByRole('alertdialog');
    const confirm = within(again).getByRole('button', { name: 'Borrar todo' });
    expect(confirm.querySelector('svg')).toBeTruthy();
    fireEvent.click(confirm);
    await waitFor(() => expect(api.wipe).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(props.onIdentityWiped).toHaveBeenCalledTimes(1));
  });

  it('keeps the dialog open with an alert when erasing fails', async () => {
    const { props } = setup({ api: { wipe: vi.fn(async () => Promise.reject(new Error('io'))) } });
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo de este equipo' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar todo' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('No se pudo borrar');
    expect(props.onIdentityWiped).not.toHaveBeenCalled();
  });

  it('hides the buttons the backend cannot do yet', async () => {
    const { api } = setup({ capabilities: { totp: false, changePassphrase: false } });
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Cambiar contraseña' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Activar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Desactivar' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Bloquear' })).toBeTruthy();
  });
});
