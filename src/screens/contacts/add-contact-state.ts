/**
 * Adding a contact from a pasted code (Contacts:54-80), as a pure state
 * machine: the panel draws a state and runs its requests. The backend
 * checks the code's signatures without saving (preview_contact, K8), so
 * "Código válido" means checked; and it never overwrites a contact (K8):
 * replacing one that has the same name with other keys takes an explicit
 * yes here, and then `replaceExisting`. The same keys under the same name
 * only bring the contact's code up to date (`conflictOf`).
 */
import { isCommandError, type ContactPreview } from '../../lib/api';
import { parseContactCode } from '../../lib/contact-code';

export interface AddContactCard {
  /** The bundle in the pasted code. */
  bundleJson: string;
  /** What the backend read in it. */
  preview: ContactPreview;
  /** The name to save the contact under: the code's, until the person changes it. */
  name: string;
  /** The person said yes to replacing the contact that has this name with other keys. */
  confirmReplace: boolean;
  /** The name field shows: the code has no name, or the name is taken. It stays once shown. */
  editingName: boolean;
}

/** Why adding failed: the name is someone else's, the keys already are a contact, or anything else. */
export type AddFailure = { code: 'name_taken' } | { code: 'already_contact'; handle: string } | { code: 'other' };

export interface AddRequest {
  bundleJson: string;
  handle: string;
  /** Only after an explicit yes; left out otherwise, as older backends expect. */
  replaceExisting?: true;
}

export type AddContactState =
  | { kind: 'idle' }
  /** The pasted text is no code, or the backend refused its signatures. */
  | { kind: 'invalid' }
  | { kind: 'checking'; bundleJson: string }
  /** The check failed for another reason; it can be retried. */
  | { kind: 'checkFailed'; bundleJson: string }
  | { kind: 'ready'; card: AddContactCard; error?: AddFailure }
  | { kind: 'adding'; card: AddContactCard; request: AddRequest }
  /** `refreshed`: the contact was there with these keys, and only its code changed. */
  | { kind: 'added'; handle: string; refreshed?: true };

export type AddContactEvent =
  | { type: 'input'; text: string }
  | { type: 'previewed'; bundleJson: string; preview: ContactPreview }
  | { type: 'previewFailed'; bundleJson: string; invalid: boolean }
  | { type: 'retry' }
  | { type: 'rename'; name: string }
  | { type: 'confirmReplace'; on: boolean }
  | { type: 'submit' }
  | { type: 'added'; handle: string }
  | { type: 'addFailed'; error: AddFailure }
  | { type: 'reset' };

export const ADD_CONTACT_IDLE: AddContactState = { kind: 'idle' };

/**
 * What stands between the card and adding it, read as K8 answers
 * (preview_contact and add_contact):
 *
 * - `known`: a contact has all three keys of the code under another name.
 *   It is the same person, and nothing is added;
 * - `refresh`: a contact has all three keys under the chosen name. Adding
 *   puts this code in place of the stored one (a newer prekey);
 * - `nameTaken`: the chosen name belongs to a contact with other keys, which
 *   is replaced only after an explicit yes;
 * - `sharesKeys`: a contact holds some of the code's keys without having the
 *   code's name, so the preview found it by a key. Two contacts never share
 *   a key, and one key does not make the same person: nothing is added.
 *
 * Null when nothing stands in the way.
 */
export type AddConflict =
  | { kind: 'known'; handle: string }
  | { kind: 'refresh'; handle: string }
  | { kind: 'nameTaken'; handle: string }
  | { kind: 'sharesKeys'; handle: string };

export function conflictOf(state: AddContactState): AddConflict | null {
  if (state.kind !== 'ready' && state.kind !== 'adding') return null;
  const { preview, name } = state.card;
  const existing = preview.existing;
  // add_contact refuses keys that another contact holds, even one of the
  // three: the same person only when the preview found all of them under that name.
  if (state.kind === 'ready' && state.error?.code === 'already_contact') {
    const handle = state.error.handle;
    return existing?.same_keys && existing.handle === handle ? { kind: 'known', handle } : { kind: 'sharesKeys', handle };
  }
  if (!existing) return null;
  const chosen = name.trim();
  if (existing.same_keys) {
    return { kind: chosen === existing.handle ? 'refresh' : 'known', handle: existing.handle };
  }
  if (chosen === existing.handle) return { kind: 'nameTaken', handle: existing.handle };
  // Other keys without the code's name: the preview found that contact by one of its keys.
  if (existing.handle !== preview.handle.trim()) return { kind: 'sharesKeys', handle: existing.handle };
  return null;
}

