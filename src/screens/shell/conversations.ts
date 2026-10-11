/**
 * The messages of every conversation, as a pure reducer: the history loaded
 * at unlock, what arrives live, what this device sends (optimistic, then sent
 * or failed), the calls of the call log (K13), and deleting, expiring,
 * renaming and removing. Keyed like the backend's history: a contact by its
 * handle, a group by `grp:<gid>` (lib/convo).
 *
 * Each message has a stable key: `${ts}:${n}` from the history (n tells apart
 * the items of one second), `live:${ts}:${n}` for what arrived live, the
 * sender's own key for what was sent here, and `call:<id>` for a call. Every
 * conversation stays in order of `ts`; a call carries the time it started, so
 * it goes before what was written during it.
 *
 * The history and the live events overlap: the backend saves a message before
 * it tells the screen, so a message can come both ways. App.tsx put the live
 * ones after a history it loaded later, and showed such a message twice. Here
 * a live message the history also brings is kept once, by its time, side and
 * body (or file); two equal messages that both arrived live stay two.
 */
import type { CallLogWire, FileRef, HistItem } from '../../lib/api';
import { fromWire } from '../../lib/call-events';
import { decodeBody } from '../../lib/message-body';
import type { Msg, SendFailure } from '../types';

export interface Thread {
  /** In order of `ts`; messages of the same second keep the order they came in. */
  readonly msgs: readonly Msg[];
  /**
   * The body each text message travelled with, by message key: the `trm1:`
   * envelope or the reply marker included. "Borrar para mí" (K11) matches the
   * backend's copy on it, and a retry sends it again.
   */
  readonly bodies: Readonly<Record<string, string>>;
}

export type Conversations = Readonly<Record<string, Thread>>;

export const EMPTY_CONVERSATIONS: Conversations = {};

const EMPTY_THREAD: Thread = { msgs: [], bodies: {} };

export type SendFailureInfo = { kind: SendFailure; members?: string[] };

export type ConversationsAction =
  /** The history the backend keeps, read at unlock. `now` drops what already expired. */
  | { type: 'history'; history: Readonly<Record<string, readonly HistItem[]>>; now: number }
  /** A message from someone else: a text body as it travelled, or a file. */
  | { type: 'incoming'; convo: string; ts: number; body?: string; file?: FileRef; from?: string }
  /** Something this device sends or sent, with the body that went out. */
  | { type: 'optimistic'; convo: string; msg: Msg; body?: string }
  /** The backend took it; with a receipt (K4) a relay stored it, at the receipt's time. */
  | { type: 'sent'; convo: string; key: string; receipt: { ts: number } | null }
  | { type: 'failed'; convo: string; key: string; failure: SendFailureInfo; ts?: number }
  | { type: 'retry'; convo: string; key: string }
  | { type: 'deleted'; convo: string; key: string }
  | { type: 'pruned'; now: number }
  | { type: 'renamed'; from: string; to: string }
  | { type: 'removed'; convo: string }
  /** A call that ended, as `call-logged` brings it (K13). */
  | { type: 'call'; log: CallLogWire };

export function messagesOf(state: Conversations, convo: string): readonly Msg[] {
  return state[convo]?.msgs ?? EMPTY_THREAD.msgs;
}

export function bodyOf(state: Conversations, convo: string, key: string): string | undefined {
  return state[convo]?.bodies[key];
}

const HISTORY_KEY = /^\d+:\d+$/;
const isHistoryKey = (key: string) => HISTORY_KEY.test(key);
const callKey = (id: string) => `call:${id}`;

/** What makes two copies of one message the same: its time, side and body, or its file. */
function signature(msg: Msg, body: string | undefined): string {
  return [msg.ts, msg.side, body ?? msg.text ?? '', msg.file?.sha256 ?? ''].join('\n');
}

/** Only the fields that are set, so a message never carries `undefined` ones. */
function textFields(body: string, ts: number): Pick<Msg, 'text' | 'reply' | 'ttl' | 'expiresAt'> {
  const { text, reply, ttl } = decodeBody(body);
  return {
    text,
    ...(reply && { reply }),
    ...(ttl && ttl > 0 ? { ttl, expiresAt: ts + ttl } : {}),
  };
}

function callMessage(ts: number, wire: CallLogWire['call']): Msg {
  const call = fromWire(wire);
  const ttl = wire.ttl;
  return {
    key: callKey(call.id),
    side: call.direction === 'outgoing' ? 'me' : 'them',
    ts,
    call,
    ...(typeof ttl === 'number' && ttl > 0 ? { ttl, expiresAt: ts + ttl } : {}),
  };
}

