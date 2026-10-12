/**
 * The conversations of the shell, rewritten from the effects and sends of
 * MainShell in App.tsx: the contacts and groups, the history and what
 * arrives live (conversations.ts), unread counts, trust, notifications, the
 * cleanup of disappearing messages every 10 s, reconnection and the outbox,
 * and every way of sending: text (optimistic, with retry), files, stickers,
 * forwarding and "Borrar para mí".
 *
 * A message counts as unread unless its chat is open and the window has the
 * focus, and the notifier hears it by the same rule unless its group is
 * muted. A call never counts as unread: its missed calls are counted by the
 * Calls tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isCommandError,
  type FileRef,
  type GroupInfo,
  type GroupSendReceipt,
  type NodeInfo,
  type StickerInfo,
} from '../../lib/api';
import { convoKey } from '../../lib/convo';
import type { TFunction } from '../../lib/i18n';
import type { ProcessedFile } from '../../lib/media';
import { decodeBody, encodeMeta } from '../../lib/message-body';
import { stickerThumb } from '../chat/composer/sticker-limits';
import type { ConvoRef, Msg, Notifier, ReplyRef, SendFailure, Trust } from '../types';
import {
  EMPTY_CONVERSATIONS,
  bodyOf,
  conversationsReducer,
  type Conversations,
  type ConversationsAction,
  type SendFailureInfo,
} from './conversations';
import { listenAll, nowSeconds } from './listen';
import type { ShellApi, ShellCapabilities, ShellEvents, ShellPrefs } from './shell-api';

/** How often disappearing messages are cleaned up, here and in the backend. */
export const PRUNE_EVERY_MS = 10_000;

/** What went wrong outside a message, for the shell to say. */
/** `forward`: a file that did not go out, why (K4's codes) and whether to a group. */
export type ShellError =
  | { kind: 'reconnect'; handle: string }
  | { kind: 'forward'; reason: SendFailure; group: boolean };

export interface ConversationsOptions {
  api: ShellApi;
  events: ShellEvents;
  prefs: ShellPrefs;
  notifier: Notifier;
  capabilities: Pick<ShellCapabilities, 'sendAck' | 'deleteForMe'>;
  isWindowFocused(): boolean;
  /** The key of the conversation open on screen, or null. */
  openKey: string | null;
  t: TFunction;
  /** A new key for a message sent here; `crypto.randomUUID()` by default. */
  newKey?(): string;
  onError?(error: ShellError): void;
}

export interface ConversationsState {
  nodes: readonly NodeInfo[];
  /** The contacts were read once: before that, an empty list says nothing. */
  nodesLoaded: boolean;
  groups: readonly GroupInfo[];
  /** By conversation key, in order of `ts`. */
  messages: Readonly<Record<string, readonly Msg[]>>;
  unread: Readonly<Record<string, number>>;
  /** By handle. */
  trust: Readonly<Record<string, Trust>>;
  /** Epoch seconds, refreshed with each cleanup. */
  now: number;
  /** The history could not be read; `reloadHistory` tries again. */
  historyFailed: boolean;
  reloadHistory(): Promise<void>;
  refreshNodes(): Promise<void>;
  refreshGroups(): Promise<void>;
  markRead(key: string): void;
  /** Shows the message at once as sending; it turns sent or failed. */
  sendText(ref: ConvoRef, text: string, reply?: ReplyRef): void;
  retry(ref: ConvoRef, key: string): void;
  /** Sends the files one by one and answers with the ones that failed, for the chat to keep. */
  sendFiles(ref: ConvoRef, files: readonly ProcessedFile[]): Promise<{ failed: readonly ProcessedFile[] }>;
  sendSticker(ref: ConvoRef, sticker: StickerInfo): Promise<void>;
  forward(from: ConvoRef, key: string, to: ConvoRef): Promise<void>;
  /** Deletes a message here for good (K11); rejects, and keeps it, when the backend fails. */
  deleteForMe(ref: ConvoRef, key: string): Promise<void>;
  acknowledgeKeyChange(handle: string): Promise<void>;
  /** A contact was renamed: its messages, counts and preferences move with it. */
  renamed(from: string, to: string): void;
  /** A contact was removed or a group left: its conversation goes. */
  removed(key: string): void;
}

function defaultKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const FAILURES: Readonly<Partial<Record<string, SendFailure>>> = {
  offline: 'offline',
  not_accepted: 'not_accepted',
  message_too_long: 'too_long',
  no_session: 'no_session',
};

/** Why a send failed, as the chat says it (K4's codes); anything else is `other`. */
export function sendFailureOf(error: unknown): SendFailure {
  return (isCommandError(error) && FAILURES[error.code]) || 'other';
}

/** A file to send: what the chat prepared, or a sticker. */
type Outgoing = Pick<ProcessedFile, 'name' | 'mime' | 'dataB64' | 'thumb'>;

function sameRecord<T>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

export function useConversations(options: ConversationsOptions): ConversationsState {
  const latest = useRef(options);
  latest.current = options;

  // The reducer runs here, synchronously, so a handler knows at once whether
  // an event changed anything: a live copy of a saved message is no news.
  const store = useRef<Conversations>(EMPTY_CONVERSATIONS);
  const [conversations, setConversations] = useState<Conversations>(EMPTY_CONVERSATIONS);
  const apply = useCallback((action: ConversationsAction): boolean => {
    const next = conversationsReducer(store.current, action);
    if (next === store.current) return false;
    store.current = next;
    setConversations(next);
    return true;
  }, []);

  const [nodes, setNodes] = useState<readonly NodeInfo[]>([]);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [groups, setGroups] = useState<readonly GroupInfo[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const [unread, setUnread] = useState<Readonly<Record<string, number>>>({});
  const [mismatched, setMismatched] = useState<ReadonlySet<string>>(() => new Set());
  const [historyFailed, setHistoryFailed] = useState(false);
  const [now, setNow] = useState(nowSeconds);
  /** Group files that reached only some members, kept to send again to the others. */
  const pendingFiles = useRef(new Map<string, Outgoing>());

  const newKey = () => (latest.current.newKey ?? defaultKey)();

  const refreshNodes = useCallback(async () => {
    try {
      setNodes(await latest.current.api.listNodes());
      setNodesLoaded(true);
    } catch (error) {
      console.error('listNodes failed', error);
    }
  }, []);
  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await latest.current.api.listGroups());
    } catch (error) {
      console.error('listGroups failed', error);
    }
  }, []);
  const reloadHistory = useCallback(async () => {
    try {
      const history = await latest.current.api.getHistory();
      apply({ type: 'history', history, now: nowSeconds() });
      setHistoryFailed(false);
    } catch (error) {
      console.error('getHistory failed', error);
      setHistoryFailed(true);
    }
  }, [apply]);

  /** A message from someone else: in its chat, unread unless seen, and heard unless muted. */
  const receive = useCallback(
    (
      ref: Exclude<ConvoRef, { kind: 'channel' }>,
      message: { ts: number; body?: string; file?: FileRef; from?: string },
      notice: Parameters<Notifier['message']>[0],
    ) => {
      const key = convoKey(ref);
      if (!apply({ type: 'incoming', convo: key, ...message })) return;
      const o = latest.current;
      if (o.openKey === key && o.isWindowFocused()) return;
      setUnread(current => ({ ...current, [key]: (current[key] ?? 0) + 1 }));
      if (ref.kind === 'group' && o.prefs.getGroupMuted(ref.gid)) return;
      o.notifier.message(notice);
    },
    [apply],
  );

  useEffect(() => {
    void refreshNodes();
    void refreshGroups();
    void reloadHistory();
    const { api, events } = latest.current;
    const groupName = (gid: string, fallback: string) => groupsRef.current.find(g => g.gid === gid)?.name ?? fallback;
    const stop = listenAll([
      events.onMessageReceived(event => {
        const ref = { kind: 'contact' as const, handle: event.from_handle };
        const { text } = decodeBody(event.text);
        receive(ref, { ts: event.timestamp, body: event.text }, { convo: ref, title: event.from_handle, text, kind: 'text' });
      }),
      events.onGroupMessage(event => {
        const ref = { kind: 'group' as const, gid: event.gid };
        const { text } = decodeBody(event.text);
        receive(
          ref,
          { ts: event.timestamp, body: event.text, from: event.from_handle },
          { convo: ref, title: groupName(event.gid, event.from_handle), text: `${event.from_handle}: ${text}`, kind: 'text' },
        );
      }),
      events.onFileMessage(event => {
        const sticker = event.file.name.startsWith('sticker::');
        if (event.gid) {
          const ref = { kind: 'group' as const, gid: event.gid };
          receive(
            ref,
            { ts: event.timestamp, file: event.file, from: event.from_handle },
            sticker
              ? {
                  convo: ref,
                  title: groupName(event.gid, event.from_handle),
                  text: `${event.from_handle}: ${latest.current.t('inbox.preview.sticker')}`,
                  kind: 'sticker',
                }
              : {
                  convo: ref,
                  title: groupName(event.gid, event.from_handle),
                  text: `${event.from_handle}: ${event.file.name}`,
                  kind: 'file',
                },
          );
        } else {
          const ref = { kind: 'contact' as const, handle: event.from_handle };
          receive(
            ref,
            { ts: event.timestamp, file: event.file },
            sticker
              ? { convo: ref, title: event.from_handle, kind: 'sticker' }
              : { convo: ref, title: event.from_handle, text: event.file.name, kind: 'file' },
          );
        }
      }),
      events.onGroupUpdated(() => {
        void refreshGroups();
        void refreshNodes();
      }),
      events.onGroupRemoved(() => void refreshGroups()),
      // The backend cleared a session that fell out of step: handshake again,
      // then resend what waited, so nothing sent meanwhile is lost.
      events.onResyncNeeded(handle => {
        api
          .resyncSession(handle)
          .then(() => api.resendOutbox(handle))
          .then(refreshNodes)
          .catch(error => {
            console.error('resync failed', error);
            latest.current.onError?.({ kind: 'reconnect', handle });
          });
      }),
      events.onSessionEstablished(handle => {
        api.resendOutbox(handle).catch(() => {});
        void refreshNodes();
      }),
      events.onContactKeyMismatch(({ handle }) => setMismatched(current => new Set(current).add(handle))),
      events.onCallLogged(log => void apply({ type: 'call', log })),
      events.onProfileUpdated(() => void refreshNodes()),
    ]);
    const prune = window.setInterval(() => {
      const at = nowSeconds();
      setNow(at);
      apply({ type: 'pruned', now: at });
      latest.current.api.pruneExpired().catch(() => {});
    }, PRUNE_EVERY_MS);
    return () => {
      stop();
      window.clearInterval(prune);
    };
  }, [apply, receive, refreshGroups, refreshNodes, reloadHistory]);

  const find = (ref: ConvoRef, key: string): Msg | undefined =>
    store.current[convoKey(ref)]?.msgs.find(msg => msg.key === key);

  /** Opens a session first for a known contact without one, as App.tsx did. */
  const ensureSession = async (handle: string) => {
    const node = nodesRef.current.find(n => n.handle === handle);
    if (node && !node.has_session) {
      await latest.current.api.connectNode(handle);
      void refreshNodes();
    }
  };

  const receiptOf = (ts: number | undefined) =>
    latest.current.capabilities.sendAck && ts !== undefined ? { ts } : null;

  /** The answer of a group send: sent, or failed for the members it did not reach. */
  const settleGroup = (convo: string, key: string, receipt: Pick<GroupSendReceipt, 'ts' | 'failed'> | null) => {
    if (receipt && receipt.failed.length > 0) {
      apply({ type: 'failed', convo, key, failure: { kind: 'partial', members: receipt.failed }, ts: receipt.ts });
    } else {
      apply({ type: 'sent', convo, key, receipt: receiptOf(receipt?.ts) });
    }
  };

  const deliverText = async (ref: ConvoRef, key: string, body: string, only?: string[]) => {
    const { api } = latest.current;
    const convo = convoKey(ref);
    try {
      if (ref.kind === 'contact') {
        await ensureSession(ref.handle);
        const receipt = await api.sendMessage(ref.handle, body);
        apply({ type: 'sent', convo, key, receipt: receiptOf(receipt?.ts) });
      } else if (ref.kind === 'group') {
        const receipt = only
          ? await api.sendGroupMessage(ref.gid, body, only)
          : await api.sendGroupMessage(ref.gid, body);
        settleGroup(convo, key, receipt);
      }
    } catch (error) {
      console.error('send failed', error);
      const failure: SendFailureInfo = { kind: sendFailureOf(error) };
      apply({ type: 'failed', convo, key, failure });
    }
  };

  const sendText = (ref: ConvoRef, text: string, reply?: ReplyRef) => {
    if (ref.kind === 'channel') return;
    const convo = convoKey(ref);
    const ttl = latest.current.prefs.getTtl(convo);
    const ts = nowSeconds();
    const key = newKey();
    const body = encodeMeta(text, { reply, ttl });
    apply({
      type: 'optimistic',
      convo,
      body,
      msg: {
        key,
        side: 'me',
        ts,
        text,
        ...(reply && { reply }),
        ...(ttl > 0 && { ttl, expiresAt: ts + ttl }),
        state: 'sending',
      },
    });
    void deliverText(ref, key, body);
  };

  /**
   * Sends one file. Without `key` it adds the sent file to the chat; with
   * `key` it is a retry of that message, to `only` the members it missed.
   * Rejects when nothing was sent, so the chat keeps the file.
   */
  const deliverFile = async (ref: ConvoRef, file: Outgoing, retry?: { key: string; only: string[] }) => {
    const { api } = latest.current;
    const convo = convoKey(ref);
    if (ref.kind === 'contact') {
      await ensureSession(ref.handle);
      const { ts, accepted_by: _acceptedBy, ...sent } = await api.sendFile(
        ref.handle,
        file.name,
        file.mime,
        file.dataB64,
        file.thumb,
      );
      const receipt = receiptOf(ts);
      apply({
        type: 'optimistic',
        convo,
        msg: { key: newKey(), side: 'me', ts: receipt?.ts ?? nowSeconds(), file: sent, ...(receipt && { state: 'sent' }) },
      });
      return;
    }
    if (ref.kind !== 'group') return;
    const answer = retry
      ? await api.sendGroupFile(ref.gid, file.name, file.mime, file.dataB64, file.thumb, retry.only)
      : await api.sendGroupFile(ref.gid, file.name, file.mime, file.dataB64, file.thumb);
    const { ts, accepted: _accepted, failed, ...sent } = answer;
    const key = retry?.key ?? newKey();
    if (!retry) {
      apply({ type: 'optimistic', convo, msg: { key, side: 'me', ts: ts ?? nowSeconds(), file: sent } });
    }
    const pendingKey = `${convo}\n${key}`;
    if (failed && failed.length > 0) pendingFiles.current.set(pendingKey, file);
    else pendingFiles.current.delete(pendingKey);
    settleGroup(convo, key, ts !== undefined ? { ts, failed: failed ?? [] } : null);
  };

  const sendFiles = async (ref: ConvoRef, files: readonly ProcessedFile[]) => {
    const failed: ProcessedFile[] = [];
    for (const file of files) {
      try {
        await deliverFile(ref, file);
      } catch (error) {
        console.error('send file failed', error);
        failed.push(file);
      }
    }
    return { failed };
  };

  const sendSticker = async (ref: ConvoRef, sticker: StickerInfo) => {
    const comma = sticker.data_url.indexOf(',');
    const extension = sticker.mime.split('/')[1] || 'png';
    await deliverFile(ref, {
      name: `sticker::${sticker.id}.${extension}`,
      mime: sticker.mime,
      dataB64: comma >= 0 ? sticker.data_url.slice(comma + 1) : '',
      // The chat's rule (W3): inline only a safe picture that keeps the event
      // under the relays' 64 KB; otherwise the contact downloads the sticker.
      thumb: stickerThumb(sticker),
    });
  };

  const retry = (ref: ConvoRef, key: string) => {
    const msg = find(ref, key);
    if (!msg || msg.state !== 'failed') return;
    const convo = convoKey(ref);
    const only = msg.failure?.kind === 'partial' ? msg.failure.members : undefined;
    if (msg.file) {
      const file = pendingFiles.current.get(`${convo}\n${key}`);
      if (!file || !only) return;
      apply({ type: 'retry', convo, key });
      deliverFile(ref, file, { key, only }).catch(error => {
        console.error('send file failed', error);
        apply({ type: 'failed', convo, key, failure: { kind: sendFailureOf(error) } });
      });
      return;
    }
    apply({ type: 'retry', convo, key });
    void deliverText(ref, key, bodyOf(store.current, convo, key) ?? msg.text ?? '', only);
  };

  const forward = async (from: ConvoRef, key: string, to: ConvoRef) => {
    const msg = find(from, key);
    if (!msg || msg.call || to.kind === 'channel') return;
    if (!msg.file) {
      if (msg.text !== undefined) sendText(to, msg.text);
      return;
    }
    try {
      if (to.kind === 'contact') await ensureSession(to.handle);
      await latest.current.api.forwardFile(to.kind === 'contact' ? to.handle : to.gid, to.kind === 'group', msg.file);
      apply({ type: 'optimistic', convo: convoKey(to), msg: { key: newKey(), side: 'me', ts: nowSeconds(), file: msg.file } });
    } catch (error) {
      console.error('forward failed', error);
      latest.current.onError?.({ kind: 'forward', reason: sendFailureOf(error), group: to.kind === 'group' });
    }
  };

  const deleteForMe = async (ref: ConvoRef, key: string) => {
    const msg = find(ref, key);
    if (!msg || msg.call) return;
    const convo = convoKey(ref);
    const text = msg.file ? null : (bodyOf(store.current, convo, key) ?? msg.text ?? null);
    const sha256 = msg.file?.sha256 ?? null;
    // The sender of a group message from others, as the history keeps it,
    // tells apart two members who sent the same in the same second (K11).
    const from = ref.kind === 'group' && msg.side === 'them' ? msg.from : undefined;
    try {
      await (from === undefined
        ? latest.current.api.deleteHistoryItem(convo, msg.ts, msg.side, text, sha256)
        : latest.current.api.deleteHistoryItem(convo, msg.ts, msg.side, text, sha256, from));
    } catch (error) {
      // Never saved there (a send that failed): it only has to leave the screen.
      if (!(isCommandError(error) && error.code === 'not_found')) throw error;
    }
    apply({ type: 'deleted', convo, key });
  };

  const acknowledgeKeyChange = async (handle: string) => {
    await latest.current.api.acknowledgeKeyChange(handle);
    setMismatched(current => {
      if (!current.has(handle)) return current;
      const next = new Set(current);
      next.delete(handle);
      return next;
    });
    await refreshNodes();
  };

  const markRead = useCallback((key: string) => {
    setUnread(current => (current[key] ? { ...current, [key]: 0 } : current));
  }, []);

  const renamed = (from: string, to: string) => {
    apply({ type: 'renamed', from, to });
    setUnread(current => {
      if (!(from in current)) return current;
      const { [from]: count = 0, ...rest } = current;
      return { ...rest, [to]: (rest[to] ?? 0) + count };
    });
    setMismatched(current => {
      if (!current.has(from)) return current;
      const next = new Set(current);
      next.delete(from);
      return next.add(to);
    });
    latest.current.prefs.renameContact(from, to);
    void refreshNodes();
  };

  const removed = (key: string) => {
    apply({ type: 'removed', convo: key });
    setUnread(current => {
      if (!(key in current)) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
    void refreshNodes();
    void refreshGroups();
  };

  const messages = useMemo(
    () => Object.fromEntries(Object.entries(conversations).map(([key, thread]) => [key, thread.msgs])),
    [conversations],
  );

  // Read on every render: a call's "Coinciden" writes `verified:<handle>`
  // through the preferences, outside the shell (W6, I5).
  const trustRef = useRef<Readonly<Record<string, Trust>>>({});
  const { prefs } = options;
  const trust: Record<string, Trust> = {};
  for (const node of nodes) {
    trust[node.handle] =
      mismatched.has(node.handle) || (node.key_changed_at ?? null) !== null
        ? 'keyChanged'
        : prefs.isVerified(node.handle, node.fingerprint)
          ? 'verified'
          : 'unverified';
  }
  if (!sameRecord(trust, trustRef.current)) trustRef.current = trust;

  return {
    nodes,
    nodesLoaded,
    groups,
    messages,
    unread,
    trust: trustRef.current,
    now,
    historyFailed,
    reloadHistory,
    refreshNodes,
    refreshGroups,
    markRead,
    sendText,
    retry,
    sendFiles,
    sendSticker,
    forward,
    deleteForMe,
    acknowledgeKeyChange,
    renamed,
    removed,
  };
}
