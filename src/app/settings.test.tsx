// @vitest-environment jsdom
import { getVersion } from '@tauri-apps/api/app';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdAccessibility, holdAppearance, holdScanLines } from '../design/apply';
import { AppearanceProvider } from '../design/useAppearance';
import { api, notify, onRelayEvent, type NodeInfo } from '../lib/api';
import { fakeApi, fakeHost, memoryPrefs, node, withLang } from '../screens/settings/test-utils';
import type { SettingsCapabilities } from '../screens/settings';
import { platformOf, settingsBackend, useSettings, type SettingsBackend } from './settings';

// Settings in the old chats (plan §4, I2): SettingsScreen (W5) as a layer
// over the whole shell, in place of SettingsModal, until I6. A fake backend
// and a stand-in for the old shell drive it: its button "ajustes" and its
// panes, which the layer makes inert.

beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
  // "Tu código QR" draws the QR's PNG on a canvas, which jsdom does not have.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BUNDLE = JSON.stringify({
  handle: 'rechita',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});

function setup({
  nodes = [] as NodeInfo[],
  capabilities = undefined as SettingsCapabilities | undefined,
} = {}) {
  let current = nodes;
  const backend: SettingsBackend = {
    ...fakeApi({
      listNodes: vi.fn(async () => current),
      blockNode: vi.fn(async (handle: string, blocked: boolean) => {
        current = current.map(other => (other.handle === handle ? { ...other, blocked } : other));
      }),
      connectionStatus: vi.fn(async () => ({
        up: 1,
        total: 1,
        relays: [{ url: 'wss://relay.example', connected: true }],
      })),
    }),
    shareBundle: vi.fn(async () => BUNDLE),
  };
  const { prefs, storage } = memoryPrefs();
  const spies = {
    onLockNow: vi.fn<() => void>(),
    onIdentityWiped: vi.fn<() => void>(),
    onAutolockChanged: vi.fn<(minutes: number) => void>(),
    onProfileChanged: vi.fn<() => void>(),
    onContactsChanged: vi.fn<() => void>(),
  };

  function OldShell() {
    // The call screen of I5, which covers the shell and Settings with it.
    const [callCovering, setCallCovering] = useState(false);
    const settings = useSettings({
      api: backend,
      ...spies,
      platform: 'windows',
      ...(capabilities && { capabilities }),
      prefs,
      makeAvatar: async () => 'data:image/jpeg;base64,AAAA',
      covered: callCovering,
    });
    return (
      <div className="relative">
        <div data-testid="panes" inert={settings.isOpen}>
          <button type="button" title="ajustes" onClick={() => settings.open()} />
        </div>
        {settings.layer}
        <button type="button" onClick={() => setCallCovering(covering => !covering)}>
          una llamada cubre la ventana
        </button>
      </div>
    );
  }

  const { host } = fakeHost();
  render(
    withLang(
      <AppearanceProvider host={host}>
        <OldShell />
      </AppearanceProvider>,
    ),
  );
  const panes = screen.getByTestId('panes');
  const opener = screen.getByRole('button', { name: 'ajustes' });
  const open = () => {
    opener.focus();
    fireEvent.click(opener);
    return screen.getByRole('region', { name: 'Ajustes' });
  };
  const toggleCall = () => fireEvent.click(screen.getByRole('button', { name: 'una llamada cubre la ventana' }));
  return { backend, spies, storage, panes, opener, open, toggleCall };
}

const sectionHeading = (name: string) => screen.findByRole('heading', { level: 2, name });
const goTo = async (section: string) => {
  const nav = screen.getByRole('navigation', { name: 'Secciones de ajustes' });
  fireEvent.click(within(nav).getByRole('button', { name: section }));
  return sectionHeading(section);
};

