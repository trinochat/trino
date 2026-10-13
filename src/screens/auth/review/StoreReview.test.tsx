// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrityFinding, IntegrityReport, LegacyPreview } from '../../../lib/api';
import type { Lang } from '../../../lib/i18n';
import { renderAuth, resetDocument } from '../test-harness';
import type { Review } from './store-check';
import { StoreReview, type StoreReviewApi } from './StoreReview';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetDocument();
});

const finding = (file: string, what: IntegrityFinding['what'], action: IntegrityFinding['action']): IntegrityFinding => ({
  file,
  what,
  action,
});
const EMPTY: IntegrityReport = { findings: [] };
const PREVIEW: LegacyPreview = {
  handle: 'Ana',
  contacts: ['Bob', 'Caro'],
  blocked: 1,
  groups: ['Familia'],
  invitations: 0,
  conversations: 2,
  stickers: 3,
  unreadable: [],
};

function fakeApi(overrides: Partial<StoreReviewApi> = {}): StoreReviewApi {
  return {
    storeChoose: vi.fn(async () => EMPTY),
    legacyFilesPreview: vi.fn(async () => PREVIEW),
    legacyFilesImport: vi.fn(async () => EMPTY),
    legacyFilesRemove: vi.fn(async () => EMPTY),
    ...overrides,
  };
}

function setup(review: Partial<Review>, api = fakeApi(), lang?: Lang) {
  const onDone = vi.fn();
  renderAuth(<StoreReview review={{ customDataDir: false, ...review }} api={api} onDone={onDone} />, { lang });
  return { api, onDone };
}

const settle = () => act(async () => {});
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const title = () => screen.getByRole('heading', { level: 1 });

const OLDER_ACCOUNT: Partial<Review> = {
  integrity: {
    findings: [
      finding('account', 'olderCopy', 'ask'),
      finding('history', 'altered', 'setAside'),
      finding('sessions', 'olderCopy', 'newSessions'),
    ],
  },
};

