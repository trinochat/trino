/**
 * The members of a group as the group panel shows them (Group:88-110). The
 * backend matches each member of the roster to a contact by key (K9:
 * `group_members`), never by name: App.tsx:2253 matched by name, so two
 * people with one name got each other's chat.
 */
import type { GroupMember, NodeInfo } from '../../lib/api';
import type { Lang } from '../../lib/i18n';
import { identityInitials } from '../../lib/initials';

/**
 * - `verified`: a contact verified with the key it has now (on this device);
 * - `unverified`: a contact you added, not verified;
 * - `viaGroup`: someone you know only through a group's signed roster: a
 *   contact that came with a group, or a member who is not a contact;
 * - `self`: you.
 */
export type MemberTrust = 'verified' | 'unverified' | 'viaGroup' | 'self';

export interface GroupMemberView {
  /** The member's identity key (ik_sign_pub): the same in every roster. */
  key: string;
  /** Your name for them when they are a contact, else the roster's. */
  name: string;
  /** The contact this member is; null for you and for a member who is not a contact. */
  localHandle: string | null;
  initials: string;
  isSelf: boolean;
  isAdmin: boolean;
  trust: MemberTrust;
  /** Someone you blocked (UR-2). */
  blocked: boolean;
  /**
   * A contact the group made and you did not accept (UR-3): named "~name",
   * the name the admin wrote (R-10), with "Agregar a contactos".
   */
  limited: boolean;
}

function trustOf(member: GroupMember, isVerified: (handle: string, fingerprint: string) => boolean): MemberTrust {
  if (member.is_self) return 'self';
  const handle = member.local_handle ?? null;
  if (handle !== null && isVerified(handle, member.fingerprint)) return 'verified';
  if (handle === null || member.via_group) return 'viaGroup';
  return 'unverified';
}

/**
 * The members to show, in order: whoever administers first, then you, then
 * the rest by name in the language's order. `isVerified` is
 * `prefs.isVerified`, true only while the stored fingerprint is the
 * contact's current one.
 */
export function buildMemberViews(
  members: readonly GroupMember[],
  isVerified: (handle: string, fingerprint: string) => boolean,
  lang?: Lang,
): GroupMemberView[] {
  const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
  const rank = (view: GroupMemberView) => (view.isAdmin ? 0 : view.isSelf ? 1 : 2);
  return members
    .map(member => {
      const localHandle = member.is_self ? null : (member.local_handle ?? null);
      const limited = !member.is_self && member.limited === true;
      const name = limited ? `~${member.roster_handle}` : (localHandle ?? member.roster_handle);
      return {
        key: member.ik_sign_pub,
        name,
        localHandle,
        initials: identityInitials(limited ? member.roster_handle : name),
        isSelf: member.is_self,
        isAdmin: member.is_admin,
        trust: trustOf(member, isVerified),
        blocked: member.blocked === true,
        limited,
      };
    })
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name) || (a.key < b.key ? -1 : 1));
}

/**
 * The contacts you can invite to the group: not blocked, and not a member
 * already, by identity: the contact the backend matched to a member (K9), or
 * one with a member's fingerprint. Never by the name in the roster.
 */
export function inviteCandidates(contacts: readonly NodeInfo[], members: readonly GroupMember[]): NodeInfo[] {
  const handles = new Set(members.flatMap(member => (member.local_handle ? [member.local_handle] : [])));
  const fingerprints = new Set(members.map(member => member.fingerprint));
  return contacts.filter(
    contact => !contact.blocked && !handles.has(contact.handle) && !fingerprints.has(contact.fingerprint),
  );
}
