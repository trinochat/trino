// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TEXT_SCALE_STORAGE_KEY } from '../../design/accessibility';
import { holdAccessibility, holdAppearance, holdScanLines } from '../../design/apply';
import { AppearanceProvider } from '../../design/useAppearance';
import type { SettingsSectionId } from '../types';
import { SettingsScreen } from './SettingsScreen';
import { fakeApi, fakeHost, memoryPrefs, PROFILE, renderEs } from './test-utils';
import type { SettingsApi, SettingsCapabilities } from './types';

afterEach(cleanup);
beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
});

const ALL: SettingsCapabilities = { totp: true, changePassphrase: true, relayStatus: true, profileSync: true };

const TITLES: Record<SettingsSectionId, string> = {
  profile: 'Perfil',
  security: 'Cuenta y seguridad',
  privacy: 'Privacidad',
  notifications: 'Notificaciones',
  appearance: 'Apariencia',
  accessibility: 'Accesibilidad',
  language: 'Idioma',
  advanced: 'Avanzado',
};
const SECTIONS = Object.keys(TITLES) as SettingsSectionId[];

function setup({
  width = 1024,
  initial = 'privacy' as SettingsSectionId,
  stored = {} as Record<string, string>,
  api: overrides = {} as Partial<SettingsApi>,
} = {}) {
  const { host } = fakeHost(stored);
  const api = fakeApi(overrides);
  const { prefs } = memoryPrefs();
  const spies = {
    onSectionChange: vi.fn(),
    onClose: vi.fn(),
    onLockNow: vi.fn(),
    onIdentityWiped: vi.fn(),
    onProfileChanged: vi.fn(),
    onAutolockChanged: vi.fn(),
    onContactsChanged: vi.fn(),
  };
  function Harness() {
    const [section, setSection] = useState<SettingsSectionId>(initial);
    return (
      <SettingsScreen
        section={section}
        onSectionChange={id => {
          spies.onSectionChange(id);
          setSection(id);
        }}
        onClose={spies.onClose}
        onLockNow={spies.onLockNow}
        onIdentityWiped={spies.onIdentityWiped}
        onProfileChanged={spies.onProfileChanged}
        onAutolockChanged={spies.onAutolockChanged}
        onContactsChanged={spies.onContactsChanged}
        renderShareCode={() => <p>Panel para compartir</p>}
        api={api}
        platform="windows"
        capabilities={ALL}
        prefs={prefs}
        makeAvatar={async () => 'data:image/jpeg;base64,AAAA'}
        width={width}
      />
    );
  }
  renderEs(
    <AppearanceProvider host={host}>
      <Harness />
    </AppearanceProvider>,
  );
  return { api, spies };
}

const nav = () => screen.queryByRole('navigation', { name: 'Secciones de ajustes' });
const sectionHeading = (name: string) => screen.findByRole('heading', { level: 2, name });

