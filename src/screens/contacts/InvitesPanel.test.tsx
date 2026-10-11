// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { GroupInfo, GroupInvite } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { createPrefs, type PrefsStorage } from '../../lib/prefs';
import { groupPrefs } from '../group/group-prefs';
import { InvitesPanel, type InvitesPanelProps } from './InvitesPanel';

afterEach(cleanup);

const invite = (gid: string, name: string, extra: Partial<GroupInvite> = {}): GroupInvite => ({
  gid,
  name,
  from_handle: 'Ana Torres',
  member_count: 5,
  received_at: 1,
  ...extra,
});
const groupFor = (gid: string): GroupInfo => ({ gid, name: 'Proyecto final', epoch: 1, is_admin: false, member_count: 5, members: [] });

function memoryStorage(): PrefsStorage {
  const data = new Map<string, string>();
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

function mount(props: Partial<InvitesPanelProps> = {}) {
  const api = {
    acceptGroupInvite: vi.fn(async (gid: string) => groupFor(gid)),
    declineGroupInvite: vi.fn(async (_gid: string) => {}),
  };
  const handlers = { onGroupJoined: vi.fn(), onInvitesChanged: vi.fn() };
  render(
    <I18nContext.Provider value={makeT('es')}>
      <InvitesPanel api={api} invites={[invite('g1', 'Proyecto final')]} strangerAttempts={0} {...handlers} {...props} />
    </I18nContext.Provider>,
  );
  return { api, ...handlers };
}

describe('InvitesPanel', () => {
  it('shows each invitation with who sent it and the honest note', () => {
    mount({ invites: [invite('g1', 'Proyecto final'), invite('g2', 'Familia', { from_handle: 'Mamá', member_count: 1 })] });
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByRole('heading', { name: 'Proyecto final' })).toBeTruthy();
    expect(within(cards[0]!).getByText('Ana Torres te invitó · 5 miembros')).toBeTruthy();
    expect(within(cards[1]!).getByText('Mamá te invitó · 1 miembro')).toBeTruthy();
    expect(
      within(cards[0]!).getByText('Hasta que aceptes no entras al grupo, y nadie del grupo se agrega a tus contactos.'),
    ).toBeTruthy();
  });

  it('joins a group: accepts, then tells the shell', async () => {
    const { api, onGroupJoined, onInvitesChanged } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Proyecto final' }));
    await waitFor(() => expect(onGroupJoined).toHaveBeenCalledWith('g1'));
    expect(api.acceptGroupInvite).toHaveBeenCalledWith('g1');
    expect(onInvitesChanged).toHaveBeenCalled();
  });

  it('mutes a group it joins when Settings says new groups start muted', async () => {
    const device = createPrefs(memoryStorage());
    device.setMuteGroupsByDefault(true);
    const prefs = groupPrefs(device);
    const { onGroupJoined } = mount({ groupPrefs: prefs });
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Proyecto final' }));
    await waitFor(() => expect(onGroupJoined).toHaveBeenCalled());
    expect(prefs.isMuted('g1')).toBe(true);
  });

  it('declines an invitation', async () => {
    const { api, onGroupJoined, onInvitesChanged } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar la invitación a Proyecto final' }));
    await waitFor(() => expect(onInvitesChanged).toHaveBeenCalled());
    expect(api.declineGroupInvite).toHaveBeenCalledWith('g1');
    expect(onGroupJoined).not.toHaveBeenCalled();
  });

  it('says so when an answer fails, on that invitation only', async () => {
    const { api, onGroupJoined } = mount({ invites: [invite('g1', 'Proyecto final'), invite('g2', 'Familia')] });
    api.acceptGroupInvite.mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Proyecto final' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se pudo responder a la invitación.');
    expect(screen.getAllByRole('article')[0]!.contains(alert)).toBe(true);
    expect(onGroupJoined).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Unirme a Proyecto final' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('says when there are no invitations', () => {
    mount({ invites: [] });
    expect(screen.getByText('No tienes invitaciones a grupos.')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  // Plan §1.2: a stranger's message is dropped, so all Trino can say is that someone tried.
  it('says, honestly, that someone outside your contacts tried to write', () => {
    mount({ invites: [], strangerAttempts: 1 });
    expect(
      screen.getByText(
        'Alguien que no está en tus contactos intentó escribirte. Trino todavía no puede mostrarte quién es: pídele su código.',
      ),
    ).toBeTruthy();
    cleanup();
    mount({ strangerAttempts: 3 });
    expect(screen.getByText(/^3 personas que no están en tus contactos intentaron escribirte\./)).toBeTruthy();
  });

  it('offers no message from strangers to open', () => {
    mount({ strangerAttempts: 2 });
    expect(screen.queryByRole('button', { name: /^Ver/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/solicitud/i);
  });
});
