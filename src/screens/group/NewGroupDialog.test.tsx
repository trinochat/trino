// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GroupInfo, NodeInfo } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { createPrefs, type PrefsStorage } from '../../lib/prefs';
import { groupPrefs } from './group-prefs';
import { NewGroupDialog, type NewGroupDialogProps } from './NewGroupDialog';

afterEach(cleanup);

const contact = (handle: string, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint: `fp-${handle}`,
  has_session: true,
  added_at: 0,
  ...extra,
});
const CONTACTS = [contact('Bruno'), contact('Ana'), contact('Dora', { blocked: true }), contact('Carla')];
const created = (name: string): GroupInfo => ({ gid: 'g-new', name, epoch: 1, is_admin: true, member_count: 1, members: [] });

function memoryStorage(): PrefsStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

function mount(props: Partial<NewGroupDialogProps> = {}) {
  const api = {
    createGroup: vi.fn(async (name: string) => created(name)),
    addGroupMember: vi.fn(async (_gid: string, _handle: string) => created('x')),
  };
  const handlers = { onClose: vi.fn(), onCreated: vi.fn() };
  render(
    <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
      <I18nContext.Provider value={makeT('es')}>
        <NewGroupDialog contacts={CONTACTS} api={api} {...handlers} {...props} />
      </I18nContext.Provider>
    </LangCtx.Provider>,
  );
  return { api, ...handlers };
}

const nameBox = () => screen.getByRole('textbox', { name: 'Nombre del grupo' });
const create = () => screen.getByRole('button', { name: 'Crear grupo' }) as HTMLButtonElement;
const pick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));

describe('NewGroupDialog', () => {
  it('asks for a name, focused, and offers your contacts in order, without the blocked ones', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Nuevo grupo' })).toBeTruthy();
    expect(document.activeElement).toBe(nameBox());
    expect(screen.getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual(['Ana', 'Bruno', 'Carla']);
    expect(screen.getByText('Solo le llega a contactos que también te tengan agregado.')).toBeTruthy();
    expect(screen.getByText('Serás quien administre el grupo y sus miembros.')).toBeTruthy();
  });

  it('creates nothing without a name', () => {
    const { api } = mount();
    expect(create().disabled).toBe(true);
    fireEvent.change(nameBox(), { target: { value: '   ' } });
    fireEvent.submit(nameBox().closest('form')!);
    expect(api.createGroup).not.toHaveBeenCalled();
  });

  it('creates the group, then adds the chosen contacts one by one', async () => {
    const { api, onCreated } = mount();
    fireEvent.change(nameBox(), { target: { value: '  Familia ' } });
    pick('Carla');
    pick('Ana');
    fireEvent.click(create());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(api.createGroup).toHaveBeenCalledWith('Familia');
    expect(api.addGroupMember.mock.calls).toEqual([
      ['g-new', 'Ana'],
      ['g-new', 'Carla'],
    ]);
  });

  it('shows its progress while it adds', async () => {
    let finish!: () => void;
    const addGroupMember = vi.fn(() => new Promise<GroupInfo>(resolve => (finish = () => resolve(created('x')))));
    mount({ api: { createGroup: vi.fn(async (name: string) => created(name)), addGroupMember } });
    fireEvent.change(nameBox(), { target: { value: 'Familia' } });
    pick('Ana');
    fireEvent.click(create());
    expect((await screen.findByText('Agregando a Ana… (1 de 1)')).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('button', { name: 'Cerrar' })).toBeNull();
    finish();
  });

  it('says honestly who could not be added, and opens the group when asked', async () => {
    const addGroupMember = vi.fn(async (_gid: string, handle: string) => {
      if (handle === 'Bruno') throw new Error('io');
      return created('x');
    });
    const { onCreated } = mount({ api: { createGroup: vi.fn(async (name: string) => created(name)), addGroupMember } });
    fireEvent.change(nameBox(), { target: { value: 'Familia' } });
    pick('Ana');
    pick('Bruno');
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Se creó el grupo, pero no se pudo agregar a: Bruno. Puedes invitarlos después desde los detalles del grupo.',
    );
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir el grupo' }));
    expect(onCreated).toHaveBeenCalledWith('g-new');
  });

  it('tells the shell about the new group when you close after a partial failure', async () => {
    const addGroupMember = vi.fn(async () => Promise.reject(new Error('io')));
    const { onCreated, onClose } = mount({ api: { createGroup: vi.fn(async (name: string) => created(name)), addGroupMember } });
    fireEvent.change(nameBox(), { target: { value: 'Familia' } });
    pick('Ana');
    fireEvent.click(create());
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onCreated).toHaveBeenCalledWith('g-new');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('says so when the group cannot be created, and adds nobody', async () => {
    const { api, onCreated } = mount({
      api: { createGroup: vi.fn(async () => Promise.reject(new Error('io'))), addGroupMember: vi.fn() },
    });
    fireEvent.change(nameBox(), { target: { value: 'Familia' } });
    pick('Ana');
    fireEvent.click(create());
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudo crear el grupo. Inténtalo de nuevo.');
    expect(api.addGroupMember).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(create().disabled).toBe(false);
  });

  it('starts the group muted when Settings says new groups do', async () => {
    const device = createPrefs(memoryStorage());
    device.setMuteGroupsByDefault(true);
    const prefs = groupPrefs(device);
    const { onCreated } = mount({ groupPrefs: prefs });
    fireEvent.change(nameBox(), { target: { value: 'Familia' } });
    fireEvent.click(create());
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(prefs.isMuted('g-new')).toBe(true);
  });

  it('can be created with nobody yet, and says so when you have no contacts', async () => {
    const { api, onCreated } = mount({ contacts: [] });
    expect(screen.getByText('Todavía no tienes contactos para agregar. Puedes crear el grupo e invitar después.')).toBeTruthy();
    fireEvent.change(nameBox(), { target: { value: 'Solo yo' } });
    fireEvent.click(create());
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('g-new'));
    expect(api.addGroupMember).not.toHaveBeenCalled();
  });

  it('closes with Escape before it starts', () => {
    const { onClose } = mount();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});