/** The request the add button sends, or null while it cannot add. */
export function addRequest(state: AddContactState): AddRequest | null {
  if (state.kind !== 'ready') return null;
  const handle = state.card.name.trim();
  if (handle === '' || state.error?.code === 'name_taken' || state.error?.code === 'already_contact') return null;
  const conflict = conflictOf(state);
  if (conflict?.kind === 'known' || conflict?.kind === 'sharesKeys') return null;
  if (conflict?.kind === 'nameTaken') {
    return state.card.confirmReplace ? { bundleJson: state.card.bundleJson, handle, replaceExisting: true } : null;
  }
  return { bundleJson: state.card.bundleJson, handle };
}

/** The reason in what probe_node rejects with (K8); older backends reject with a string. */
export function addFailureOf(error: unknown): AddFailure {
  if (isCommandError(error)) {
    if (error.code === 'name_taken') return { code: 'name_taken' };
    if (error.code === 'already_contact') return { code: 'already_contact', handle: error.handle ?? '' };
  }
  return { code: 'other' };
}

function cardFor(bundleJson: string, preview: ContactPreview): AddContactCard {
  const name = preview.handle.trim();
  const card = { bundleJson, preview, name, confirmReplace: false, editingName: false };
  const taken = preview.existing !== null && !preview.existing.same_keys && name === preview.existing.handle;
  return { ...card, editingName: name === '' || taken };
}

export function addContactReducer(state: AddContactState, event: AddContactEvent): AddContactState {
  switch (event.type) {
    case 'input': {
      if (event.text.trim() === '') return ADD_CONTACT_IDLE;
      const code = parseContactCode(event.text);
      if (!code) return { kind: 'invalid' };
      const current = state.kind === 'ready' || state.kind === 'adding' ? state.card.bundleJson : undefined;
      const pending = state.kind === 'checking' || state.kind === 'checkFailed' ? state.bundleJson : undefined;
      if (code.bundleJson === current || code.bundleJson === pending) return state;
      return { kind: 'checking', bundleJson: code.bundleJson };
    }
    case 'previewed':
      if (state.kind !== 'checking' || state.bundleJson !== event.bundleJson) return state;
      return { kind: 'ready', card: cardFor(event.bundleJson, event.preview) };
    case 'previewFailed':
      if (state.kind !== 'checking' || state.bundleJson !== event.bundleJson) return state;
      return event.invalid ? { kind: 'invalid' } : { kind: 'checkFailed', bundleJson: event.bundleJson };
    case 'retry':
      return state.kind === 'checkFailed' ? { kind: 'checking', bundleJson: state.bundleJson } : state;
    case 'rename':
      if (state.kind !== 'ready') return state;
      return { kind: 'ready', card: { ...state.card, name: event.name, confirmReplace: false, editingName: true } };
    case 'confirmReplace':
      if (state.kind !== 'ready' || conflictOf(state)?.kind !== 'nameTaken') return state;
      return { ...state, card: { ...state.card, confirmReplace: event.on } };
    case 'submit': {
      const request = addRequest(state);
      return request && state.kind === 'ready' ? { kind: 'adding', card: state.card, request } : state;
    }
    case 'added':
      if (state.kind !== 'adding') return state;
      return conflictOf(state)?.kind === 'refresh'
        ? { kind: 'added', handle: event.handle, refreshed: true }
        : { kind: 'added', handle: event.handle };
    case 'addFailed':
      if (state.kind !== 'adding') return state;
      return {
        kind: 'ready',
        card: { ...state.card, editingName: state.card.editingName || event.error.code === 'name_taken' },
        error: event.error,
      };
    case 'reset':
      return ADD_CONTACT_IDLE;
  }
}