function fromHistory(item: HistItem, key: string): Msg | null {
  if (item.call) return callMessage(item.ts, item.call);
  if (typeof item.text !== 'string' && !item.file) return null;
  return {
    key,
    side: item.side,
    ts: item.ts,
    ...(typeof item.text === 'string' && textFields(item.text, item.ts)),
    ...(item.file && { file: item.file }),
    ...(typeof item.from === 'string' && { from: item.from }),
  };
}

const expired = (msg: Msg, now: number) => msg.expiresAt !== undefined && msg.expiresAt <= now;

/** `msgs` with `msg` after every message of its second or earlier. */
function insertSorted(msgs: readonly Msg[], msg: Msg): Msg[] {
  let index = msgs.length;
  while (index > 0 && msgs[index - 1]!.ts > msg.ts) index -= 1;
  return [...msgs.slice(0, index), msg, ...msgs.slice(index)];
}

function loadThread(items: readonly HistItem[], now: number): Thread {
  const msgs: Msg[] = [];
  const bodies: Record<string, string> = {};
  const perSecond = new Map<number, number>();
  for (const item of items) {
    const n = perSecond.get(item.ts) ?? 0;
    perSecond.set(item.ts, n + 1);
    const msg = fromHistory(item, `${item.ts}:${n}`);
    if (!msg || expired(msg, now) || msgs.some(other => other.key === msg.key)) continue;
    msgs.push(msg);
    if (!item.call && typeof item.text === 'string') bodies[msg.key] = item.text;
  }
  // Stable: items of one second keep the history's order.
  msgs.sort((a, b) => a.ts - b.ts);
  return { msgs, bodies };
}

/**
 * The history, plus what this session has that the history does not: live
 * messages it lacks, and what is still sending or failed. A message an
 * earlier history load brought is replaced by this one.
 */
function mergeLive(loaded: Thread, live: Thread): Thread {
  const copies = new Map<string, number>();
  for (const msg of loaded.msgs) {
    if (msg.call) continue;
    const sig = signature(msg, loaded.bodies[msg.key]);
    copies.set(sig, (copies.get(sig) ?? 0) + 1);
  }
  let msgs: Msg[] = [...loaded.msgs];
  const bodies: Record<string, string> = { ...loaded.bodies };
  for (const msg of live.msgs) {
    if (isHistoryKey(msg.key)) continue;
    if (msg.call) {
      if (msgs.some(other => other.key === msg.key)) continue;
    } else if (msg.state !== 'sending' && msg.state !== 'failed') {
      const sig = signature(msg, live.bodies[msg.key]);
      const left = copies.get(sig) ?? 0;
      if (left > 0) {
        copies.set(sig, left - 1);
        continue;
      }
    }
    msgs = insertSorted(msgs, msg);
    const body = live.bodies[msg.key];
    if (body !== undefined) bodies[msg.key] = body;
  }
  return { msgs, bodies };
}

/** Whether the history already holds a copy of `msg`. */
function inHistory(thread: Thread, msg: Msg, body: string | undefined): boolean {
  const sig = signature(msg, body);
  return thread.msgs.some(other => isHistoryKey(other.key) && signature(other, thread.bodies[other.key]) === sig);
}

function withoutKey(bodies: Readonly<Record<string, string>>, key: string): Record<string, string> {
  if (!(key in bodies)) return bodies as Record<string, string>;
  const { [key]: _gone, ...rest } = bodies;
  return rest;
}

/** The thread with message `key` replaced by `update(msg)`, re-sorted if its time changed; null drops it. */
function updateMessage(thread: Thread, key: string, update: (msg: Msg) => Msg | null): Thread {
  const index = thread.msgs.findIndex(msg => msg.key === key);
  if (index < 0) return thread;
  const before = thread.msgs[index]!;
  const after = update(before);
  const rest = [...thread.msgs.slice(0, index), ...thread.msgs.slice(index + 1)];
  if (after === null) return { msgs: rest, bodies: withoutKey(thread.bodies, key) };
  if (after.ts === before.ts) return { ...thread, msgs: [...rest.slice(0, index), after, ...rest.slice(index)] };
  return { ...thread, msgs: insertSorted(rest, after) };
}

function withThread(state: Conversations, convo: string, thread: Thread): Conversations {
  return thread === state[convo] ? state : { ...state, [convo]: thread };
}

/** A key for a live message of second `ts` that no message of the thread has. */
function liveKey(thread: Thread, ts: number): string {
  for (let n = 0; ; n += 1) {
    const key = `live:${ts}:${n}`;
    if (!thread.msgs.some(msg => msg.key === key)) return key;
  }
}

