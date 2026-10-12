// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdAccessibility, holdAppearance, holdScanLines } from '../design/apply';
import { AppearanceProvider } from '../design/useAppearance';
import type { GroupInfo, GroupMember, GroupRemovedEvent, NodeInfo } from '../lib/api';
import { groupPrefs as makeGroupPrefs } from '../screens/group';
import { fakeHost, memoryPrefs, withLang } from '../screens/settings/test-utils';
import { useGroups, type GroupsOptions } from './groups';

// Groups in the old chats (plan §4, I4): W4's "Nuevo grupo" from the groups'
// "+", and the details of the group on screen (GroupPanel) from "detalles del
// grupo", where "agregar miembro" was: beside the chat from 70 rem, as a
// dialog below. A fake backend and a stand-in for the old shell drive it.

beforeEach(() => {
  holdAppearance(document, null);
  holdAccessibility(document, null);
  holdScanLines(document, null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
const contact = (handle: string): NodeInfo => ({ handle, fingerprint: `fp-${handle}`, has_session: true, added_at: 0 });
const CONTACTS = [contact('Mamá'), contact('Papá'), contact('Lucía'), contact('Tía Rosa')];
const ME = (extra: Partial<GroupMember> = {}) => member('k-me', 'Rafa', { is_self: true, local_handle: null, ...extra });

/**
 * The backend as the groups see it: you administer "Familia" and are a member
 * of "Trabajo". Creating, adding, leaving and an admin's removal change what
 * list_groups answers, as they would.
 */
function fakeBackend() {
  let groups: GroupInfo[] = [
    { gid: 'g1', name: 'Familia', epoch: 3, is_admin: true, member_count: 3, members: [] },
    { gid: 'g2', name: 'Trabajo', epoch: 1, is_admin: false, member_count: 2, members: [] },
  ];
  const members: Record<string, GroupMember[]> = {
    g1: [ME({ is_admin: true }), member('k-mom', 'Mamá'), member('k-lu', 'Lucía', { via_group: 'g1' })],
    g2: [member('k-boss', 'Jefa', { is_admin: true, local_handle: null }), ME()],
  };
  const info = (gid: string) => groups.find(group => group.gid === gid)!;
  const removedListeners = new Set<(event: GroupRemovedEvent) => void>();
  const stopped: string[] = [];
  const api = {
    createGroup: vi.fn(async (name: string): Promise<GroupInfo> => {
      const created = { gid: 'g-new', name, epoch: 1, is_admin: true, member_count: 1, members: [] };
      groups = [...groups, created];
      members['g-new'] = [ME({ is_admin: true })];
      return created;
    }),
    addGroupMember: vi.fn(async (gid: string, handle: string): Promise<GroupInfo> => {
      members[gid] = [...(members[gid] ?? []), member(`k-${handle}`, handle)];
      groups = groups.map(group => (group.gid === gid ? { ...group, epoch: group.epoch + 1 } : group));
      return info(gid);
    }),
    groupMembers: vi.fn(async (gid: string) => [...(members[gid] ?? [])]),
    removeGroupMember: vi.fn(async (gid: string, _key: string) => info(gid)),
    renameGroup: vi.fn(async (gid: string, name: string) => ({ ...info(gid), name })),
    leaveGroup: vi.fn(async (gid: string) => {
      groups = groups.filter(group => group.gid !== gid);
    }),
    deleteGroup: vi.fn(async (gid: string) => {
      groups = groups.filter(group => group.gid !== gid);
    }),
  };
  const events = {
    onGroupRemoved: vi.fn(async (cb: (event: GroupRemovedEvent) => void) => {
      removedListeners.add(cb);
      return () => {
        removedListeners.delete(cb);
        stopped.push('group-removed');
      };
    }),
  };
  return {
    api,
    events,
    stopped,
    listGroups: () => [...groups],
    /** The admin removed you from `gid`: it stays, ended, and `group-removed` says so. */
    removed(gid: string) {
      groups = groups.map(group => (group.gid === gid ? { ...group, ended: true } : group));
      act(() => removedListeners.forEach(cb => cb({ gid })));
    },
  };
}

type Backend = ReturnType<typeof fakeBackend>;
type Open = { kind: 'group'; gid: string } | { kind: 'contact'; handle: string } | null;

/**
 * The old shell, as far as the groups are concerned: its list of groups with
 * the "+" (only an icon, named by its title), the chat of the group on
 * screen with "detalles del grupo", and an incoming message, heard by a
 * listener set up once, as MainShell's are.
 */
function OldShell({ backend, overrides }: { backend: Backend; overrides: Partial<GroupsOptions> }) {
  const [groups, setGroups] = useState<GroupInfo[]>(backend.listGroups);
  const [open, setOpen] = useState<Open>({ kind: 'group', gid: 'g1' });
  const [reads, setReads] = useState(0);
  const [alert, setAlert] = useState('ninguno');
  const refresh = () => {
    setGroups(backend.listGroups());
    setReads(n => n + 1);
  };
  const group = open?.kind === 'group' ? groups.find(other => other.gid === open.gid) : undefined;
  const ui = useGroups({
    api: backend.api,
    events: backend.events,
    contacts: CONTACTS,
    group,
    onCreated: gid => {
      refresh();
      setOpen({ kind: 'group', gid });
    },
    onChanged: refresh,
    onOpenContact: handle => setOpen({ kind: 'contact', handle }),
    onLeft: gid => {
      refresh();
      setOpen(current => (current?.kind === 'group' && current.gid === gid ? null : current));
    },
    ...overrides,
  });
  const heardOnce = useRef(ui.isMuted);
  const opened = open === null ? 'nada' : open.kind === 'contact' ? open.handle : (group?.name ?? '?');
  return (
    <div ref={ui.shellRef}>
      <nav aria-label="Tus grupos">
        {groups.map(other => (
          <button key={other.gid} type="button" onClick={() => setOpen({ kind: 'group', gid: other.gid })}>
            {other.name}
          </button>
        ))}
        <button type="button" title="crear grupo" onClick={() => ui.openNew()} />
      </nav>
      <p>{`Abierto: ${opened}`}</p>
      <p>{`Lecturas: ${reads}`}</p>
      <p>{`Aviso: ${alert}`}</p>
      {group && (
        <section aria-label={`Chat de ${group.name}`}>
          <button type="button" onClick={() => ui.openDetails()}>
            detalles del grupo
          </button>
          <button type="button" onClick={() => setAlert(heardOnce.current(group.gid) ? 'callado' : 'suena')}>
            Llega un mensaje
          </button>
          {ui.aside}
        </section>
      )}
      {ui.dialogs}
    </div>
  );
}

interface MountOptions {
  overrides?: Partial<GroupsOptions>;
  /** What this device keeps for the appearance and accessibility, such as the text size. */
  stored?: Record<string, string>;
}

function mount({ overrides = {}, stored = {} }: MountOptions = {}) {
  const backend = fakeBackend();
  const { prefs } = memoryPrefs();
  const groupPrefs = makeGroupPrefs(prefs);
  const { host } = fakeHost(stored);
  const view = render(
    withLang(
      <AppearanceProvider host={host}>
        <OldShell backend={backend} overrides={{ groupPrefs, ...overrides }} />
      </AppearanceProvider>,
    ),
  );
  return { ...backend, groupPrefs, view };
}

/** 1024 px at 100 %: 64 rem, under the 70 of the details beside the chat. */
const NARROW = 1024;
/** 1280 px at 100 %: 80 rem. */
const WIDE = 1280;

/**
 * A ResizeObserver that jsdom lacks, so the shell's width is measured: each
 * call of the function returned resizes every element observed.
 */
function stubResizeObserver(): { count(): number; resize(width: number): void } {
  const observers: Array<(width: number) => void> = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb;
      }
      observe() {
        observers.push(width => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver));
      }
      unobserve() {}
      disconnect() {}
    },
  );
  return {
    count: () => observers.length,
    resize: width => act(() => observers.forEach(fire => fire(width))),
  };
}

