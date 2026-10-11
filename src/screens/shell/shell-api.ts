/**
 * What the shell (W2) takes from the app: the backend commands and events it
 * uses, the preferences it reads and the backend pieces it may count on. All
 * injected, so the tests pass fakes and nobody mocks `invoke`.
 */
import type {
  api,
  onCallLogged,
  onConnectionChanged,
  onContactKeyMismatch,
  onFileMessage,
  onGroupInvite,
  onGroupMessage,
  onGroupRemoved,
  onGroupUpdated,
  onHandshakeNeeded,
  onMessageReceived,
  onProfileUpdated,
  onResyncNeeded,
  onSessionEstablished,
} from '../../lib/api';
import type { Prefs } from '../../lib/prefs';

export type ShellApi = Pick<
  typeof api,
  | 'listNodes'
  | 'listGroups'
  | 'listGroupInvites'
  | 'getHistory'
  | 'connectNode'
  | 'sendMessage'
  | 'sendGroupMessage'
  | 'sendFile'
  | 'sendGroupFile'
  | 'forwardFile'
  | 'fetchFile'
  | 'pruneExpired'
  | 'resyncSession'
  | 'resendOutbox'
  | 'deleteHistoryItem'
  | 'connectionStatus'
  | 'acknowledgeKeyChange'
  | 'listStickers'
  | 'importSticker'
  | 'deleteSticker'
  | 'listCallHistory'
>;

/** The `on*` functions of lib/api.ts that the shell listens to. */
export interface ShellEvents {
  onMessageReceived: typeof onMessageReceived;
  onGroupMessage: typeof onGroupMessage;
  onGroupUpdated: typeof onGroupUpdated;
  onGroupInvite: typeof onGroupInvite;
  onFileMessage: typeof onFileMessage;
  onResyncNeeded: typeof onResyncNeeded;
  onSessionEstablished: typeof onSessionEstablished;
  onHandshakeNeeded: typeof onHandshakeNeeded;
  onConnectionChanged: typeof onConnectionChanged;
  onContactKeyMismatch: typeof onContactKeyMismatch;
  onGroupRemoved: typeof onGroupRemoved;
  onCallLogged: typeof onCallLogged;
  onProfileUpdated: typeof onProfileUpdated;
}

/**
 * The backend pieces that may not have landed yet (src/app/capabilities.ts).
 * Without one, what it backs is hidden, never faked.
 */
export interface ShellCapabilities {
  /** K3: the real state of the relays, for the connection chip. */
  connection: boolean;
  /** K4: a send answers with the relays' receipt, so "sent" can show. */
  sendAck: boolean;
  /** K11: "Borrar para mí" deletes from the history on this device for good. */
  deleteForMe: boolean;
  /** K13: the calls are recorded, so the Calls tab and the calls in the chats show. */
  callLog: boolean;
}

/** The preferences of this device the shell reads and writes (lib/prefs). */
export type ShellPrefs = Pick<
  Prefs,
  | 'isVerified'
  | 'getTtl'
  | 'getGroupMuted'
  | 'getUpdatesMuted'
  | 'setUpdatesMuted'
  | 'getUpdatesLastRead'
  | 'setUpdatesLastRead'
  | 'getCallsSeenAt'
  | 'setCallsSeenAt'
  | 'renameContact'
  | 'forgetContact'
>;