export function conversationsReducer(state: Conversations, action: ConversationsAction): Conversations {
  switch (action.type) {
    case 'history': {
      const next: Record<string, Thread> = {};
      for (const convo of new Set([...Object.keys(action.history), ...Object.keys(state)])) {
        const loaded = loadThread(action.history[convo] ?? [], action.now);
        const live = state[convo];
        next[convo] = live ? mergeLive(loaded, live) : loaded;
      }
      return next;
    }

    case 'incoming': {
      const thread = state[action.convo] ?? EMPTY_THREAD;
      const msg: Msg = {
        key: '',
        side: 'them',
        ts: action.ts,
        ...(action.body !== undefined && textFields(action.body, action.ts)),
        ...(action.file && { file: action.file }),
        ...(action.from !== undefined && { from: action.from }),
      };
      if (inHistory(thread, msg, action.body)) return state;
      msg.key = liveKey(thread, action.ts);
      return withThread(state, action.convo, {
        msgs: insertSorted(thread.msgs, msg),
        bodies: action.body === undefined ? thread.bodies : { ...thread.bodies, [msg.key]: action.body },
      });
    }

    case 'optimistic': {
      const thread = state[action.convo] ?? EMPTY_THREAD;
      if (thread.msgs.some(msg => msg.key === action.msg.key)) return state;
      return withThread(state, action.convo, {
        msgs: insertSorted(thread.msgs, action.msg),
        bodies: action.body === undefined ? thread.bodies : { ...thread.bodies, [action.msg.key]: action.body },
      });
    }

    case 'sent': {
      const thread = state[action.convo];
      if (!thread) return state;
      const { receipt } = action;
      return withThread(
        state,
        action.convo,
        updateMessage(thread, action.key, msg => {
          const { state: _state, failure: _failure, ...rest } = msg;
          const sent: Msg = receipt ? { ...rest, state: 'sent', ts: receipt.ts } : rest;
          // The history may already hold it, under the time of its receipt.
          return inHistory(thread, sent, thread.bodies[msg.key]) ? null : sent;
        }),
      );
    }

    case 'failed': {
      const thread = state[action.convo];
      if (!thread) return state;
      return withThread(
        state,
        action.convo,
        updateMessage(thread, action.key, msg => ({
          ...msg,
          state: 'failed',
          failure: action.failure,
          ts: action.ts ?? msg.ts,
        })),
      );
    }

    case 'retry': {
      const thread = state[action.convo];
      if (!thread) return state;
      return withThread(
        state,
        action.convo,
        updateMessage(thread, action.key, msg => {
          const { failure: _failure, ...rest } = msg;
          return { ...rest, state: 'sending' };
        }),
      );
    }

    case 'deleted': {
      const thread = state[action.convo];
      if (!thread) return state;
      return withThread(state, action.convo, updateMessage(thread, action.key, () => null));
    }

    case 'pruned': {
      let next: Record<string, Thread> | null = null;
      for (const [convo, thread] of Object.entries(state)) {
        if (!thread.msgs.some(msg => expired(msg, action.now))) continue;
        let bodies = thread.bodies;
        const msgs = thread.msgs.filter(msg => {
          if (!expired(msg, action.now)) return true;
          bodies = withoutKey(bodies, msg.key);
          return false;
        });
        next ??= { ...state };
        next[convo] = { msgs, bodies };
      }
      return next ?? state;
    }

    case 'renamed': {
      const moving = state[action.from];
      if (!moving || action.from === action.to) return state;
      const { [action.from]: _old, ...rest } = state;
      const target = state[action.to] ?? EMPTY_THREAD;
      let msgs: Msg[] = [...target.msgs];
      const bodies: Record<string, string> = { ...target.bodies };
      for (const msg of moving.msgs) {
        let key = msg.key;
        // A call is the same call under both names; any other key that clashes takes a new one.
        if (msg.call && msgs.some(other => other.key === key)) continue;
        while (msgs.some(other => other.key === key)) key += '+';
        msgs = insertSorted(msgs, key === msg.key ? msg : { ...msg, key });
        const body = moving.bodies[msg.key];
        if (body !== undefined) bodies[key] = body;
      }
      return { ...rest, [action.to]: { msgs, bodies } };
    }

    case 'removed': {
      if (!(action.convo in state)) return state;
      const { [action.convo]: _gone, ...rest } = state;
      return rest;
    }

    case 'call': {
      const { log } = action;
      const thread = state[log.peer] ?? EMPTY_THREAD;
      const msg = callMessage(log.ts, log.call);
      if (thread.msgs.some(other => other.key === msg.key)) return state;
      return withThread(state, log.peer, { ...thread, msgs: insertSorted(thread.msgs, msg) });
    }
  }
}
