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
  const view = (more: Partial<InvitesPanelProps>) => (
    <I18nContext.Provider value={makeT('es')}>
      <InvitesPanel api={api} invites={[invite('g1', 'Proyecto final')]} strangerAttempts={0} {...handlers} {...more} />
    </I18nContext.Provider>
  );
  const { rerender } = render(view(props));
  /** The shell read the invitations again. */
  const reread = (invites: GroupInvite[]) => rerender(view({ ...props, invites }));
  return { api, reread, ...handlers };
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

  // accept_group_invite takes the invitation out before it tries to join, and
  // keeps it out when joining fails (take_group_invite: "The invite is
  // consumed either way"): a retry could only fail. So the panel reads the
  // invitations again and says what is left to do, without promising a retry.
  it('says a failed join used up that invitation, and reads the invitations again', async () => {
    const { api, onGroupJoined, onInvitesChanged, reread } = mount({
      invites: [invite('g1', 'Proyecto final'), invite('g2', 'Familia')],
    });
    api.acceptGroupInvite.mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Proyecto final' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'No se pudo entrar a «Proyecto final», y esa invitación ya no se puede usar. Pídele a Ana Torres que te invite otra vez.',
    );
    expect(onInvitesChanged).toHaveBeenCalledTimes(1);
    expect(onGroupJoined).not.toHaveBeenCalled();

    // The used invitation is gone from the backend; the alert stays with the panel.
    reread([invite('g2', 'Familia')]);
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toContain('«Proyecto final»');
  });

  it('says a failed decline may come back, and reads the invitations again', async () => {
    const { api, onInvitesChanged } = mount();
    api.declineGroupInvite.mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar la invitación a Proyecto final' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'No se pudo rechazar la invitación a «Proyecto final». Si vuelve a aparecer, recházala otra vez.',
    );
    expect(onInvitesChanged).toHaveBeenCalledTimes(1);
  });

  it('clears what failed when another invitation is answered', async () => {
    const { api, onGroupJoined } = mount({ invites: [invite('g1', 'Proyecto final'), invite('g2', 'Familia')] });
    api.acceptGroupInvite.mockRejectedValueOnce(new Error('io'));
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Proyecto final' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Unirme a Familia' }));
    await waitFor(() => expect(onGroupJoined).toHaveBeenCalledWith('g2'));
    expect(screen.queryByRole('alert')).toBeNull();
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
