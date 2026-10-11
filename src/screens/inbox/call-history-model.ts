/**
 * The call log of the Calls tab (PropLlamadas:53-87): the calls of every
 * chat, the newest first, all of them or only the missed ones, and "N": the
 * missed calls since the log was last seen. Pure, like inbox-model.ts.
 *
 * The backend records only the calls that ended with Trino open and unlocked
 * (K13), so the tab says so under the list. A call lives in its contact's
 * chat history: it goes with the chat's disappearing messages, at the time
 * the backend prunes it (`ts + ttl`), and with the contact when it is
 * removed, so the log lets it go then too.
 */
import type { CallLogWire } from '../../lib/api';
import { fromWire, isMissed } from '../../lib/call-events';
import type { CallLogEntry } from '../types';

export type CallFilter = 'all' | 'missed';

/** The chips of the tab, in order. */
export const CALL_FILTERS: readonly CallFilter[] = ['all', 'missed'];

/** A call of the log as the shell keeps it: an entry, and when it goes if its chat has disappearing messages. */
export interface LoggedCall extends CallLogEntry {
  /** Epoch seconds, `ts + ttl`: when the backend prunes the call and the chat drops its copy. */
  expiresAt?: number;
}

/** An entry of `list_call_history` or `call-logged`, keyed like the call's message in its chat. */
export function fromLog(wire: CallLogWire): LoggedCall {
  const call = fromWire(wire.call);
  const { ttl } = wire.call;
  return {
    key: `call:${call.id}`,
    peer: wire.peer,
    ts: wire.ts,
    call,
    ...(typeof ttl === 'number' && ttl > 0 && { expiresAt: wire.ts + ttl }),
  };
}

/** The newest first; calls of the same second keep their order. */
export function sortCalls<T extends CallLogEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => b.ts - a.ts);
}

/** `entries` with `entry` in its place, or the same list when it is there already. */
export function addCall<T extends CallLogEntry>(entries: readonly T[], entry: T): readonly T[] {
  if (entries.some(other => other.key === entry.key)) return entries;
  const index = entries.findIndex(other => other.ts < entry.ts);
  return index < 0 ? [...entries, entry] : [...entries.slice(0, index), entry, ...entries.slice(index)];
}

export function filterCalls<T extends CallLogEntry>(entries: readonly T[], filter: CallFilter): readonly T[] {
  return filter === 'missed' ? entries.filter(entry => isMissed(entry.call)) : entries;
}

/** The missed calls that started after `seenAt` (epoch seconds): the N of "Llamadas · N". */
export function missedUnseen(entries: readonly CallLogEntry[], seenAt: number): number {
  return entries.filter(entry => entry.ts > seenAt && isMissed(entry.call)).length;
}

/** The log with the calls of a renamed contact under its new handle. */
export function renamePeer<T extends CallLogEntry>(entries: readonly T[], from: string, to: string): readonly T[] {
  if (!entries.some(entry => entry.peer === from)) return entries;
  return entries.map(entry => (entry.peer === from ? { ...entry, peer: to } : entry));
}

/** The log without the calls whose time ran out by `now` (epoch seconds); the same list when none did. */
export function withoutExpired<T extends LoggedCall>(entries: readonly T[], now: number): readonly T[] {
  const live = entries.filter(entry => entry.expiresAt === undefined || entry.expiresAt > now);
  return live.length === entries.length ? entries : live;
}

/** The log without the calls of a contact that was removed; the same list when it had none. */
export function withoutPeer<T extends CallLogEntry>(entries: readonly T[], peer: string): readonly T[] {
  return entries.some(entry => entry.peer === peer) ? entries.filter(entry => entry.peer !== peer) : entries;
}
