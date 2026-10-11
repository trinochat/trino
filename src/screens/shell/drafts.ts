/**
 * What was typed in each conversation and not sent yet. Only in memory: a
 * draft is message text, and `localStorage` would leave it in clear on the
 * disk. Locking unmounts the shell, and the drafts go with it.
 */
import { useCallback, useState } from 'react';

export type Drafts = ReadonlyMap<string, string>;

/** `drafts` with the draft of conversation `key`; an empty text removes it. */
export function setDraft(drafts: Drafts, key: string, text: string): Drafts {
  if ((drafts.get(key) ?? '') === text) return drafts;
  const next = new Map(drafts);
  if (text === '') next.delete(key);
  else next.set(key, text);
  return next;
}

/** `drafts` with the draft of `from` under `to`, as when a contact is renamed. */
export function moveDraft(drafts: Drafts, from: string, to: string): Drafts {
  const text = drafts.get(from);
  if (text === undefined || from === to) return drafts;
  const next = new Map(drafts);
  next.delete(from);
  next.set(to, text);
  return next;
}

export function useDrafts() {
  const [drafts, setDrafts] = useState<Drafts>(() => new Map());
  return {
    drafts,
    setDraft: useCallback((key: string, text: string) => setDrafts(current => setDraft(current, key, text)), []),
    moveDraft: useCallback((from: string, to: string) => setDrafts(current => moveDraft(current, from, to)), []),
  };
}
