// The contacts unit (W4): what the shell and Settings mount.
export type { ContactsApi } from './contacts-api';
// The contacts slot: add, share and invitations.
export { ContactsDialog, type ContactsDialogProps } from './ContactsDialog';
// Settings' "Tu código QR" (renderShareCode) mounts this on its own.
export { ShareCodePanel, type ShareCodePanelProps } from './ShareCodePanel';
// The newChat slot: "Nuevo chat" and "Nueva llamada".
export {
  NewChatDialog,
  newChatShortcuts,
  type NewChatDialogProps,
  type NewChatShortcut,
} from './newchat/NewChatDialog';
export { contactIndex, type ContactLetter } from './newchat/contact-index';
