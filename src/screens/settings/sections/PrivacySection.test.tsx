// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NodeInfo } from '../../../lib/api';
import type { Lang } from '../../../lib/i18n';
import type { Prefs } from '../../../lib/prefs';
import { fakeApi, memoryPrefs, node, renderEs, withLang } from '../test-utils';
import type { SettingsApi, SettingsPlatform } from '../types';
import { PrivacySection } from './PrivacySection';

afterEach(cleanup);

const CALLS_LINE =
  'Tus llamadas pasan por un servidor de Cloudflare: tu contacto no ve tu IP, pero Cloudflare sí. Si una llamada no se puede proteger, Trino te pregunta antes de llamar directo.';

function setup(nodes: NodeInfo[]) {
  let current = nodes;
  const api = fakeApi({
    listNodes: vi.fn(async () => current),
    blockNode: vi.fn(async (handle: string, blocked: boolean) => {
      current = current.map(n => (n.handle === handle ? { ...n, blocked } : n));
    }),
  });
  const onContactsChanged = vi.fn();
  const { prefs } = memoryPrefs();
  const view = renderEs(
    <PrivacySection api={api} prefs={prefs} platform="windows" onContactsChanged={onContactsChanged} />,
  );
  return { ...view, api, onContactsChanged };
}

// Settings > Privacidad (plan-cambios-11oct §4 W5): the blocked contacts and
// the line on calls; nothing about Tor, the old IP warning or @names.
describe('PrivacySection', () => {
  it('counts the blocked contacts on their row', async () => {
    setup([node('ana', { blocked: true }), node('beto', { blocked: true }), node('caro')]);
    const rows = screen.getByRole('list', { name: 'Privacidad' });
    expect(await within(rows).findByRole('button', { name: /Contactos bloqueados\s*2/ })).toBeTruthy();
  });

  it('says "Ninguno" without any', async () => {
    setup([node('caro')]);
    expect(await screen.findByRole('button', { name: /Contactos bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('opens the list and unblocks with blockNode(handle, false)', async () => {
    const { api, onContactsChanged } = setup([node('ana', { blocked: true }), node('caro')]);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(api.blockNode).toHaveBeenCalledWith('ana', false));
    expect(await screen.findByText('No tienes contactos bloqueados.')).toBeTruthy();
    expect(onContactsChanged).toHaveBeenCalledTimes(1);
  });

  it('comes back from the list with the new count', async () => {
    setup([node('ana', { blocked: true })]);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await screen.findByText('No tienes contactos bloqueados.');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(await screen.findByRole('button', { name: /Contactos bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('says that calls go through Cloudflare, which sees your IP', () => {
    setup([]);
    expect(screen.getByText(CALLS_LINE)).toBeTruthy();
  });

  it('has no IP warning, no Tor, no "Quién puede escribirte", no @name and no default timer', async () => {
    const { container, api } = setup([node('ana', { blocked: true })]);
    await waitFor(() => expect(api.listNodes).toHaveBeenCalled());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Avisar|antes de una llamada que muestra|(?<!\p{L})Tor(?!\p{L})|Quién puede escribirte|@|por defecto/u);
    expect(screen.queryAllByRole('radiogroup')).toEqual([]);
    // The one switch is the block of screen captures (SC-1).
    expect(screen.getAllByRole('switch').map(nameOf)).toEqual([
      'Bloquear capturas de pantalla',
    ]);
  });

  it('says so when the contacts cannot be read', async () => {
    const api = fakeApi({ listNodes: vi.fn(async () => Promise.reject(new Error('no_vault'))) });
    renderEs(<PrivacySection api={api} prefs={memoryPrefs().prefs} platform="windows" />);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de contactos.');
  });

  // Without the contacts, the app does not know who is blocked: the list
  // says so and tries again, and never says that nobody is.
  it('says in the list that the contacts could not be read, and reads them again', async () => {
    const listNodes = vi
      .fn<SettingsApi['listNodes']>()
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockResolvedValue([node('ana', { blocked: true })]);
    renderEs(<PrivacySection api={fakeApi({ listNodes })} prefs={memoryPrefs().prefs} platform="windows" />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Contactos bloqueados/ }));
    const heading = await screen.findByRole('heading', { name: 'Contactos bloqueados' });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar la lista de contactos.');
    expect(screen.queryByText('No tienes contactos bloqueados.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Desbloquear a ana' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it('says so when the list cannot be read again after an unblock, without the contact unblocked', async () => {
    const listNodes = vi
      .fn<SettingsApi['listNodes']>()
      .mockResolvedValueOnce([node('ana', { blocked: true }), node('beto', { blocked: true })])
      .mockRejectedValue(new Error('io'));
    renderEs(<PrivacySection api={fakeApi({ listNodes })} prefs={memoryPrefs().prefs} platform="windows" />);
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de contactos.');
    expect(screen.queryByRole('button', { name: 'Desbloquear a ana' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Desbloquear a beto' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });
});

/** A switch's name, from the label it points to. */
function nameOf(element: HTMLElement): string {
  return document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent ?? '';
}

/** What a switch's description says. */
function descriptionOf(element: HTMLElement): string {
  return document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '';
}

const CAPTURES_ES =
  'En capturas, grabaciones y al compartir pantalla (Recortes, Impr Pant, OBS, Zoom, Meet), la ventana de Trino sale en negro o no aparece. No evita que alguien le tome una foto a la pantalla con otro celular. Si usas la Lupa de Windows o necesitas compartir tu pantalla, apágalo.';

function captures(
  options: {
    stored?: Record<string, string>;
    platform?: SettingsPlatform;
    lang?: Lang;
    api?: Partial<SettingsApi>;
    prefs?: Prefs;
  } = {},
) {
  const memory = memoryPrefs(options.stored);
  const prefs = options.prefs ?? memory.prefs;
  const api = fakeApi(options.api);
  render(withLang(<PrivacySection api={api} prefs={prefs} platform={options.platform ?? 'windows'} />, options.lang ?? 'es'));
  return { api, storage: memory.storage };
}

const capturesSwitch = (name = 'Bloquear capturas de pantalla') => screen.getByRole('switch', { name });

// SC-1 (David, 12 Oct): on by default, and anyone can turn it off here. The
// window takes each change at once, through Tauri's setContentProtected, and
// the choice is kept with the appearance, readable before unlocking.
describe('PrivacySection, the block of screen captures', () => {
  it('is on by default, with honest words on what it does and does not do', () => {
    captures();
    const toggle = capturesSwitch();
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(descriptionOf(toggle)).toBe(CAPTURES_ES);
  });

  it('shows what this device chose', () => {
    captures({ stored: { 'trino.pref.blockCaptures': '0' } });
    expect(capturesSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('turns the protection off and on at once, and keeps the choice', async () => {
    const { api, storage } = captures();
    fireEvent.click(capturesSwitch());
    await waitFor(() => expect(api.setContentProtected).toHaveBeenLastCalledWith(false));
    await waitFor(() => expect(storage.data.get('trino.pref.blockCaptures')).toBe('0'));
    expect(capturesSwitch().getAttribute('aria-checked')).toBe('false');

    fireEvent.click(capturesSwitch());
    await waitFor(() => expect(api.setContentProtected).toHaveBeenLastCalledWith(true));
    await waitFor(() => expect(storage.data.get('trino.pref.blockCaptures')).toBe('1'));
    expect(capturesSwitch().getAttribute('aria-checked')).toBe('true');
    expect(api.setContentProtected).toHaveBeenCalledTimes(2);
  });

  it('goes back and says so when the window refuses, keeping nothing', async () => {
    const { storage } = captures({ api: { setContentProtected: vi.fn(async () => Promise.reject(new Error('window'))) } });
    fireEvent.click(capturesSwitch());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No se pudo cambiar la protección de la ventana. Sigue como estaba.',
    );
    expect(capturesSwitch().getAttribute('aria-checked')).toBe('true');
    expect(storage.data.has('trino.pref.blockCaptures')).toBe(false);
  });

  it('says the change lasts until Trino closes when it cannot be kept', async () => {
    const prefs: Prefs = { ...memoryPrefs().prefs, getBlockCaptures: () => true, setBlockCaptures: () => false };
    const { api } = captures({ prefs });
    fireEvent.click(capturesSwitch());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No se pudo guardar en este equipo: el cambio dura hasta que cierres Trino.',
    );
    expect(api.setContentProtected).toHaveBeenCalledWith(false);
    expect(capturesSwitch().getAttribute('aria-checked')).toBe('false');
  });

  // macOS keeps a window out of captures only when the recorder respects
  // it, and Linux has nothing for it: no switch there, so nothing is faked.
  it('tells on macOS that some recorders ignore it', () => {
    captures({ platform: 'macos' });
    expect(descriptionOf(capturesSwitch())).toBe(
      'Trino le pide a macOS que no lo muestre en capturas, grabaciones ni al compartir pantalla, pero algunas apps de grabación no lo respetan. No evita que alguien le tome una foto a la pantalla con otro celular. Si necesitas compartir tu pantalla, apágalo.',
    );
  });

  it('has no switch on Linux, where the window cannot be protected', () => {
    captures({ platform: 'linux' });
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it.each([
    [
      'en',
      'Block screenshots',
      'In screenshots, recordings and screen sharing (Snipping Tool, Print Screen, OBS, Zoom, Meet), the Trino window comes out black or does not appear. It does not stop someone from taking a photo of the screen with another phone. If you use Windows Magnifier or need to share your screen, turn it off.',
    ],
    [
      'pt',
      'Bloquear capturas de tela',
      'Em capturas, gravações e no compartilhamento de tela (Ferramenta de Captura, Print Screen, OBS, Zoom, Meet), a janela do Trino fica preta ou não aparece. Não impede que alguém tire uma foto da tela com outro celular. Se você usa a Lupa do Windows ou precisa compartilhar sua tela, desative.',
    ],
  ] as const)('speaks %s', (lang, label, body) => {
    captures({ lang });
    const toggle = capturesSwitch(label);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(descriptionOf(toggle)).toBe(body);
  });
});