describe('useSettings', () => {
  it('opens on Perfil over the shell, inert behind it, and gives the focus back once closed', async () => {
    const { panes, opener, open } = setup();
    expect(screen.queryByRole('region', { name: 'Ajustes' })).toBeNull();
    expect(panes.hasAttribute('inert')).toBe(false);

    const layer = open();
    expect(document.activeElement).toBe(layer);
    expect(await sectionHeading('Perfil')).toBeTruthy();
    expect(panes.hasAttribute('inert')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar ajustes' }));
    expect(screen.queryByRole('region', { name: 'Ajustes' })).toBeNull();
    expect(panes.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  // A call answered while Settings is open covers it (I5): nothing hidden under the call screen
  // keeps the focus, so the layer goes inert like the panes, and comes back when the call goes.
  it('goes inert while a call screen covers it', async () => {
    const { open, toggleCall } = setup();
    const layer = open();
    await sectionHeading('Perfil');
    expect(layer.hasAttribute('inert')).toBe(false);

    toggleCall();
    expect(layer.hasAttribute('inert')).toBe(true);
    toggleCall();
    expect(layer.hasAttribute('inert')).toBe(false);
  });

  // The layer itself has the focus as it opens, outside the screen that
  // hears Escape.
  it('closes with Escape right after opening', async () => {
    const { opener, open } = setup();
    const layer = open();
    await sectionHeading('Perfil');
    fireEvent.keyDown(layer, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Ajustes' })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('closes with Escape, and opens again on the section it was left on', async () => {
    const { opener, open } = setup();
    open();
    const heading = await goTo('Privacidad');
    fireEvent.keyDown(heading, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Ajustes' })).toBeNull();
    expect(document.activeElement).toBe(opener);

    open();
    expect(await sectionHeading('Privacidad')).toBeTruthy();
  });

  it('shows Contactos’ share panel as "Tu código QR", with your trino2 code', async () => {
    const { backend, open } = setup();
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Mostrar tu código QR' }));
    expect(await sectionHeading('Tu código QR')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Copiar código' })).toBeTruthy();
    expect(screen.getByText(/^trino2:/)).toBeTruthy();
    expect(backend.shareBundle).toHaveBeenCalled();
  });

  it('tells the shell to read its contacts again once one is unblocked', async () => {
    const { backend, spies, open } = setup({ nodes: [node('ana', { blocked: true }), node('beto')] });
    open();
    await goTo('Privacidad');
    fireEvent.click(await screen.findByRole('button', { name: /Contactos bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(spies.onContactsChanged).toHaveBeenCalledTimes(1));
    expect(backend.blockNode).toHaveBeenCalledWith('ana', false);
  });

  it('hands the lock and a new auto-lock time to the app', async () => {
    const { spies, storage, open } = setup();
    open();
    await goTo('Cuenta y seguridad');
    fireEvent.change(screen.getByLabelText('Bloqueo automático'), { target: { value: '1' } });
    expect(spies.onAutolockChanged).toHaveBeenCalledWith(1);
    expect(storage.data.get('autolock')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Bloquear' }));
    expect(spies.onLockNow).toHaveBeenCalledTimes(1);
  });

  it('hands over to the app’s wipe once everything is erased', async () => {
    const { backend, spies, open } = setup();
    open();
    await goTo('Cuenta y seguridad');
    fireEvent.click(screen.getByRole('button', { name: 'Borrar todo de este equipo' }));
    const dialog = await screen.findByRole('alertdialog', { name: '¿Borrar todo de este equipo?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Borrar todo' }));
    await waitFor(() => expect(spies.onIdentityWiped).toHaveBeenCalledTimes(1));
    expect(backend.wipe).toHaveBeenCalledTimes(1);
  });

  it('tells the shell once your profile is saved', async () => {
    const { backend, spies, open } = setup();
    open();
    await sectionHeading('Perfil');
    fireEvent.change(await screen.findByLabelText('Nombre'), { target: { value: 'rechi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(spies.onProfileChanged).toHaveBeenCalledTimes(1));
    expect(backend.updateProfile).toHaveBeenCalledWith('rechi', null, 'Respondo en las tardes.');
  });

  // I0 brought K3, K5 and K6: by default the layer shows what this build has.
  it('shows by default what this build’s backend can do', async () => {
    const { open } = setup();
    open();
    await goTo('Cuenta y seguridad');
    expect(screen.getByRole('button', { name: 'Cambiar contraseña' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Activar' })).toBeTruthy();
    await goTo('Avanzado');
    const relays = await screen.findByRole('list', { name: 'Servidores de mensajes' });
    expect(within(relays).getByText('wss://relay.example')).toBeTruthy();
  });

  it('leaves out what the backend cannot do', async () => {
    const { open } = setup({
      capabilities: { totp: false, changePassphrase: false, relayStatus: false, profileSync: false, diagnosticLog: false },
    });
    open();
    await goTo('Cuenta y seguridad');
    expect(screen.queryByRole('button', { name: 'Cambiar contraseña' })).toBeNull();
    await goTo('Avanzado');
    expect(screen.queryByRole('list', { name: 'Servidores de mensajes' })).toBeNull();
    expect(screen.queryByText(/trino-gui\.log/)).toBeNull();
  });
});

describe('platformOf', () => {
  it.each([
    ['windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'],
    ['macos', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'],
    ['linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15'],
    ['linux', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'],
    ['macos', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'],
  ])('reads %s from the webview of %s', (platform, userAgent) => {
    expect(platformOf(userAgent)).toBe(platform);
  });
});

describe('settingsBackend', () => {
  it('is the app’s backend: src/lib/api.ts and the version Tauri gives', () => {
    const fromApi = [
      'getProfile',
      'updateProfile',
      'status',
      'totpBegin',
      'totpVerify',
      'totpEnable',
      'totpDisable',
      'changePassphrase',
      'wipe',
      'getAutostart',
      'setAutostart',
      'connectionStatus',
      'relayInspectStart',
      'relayInspectStop',
      'listNodes',
      'blockNode',
      'shareBundle',
    ] as const;
    for (const key of fromApi) expect(settingsBackend[key], key).toBe(api[key]);
    expect(settingsBackend.onRelayEvent).toBe(onRelayEvent);
    expect(settingsBackend.notify).toBe(notify);
    expect(settingsBackend.getVersion).toBe(getVersion);
    // Nothing more and nothing less than Settings asks for.
    expect(Object.keys(settingsBackend).sort()).toEqual([...fromApi, 'onRelayEvent', 'notify', 'getVersion'].sort());
  });
});
