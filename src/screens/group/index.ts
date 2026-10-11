// The group unit (W4): what the shell mounts.
export type { GroupApi } from './group-api';
// The groupPanel slot: the details of a group, as an aside or a dialog.
export { GroupPanel, type GroupAdminAction, type GroupPanelProps } from './GroupPanel';
export { buildMemberViews, inviteCandidates, type GroupMemberView, type MemberTrust } from './group-model';
export { GROUP_TTL_OPTIONS, groupPrefs, type GroupPrefs } from './group-prefs';
// The newGroup slot: create a group and add its members.
export { NewGroupDialog, type NewGroupDialogProps } from './NewGroupDialog';