describe('StoreReview, when files changed (design §6.2 and §11.4)', () => {
  // Design test 44: the dialog lists what happened and takes no choice by
  // itself; nothing closes it but an answer.
  it('lists what changed and accepts nothing by itself', async () => {
    const { api, onDone } = setup(OLDER_ACCOUNT);
    expect(title().textContent).toBe('Algunos archivos de Trino cambiaron');
    expect(document.activeElement).toBe(title());
    expect(screen.getByRole('main', { name: 'Algunos archivos de Trino cambiaron' })).toBeTruthy();
    expect(
      screen.getByText(
        'Desde la última vez, algo cambió archivos de Trino en este computador. Pudo ser una copia de seguridad que restauraste, otro programa o una persona. Trino no usó lo que no pudo comprobar.',
      ),
    ).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Lo que Trino encontró' });
    expect(within(list).getByText('Historial.')).toBeTruthy();
    expect(within(list).getByText('No se pudo comprobar: se dañó o alguien lo cambió. Trino no lo abrió y lo guardó aparte.')).toBeTruthy();
    expect(within(list).getByText('Sesiones.')).toBeTruthy();
    expect(within(list).getByText('Trino las vuelve a crear con cada contacto. No tienes que hacer nada.')).toBeTruthy();

    fireEvent.keyDown(title(), { key: 'Escape' });
    fireEvent.keyDown(title(), { key: 'Enter' });
    await settle();
    expect(api.storeChoose).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Entendido' })).toBeNull();
  });

  // Design test 67 and David's decision 3: two buttons of the same style,
  // and the text says what each one risks.
  it('offers both choices of an old copy alike, and says what each one risks', () => {
    setup(OLDER_ACCOUNT);
    const question = screen.getByRole('group', { name: 'Contactos y grupos' });
    expect(within(question).getByText('Es una copia más vieja que la última que guardó Trino.')).toBeTruthy();
    expect(
      within(question).getByText('Puede traer contactos que quitaste y desbloquear a personas que bloqueaste después.'),
    ).toBeTruthy();
    expect(within(question).getByText('Si sigues sin ella, en este equipo quedas sin contactos ni grupos.')).toBeTruthy();
    const without = within(question).getByRole('button', { name: 'Seguir sin ella' });
    const use = within(question).getByRole('button', { name: 'Usar esa copia' });
    expect(without.className).toBe(use.className);
    expect(without.className).not.toMatch(/bg-ui-accent\b/);
  });

  it('uses the copy only once you choose it, then lets you go on', async () => {
    const { api, onDone } = setup(OLDER_ACCOUNT);
    click('Usar esa copia');
    await settle();
    expect(api.storeChoose).toHaveBeenCalledWith('account', true);
    expect(screen.getByText('Listo. Trino usa lo que elegiste.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Usar esa copia' })).toBeNull();
    const done = screen.getByRole('button', { name: 'Entendido' });
    expect(document.activeElement).toBe(done);
    fireEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('asks once for everything it could not check, and goes on without it on request', async () => {
    const { api } = setup({
      integrity: {
        findings: [
          finding('index', 'altered', 'notice'),
          finding('account', 'unverified', 'ask'),
          finding('prefs', 'unverified', 'ask'),
          finding('sessions', 'unverified', 'newSessions'),
        ],
      },
    });
    const question = screen.getByRole('group', { name: 'Tus datos' });
    expect(within(question).getByText('No se pudo comprobar si son lo último que guardó Trino.')).toBeTruthy();
    expect(within(question).getByText('Contactos y grupos.')).toBeTruthy();
    expect(within(question).getByText('Notas y ajustes.')).toBeTruthy();
    expect(within(question).getByText('Si sigues sin ellos, vuelven los ajustes por defecto y quedas sin tus notas.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Usar/ })).toHaveLength(1);
    click('Seguir sin ellos');
    await settle();
    expect(vi.mocked(api.storeChoose).mock.calls).toEqual([
      ['account', false],
      ['prefs', false],
    ]);
    expect(screen.getByText('Listo. Trino sigue sin eso y lo guardó aparte.')).toBeTruthy();
  });

  it('says so when a choice cannot be kept, and asks again only for what is left', async () => {
    const storeChoose = vi
      .fn<StoreReviewApi['storeChoose']>()
      .mockResolvedValueOnce(EMPTY)
      .mockRejectedValueOnce({ code: 'io', message: 'for the log' })
      .mockResolvedValue(EMPTY);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onDone } = setup(
      {
        integrity: {
          findings: [finding('account', 'olderCopy', 'ask'), finding('history', 'olderCopy', 'ask')],
        },
      },
      fakeApi({ storeChoose }),
    );
    click('Usar esas copias');
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('No se pudo guardar tu elección. Inténtalo de nuevo.');
    expect(screen.queryByRole('button', { name: 'Entendido' })).toBeNull();
    click('Usar esas copias');
    await settle();
    expect(storeChoose.mock.calls).toEqual([
      ['account', true],
      ['history', true],
      ['history', true],
    ]);
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('only tells, with "Entendido", when there is nothing to choose', () => {
    const { onDone } = setup({
      integrity: { findings: [finding('vault', 'vaultChanged', 'notice'), finding('store', 'missing', 'empty')] },
    });
    expect(
      screen.getByText(
        'No es el archivo que Trino guardó la última vez. Pudo ser una copia de antes de cambiar la contraseña, o abriste Trino con una versión anterior.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('No encontramos tus datos en este equipo. Si los borraste tú, no tienes que hacer nada.')).toBeTruthy();
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('ends with who could have done it, and what to do', () => {
    setup(OLDER_ACCOUNT);
    expect(screen.getByText('Si no fuiste tú, alguien pudo tener acceso a este computador.')).toBeTruthy();
    const what = screen.getByRole('button', { name: 'Qué hacer' });
    expect(what.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(what);
    expect(what.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(what.getAttribute('aria-controls')!)?.textContent).toContain(
      'Si crees que alguien conoce tu contraseña de Trino, cámbiala en Ajustes › Cuenta y seguridad.',
    );
  });

  it('speaks the language of the app', () => {
    setup(OLDER_ACCOUNT, fakeApi(), 'en');
    expect(title().textContent).toBe('Some of Trino’s files changed');
    expect(screen.getByRole('button', { name: 'Use that copy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go on without it' })).toBeTruthy();
  });
});

describe('StoreReview, with files of an earlier version (design §4.8)', () => {
  const PLAIN: Partial<Review> = { integrity: { findings: [finding('legacy', 'plainFiles', 'offerImport')] } };

  it('opens nothing until you ask, and shows what they hold', async () => {
    const { api } = setup(PLAIN);
    const files = screen.getByRole('group', { name: 'Archivos sin cifrar' });
    expect(
      within(files).getByText('Aparecieron archivos de una versión anterior de Trino, y nada muestra que sean tuyos. Trino no los abrió.'),
    ).toBeTruthy();
    expect(api.legacyFilesPreview).not.toHaveBeenCalled();
    click('Ver qué traen');
    await settle();
    expect(api.legacyFilesPreview).toHaveBeenCalledTimes(1);
    expect(within(files).getByText('Nombre: Ana')).toBeTruthy();
    expect(within(files).getByText('Contactos (2): Bob, Caro')).toBeTruthy();
    expect(within(files).getByText('Grupos (1): Familia')).toBeTruthy();
    expect(within(files).getByText('Chats: 2 · Bloqueados: 1 · Invitaciones: 0 · Stickers: 3')).toBeTruthy();
  });

  it('imports them only when you choose it', async () => {
    const { api, onDone } = setup(PLAIN);
    click('Importarlos');
    await settle();
    expect(api.legacyFilesImport).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Listo. Trino los importó y borró los archivos sin cifrar.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Borrarlos' })).toBeNull();
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('asks once more before removing them unread', async () => {
    const { api } = setup(PLAIN);
    click('Borrarlos');
    expect(api.legacyFilesRemove).not.toHaveBeenCalled();
    expect(screen.getByText('Se borran sin abrirlos. No se puede deshacer.')).toBeTruthy();
    click('Cancelar');
    expect(screen.queryByText('Se borran sin abrirlos. No se puede deshacer.')).toBeNull();
    click('Borrarlos');
    click('Borrar');
    await settle();
    expect(api.legacyFilesRemove).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Listo. Trino los borró sin abrirlos.')).toBeTruthy();
  });

  it('leaves them as they were when that fails, and lets you decide another time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { onDone } = setup(PLAIN, fakeApi({ legacyFilesImport: vi.fn(async () => Promise.reject({ code: 'io', message: 'x' })) }));
    click('Importarlos');
    await settle();
    expect(screen.getByRole('alert').textContent).toBe('No se pudo hacer. Los archivos siguen como estaban.');
    expect(screen.getByRole('button', { name: 'Importarlos' })).toBeTruthy();
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// Design §11.5 and test 45: the note shows at the unlock that ended the
// migration, with what it encrypted, after the dialog when there is one.
describe('StoreReview, after the migration', () => {
  const MIGRATED: Partial<Review> = { migration: { contacts: 4, groups: 2, stickers: 0, notes: 3 } };

  it('shows the note with the counts, then goes on', () => {
    const { onDone } = setup(MIGRATED);
    expect(title().textContent).toBe('Tus datos en este equipo ya están cifrados');
    expect(document.activeElement).toBe(title());
    expect(
      screen.getByText(
        'Trino cifró con tu contraseña tu perfil, tus contactos (4), tus grupos (2), tus notas (3) y tus stickers (0), como ya hacía con tus chats.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Borró los archivos viejos sin cifrar. En un disco SSD pueden quedar restos. BitLocker los protege solo con el computador apagado.'),
    ).toBeTruthy();
    expect(
      screen.getByText('Si guardaste una copia de la carpeta .trino, esa copia sigue sin cifrar: bórrala cuando ya no la necesites.'),
    ).toBeTruthy();
    expect(screen.queryByText(/otra carpeta de datos/)).toBeNull();
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('says that the other data folders wait for their own unlock', () => {
    setup({ ...MIGRATED, customDataDir: true });
    expect(
      screen.getByText(
        'Usas otra carpeta de datos: las notas y los ajustes de las otras cuentas de este equipo se cifran cuando las abras con esta versión.',
      ),
    ).toBeTruthy();
  });

  it('comes after the dialog, never in its place', async () => {
    const { onDone } = setup({ ...OLDER_ACCOUNT, ...MIGRATED });
    expect(title().textContent).toBe('Algunos archivos de Trino cambiaron');
    click('Seguir sin ella');
    await settle();
    click('Entendido');
    expect(onDone).not.toHaveBeenCalled();
    expect(title().textContent).toBe('Tus datos en este equipo ya están cifrados');
    expect(document.activeElement).toBe(title());
    click('Entendido');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