// Settings (W5): PropAjustes:41-119 for the navigation, plan-cambios-11oct
// §4 W5 and accesibilidad.md §4.7 rule 10 for one pane.
describe('SettingsScreen', () => {
  it('offers eight sections and marks the one on screen with aria-current', async () => {
    for (const id of SECTIONS) {
      setup({ initial: id });
      await sectionHeading(TITLES[id]);
      await within(nav()!).findByText('rechita');
      const marked = within(nav()!).getAllByRole('button').filter(button => button.getAttribute('aria-current') === 'page');
      expect(marked, id).toHaveLength(1);
      expect(marked[0]!.textContent, id).toContain(id === 'profile' ? 'rechita' : TITLES[id]);
      cleanup();
    }
  });

  it('puts Accesibilidad between Apariencia and Idioma, in named groups', async () => {
    setup();
    const groups = ['Cuenta', 'Uso', 'Más'].map(name => screen.getByRole('list', { name }));
    expect(groups).toHaveLength(3);
    const order = within(groups[1]!).getAllByRole('button').map(button => button.textContent);
    expect(order.indexOf('Accesibilidad')).toBe(order.indexOf('Apariencia') + 1);
    expect(order.indexOf('Idioma')).toBe(order.indexOf('Accesibilidad') + 1);
  });

  it('shows your card, whose QR button opens the contacts unit’s share panel', async () => {
    const { spies } = setup({ initial: 'privacy' });
    expect(await within(nav()!).findByRole('button', { name: /rechita/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar tu código QR' }));
    expect(spies.onSectionChange).toHaveBeenLastCalledWith('profile');
    const view = await screen.findByRole('region', { name: 'Tu código QR' });
    expect(within(view).getByText('Panel para compartir')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mostrar tu código QR' }).getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Volver al perfil' }));
    const heading = await sectionHeading('Perfil');
    expect(document.activeElement).toBe(heading);
  });

  it('opens the QR view from the profile’s own row, moving the focus there', async () => {
    setup({ initial: 'profile' });
    await sectionHeading('Perfil');
    fireEvent.click(screen.getByRole('button', { name: /Tu código QR/ }));
    expect(document.activeElement).toBe(await sectionHeading('Tu código QR'));
  });

  it('never shows what this batch does not have', async () => {
    for (const id of SECTIONS) {
      setup({ initial: id });
      await sectionHeading(TITLES[id]);
      const text = document.body.textContent ?? '';
      expect(text, id).not.toMatch(
        /Apoyar|(?<!\p{L})Tor(?!\p{L})|Quién puede escribirte|Agregar relay|Avisar una vez|muestra tu IP|@/u,
      );
      cleanup();
    }
  });

  it('shows one pane below 47.5 rem: the list, then a section with a way back', async () => {
    setup({ width: 700 });
    expect(nav()).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(document.querySelectorAll('[aria-current]')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Notificaciones' }));
    expect(nav()).toBeNull();
    expect(document.activeElement).toBe(await sectionHeading('Notificaciones'));

    fireEvent.click(screen.getByRole('button', { name: 'Volver a ajustes' }));
    expect(nav()).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Notificaciones' }));
  });

  it('decides with the text size: 900 px is two panes at 100 % and one at 125 %', async () => {
    setup({ width: 900 });
    expect(nav()).toBeTruthy();
    expect(await sectionHeading('Privacidad')).toBeTruthy();
    cleanup();
    setup({ width: 900, stored: { [SYSTEM_TEXT_SCALE_STORAGE_KEY]: '1.25' } });
    expect(nav()).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('closes with its button and with Escape, but Escape in a text field stays', async () => {
    const { spies } = setup({ initial: 'profile' });
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ajustes' }));
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(await screen.findByRole('textbox', { name: 'Nombre' }), { key: 'Escape' });
    expect(spies.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Guardar' }), { key: 'Escape' });
    expect(spies.onClose).toHaveBeenCalledTimes(2);
  });

  it('goes back to the list with Escape on one pane', async () => {
    const { spies } = setup({ width: 700 });
    fireEvent.click(screen.getByRole('button', { name: 'Idioma' }));
    fireEvent.keyDown(await sectionHeading('Idioma'), { key: 'Escape' });
    expect(nav()).toBeTruthy();
    expect(spies.onClose).not.toHaveBeenCalled();
  });

  it('reads the profile again after saving it, and tells the shell', async () => {
    const getProfile = vi
      .fn<SettingsApi['getProfile']>()
      .mockResolvedValueOnce(PROFILE)
      .mockResolvedValue({ ...PROFILE, handle: 'rechi' });
    const { spies } = setup({ initial: 'profile', api: { getProfile } });
    const name = await screen.findByRole('textbox', { name: 'Nombre' });
    fireEvent.change(name, { target: { value: 'rechi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(spies.onProfileChanged).toHaveBeenCalledTimes(1));
    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(await within(nav()!).findByRole('button', { name: /rechi/ })).toBeTruthy();
  });

  it('says when the profile cannot be read, and tries again', async () => {
    const getProfile = vi
      .fn<SettingsApi['getProfile']>()
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockResolvedValue(PROFILE);
    setup({ initial: 'profile', api: { getProfile } });
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar tu perfil.');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('textbox', { name: 'Nombre' })).toBeTruthy();
  });

  it('hands the slot’s actions to its sections', async () => {
    const { spies } = setup({ initial: 'security' });
    await sectionHeading('Cuenta y seguridad');
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(spies.onLockNow).toHaveBeenCalledTimes(1);
  });
});
