// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GroupInfo, GroupMember, NodeInfo } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { LangCtx } from '../../lib/i18n-context';
import { createPrefs, type PrefsStorage } from '../../lib/prefs';
import { groupPrefs } from './group-prefs';
import { GroupPanel, type GroupPanelProps } from './GroupPanel';

afterEach(cleanup);

const member = (key: string, roster: string, extra: Partial<GroupMember> = {}): GroupMember => ({
  ik_sign_pub: key,
  roster_handle: roster,
  local_handle: roster,
  fingerprint: `fp-${key}`,
  is_admin: false,
  is_self: false,
  via_group: null,
  ...extra,
});
const GROUP: GroupInfo = { gid: 'g1', name: 'Familia', epoch: 3, is_admin: false, member_count: 4, members: [] };
const AS_MEMBER = [
  member('k-mom', 'Mamá', { is_admin: true }),
  member('k-me', 'Rafa', { is_self: true, local_handle: null }),
  member('k-dad', 'Papá'),
  member('k-lu', 'Lucía', { via_group: 'g1' }),
];
const AS_ADMIN = [
  member('k-me', 'Rafa', { is_self: true, is_admin: true, local_handle: null }),
  member('k-mom', 'Mamá'),
  member('k-dad', 'Papá'),
  member('k-x', 'Ximena', { local_handle: null }),
];
const contact = (handle: string): NodeInfo => ({ handle, fingerprint: `fp-${handle}`, has_session: true, added_at: 0 });

function memoryStorage(): PrefsStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

interface MountOptions {
  members?: GroupMember[];
  group?: Partial<GroupInfo>;
  props?: Partial<GroupPanelProps>;
  /** The first read of the members fails. */
  membersFail?: boolean;
}

function mount({ members = AS_MEMBER, group = {}, props = {}, membersFail = false }: MountOptions = {}) {
  const api = {
    createGroup: vi.fn(async (_name: string) => ({ ...GROUP })),
    addGroupMember: vi.fn(async (_gid: string, _handle: string) => ({ ...GROUP })),
    groupMembers: vi.fn(async (_gid: string) => members),
    removeGroupMember: vi.fn(async (_gid: string, _key: string) => ({ ...GROUP })),
    renameGroup: vi.fn(async (_gid: string, name: string) => ({ ...GROUP, name })),
    leaveGroup: vi.fn(async (_gid: string) => {}),
    deleteGroup: vi.fn(async (_gid: string) => {}),
  };
  if (membersFail) api.groupMembers.mockRejectedValueOnce(new Error('io'));
  const handlers = { onClose: vi.fn(), onChanged: vi.fn(), onOpenContact: vi.fn(), onLeft: vi.fn() };
  const prefs = groupPrefs(createPrefs(memoryStorage()));
  const isVerified = (handle: string, fp: string) => handle === 'Mamá' && fp === 'fp-k-mom';
  render(
    <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
      <I18nContext.Provider value={makeT('es')}>
        <GroupPanel
          group={{ ...GROUP, ...group }}
          contacts={[contact('Mamá'), contact('Papá'), contact('Lucía'), contact('Tía Rosa')]}
          layout="aside"
          api={api}
          capabilities={{ members: true, manage: true }}
          isVerified={isVerified}
          groupPrefs={prefs}
          {...handlers}
          {...props}
        />
      </I18nContext.Provider>
    </LangCtx.Provider>,
  );
  return { api, prefs, ...handlers };
}

const rows = async () => within(await screen.findByRole('list', { name: 'Miembros' })).getAllByRole('listitem');
/** Which of `names` each row is about, in the order of the rows. */
const namesOf = (items: HTMLElement[], names: string[]) =>
  items.map(item => names.find(name => within(item).queryByText(name, { exact: true })));

