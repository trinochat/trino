import { describe, expect, it } from 'vitest';
import type { GroupMember, NodeInfo } from '../../lib/api';
import { buildMemberViews, inviteCandidates } from './group-model';

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
const contact = (handle: string, fingerprint: string, extra: Partial<NodeInfo> = {}): NodeInfo => ({
  handle,
  fingerprint,
  has_session: true,
  added_at: 0,
  ...extra,
});
const never = () => false;

describe('buildMemberViews', () => {
  // UR-3 (R-10): a contact the group made, not accepted, goes by the name the admin wrote, with "~".
  it('names a contact the group made and you did not accept with "~"', () => {
    const views = buildMemberViews(
      [member('k-mara', 'mara', { local_handle: 'mara', via_group: 'g1', limited: true })],
      never,
    );
    expect(views.map(v => [v.name, v.localHandle, v.limited, v.trust])).toEqual([['~mara', 'mara', true, 'viaGroup']]);
  });

  // App.tsx:2253 matched the roster to contacts by name, so two people with
  // one name got each other's chat. The backend matches by key (K9).
  it('takes the contact the backend matched by key, not the name in the roster', () => {
    const views = buildMemberViews(
      [
        member('k-ana', 'Ana', { local_handle: 'Ana Torres' }),
        member('k-ana2', 'Ana', { local_handle: 'Ana-k-an', via_group: 'g1' }),
      ],
      never,
    );
    expect(views.map(v => [v.key, v.name, v.localHandle])).toEqual([
      ['k-ana', 'Ana Torres', 'Ana Torres'],
      ['k-ana2', 'Ana-k-an', 'Ana-k-an'],
    ]);
  });

  it('names a member who is not a contact as the roster does', () => {
    const [view] = buildMemberViews([member('k1', 'Lucía', { local_handle: null })], never);
    expect(view).toMatchObject({ name: 'Lucía', localHandle: null, initials: 'LU' });
  });

  it('marks you and the admin', () => {
    const views = buildMemberViews(
      [member('k-me', 'Rafa', { is_self: true, local_handle: null }), member('k-mom', 'Mamá', { is_admin: true })],
      never,
    );
    expect(views.map(v => [v.name, v.isSelf, v.isAdmin, v.trust])).toEqual([
      ['Mamá', false, true, 'unverified'],
      ['Rafa', true, false, 'self'],
    ]);
  });

  it('gives each member its trust: verified with the current key, came with a group, or not verified', () => {
    const isVerified = (handle: string, fp: string) => handle === 'Mamá' && fp === 'fp-k-mom';
    const views = buildMemberViews(
      [
        member('k-mom', 'Mamá'),
        member('k-dad', 'Papá'),
        member('k-lu', 'Lucía', { via_group: 'g1' }),
        member('k-x', 'Ximena', { local_handle: null }),
        member('k-old', 'Mamá vieja', { local_handle: 'Mamá', fingerprint: 'fp-old' }),
      ],
      isVerified,
    );
    expect(Object.fromEntries(views.map(v => [v.key, v.trust]))).toEqual({
      'k-mom': 'verified',
      'k-dad': 'unverified',
      'k-lu': 'viaGroup',
      'k-x': 'viaGroup',
      'k-old': 'unverified',
    });
  });

  it('a member verified since coming with a group is verified', () => {
    const [view] = buildMemberViews([member('k-lu', 'Lucía', { via_group: 'g1' })], () => true);
    expect(view!.trust).toBe('verified');
  });

  it('puts whoever administers first, then you, then the rest by name', () => {
    const views = buildMemberViews(
      [
        member('k-z', 'zoe'),
        member('k-me', 'Rafa', { is_self: true }),
        member('k-b', 'Bruno'),
        member('k-a', 'álvaro'),
        member('k-admin', 'Mamá', { is_admin: true }),
      ],
      never,
      'es',
    );
    expect(views.map(v => v.name)).toEqual(['Mamá', 'Rafa', 'álvaro', 'Bruno', 'zoe']);
  });

  it('puts you first when you administer', () => {
    const views = buildMemberViews(
      [member('k-b', 'Bruno'), member('k-me', 'Rafa', { is_self: true, is_admin: true })],
      never,
    );
    expect(views.map(v => v.name)).toEqual(['Rafa', 'Bruno']);
  });
});

describe('inviteCandidates', () => {
  // A contact is a member when the backend matched it to one (K9), or when
  // its key is a member's: never by the name in the roster.
  it('leaves out the contacts who already are members, by identity', () => {
    const members = [
      member('k-ana', 'Ana', { local_handle: 'Ana Torres' }),
      member('k-bruno', 'Bruno', { local_handle: null, fingerprint: 'fp-bruno' }),
    ];
    const contacts = [
      contact('Ana Torres', 'fp-ana'),
      contact('Bruno B', 'fp-bruno'),
      contact('Ana', 'fp-other-ana'),
      contact('Carla', 'fp-carla'),
    ];
    expect(inviteCandidates(contacts, members).map(c => c.handle)).toEqual(['Ana', 'Carla']);
  });

  it('leaves out blocked contacts', () => {
    expect(inviteCandidates([contact('Ana', 'fp-a', { blocked: true }), contact('Bea', 'fp-b')], []).map(c => c.handle)).toEqual(['Bea']);
  });
});
