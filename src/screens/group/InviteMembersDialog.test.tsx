// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { GroupInfo, GroupMember, NodeInfo } from '../../lib/api';
import { I18nContext, makeT } from '../../lib/i18n';
import { InviteMembersDialog } from './InviteMembersDialog';

afterEach(cleanup);

const GROUP: GroupInfo = { gid: 'g1', name: 'Familia', epoch: 1, is_admin: true, member_count: 2, members: [] };
const member = (key: string, local: string | null, fingerprint: string): GroupMember => ({
  ik_sign_pub: key,
  roster_handle: local ?? key,
  local_handle: local,
  fingerprint,
  is_admin: false,
  is_self: false,
});
const contact = (handle: string, fingerprint = `fp-${handle}`, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint,
  has_session: true,
  added_at: 0,
  ...extra,
});

const MEMBERS = [member('k-me', null, 'fp-me'), member('k-ana', 'Ana', 'fp-Ana')];
const CONTACTS = [contact('Ana'), contact('Bruno'), contact('Carla'), contact('Ana 2', 'fp-Ana'), contact('Dora', 'fp-d', { blocked: true })];

function mount(addGroupMember = vi.fn(async (_gid: string, _handle: string) => GROUP), contacts = CONTACTS) {
  const handlers = { onClose: vi.fn(), onInvited: vi.fn() };
  render(
    <I18nContext.Provider value={makeT('es')}>
      <InviteMembersDialog group={GROUP} members={MEMBERS} contacts={contacts} api={{ addGroupMember }} {...handlers} />
    </I18nContext.Provider>,
  );
  return { addGroupMember, ...handlers };
}

const pick = (name: string) => fireEvent.click(screen.getByRole('checkbox', { name }));
const invite = () => screen.getByRole('button', { name: 'Invitar' }) as HTMLButtonElement;

describe('InviteMembersDialog', () => {
  it('offers only the contacts who are not members, by identity, and not the blocked ones', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Invitar a Familia' })).toBeTruthy();
    expect(screen.getAllByRole('checkbox').map(box => box.closest('label')?.textContent)).toEqual(['Bruno', 'Carla']);
  });

  it('says honestly who gets the invitation', () => {
    mount();
    expect(screen.getByText('Solo le llega a contactos que también te tengan agregado.')).toBeTruthy();
  });

  it('invites the chosen contacts one by one, then closes', async () => {
    const { addGroupMember, onInvited, onClose } = mount();
    expect(invite().disabled).toBe(true);
    pick('Bruno');
    pick('Carla');
    fireEvent.click(invite());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(addGroupMember.mock.calls).toEqual([
      ['g1', 'Bruno'],
      ['g1', 'Carla'],
    ]);
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it('shows its progress while it invites', async () => {
    let finish!: () => void;
    const addGroupMember = vi.fn(() => new Promise<GroupInfo>(resolve => (finish = () => resolve(GROUP))));
    mount(addGroupMember);
    pick('Bruno');
    fireEvent.click(invite());
    expect(screen.getByRole('status').textContent).toBe('Invitando a Bruno… (1 de 1)');
    finish();
    await waitFor(() => expect(screen.queryByText(/^Invitando/)).toBeNull());
  });

  it('says who could not be invited, and keeps them chosen to try again', async () => {
    const addGroupMember = vi.fn(async (_gid: string, handle: string) => {
      if (handle === 'Carla') throw new Error('io');
      return GROUP;
    });
    const { onInvited, onClose } = mount(addGroupMember);
    pick('Bruno');
    pick('Carla');
    fireEvent.click(invite());
    expect((await screen.findByRole('alert')).textContent).toBe('No se pudo invitar a: Carla.');
    expect(onInvited).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('checkbox', { name: 'Carla' }) as HTMLInputElement).checked).toBe(true);
  });

  it('says when every contact already is in the group', () => {
    mount(undefined, [contact('Ana')]);
    expect(screen.getByText('Todos tus contactos ya están en el grupo.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Invitar' })).toBeNull();
  });
});
