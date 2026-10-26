/**
 * What the group screens ask of the backend (plan §3, W4). `api` from
 * src/lib/api.ts fits it; the tests pass a fake, so nothing mocks `invoke`.
 * The members and the admin's changes arrive with W8 (K9, K10); until then
 * the panel's `capabilities` hide what needs them.
 */
import type { GroupInfo, GroupMember } from '../../lib/api';
import type { BlockDialogApi } from '../block/BlockDialog';

export interface GroupApi extends BlockDialogApi {
  createGroup(name: string): Promise<GroupInfo>;
  addGroupMember(gid: string, friendHandle: string): Promise<GroupInfo>;
  /** The roster's members, matched to your contacts by key (K9). */
  groupMembers(gid: string): Promise<GroupMember[]>;
  removeGroupMember(gid: string, ikSignPub: string): Promise<GroupInfo>;
  renameGroup(gid: string, name: string): Promise<GroupInfo>;
  /** Local: no tombstone, so a later roster comes back as an invitation (K10). */
  leaveGroup(gid: string): Promise<void>;
  deleteGroup(gid: string): Promise<void>;
}
