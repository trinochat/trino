// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCESSIBILITY, SYSTEM_TEXT_SCALE_STORAGE_KEY, type TextScale } from '../../design/accessibility';
import { changeAccessibility, holdAccessibility, holdAppearance, holdScanLines } from '../../design/apply';
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
  let resizeTo: (next: number) => void = () => {};
  function Harness() {
    const [section, setSection] = useState<SettingsSectionId>(initial);
    const [shown, setShown] = useState(width);
    resizeTo = setShown;
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
        width={shown}
      />
    );
  }
  renderEs(
    <AppearanceProvider host={host}>
      <Harness />
    </AppearanceProvider>,
  );
  /** The screen gets narrower or wider while it is open, as a window snapped to half the screen. */
  const resize = (next: number) => act(() => resizeTo(next));
  /** The text size changes while the screen is open, as with Ctrl + +. */
  const textScale = (factor: TextScale) =>
    act(() => {
      changeAccessibility(host, { ...DEFAULT_ACCESSIBILITY, textScale: factor });
    });
  return { api, spies, resize, textScale };
}

const nav = () => screen.queryByRole('navigation', { name: 'Secciones de ajustes' });
const sectionHeading = (name: string) => screen.findByRole('heading', { level: 2, name });
/** The button of your card: your name, then "Tu perfil" (jsdom joins the two lines without a space). */
const card = (name: string) => new RegExp(`^${name}\\s*Tu perfil$`);

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

  // SC-1: Privacidad gets this device's preferences and the platform, for
  // the block of screen captures, and changes the window through the API.
  it('gives Privacidad the device’s preferences and the window, for the block of captures', async () => {
    const { api } = setup({ initial: 'privacy' });
    await sectionHeading('Privacidad');
    const toggle = screen.getByRole('switch', { name: 'Bloquear capturas de pantalla' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(api.setContentProtected).toHaveBeenCalledWith(false));
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

  // A section shown in two panes is open: when the window narrows or the
  // text grows, it stays on its own pane, with what was being typed and the
  // focus, until "Volver a ajustes" or Escape.
  it('keeps the section, its edits and the focus when two panes turn into one', async () => {
    const { api, resize } = setup({ width: 1200, initial: 'profile' });
    const name = (await screen.findByRole('textbox', { name: 'Nombre' })) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'rechi sin guardar' } });
    name.focus();

    resize(700);
    expect(nav()).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Perfil' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Nombre' })).toBe(name);
    expect(name.value).toBe('rechi sin guardar');
    expect(document.activeElement).toBe(name);
    expect(api.updateProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Volver a ajustes' }));
    expect(nav()).toBeTruthy();
  });

  it('keeps the section when a larger text size turns two panes into one', async () => {
    const { textScale } = setup({ width: 900 });
    const heading = await sectionHeading('Privacidad');
    textScale(1.25);
    expect(nav()).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Privacidad' })).toBe(heading);
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(nav()).toBeTruthy();
  });

  it('moves the focus to the heading when the layout takes away the control that had it', async () => {
    const { resize } = setup({ width: 1200 });
    const row = screen.getByRole('button', { name: 'Notificaciones' });
    fireEvent.click(row);
    row.focus();
    const notifications = await sectionHeading('Notificaciones');
    resize(700);
    expect(document.activeElement).toBe(notifications);

    const back = screen.getByRole('button', { name: 'Volver a ajustes' });
    back.focus();
    resize(1200);
    expect(back.isConnected).toBe(false);
    expect(document.activeElement).toBe(notifications);
  });

  it('keeps the list and its focus when one pane turns into two', async () => {
    const { resize } = setup({ width: 700 });
    const row = screen.getByRole('button', { name: 'Idioma' });
    row.focus();
    resize(1200);
    expect(await sectionHeading('Privacidad')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Idioma' })).toBe(row);
    expect(document.activeElement).toBe(row);
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

  // The profile and "Tu código QR" open from your card, not from a row of
  // the groups: going back on one pane gives the focus to the card's button.
  it('gives the focus back to your card after Perfil or your QR code on one pane', async () => {
    setup({ width: 700 });
    fireEvent.click(await within(nav()!).findByRole('button', { name: card('rechita') }));
    await sectionHeading('Perfil');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a ajustes' }));
    expect(document.activeElement).toBe(within(nav()!).getByRole('button', { name: card('rechita') }));

    fireEvent.click(screen.getByRole('button', { name: 'Mostrar tu código QR' }));
    fireEvent.keyDown(await sectionHeading('Tu código QR'), { key: 'Escape' });
    expect(document.activeElement).toBe(within(nav()!).getByRole('button', { name: 'Mostrar tu código QR' }));
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
    expect(await within(nav()!).findByRole('button', { name: card('rechi') })).toBeTruthy();
    expect(within(nav()!).queryByRole('button', { name: /rechita/ })).toBeNull();
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

  // "Reintentar" goes away as the profile is read again, and the view that
  // shows it replaces the one that waited: the heading keeps the focus.
  it('keeps the focus on the profile’s heading while it is read again, and once it is', async () => {
    const getProfile = vi
      .fn<SettingsApi['getProfile']>()
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockResolvedValue(PROFILE);
    setup({ initial: 'profile', api: { getProfile } });
    await screen.findByRole('alert');
    const first = screen.getByRole('button', { name: 'Reintentar' });
    first.focus();
    fireEvent.click(first);
    await waitFor(() => expect(getProfile).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Perfil' }));

    const second = screen.getByRole('button', { name: 'Reintentar' });
    second.focus();
    fireEvent.click(second);
    await screen.findByRole('textbox', { name: 'Nombre' });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Perfil' }));
  });

  it('hands the slot’s actions to its sections', async () => {
    const { spies } = setup({ initial: 'security' });
    await sectionHeading('Cuenta y seguridad');
    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(spies.onLockNow).toHaveBeenCalledTimes(1);
  });
});
