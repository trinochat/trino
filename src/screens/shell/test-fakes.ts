/**
 * Fakes of what the shell takes from the app, for the tests of src/screens/shell
 * and src/screens/inbox. Not part of the app: only test files import this module.
 */
import { vi, type Mock } from 'vitest';
import type {
  CallLogWire,
  ConnectionStatus,
  ContactKeyMismatchEvent,
  FileMessageEvent,
  FileRef,
  GroupInvite,
  GroupRemovedEvent,
  GroupUpdatedEvent,
  HandshakeNeededEvent,
  IncomingGroupMessageEvent,
  IncomingMessageEvent,
  ProfileUpdatedEvent,
} from '../../lib/api';
import { createPrefs, type PrefsStorage } from '../../lib/prefs';
import type { ShellApi, ShellEvents } from './shell-api';

type Unlisten = () => void;

/** One backend event: what the shell listens with, and how a test fires it. */
function channel<T>() {
  const listeners = new Set<(payload: T) => void>();
  return {
    on: (listener: (payload: T) => void): Promise<Unlisten> => {
      listeners.add(listener);
      return Promise.resolve(() => {
        listeners.delete(listener);
      });
    },
    emit: (payload: T) => {
      for (const listener of [...listeners]) listener(payload);
    },
    size: () => listeners.size,
  };
}

export function fakeEvents() {
  const channels = {
    messageReceived: channel<IncomingMessageEvent>(),
    groupMessage: channel<IncomingGroupMessageEvent>(),
    groupUpdated: channel<GroupUpdatedEvent>(),
    groupInvite: channel<GroupInvite>(),
    fileMessage: channel<FileMessageEvent>(),
    resyncNeeded: channel<string>(),
    sessionEstablished: channel<string>(),
    handshakeNeeded: channel<HandshakeNeededEvent>(),
    connectionChanged: channel<ConnectionStatus>(),
    contactKeyMismatch: channel<ContactKeyMismatchEvent>(),
    groupRemoved: channel<GroupRemovedEvent>(),
    callLogged: channel<CallLogWire>(),
    profileUpdated: channel<ProfileUpdatedEvent>(),
  };
  const events: ShellEvents = {
    onMessageReceived: channels.messageReceived.on,
    onGroupMessage: channels.groupMessage.on,
    onGroupUpdated: channels.groupUpdated.on,
    onGroupInvite: channels.groupInvite.on,
    onFileMessage: channels.fileMessage.on,
    onResyncNeeded: channels.resyncNeeded.on,
    onSessionEstablished: channels.sessionEstablished.on,
    onHandshakeNeeded: channels.handshakeNeeded.on,
    onConnectionChanged: channels.connectionChanged.on,
    onContactKeyMismatch: channels.contactKeyMismatch.on,
    onGroupRemoved: channels.groupRemoved.on,
    onCallLogged: channels.callLogged.on,
    onProfileUpdated: channels.profileUpdated.on,
  };
  const emit = Object.fromEntries(Object.entries(channels).map(([name, { emit }]) => [name, emit])) as {
    [K in keyof typeof channels]: (typeof channels)[K]['emit'];
  };
  /** How many listeners are still subscribed, over every event. */
  const listening = () => Object.values(channels).reduce((sum, { size }) => sum + size(), 0);
  return { events, emit, listening };
}

export type FakeApi = { [K in keyof ShellApi]: Mock<ShellApi[K]> };

/** A file the fake backend answers a send with. */
export function sentFile(name: string, mime = 'application/octet-stream'): FileRef {
  return { url: `https://blossom.example/${name}`, key: 'k', sha256: `sha-${name}`, mime, name, size: 1 };
}

/** The shell's API, answering like a backend with nothing in it; tests override what they need. */
export function fakeApi(): FakeApi {
  return {
    listNodes: vi.fn(async () => []),
    listGroups: vi.fn(async () => []),
    listGroupInvites: vi.fn(async () => []),
    getHistory: vi.fn(async () => ({})),
    connectNode: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => null),
    sendGroupMessage: vi.fn(async () => null),
    sendFile: vi.fn(async (_handle: string, name: string, mime: string) => sentFile(name, mime)),
    sendGroupFile: vi.fn(async (_gid: string, name: string, mime: string) => sentFile(name, mime)),
    forwardFile: vi.fn(async () => {}),
    fetchFile: vi.fn(async () => 'data:application/octet-stream;base64,'),
    pruneExpired: vi.fn(async () => {}),
    resyncSession: vi.fn(async () => {}),
    resendOutbox: vi.fn(async () => {}),
    deleteHistoryItem: vi.fn(async () => {}),
    connectionStatus: vi.fn(async () => ({ up: 0, total: 0, relays: [] })),
    acknowledgeKeyChange: vi.fn(async () => {}),
    listStickers: vi.fn(async () => []),
    importSticker: vi.fn(async () => {
      throw new Error('no stickers in this fake');
    }),
    deleteSticker: vi.fn(async () => {}),
    listCallHistory: vi.fn(async () => []),
  };
}

/** `localStorage` in memory, with what a test stored in it. */
export function memoryStorage(seed: Record<string, string> = {}): PrefsStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: key => {
      data.delete(key);
    },
  };
}

/** The real preferences over a storage in memory. */
export function fakePrefs(seed: Record<string, string> = {}) {
  const storage = memoryStorage(seed);
  return { prefs: createPrefs(storage), storage };
}
