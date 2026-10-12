// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactPreview, GroupInfo, GroupInvite, HandshakeNeededEvent, NodeInfo, ProfileResponse } from '../lib/api';
import { toCompactCodeV2 } from '../lib/contact-code';
import { I18nContext, makeT } from '../lib/i18n';
import type { OnboardingIntent } from '../screens/types';
import { useContacts, type ContactsOptions } from './contacts';

// Contactos in the old chats (plan §4, I3): ContactsDialog (W4) opens from
// the first run's "Agregar un contacto", from the shell's buttons and from the
// notice of waiting invitations; invitations never open anything by
// themselves. A fake backend and a stand-in for the old shell drive it.

beforeEach(() => {
  // "Mi código" draws the QR's PNG on a canvas, which jsdom does not have.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const BUNDLE = JSON.stringify({
  handle: 'Ana Torres',
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
const CODE = toCompactCodeV2(BUNDLE);
const PROFILE: ProfileResponse = { handle: 'Rechita', avatar: null, fingerprint: '70a5.83c6.766d.aad7', nostr_pub: '' };
const PREVIEW: ContactPreview = {
  handle: 'Ana Torres',
  fingerprint: '7f3a.91c2.0b5e.d4a8',
  identity_digest: 'ab'.repeat(32),
  existing: null,
};

const invite = (gid: string, name: string): GroupInvite => ({
  gid,
  name,
  from_handle: 'Ana Torres',
  member_count: 3,
  received_at: 1,
});

/**
 * The backend as the contacts see it: its invitations, which an answer takes
 * out (also when it fails, as take_group_invite does), and its two events.
 */
function fakeBackend(waiting: readonly GroupInvite[]) {
  let pending = [...waiting];
  const take = (gid: string) => {
    pending = pending.filter(other => other.gid !== gid);
  };
  const inviteListeners = new Set<(invite: GroupInvite) => void>();
  const strangerListeners = new Set<(event: HandshakeNeededEvent) => void>();
  const stopped: string[] = [];
  const api = {
    shareBundle: vi.fn(async () => BUNDLE),
    getProfile: vi.fn(async () => PROFILE),
    previewContact: vi.fn(async () => PREVIEW),
    probeNode: vi.fn(
      async (_bundleJson: string, handle: string, _replaceExisting?: boolean): Promise<NodeInfo> => ({
        handle,
        fingerprint: PREVIEW.fingerprint,
        has_session: false,
        added_at: 1,
      }),
    ),
    listGroupInvites: vi.fn(async () => [...pending]),
    acceptGroupInvite: vi.fn(async (gid: string): Promise<GroupInfo> => {
      take(gid);
      return { gid, name: 'Proyecto final', epoch: 1, is_admin: false, member_count: 3, members: [] };
    }),
    declineGroupInvite: vi.fn(async (gid: string) => take(gid)),
  };
  const events = {
    onGroupInvite: vi.fn(async (cb: (invite: GroupInvite) => void) => {
      inviteListeners.add(cb);
      return () => {
        inviteListeners.delete(cb);
        stopped.push('group-invite');
      };
    }),
    onHandshakeNeeded: vi.fn(async (cb: (event: HandshakeNeededEvent) => void) => {
      strangerListeners.add(cb);
      return () => {
        strangerListeners.delete(cb);
        stopped.push('handshake-needed');
      };
    }),
  };
  return {
    api,
    events,
    stopped,
    take,
    /** An invitation arrives, as `group-invite` says. */
    invite(next: GroupInvite) {
      pending = [...pending.filter(other => other.gid !== next.gid), next];
      act(() => inviteListeners.forEach(cb => cb(next)));
    },
    /** Someone who is not a contact tried to write, as `handshake-needed` says. */
    stranger(fromPubkey: string) {
      act(() => strangerListeners.forEach(cb => cb({ from_pubkey: fromPubkey })));
    },
  };
}

/** The old shell, as far as the contacts are concerned: its two buttons and the notice. */
function Shell({ options }: { options: ContactsOptions }) {
  const contacts = useContacts(options);
  return (
    <>
      <button type="button" onClick={() => contacts.open('add')}>
        Agregar contacto
      </button>
      <button type="button" onClick={() => contacts.open('share')}>
        Compartir mi código
      </button>
      <button type="button" onClick={() => contacts.open('invites')}>
        Ver invitaciones
      </button>
      <p>{`Esperan: ${contacts.invites.map(waiting => waiting.name).join(', ') || 'ninguna'}`}</p>
      {contacts.dialog}
    </>
  );
}

function mount(intent: OnboardingIntent = 'chats', waiting: readonly GroupInvite[] = []) {
  const backend = fakeBackend(waiting);
  const shell = { onContactAdded: vi.fn(), onGroupJoined: vi.fn(), onGroupsChanged: vi.fn() };
  const view = render(
    <I18nContext.Provider value={makeT('es')}>
      <Shell options={{ api: backend.api, events: backend.events, intent, download: vi.fn(), ...shell }} />
    </I18nContext.Provider>,
  );
  return { ...backend, ...shell, view };
}

const contactsDialog = () => screen.getByRole('dialog', { name: 'Contactos' });
const selectedTab = () =>
  within(contactsDialog())
    .getAllByRole('tab')
    .find(tab => tab.getAttribute('aria-selected') === 'true')?.textContent;

describe('useContacts', () => {
  it('opens Contactos on "Agregar" once, when the first run ended with "Agregar un contacto"', async () => {
    const backend = mount('add-contact');
    expect(selectedTab()).toBe('Agregar');
    expect(within(contactsDialog()).getByRole('textbox', { name: 'Pega el código de la otra persona' })).toBeTruthy();

    fireEvent.click(within(contactsDialog()).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Whatever renders the shell again, the first run's wish is spent.
    backend.invite(invite('a', 'Proyecto final'));
    expect(screen.getByText('Esperan: Proyecto final')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stays closed after a first run that ended otherwise, and opens on the tab the shell asks for', () => {
    mount('chats');
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Compartir mi código' }));
    expect(selectedTab()).toBe('Mi código');
    fireEvent.click(within(contactsDialog()).getByRole('tab', { name: 'Agregar' }));
    expect(selectedTab()).toBe('Agregar');
    fireEvent.click(within(contactsDialog()).getByRole('button', { name: 'Cerrar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar contacto' }));
    expect(selectedTab()).toBe('Agregar');
  });

  // The old shell opened a dialog for each invitation as it came (the queue
  // of GroupInviteModal). Now they wait in Contactos, under the notice.
  it('keeps the invitations, the waiting ones and those that arrive, without opening anything', async () => {
    const backend = mount('chats', [invite('a', 'Proyecto final')]);
    expect(await screen.findByText('Esperan: Proyecto final')).toBeTruthy();
    backend.invite(invite('b', 'Familia'));
    expect(screen.getByText('Esperan: Proyecto final, Familia')).toBeTruthy();
    // The same group again replaces its invitation, in its place.
    backend.invite({ ...invite('a', 'Proyecto final (2026)'), member_count: 4 });
    expect(screen.getByText('Esperan: Proyecto final (2026), Familia')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens "Invitaciones" from the notice, and reads the invitations and the groups again after an answer', async () => {
    const backend = mount('chats', [invite('a', 'Proyecto final'), invite('b', 'Familia')]);
    await screen.findByText('Esperan: Proyecto final, Familia');
    fireEvent.click(screen.getByRole('button', { name: 'Ver invitaciones' }));
    expect(selectedTab()).toBe('Invitaciones · 2');

    fireEvent.click(within(contactsDialog()).getByRole('button', { name: 'Rechazar la invitación a Familia' }));
    expect(await screen.findByText('Esperan: Proyecto final')).toBeTruthy();
    expect(backend.api.declineGroupInvite).toHaveBeenCalledWith('b');
    expect(backend.api.listGroupInvites).toHaveBeenCalledTimes(2);
    expect(backend.onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(selectedTab()).toBe('Invitaciones · 1');
  });

  // An answer that fails took the invitation out anyway, and a join that
  // failed on a write may have joined the group in memory (W4, note 7): the
  // shell reads both again.
  it('reads the invitations and the groups again after a failed answer too', async () => {
    const backend = mount('chats', [invite('a', 'Proyecto final')]);
    backend.api.acceptGroupInvite.mockImplementationOnce(async (gid: string) => {
      backend.take(gid);
      throw new Error('persist_groups failed');
    });
    await screen.findByText('Esperan: Proyecto final');
    fireEvent.click(screen.getByRole('button', { name: 'Ver invitaciones' }));
    fireEvent.click(within(contactsDialog()).getByRole('button', { name: 'Unirme a Proyecto final' }));

    expect((await within(contactsDialog()).findByRole('alert')).textContent).toContain('No se pudo entrar a «Proyecto final»');
    expect(await screen.findByText('Esperan: ninguna')).toBeTruthy();
    expect(backend.api.listGroupInvites).toHaveBeenCalledTimes(2);
    expect(backend.onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(backend.onGroupJoined).not.toHaveBeenCalled();
  });

  it('closes Contactos and hands a group just joined to the shell', async () => {
    const backend = mount('chats', [invite('a', 'Proyecto final')]);
    await screen.findByText('Esperan: Proyecto final');
    fireEvent.click(screen.getByRole('button', { name: 'Ver invitaciones' }));
    fireEvent.click(within(contactsDialog()).getByRole('button', { name: 'Unirme a Proyecto final' }));

    await waitFor(() => expect(backend.onGroupJoined).toHaveBeenCalledWith('a'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Esperan: ninguna')).toBeTruthy();
    expect(backend.onGroupsChanged).toHaveBeenCalled();
  });

  it('closes Contactos and hands a contact just added to the shell', async () => {
    const backend = mount('add-contact');
    fireEvent.change(within(contactsDialog()).getByRole('textbox', { name: 'Pega el código de la otra persona' }), {
      target: { value: CODE },
    });
    fireEvent.click(await within(contactsDialog()).findByRole('button', { name: 'Agregar a Ana Torres' }));

    await waitFor(() => expect(backend.onContactAdded).toHaveBeenCalledWith('Ana Torres'));
    expect(backend.api.probeNode).toHaveBeenCalledWith(expect.any(String), 'Ana Torres', undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tells Contactos how many people who are not contacts tried to write, each one once', async () => {
    const backend = mount('chats');
    await waitFor(() => expect(backend.events.onHandshakeNeeded).toHaveBeenCalled());
    backend.stranger('k1');
    backend.stranger('k1');
    backend.stranger('k2');
    fireEvent.click(screen.getByRole('button', { name: 'Ver invitaciones' }));
    expect(
      within(contactsDialog()).getByText(/^2 personas que no están en tus contactos intentaron escribirte\./),
    ).toBeTruthy();
  });

  it('stops listening once the shell is gone', async () => {
    const backend = mount('chats');
    await waitFor(() => expect(backend.events.onGroupInvite).toHaveBeenCalledTimes(1));
    backend.view.unmount();
    await waitFor(() => expect([...backend.stopped].sort()).toEqual(['group-invite', 'handshake-needed']));
  });
});
