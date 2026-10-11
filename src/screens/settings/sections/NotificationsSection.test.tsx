// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeApi, memoryPrefs, renderEs } from '../test-utils';
import type { SettingsPlatform } from '../types';
import { NotificationsSection } from './NotificationsSection';

afterEach(cleanup);

function setup(platform: SettingsPlatform = 'windows', overrides: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(overrides);
  const { prefs, storage } = memoryPrefs();
  const view = renderEs(<NotificationsSection api={api} prefs={prefs} platform={platform} />);
  return { ...view, api, prefs, storage };
}

const preview = () => screen.getByRole('group', { name: 'Vista previa de la notificación' });

// Settings > Notificaciones (Settings:50-113, plan §1.5).
describe('NotificationsSection', () => {
  it('offers the three levels, "Solo el nombre" by default, and keeps the choice', () => {
    const { prefs } = setup();
    const group = screen.getByRole('radiogroup', { name: 'Qué se ve en la notificación' });
    const options = within(group).getAllByRole('radio');
    expect(options.map(option => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(within(group).getByRole('radio', { name: 'Solo el nombre (recomendado)' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(group).getByRole('radio', { name: 'Nada' }));
    expect(prefs.getNotifPreview()).toBe('none');
  });

  it('previews the notification at the chosen level, without an avatar', () => {
    setup();
    expect(preview().textContent).toContain('Ana Torres');
    expect(preview().textContent).toContain('Nuevo mensaje');
    fireEvent.click(screen.getByRole('radio', { name: 'Nombre y mensaje' }));
    expect(preview().textContent).toContain('¿Nos vemos el jueves a las 6?');
    fireEvent.click(screen.getByRole('radio', { name: 'Nada' }));
    expect(preview().textContent).not.toContain('Ana Torres');
    expect(within(preview()).queryAllByRole('img')).toEqual([]);
    expect(preview().querySelector('img')).toBeNull();
  });

  it('sends a test notification with what the level shows', async () => {
    const { api } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Probar notificación' }));
    await waitFor(() => expect(api.notify).toHaveBeenCalledWith('Ana Torres', 'Nuevo mensaje'));
  });

  it('switches the message sound, the calls with the window closed and the muted groups', () => {
    const { prefs } = setup();
    const sound = screen.getByRole('switch', { name: 'Sonido de mensajes' });
    expect(sound.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sound);
    expect(prefs.getMessageSound()).toBe(false);

    fireEvent.click(screen.getByRole('switch', { name: 'Avisar de llamadas con la ventana cerrada' }));
    expect(prefs.getCallNotifyHidden()).toBe(false);

    const groups = screen.getByRole('switch', { name: 'Silenciar grupos por defecto' });
    expect(groups.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(groups);
    expect(prefs.getMuteGroupsByDefault()).toBe(true);
  });

  it('picks the ringtone between "Suave" and "Silencio" only, and its volume', () => {
    const { prefs } = setup();
    const tone = screen.getByRole('combobox', { name: /Tono de llamada/ }) as HTMLSelectElement;
    expect(Array.from(tone.options).map(option => option.textContent)).toEqual(['Suave', 'Silencio']);
    const volume = screen.getByRole('slider', { name: 'Volumen del tono' }) as HTMLInputElement;
    expect(volume.value).toBe('60');
    fireEvent.change(volume, { target: { value: '30' } });
    expect(prefs.getRingVolume()).toBe(30);
    expect(volume.getAttribute('aria-valuetext')).toBe('30 %');

    fireEvent.change(tone, { target: { value: 'silent' } });
    expect(prefs.getRingtone()).toBe('silent');
    expect(volume.disabled).toBe(true);
  });

  it('offers starting with Windows on Windows, and turns it on', async () => {
    const { api } = setup('windows');
    const autostart = await screen.findByRole('switch', { name: 'Iniciar con Windows' });
    expect(screen.getByText('Para recibir mensajes, Trino tiene que estar abierto.')).toBeTruthy();
    await waitFor(() => expect(api.getAutostart).toHaveBeenCalled());
    fireEvent.click(autostart);
    await waitFor(() => expect(api.setAutostart).toHaveBeenCalledWith(true));
    expect(autostart.getAttribute('aria-checked')).toBe('true');
  });

  it('puts the switch back and says so when starting with Windows cannot change', async () => {
    setup('windows', { setAutostart: vi.fn(async () => Promise.reject(new Error('io'))) });
    const autostart = await screen.findByRole('switch', { name: 'Iniciar con Windows' });
    fireEvent.click(autostart);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cambiar el inicio con Windows.');
    expect(autostart.getAttribute('aria-checked')).toBe('false');
  });

  it('has no "Iniciar con Windows" on macOS and Linux', async () => {
    for (const platform of ['macos', 'linux'] as const) {
      const { api, unmount } = setup(platform);
      expect(screen.queryByRole('switch', { name: 'Iniciar con Windows' })).toBeNull();
      expect(api.getAutostart).not.toHaveBeenCalled();
      unmount();
    }
  });
});