const detailsButton = () => screen.getByRole('button', { name: 'detalles del grupo' });
const openDetails = () => {
  const button = detailsButton();
  button.focus();
  fireEvent.click(button);
  return button;
};
const chatOf = (name: string) => screen.getByRole('region', { name: `Chat de ${name}` });
const opened = (name: string) => screen.findByText(`Abierto: ${name}`);

describe('useGroups', () => {
  it('opens "Nuevo grupo" from the groups’ "+", and opens the group it created', async () => {
    const backend = mount({ overrides: { width: NARROW } });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'crear grupo' }));

    const dialog = screen.getByRole('dialog', { name: 'Nuevo grupo' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre del grupo' }), { target: { value: 'Viaje' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Mamá' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));

    expect(await opened('Viaje')).toBeTruthy();
    expect(backend.api.createGroup).toHaveBeenCalledWith('Viaje');
    expect(backend.api.addGroupMember).toHaveBeenCalledWith('g-new', 'Mamá');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Viaje' })).toBeTruthy();
  });

  // The group exists even when some could not be added: closing that
  // dialog still hands it to the shell.
  it('opens the group it created after a partial failure too, once the dialog is answered', async () => {
    const backend = mount({ overrides: { width: NARROW } });
    backend.api.addGroupMember.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(screen.getByRole('button', { name: 'crear grupo' }));
    const dialog = screen.getByRole('dialog', { name: 'Nuevo grupo' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Nombre del grupo' }), { target: { value: 'Viaje' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Papá' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Crear grupo' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no se pudo agregar a: Papá');
    expect(screen.getByText('Abierto: Familia')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir el grupo' }));
    expect(await opened('Viaje')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the details of the group on screen as a dialog under 70 rem, and gives the focus back', async () => {
    mount({ overrides: { width: NARROW } });
    const button = openDetails();

    const dialog = screen.getByRole('dialog', { name: 'Familia' });
    expect(within(dialog).getByRole('button', { name: 'Silenciar' })).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.queryByRole('complementary')).toBeNull();
    await within(dialog).findByRole('list', { name: 'Miembros' });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('shows them beside the chat from 70 rem, takes the focus there, and gives it back once closed', async () => {
    mount({ overrides: { width: WIDE } });
    const button = openDetails();

    const aside = within(chatOf('Familia')).getByRole('complementary', { name: 'Familia' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(aside.contains(document.activeElement)).toBe(true);
    await within(aside).findByRole('list', { name: 'Miembros' });

    fireEvent.click(within(aside).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  // The width counts in rem: at 200 % text the same window has 40 rem.
  it('follows the text size: at 200 % the same window shows them as a dialog', async () => {
    mount({ overrides: { width: WIDE }, stored: { 'trino.accessibility': JSON.stringify({ textScale: 2 }) } });
    openDetails();
    expect(screen.getByRole('dialog', { name: 'Familia' })).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
    await screen.findByRole('list', { name: 'Miembros' });
  });

  it('measures the shell when no width is given, and moves the details as it changes', async () => {
    const shell = stubResizeObserver();
    mount();
    expect(shell.count()).toBe(1);

    shell.resize(WIDE);
    openDetails();
    expect(within(chatOf('Familia')).getByRole('complementary', { name: 'Familia' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Miembros' });

    shell.resize(NARROW);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Familia' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Miembros' });
  });

  // The dialog gives the focus back to its opener as it goes; the details
  // beside the chat take it after that.
  it('keeps the focus in the details when a wider shell turns their dialog into an aside', async () => {
    const shell = stubResizeObserver();
    mount();
    shell.resize(NARROW);
    openDetails();
    expect(screen.getByRole('dialog', { name: 'Familia' }).contains(document.activeElement)).toBe(true);
    await screen.findByRole('list', { name: 'Miembros' });

    shell.resize(WIDE);
    const aside = within(chatOf('Familia')).getByRole('complementary', { name: 'Familia' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(aside.contains(document.activeElement)).toBe(true);
    await within(aside).findByRole('list', { name: 'Miembros' });
  });

  // Invitar is W4's InviteMembersDialog: by identity, never by the name in the roster.
  it('invites from the details, offering only contacts who are not members yet, and reads the groups again', async () => {
    const backend = mount({ overrides: { width: WIDE } });
    openDetails();
    const aside = within(chatOf('Familia')).getByRole('complementary', { name: 'Familia' });
    fireEvent.click(await within(aside).findByRole('button', { name: 'Invitar' }));

    const dialog = screen.getByRole('dialog', { name: 'Invitar a Familia' });
    expect(within(dialog).getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual([
      'Papá',
      'Tía Rosa',
    ]);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Tía Rosa' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Invitar' }));

    expect(await screen.findByText('Lecturas: 1')).toBeTruthy();
    expect(backend.api.addGroupMember).toHaveBeenCalledWith('g1', 'Tía Rosa');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the chat of a member who came with the group, and closes the details', async () => {
    mount({ overrides: { width: WIDE } });
    openDetails();
    fireEvent.click(await screen.findByRole('button', { name: 'Escribirle a Lucía' }));
    expect(await opened('Lucía')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('lets a group you leave go: the details close and the shell forgets it', async () => {
    const backend = mount({ overrides: { width: NARROW } });
    fireEvent.click(screen.getByRole('button', { name: 'Trabajo' }));
    openDetails();
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Trabajo' })).getByRole('button', { name: 'Salir del grupo' }));
    const confirm = screen.getByRole('alertdialog', { name: '¿Salir de Trabajo?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Salir del grupo' }));

    expect(await opened('nada')).toBeTruthy();
    expect(backend.api.leaveGroup).toHaveBeenCalledWith('g2');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Trabajo' })).toBeNull();
  });

  it('closes the details when another conversation opens, and does not bring them back', async () => {
    mount({ overrides: { width: WIDE } });
    openDetails();
    expect(within(chatOf('Familia')).getByRole('complementary', { name: 'Familia' })).toBeTruthy();
    await screen.findByRole('list', { name: 'Miembros' });

    fireEvent.click(screen.getByRole('button', { name: 'Trabajo' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Familia' }));
    expect(chatOf('Familia')).toBeTruthy();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  // "Silenciar" is a mark on this device that cuts the sound and the
  // notification (plan §1.4), so the shell's listeners ask for it.
  it('silences a group muted in its details for the shell’s listeners, set up once', async () => {
    const { groupPrefs } = mount({ overrides: { width: WIDE } });
    const message = () => fireEvent.click(screen.getByRole('button', { name: 'Llega un mensaje' }));
    message();
    expect(screen.getByText('Aviso: suena')).toBeTruthy();

    openDetails();
    const mute = screen.getByRole('button', { name: 'Silenciar' });
    fireEvent.click(mute);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(groupPrefs.isMuted('g1')).toBe(true);
    message();
    expect(screen.getByText('Aviso: callado')).toBeTruthy();

    fireEvent.click(mute);
    message();
    expect(screen.getByText('Aviso: suena')).toBeTruthy();
    await screen.findByRole('list', { name: 'Miembros' });
  });

  // K10 tells only through group-removed; the details then say you are out.
  it('reads the groups again when the admin removed you, so the details say so', async () => {
    const backend = mount({ overrides: { width: WIDE } });
    fireEvent.click(screen.getByRole('button', { name: 'Trabajo' }));
    openDetails();
    await screen.findByRole('list', { name: 'Miembros' });
    await waitFor(() => expect(backend.events.onGroupRemoved).toHaveBeenCalledTimes(1));

    backend.removed('g2');
    expect(await screen.findByText('Lecturas: 1')).toBeTruthy();
    expect(
      await screen.findByText('Ya no eres parte de este grupo: quien lo administra te quitó o lo eliminó.'),
    ).toBeTruthy();
  });

  it('stops listening once the shell is gone', async () => {
    const backend = mount({ overrides: { width: NARROW } });
    await waitFor(() => expect(backend.events.onGroupRemoved).toHaveBeenCalledTimes(1));
    backend.view.unmount();
    await waitFor(() => expect(backend.stopped).toEqual(['group-removed']));
  });
});
