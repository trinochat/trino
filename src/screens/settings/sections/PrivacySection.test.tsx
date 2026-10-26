// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BlockedView } from '../../../lib/api';
import type { Lang } from '../../../lib/i18n';
import type { Prefs } from '../../../lib/prefs';
import { prefsSession } from '../../../lib/prefs-session';
import { blockedView, fakeApi, memoryPrefs, renderEs, withLang } from '../test-utils';
import type { SettingsApi, SettingsPlatform } from '../types';
import { fakeNet } from '../../net/test-support';
import { PrivacySection } from './PrivacySection';

afterEach(cleanup);

const CALLS_LINE =
  'En las llamadas, Cloudflare —la empresa que pasa el audio— ve desde dónde te conectas. Tu contacto no lo ve. Trino pide cada llamada por separado, para que Cloudflare no la una con tu cuenta.';

function setup(blocked: BlockedView[]) {
  let current = blocked;
  const api = fakeApi({
    listBlocked: vi.fn(async () => current),
    unblockIdentity: vi.fn(async (key: string) => {
      const gone = current.find(view => view.key === key)!;
      current = current.filter(view => view.key !== key);
      return gone;
    }),
  });
  const onContactsChanged = vi.fn();
  const { prefs } = memoryPrefs();
  const view = renderEs(
    <PrivacySection api={api} prefs={prefs} platform="windows" onContactsChanged={onContactsChanged} />,
  );
  return { ...view, api, onContactsChanged };
}