describe('GroupPanel', () => {
  // The shell may hand the same API over in a new object on every render.
  it('reads the members once, even when its parent passes the API in a new object each render', async () => {
    const { api } = mount();
    await rows();
    const props = (fresh: typeof api) => (
      <LangCtx.Provider value={{ lang: 'es', setLang: () => {} }}>
        <I18nContext.Provider value={makeT('es')}>
          <GroupPanel
            group={GROUP}
            contacts={[]}
            layout="aside"
            api={{ ...fresh }}
            capabilities={{ members: true, manage: true }}
            onClose={vi.fn()}
            onChanged={vi.fn()}
            onOpenContact={vi.fn()}
            onLeft={vi.fn()}
          />
        </I18nContext.Provider>
      </LangCtx.Provider>
    );
    cleanup();
    api.groupMembers.mockClear();
    const { rerender } = render(props(api));
    await rows();
    rerender(props(api));
    rerender(props(api));
    await rows();
    expect(api.groupMembers).toHaveBeenCalledTimes(1);
  });

  it('names the group, counts its members and says who administers it', async () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Familia' })).toBeTruthy();
    expect(await screen.findByText('4 miembros · Administra Mamá')).toBeTruthy();
  });

  it('says you administer it when you do', async () => {
    mount({ members: AS_ADMIN, group: { is_admin: true } });
    expect(await screen.findByText('4 miembros · Administras este grupo')).toBeTruthy();
  });

  it('lists the members with their part and their trust, as text', async () => {
    mount();
    const items = await rows();
    expect(namesOf(items, ['Mamá', 'Tú', 'Lucía', 'Papá'])).toEqual(['Mamá', 'Tú', 'Lucía', 'Papá']);
    expect(items[0]!.textContent).toContain('Administra el grupo');
    expect(items[0]!.textContent).toContain('Verificado');
    expect(items[1]!.textContent).toContain('Miembro');
    expect(items[2]!.textContent).toContain('Llegó con un grupo');
    expect(items[3]!.textContent).toContain('Sin verificar');
  });

  it('offers to write to a member who came with a group', async () => {
    const { onOpenContact } = mount();
    await rows();
    fireEvent.click(screen.getByRole('button', { name: 'Escribirle a Lucía' }));
    expect(onOpenContact).toHaveBeenCalledWith('Lucía');
    expect(screen.queryByRole('button', { name: 'Escribirle a Papá' })).toBeNull();
  });

  it('says a member is not in your contacts, and offers no chat with them', async () => {
    mount({ members: AS_ADMIN, group: { is_admin: true } });
    const items = await rows();
    const ximena = items.find(item => item.textContent?.includes('Ximena'))!;
    expect(ximena.textContent).toContain('No está en tus contactos');
    expect(within(ximena).queryByRole('button', { name: /Escribirle/ })).toBeNull();
  });

  it('mutes the group on this device, with aria-pressed', async () => {
    const { prefs } = mount();
    const mute = screen.getByRole('button', { name: 'Silenciar' });
    expect(mute.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(mute);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(prefs.isMuted('g1')).toBe(true);
    fireEvent.click(mute);
    expect(prefs.isMuted('g1')).toBe(false);
  });

  it('has no group call', async () => {
    mount();
    await rows();
    expect(screen.queryByRole('button', { name: /llamada|llamar/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/pronto/i);
  });

  it('sets how long your messages last here, and says honestly what that does', async () => {
    const { prefs } = mount();
    const select = screen.getByRole('combobox', { name: 'Mensajes temporales' }) as HTMLSelectElement;
    expect(select.value).toBe('0');
    expect(screen.getByText('Cada persona elige el tiempo de sus propios mensajes en este grupo.')).toBeTruthy();
    fireEvent.change(select, { target: { value: '86400' } });
    expect(prefs.getTtl('g1')).toBe(86400);
    expect(
      screen.getByText(
        'Tus mensajes nuevos en este grupo se borran de los equipos de todos después de 1 día. Cada persona elige el tiempo de sus propios mensajes.',
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/para todo el grupo|lo verán todos/i);
  });

  it('shows a time stored elsewhere that is not among the options, as it is', () => {
    const storage = memoryStorage();
    const device = createPrefs(storage);
    device.setTtl('grp:g1', 45);
    mount({ props: { groupPrefs: groupPrefs(device) } });
    const select = screen.getByRole('combobox', { name: 'Mensajes temporales' }) as HTMLSelectElement;
    expect(select.value).toBe('45');
    expect(select.selectedOptions[0]!.textContent).toBe('45 segundos');
    expect(screen.getByText(/después de 45 segundos\./)).toBeTruthy();
  });

  it('keeps the signed note of the board', async () => {
    mount();
    expect(
      screen.getByText(
        'Solo quien administra puede cambiar los miembros, y cada cambio va firmado: nadie puede agregar a alguien haciéndose pasar por otra persona.',
      ),
    ).toBeTruthy();
  });

  it('gives a member "Salir del grupo" and nothing of the admin', async () => {
    mount();
    await rows();
    expect(screen.getByRole('button', { name: 'Salir del grupo' })).toBeTruthy();
    for (const name of ['Invitar', 'Renombrar el grupo', 'Eliminar el grupo']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Quitar a/ })).toBeNull();
  });

  it('gives the admin Invitar, Quitar, Renombrar and Eliminar, and no Salir', async () => {
    mount({ members: AS_ADMIN, group: { is_admin: true } });
    await rows();
    expect(screen.getByRole('button', { name: 'Invitar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Renombrar el grupo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Eliminar el grupo' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Quitar a Mamá del grupo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Quitar a Tú del grupo' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salir del grupo' })).toBeNull();
  });

  it('hides what needs the members (K9) when the backend lacks it', () => {
    const { api } = mount({ members: AS_ADMIN, group: { is_admin: true }, props: { capabilities: { members: false, manage: true } } });
    expect(api.groupMembers).not.toHaveBeenCalled();
    expect(screen.getByText('4 miembros · Administras este grupo')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Miembros' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Invitar' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Quitar a/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Eliminar el grupo' })).toBeTruthy();
  });

  it('hides what needs managing the group (K10) when the backend lacks it', async () => {
    mount({ members: AS_ADMIN, group: { is_admin: true }, props: { capabilities: { members: true, manage: false } } });
    await rows();
    expect(screen.getByRole('button', { name: 'Invitar' })).toBeTruthy();
    for (const name of ['Renombrar el grupo', 'Eliminar el grupo', 'Salir del grupo']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Quitar a/ })).toBeNull();
  });

  it('removes a member after a confirmation', async () => {
    const { api, onChanged } = mount({ members: AS_ADMIN, group: { is_admin: true } });
    await rows();
    fireEvent.click(screen.getByRole('button', { name: 'Quitar a Papá del grupo' }));
    const confirm = screen.getByRole('alertdialog', { name: '¿Quitar a Papá del grupo?' });
    expect(api.removeGroupMember).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Quitar del grupo' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.removeGroupMember).toHaveBeenCalledWith('g1', 'k-dad');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leaves the group after a confirmation', async () => {
    const { api, onLeft } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Salir del grupo' }));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '¿Salir de Familia?' })).getByRole('button', { name: 'Salir del grupo' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(api.leaveGroup).toHaveBeenCalledWith('g1');
  });

  it('deletes the group after a confirmation', async () => {
    const { api, onLeft } = mount({ members: AS_ADMIN, group: { is_admin: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar el grupo' }));
    fireEvent.click(within(screen.getByRole('alertdialog', { name: '¿Eliminar Familia?' })).getByRole('button', { name: 'Eliminar el grupo' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(api.deleteGroup).toHaveBeenCalledWith('g1');
  });

  it('renames the group', async () => {
    const { api, onChanged } = mount({ members: AS_ADMIN, group: { is_admin: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Renombrar el grupo' }));
    const dialog = screen.getByRole('dialog', { name: 'Renombrar el grupo' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre del grupo' }), { target: { value: 'Familia Pérez' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.renameGroup).toHaveBeenCalledWith('g1', 'Familia Pérez');
  });

  it('invites contacts who are not members yet', async () => {
    const { api, onChanged } = mount({ members: AS_ADMIN, group: { is_admin: true } });
    await rows();
    fireEvent.click(screen.getByRole('button', { name: 'Invitar' }));
    const dialog = screen.getByRole('dialog', { name: 'Invitar a Familia' });
    expect(within(dialog).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual([
      'Lucía',
      'Tía Rosa',
    ]);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tía Rosa' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invitar' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.addGroupMember).toHaveBeenCalledWith('g1', 'Tía Rosa');
  });

  it('says when the members could not be read, and tries again', async () => {
    mount({ membersFail: true });
    expect((await screen.findByRole('alert')).textContent).toContain('No se pudieron cargar los miembros.');
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('list', { name: 'Miembros' })).toBeTruthy();
  });

  it('says so when you are no longer in the group', () => {
    mount({ group: { ended: true }, props: { capabilities: { members: false, manage: true } } });
    expect(screen.getByText('Ya no eres parte de este grupo: quien lo administra te quitó o lo eliminó.')).toBeTruthy();
  });

  it('works as a dialog too, closing with Escape', async () => {
    const { onClose } = mount({ props: { layout: 'dialog' } });
    const dialog = screen.getByRole('dialog', { name: 'Familia' });
    expect(within(dialog).getByRole('button', { name: 'Silenciar' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    await rows();
  });

  it('closes as an aside with its button', () => {
    const { onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(onClose).toHaveBeenCalled();
  });
});
