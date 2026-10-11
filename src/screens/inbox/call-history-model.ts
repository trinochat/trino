/**
 * The call log of the Calls tab (PropLlamadas:53-87): the calls of every
 * chat, the newest first, all of them or only the missed ones, and "N": the
 * missed calls since the log was last seen. Pure, like inbox-model.ts.
 *
 * The backend records only the calls that ended with Trino open and unlocked
 * (K13), so the tab says so under the list.
 */
import type { CallLogWire } from '../../lib/api';
import { fromWire, isMissed } from '../../lib/call-events';
import type { CallLogEntry } from '../types';

export type CallFilter = 'all' | 'missed';

/** The chips of the tab, in order. */
export const CALL_FILTERS: readonly CallFilter[] = ['all', 'missed'];

/** An entry of `list_call_history` or `call-logged`, keyed like the call's message in its chat. */
export function fromLog(wire: CallLogWire): CallLogEntry {
  const call = fromWire(wire.call);
  return { key: `call:${call.id}`, peer: wire.peer, ts: wire.ts, call };
}

/** The newest first; calls of the same second keep their order. */
export function sortCalls(entries: readonly CallLogEntry[]): CallLogEntry[] {
  return [...entries].sort((a, b) => b.ts - a.ts);
}

/** `entries` with `entry` in its place, or the same list when it is there already. */
export function addCall(entries: readonly CallLogEntry[], entry: CallLogEntry): readonly CallLogEntry[] {
  if (entries.some(other => other.key === entry.key)) return entries;
  const index = entries.findIndex(other => other.ts < entry.ts);
  return index < 0 ? [...entries, entry] : [...entries.slice(0, index), entry, ...entries.slice(index)];
}

export function filterCalls(entries: readonly CallLogEntry[], filter: CallFilter): readonly CallLogEntry[] {
  return filter === 'missed' ? entries.filter(entry => isMissed(entry.call)) : entries;
}

/** The missed calls that started after `seenAt` (epoch seconds): the N of "Llamadas · N". */
export function missedUnseen(entries: readonly CallLogEntry[], seenAt: number): number {
  return entries.filter(entry => entry.ts > seenAt && isMissed(entry.call)).length;
}

/** The log with the calls of a renamed contact under its new handle. */
export function renamePeer(entries: readonly CallLogEntry[], from: string, to: string): readonly CallLogEntry[] {
  if (!entries.some(entry => entry.peer === from)) return entries;
  return entries.map(entry => (entry.peer === from ? { ...entry, peer: to } : entry));
}