// Settings > Privacidad (plan-cambios-11oct §4 W5): whom you blocked (UR-2:
// by identity, contacts or not) and the line on calls; nothing about Tor,
// the old IP warning or @names.
describe('PrivacySection', () => {
  it('counts whom you blocked on their row', async () => {
    setup([blockedView('ana'), blockedView('jhon', { from: 'group', contact: null })]);
    const rows = screen.getByRole('list', { name: 'Privacidad' });
    expect(await within(rows).findByRole('button', { name: /Bloqueados\s*2/ })).toBeTruthy();
  });

  it('says "Ninguno" without any', async () => {
    setup([]);
    expect(await screen.findByRole('button', { name: /Bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('opens the list and unblocks by key', async () => {
    const { api, onContactsChanged } = setup([blockedView('ana')]);
    fireEvent.click(await screen.findByRole('button', { name: /Bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await waitFor(() => expect(api.unblockIdentity).toHaveBeenCalledWith('key-ana'));
    expect(await screen.findByText('No has bloqueado a nadie.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^Desbloqueaste a ana\./);
    expect(onContactsChanged).toHaveBeenCalledTimes(1);
  });

  it('comes back from the list with the new count', async () => {
    setup([blockedView('ana')]);
    fireEvent.click(await screen.findByRole('button', { name: /Bloqueados\s*1/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    await screen.findByText('No has bloqueado a nadie.');
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(await screen.findByRole('button', { name: /Bloqueados\s*Ninguno/ })).toBeTruthy();
  });

  it('says that calls go through Cloudflare, which sees your IP', () => {
    setup([]);
    expect(screen.getByText(CALLS_LINE)).toBeTruthy();
  });

  it('has no IP warning, no Tor, no "Quién puede escribirte", no @name and no default timer', async () => {
    const { container, api } = setup([blockedView('ana')]);
    await waitFor(() => expect(api.listBlocked).toHaveBeenCalled());
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Avisar|antes de una llamada que muestra|(?<!\p{L})Tor(?!\p{L})|Quién puede escribirte|@|por defecto/u);
    expect(screen.queryAllByRole('radiogroup')).toEqual([]);
    // The switches are locking with Windows (CL-6a), Protección reforzada
    // (CL-6b) and the block of screen captures (SC-1).
    expect(screen.getAllByRole('switch').map(nameOf)).toEqual([
      'Bloquear Trino al bloquear Windows',
      'Protección reforzada',
      'Bloquear capturas de pantalla',
    ]);
  });

  it('says so when the list cannot be read', async () => {
    const api = fakeApi({ listBlocked: vi.fn(async () => Promise.reject(new Error('no_vault'))) });
    renderEs(<PrivacySection api={api} prefs={memoryPrefs().prefs} platform="windows" />);
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de bloqueados.');
  });

  // Without the list, the app does not know who is blocked: the list says
  // so and tries again, and never says that nobody is.
  it('says in the list that it could not be read, and reads it again', async () => {
    const listBlocked = vi
      .fn<SettingsApi['listBlocked']>()
      .mockRejectedValueOnce(new Error('no_vault'))
      .mockResolvedValue([blockedView('ana')]);
    renderEs(<PrivacySection api={fakeApi({ listBlocked })} prefs={memoryPrefs().prefs} platform="windows" />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Bloqueados/ }));
    const heading = await screen.findByRole('heading', { name: 'Bloqueados' });
    expect(screen.getByRole('alert').textContent).toContain('No se pudo cargar la lista de bloqueados.');
    expect(screen.queryByText('No has bloqueado a nadie.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('button', { name: 'Desbloquear a ana' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it('says so when the list cannot be read again after an unblock, without the one unblocked', async () => {
    const listBlocked = vi
      .fn<SettingsApi['listBlocked']>()
      .mockResolvedValueOnce([blockedView('ana'), blockedView('beto')])
      .mockRejectedValue(new Error('io'));
    const unblockIdentity = vi.fn(async () => blockedView('ana'));
    renderEs(
      <PrivacySection api={fakeApi({ listBlocked, unblockIdentity })} prefs={memoryPrefs().prefs} platform="windows" />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Bloqueados\s*2/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Desbloquear a ana' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo cargar la lista de bloqueados.');
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

const LOCK_WITH_WINDOWS = 'Bloquear Trino al bloquear Windows';
const LOCK_WITH_WINDOWS_BODY = 'También al suspender o hibernar el computador. Si estás en una llamada, al colgar.';

// Cifrado local CL-6a (design §7.2 and §11.1; David's decision 4): Trino
// locks when Windows locks, sleeps or hibernates, on by default, and the
// switch lives in "En este equipo". Only Windows has it.
describe('PrivacySection, locking with Windows', () => {
  it('is on by default in "En este equipo", and says when else it locks', () => {
    captures();
    const toggle = screen.getByRole('switch', { name: LOCK_WITH_WINDOWS });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(descriptionOf(toggle)).toBe(LOCK_WITH_WINDOWS_BODY);
    const group = screen.getByRole('heading', { level: 3, name: 'En este equipo' }).parentElement!;
    expect(within(group).getByRole('switch', { name: LOCK_WITH_WINDOWS })).toBe(toggle);
  });

  it('shows what the account chose, and keeps each change', async () => {
    const { storage } = captures({ stored: { 'trino.pref.lockWithSystem': '0' } });
    const toggle = () => screen.getByRole('switch', { name: LOCK_WITH_WINDOWS });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle());
    await waitFor(() => expect(storage.data.get('trino.pref.lockWithSystem')).toBe('1'));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(storage.data.get('trino.pref.lockWithSystem')).toBe('0'));
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('goes back and says so when the change cannot be kept', async () => {
    const prefs: Prefs = { ...memoryPrefs().prefs, getLockWithSystem: () => true, setLockWithSystem: () => false };
    captures({ prefs });
    fireEvent.click(screen.getByRole('switch', { name: LOCK_WITH_WINDOWS }));
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo guardar el cambio. Sigue como estaba.');
    expect(screen.getByRole('switch', { name: LOCK_WITH_WINDOWS }).getAttribute('aria-checked')).toBe('true');
  });

  it.each(['macos', 'linux'] as const)('is not there on %s, where nothing would lock', platform => {
    captures({ platform });
    expect(screen.queryByRole('switch', { name: LOCK_WITH_WINDOWS })).toBeNull();
  });

  it.each([
    ['en', 'Lock Trino when Windows locks', 'Also when the computer sleeps or hibernates. If you are on a call, when it ends.'],
    [
      'pt',
      'Bloquear o Trino ao bloquear o Windows',
      'Também ao suspender ou hibernar o computador. Se você estiver em uma chamada, ao desligar.',
    ],
  ] as const)('speaks %s', (lang, label, body) => {
    captures({ lang });
    const toggle = screen.getByRole('switch', { name: label });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(descriptionOf(toggle)).toBe(body);
  });
});

const REINFORCED = 'Protección reforzada';
const REINFORCED_OFF = 'Para cuando tu computador corre más riesgo. Cambia varios ajustes a la vez.';
const REINFORCED_ON =
  'Se bloquea al minuto, las notificaciones no dicen quién escribe, la ventana sale en negro o no aparece en las capturas de pantalla y lo que copias se borra a los 30 segundos.';
const REINFORCED_TIP =
  'También ayuda activar el cifrado del dispositivo (BitLocker) y apagar o hibernar el computador cuando lo pierdas de vista.';

function reinforced(options: { stored?: Record<string, string>; platform?: SettingsPlatform; lang?: Lang; api?: Partial<SettingsApi> } = {}) {
  const { prefs, storage } = memoryPrefs(options.stored);
  const api = fakeApi(options.api);
  const onAutolockChanged = vi.fn();
  render(
    withLang(
      <PrivacySection api={api} prefs={prefs} platform={options.platform ?? 'windows'} onAutolockChanged={onAutolockChanged} />,
      options.lang ?? 'es',
    ),
  );
  const toggle = (name = REINFORCED) => screen.getByRole('switch', { name });
  return { api, prefs, storage, onAutolockChanged, toggle };
}

// Cifrado local CL-6b (design §10 and §11.1; David's decision 5): a switch,
// off by default, that sets the stricter values together; each can still be
// changed on its own after. Turning it off gives back what it changed.
describe('PrivacySection, Protección reforzada', () => {
  it('is off by default in "En este equipo", after locking with Windows, and says what it is for', () => {
    const { toggle } = reinforced();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(descriptionOf(toggle())).toBe(REINFORCED_OFF);
    const group = screen.getByRole('heading', { level: 3, name: 'En este equipo' }).parentElement!;
    expect(within(group).getAllByRole('switch').map(nameOf)).toEqual([LOCK_WITH_WINDOWS, REINFORCED]);
    expect(screen.queryByText(REINFORCED_TIP)).toBeNull();
  });

  it('sets the stricter values at once and says what it did', async () => {
    const stored = { autolock: '15', 'trino.pref.lockWithSystem': '0', 'trino.pref.notifPreview': 'full', 'trino.pref.blockCaptures': '0' };
    const { api, storage, onAutolockChanged, toggle } = reinforced({ stored });
    expect(toggle(LOCK_WITH_WINDOWS).getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(descriptionOf(toggle())).toBe(REINFORCED_ON);
    expect(screen.getByText(REINFORCED_TIP)).toBeTruthy();
    expect(storage.data.get('trino.pref.reinforced')).toBe('1');
    expect(storage.data.get('autolock')).toBe('1');
    expect(storage.data.get('trino.pref.notifPreview')).toBe('none');
    expect(api.setContentProtected).toHaveBeenLastCalledWith(true);
    expect(onAutolockChanged).toHaveBeenLastCalledWith(1);
    // The switches of the same section show the new values.
    expect(toggle(LOCK_WITH_WINDOWS).getAttribute('aria-checked')).toBe('true');
    expect(toggle('Bloquear capturas de pantalla').getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives back what it changed when turned off', async () => {
    const stored = { autolock: '15', 'trino.pref.lockWithSystem': '0', 'trino.pref.notifPreview': 'full', 'trino.pref.blockCaptures': '0' };
    const { api, storage, onAutolockChanged, toggle } = reinforced({ stored });
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(descriptionOf(toggle())).toBe(REINFORCED_OFF);
    expect(storage.data.get('trino.pref.reinforced')).toBe('0');
    expect(storage.data.get('autolock')).toBe('15');
    expect(storage.data.get('trino.pref.notifPreview')).toBe('full');
    expect(api.setContentProtected).toHaveBeenLastCalledWith(false);
    expect(onAutolockChanged).toHaveBeenLastCalledWith(15);
    expect(toggle(LOCK_WITH_WINDOWS).getAttribute('aria-checked')).toBe('false');
    expect(toggle('Bloquear capturas de pantalla').getAttribute('aria-checked')).toBe('false');
  });

  it('says so when not everything could change, and stays on', async () => {
    const { toggle, storage } = reinforced({
      stored: { 'trino.pref.blockCaptures': '0' },
      api: { setContentProtected: vi.fn(async () => Promise.reject(new Error('window'))) },
    });
    fireEvent.click(toggle());
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudieron cambiar todos los ajustes. Revisa cada uno.');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(storage.data.get('trino.pref.blockCaptures')).toBe('0');
    expect(toggle('Bloquear capturas de pantalla').getAttribute('aria-checked')).toBe('false');
  });

  it.each(['macos', 'linux'] as const)('is not there on %s, where Trino does not copy through Windows', platform => {
    reinforced({ platform });
    expect(screen.queryByRole('switch', { name: REINFORCED })).toBeNull();
  });

  it.each([
    [
      'en',
      'Enhanced protection',
      'For when your computer is at greater risk. It changes several settings at once.',
      'Locks after a minute, notifications do not say who is writing, the window comes out black or does not appear in screenshots and what you copy is cleared after 30 seconds.',
      'It also helps to turn on device encryption (BitLocker) and to shut down or hibernate the computer when it is out of your sight.',
    ],
    [
      'pt',
      'Proteção reforçada',
      'Para quando seu computador corre mais risco. Muda vários ajustes de uma vez.',
      'Bloqueia depois de um minuto, as notificações não dizem quem escreve, a janela fica preta ou não aparece nas capturas de tela e o que você copia é apagado depois de 30 segundos.',
      'Também ajuda ativar a criptografia do dispositivo (BitLocker) e desligar ou hibernar o computador quando ele ficar fora da sua vista.',
    ],
  ] as const)('speaks %s', async (lang, label, off, on, tip) => {
    const { toggle } = reinforced({ lang });
    expect(descriptionOf(toggle(label))).toBe(off);
    fireEvent.click(toggle(label));
    await waitFor(() => expect(toggle(label).getAttribute('aria-checked')).toBe('true'));
    expect(descriptionOf(toggle(label))).toBe(on);
    expect(screen.getByText(tip)).toBeTruthy();
  });
});

// Cifrado local CL-2b (design §11.1 and §11.2): "En este equipo", under the
// blocked contacts, with what Trino keeps on this device and how.
describe('PrivacySection, your data on this device', () => {
  it('has a group "En este equipo" with a row that says what is encrypted', () => {
    setup([]);
    expect(screen.getByRole('heading', { level: 3, name: 'En este equipo' })).toBeTruthy();
    const rows = screen.getByRole('list', { name: 'En este equipo' });
    expect(
      within(rows).getByRole('button', {
        name: /^Tus datos en este equipo\s*Cifrados con tu contraseña, menos lo que usa la pantalla de desbloqueo\.$/,
      }),
    ).toBeTruthy();
  });

  it('opens what is encrypted, what is not and why, and what is outside Trino', () => {
    setup([]);
    fireEvent.click(screen.getByRole('button', { name: /Tus datos en este equipo/ }));
    const heading = screen.getByRole('heading', { level: 2, name: 'Tus datos en este equipo' });
    expect(document.activeElement).toBe(heading);
    const listed = (name: string) =>
      within(screen.getByRole('list', { name }))
        .getAllByRole('listitem')
        .map(item => item.textContent);
    expect(listed('Cifrado con tu contraseña')).toEqual([
      'Tu identidad y tus chats',
      'Tus contactos, tus grupos y a quién bloqueaste',
      'Tu perfil y tus stickers',
      'Tus notas, las marcas de verificado y los temporizadores',
    ]);
    // trino.pref.blockCaptures stays in the WebView with the appearance
    // (prefs-session.ts DEVICE_KEYS), so the list says so.
    expect(listed('Sin cifrar, para la pantalla de desbloqueo')).toEqual([
      'Que hay una cuenta y si pide código',
      'El idioma, la apariencia y la accesibilidad',
      'Si Trino bloquea las capturas de pantalla',
    ]);
    expect(screen.queryByRole('list', { name: 'Todavía sin cifrar' })).toBeNull();
    expect(listed('Fuera de Trino')).toEqual([
      'Windows guarda una copia de cada notificación. Con «Solo el nombre», ahí quedan el nombre de quien te escribe o del grupo, y el de quien te llama.',
      'Lo que descargas queda como cualquier archivo de tu computador.',
      'Lo que copias en Trino no entra al historial del portapapeles de Windows. Otros programas que guardan lo que copias pueden ignorarlo.',
    ]);
    expect(screen.getByText('Si copiaste la carpeta .trino antes de esta versión, esa copia sigue sin cifrar.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(screen.getByRole('button', { name: /Tus datos en este equipo/ })).toBeTruthy();
  });

  it('names the system that keeps the notifications only on Windows', () => {
    renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="macos" />);
    fireEvent.click(screen.getByRole('button', { name: /Tus datos en este equipo/ }));
    expect(
      screen.getByText(
        'Tu sistema puede guardar una copia de cada notificación. Con «Solo el nombre», ahí quedan el nombre de quien te escribe o del grupo, y el de quien te llama.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Windows/)).toBeNull();
    // Only Windows copies without the clipboard history (CL-6b).
    expect(screen.queryByText(/portapapeles/)).toBeNull();
  });

  it('leaves the captures out of what stays in clear on Linux, which has no such switch', () => {
    renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="linux" />);
    fireEvent.click(screen.getByRole('button', { name: /Tus datos en este equipo/ }));
    expect(screen.queryByText('Si Trino bloquea las capturas de pantalla')).toBeNull();
  });

  // An account whose migration stopped before its commit (prefs_import
  // "unavailable", Storage::Legacy) still keeps its contacts, groups, profile,
  // stickers and notes as earlier versions did: the texts must not say they
  // are encrypted.
  it('says what is not encrypted yet when the account has not moved to the store', () => {
    renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="windows" dataMoved={false} />);
    const row = screen.getByRole('button', { name: /^Tus datos en este equipo\s*Todavía no están todos cifrados\.$/ });
    fireEvent.click(row);
    const listed = (name: string) =>
      within(screen.getByRole('list', { name }))
        .getAllByRole('listitem')
        .map(item => item.textContent);
    expect(listed('Cifrado con tu contraseña')).toEqual(['Tu identidad y tus chats']);
    expect(listed('Todavía sin cifrar')).toEqual([
      'Tus contactos, tus grupos y a quién bloqueaste',
      'Tu perfil y tus stickers',
      'Tus notas, las marcas de verificado y los temporizadores',
    ]);
    expect(
      screen.getByText(
        'Trino no pudo terminar de cifrarlos en este equipo y lo vuelve a intentar la próxima vez que lo desbloquees.',
      ),
    ).toBeTruthy();
  });

  it('knows by itself from the open session whether the account has moved', () => {
    prefsSession.open({ mode: 'legacy', prefs: null, save: async () => {} });
    try {
      renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="windows" />);
      expect(screen.getByRole('button', { name: /Todavía no están todos cifrados\./ })).toBeTruthy();
      cleanup();
      prefsSession.open({ mode: 'store', prefs: {}, save: async () => {} });
      renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="windows" />);
      expect(screen.getByRole('button', { name: /Cifrados con tu contraseña, menos lo que usa la pantalla de desbloqueo\./ })).toBeTruthy();
    } finally {
      prefsSession.discard();
    }
  });

  it.each([
    ['en', 'Your data on this device', 'Encrypted with your password'],
    ['pt', 'Seus dados neste dispositivo', 'Criptografado com sua senha'],
  ] as const)('speaks %s', (lang, row, encrypted) => {
    render(withLang(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="windows" />, lang));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(row) }));
    expect(screen.getByRole('list', { name: encrypted })).toBeTruthy();
  });
});

// TOR-6 (PropTorSimple, card 6): with the network, "Conexión" leads the
// list, with its state, and opens its view; back comes to Privacidad.
describe('PrivacySection: Conexión', () => {
  it('leads the list with the state of the connection, and opens it', async () => {
    const { api: net } = fakeNet({ state: 'starting', pct: 30 });
    const { prefs } = memoryPrefs();
    renderEs(<PrivacySection api={fakeApi()} prefs={prefs} platform="windows" net={net} />);
    const rows = screen.getByRole('list', { name: 'Privacidad' });
    const first = within(rows).getAllByRole('button')[0]!;
    await waitFor(() => expect(first.textContent).toBe('ConexiónConectando de forma privada…'));
    fireEvent.click(first);
    expect(await screen.findByRole('heading', { name: 'Conexión' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Volver a Privacidad' }));
    expect(await screen.findByRole('heading', { name: 'Privacidad' })).toBeTruthy();
  });

  it('says "Sin protección" on its row while it lasts', async () => {
    const { api: net } = fakeNet({ state: 'direct' });
    renderEs(<PrivacySection api={fakeApi()} prefs={memoryPrefs().prefs} platform="windows" net={net} />);
    expect(await screen.findByRole('button', { name: /Conexión\s*Sin protección hasta que cierres Trino/ })).toBeTruthy();
  });
});
