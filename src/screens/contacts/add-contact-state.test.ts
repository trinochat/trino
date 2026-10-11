import { describe, expect, it } from 'vitest';
import type { ContactPreview } from '../../lib/api';
import { toCompactCodeV2 } from '../../lib/contact-code';
import {
  ADD_CONTACT_IDLE,
  addContactReducer,
  addFailureOf,
  addRequest,
  conflictOf,
  type AddContactEvent,
  type AddContactState,
} from './add-contact-state';

const BUNDLE = JSON.stringify({
  handle: 'Ana Torres',
  idSig: 'd4'.repeat(64),
  ikDhPub: '8f'.repeat(32),
  ikSignPub: '3b'.repeat(32),
  nostrPub: 'a1'.repeat(32),
  opkId: null,
  opkPub: null,
  spkId: 7,
  spkPub: 'e7'.repeat(32),
  spkSig: '0f'.repeat(64),
});
const CODE = toCompactCodeV2(BUNDLE);

const preview = (existing: ContactPreview['existing'] = null, handle = 'Ana Torres'): ContactPreview => ({
  handle,
  fingerprint: '7f3a.91c2.0b5e.d4a8',
  identity_digest: 'ab'.repeat(32),
  existing,
});

const run = (events: AddContactEvent[], from: AddContactState = ADD_CONTACT_IDLE) =>
  events.reduce(addContactReducer, from);

/** Paste the code and let the backend answer with `p`. */
const previewed = (p: ContactPreview = preview()) => {
  const checking = run([{ type: 'input', text: CODE }]);
  if (checking.kind !== 'checking') throw new Error('expected checking');
  return run([{ type: 'previewed', bundleJson: checking.bundleJson, preview: p }], checking);
};

describe('addContactReducer', () => {
  it('is idle with nothing pasted, and back to idle when the text is cleared', () => {
    expect(ADD_CONTACT_IDLE).toEqual({ kind: 'idle' });
    expect(run([{ type: 'input', text: '  \n' }])).toEqual({ kind: 'idle' });
    expect(run([{ type: 'input', text: CODE }, { type: 'input', text: '' }])).toEqual({ kind: 'idle' });
  });

  it('checks a pasted code, and calls a text that is no code invalid', () => {
    const checking = run([{ type: 'input', text: CODE }]);
    expect(checking.kind).toBe('checking');
    expect(checking.kind === 'checking' && JSON.parse(checking.bundleJson).handle).toBe('Ana Torres');
    expect(run([{ type: 'input', text: 'hola' }])).toEqual({ kind: 'invalid' });
  });

  it('keeps checking the same code when only the spaces around it change', () => {
    const checking = run([{ type: 'input', text: CODE }]);
    expect(run([{ type: 'input', text: `  ${CODE}\n` }], checking)).toBe(checking);
  });

  it('shows the card of a valid code, ready to add under the name in it', () => {
    const state = previewed();
    expect(state).toMatchObject({ kind: 'ready', card: { name: 'Ana Torres', confirmReplace: false, editingName: false } });
    expect(conflictOf(state)).toBeNull();
    expect(addRequest(state)).toEqual({ bundleJson: expect.any(String), handle: 'Ana Torres' });
  });

  it('ignores an answer for a code that is no longer pasted', () => {
    const checking = run([{ type: 'input', text: CODE }]);
    const other = run([{ type: 'input', text: 'hola' }], checking);
    expect(run([{ type: 'previewed', bundleJson: (checking as { bundleJson: string }).bundleJson, preview: preview() }], other)).toBe(other);
  });

  it('calls a code the backend refused invalid, and lets a failed check be retried', () => {
    const checking = run([{ type: 'input', text: CODE }]);
    const bundleJson = (checking as { bundleJson: string }).bundleJson;
    expect(run([{ type: 'previewFailed', bundleJson, invalid: true }], checking)).toEqual({ kind: 'invalid' });
    const failed = run([{ type: 'previewFailed', bundleJson, invalid: false }], checking);
    expect(failed).toEqual({ kind: 'checkFailed', bundleJson });
    expect(run([{ type: 'retry' }], failed)).toEqual({ kind: 'checking', bundleJson });
  });

  it('knows a person you already have under another name, and adds nothing', () => {
    const state = previewed(preview({ handle: 'Anita', same_keys: true }));
    expect(conflictOf(state)).toEqual({ kind: 'known', handle: 'Anita' });
    expect(addRequest(state)).toBeNull();
    expect(run([{ type: 'submit' }], state)).toBe(state);
  });

  it('never replaces a contact with the same name and other keys without an explicit yes', () => {
    const state = previewed(preview({ handle: 'Ana Torres', same_keys: false }));
    expect(conflictOf(state)).toEqual({ kind: 'nameTaken', handle: 'Ana Torres' });
    expect(state.kind === 'ready' && state.card.editingName).toBe(true);
    expect(addRequest(state)).toBeNull();
    expect(run([{ type: 'submit' }], state)).toBe(state);

    const confirmed = run([{ type: 'confirmReplace', on: true }], state);
    expect(addRequest(confirmed)).toEqual({ bundleJson: expect.any(String), handle: 'Ana Torres', replaceExisting: true });
    expect(run([{ type: 'submit' }], confirmed)).toMatchObject({ kind: 'adding', request: { replaceExisting: true } });
  });

  it('drops the yes to replacing when the name changes, and adds under the new name instead', () => {
    const state = run(
      [
        { type: 'confirmReplace', on: true },
        { type: 'rename', name: 'Ana del trabajo' },
      ],
      previewed(preview({ handle: 'Ana Torres', same_keys: false })),
    );
    expect(conflictOf(state)).toBeNull();
    expect(state.kind === 'ready' && state.card.confirmReplace).toBe(false);
    expect(addRequest(state)).toEqual({ bundleJson: expect.any(String), handle: 'Ana del trabajo' });
    const back = run([{ type: 'rename', name: ' Ana Torres ' }], state);
    expect(conflictOf(back)).toEqual({ kind: 'nameTaken', handle: 'Ana Torres' });
    expect(addRequest(back)).toBeNull();
  });

  it('ignores a yes to replacing when there is nothing to replace', () => {
    const state = previewed();
    expect(run([{ type: 'confirmReplace', on: true }], state)).toBe(state);
  });

  it('asks for a name when the code brings none, and adds nothing without one', () => {
    const state = previewed(preview(null, ''));
    expect(state).toMatchObject({ kind: 'ready', card: { name: '', editingName: true } });
    expect(addRequest(state)).toBeNull();
    expect(addRequest(run([{ type: 'rename', name: '   ' }], state))).toBeNull();
    expect(addRequest(run([{ type: 'rename', name: ' Ana ' }], state))).toMatchObject({ handle: 'Ana' });
  });

  it('adds, then is done with the name the backend saved', () => {
    const adding = run([{ type: 'submit' }], previewed());
    expect(adding).toMatchObject({ kind: 'adding', request: { handle: 'Ana Torres' } });
    expect(run([{ type: 'added', handle: 'Ana Torres' }], adding)).toEqual({ kind: 'added', handle: 'Ana Torres' });
  });

  it('goes back to the card with the reason when adding fails: name_taken opens the name', () => {
    const adding = run([{ type: 'submit' }], previewed());
    const taken = run([{ type: 'addFailed', error: { code: 'name_taken' } }], adding);
    expect(taken).toMatchObject({ kind: 'ready', error: { code: 'name_taken' }, card: { editingName: true } });
    expect(addRequest(taken)).toBeNull();
    const renamed = run([{ type: 'rename', name: 'Ana 2' }], taken);
    expect(renamed.kind === 'ready' && renamed.error).toBeUndefined();
    expect(addRequest(renamed)).toMatchObject({ handle: 'Ana 2' });

    const known = run([{ type: 'addFailed', error: { code: 'already_contact', handle: 'Anita' } }], adding);
    expect(known).toMatchObject({ kind: 'ready', error: { code: 'already_contact', handle: 'Anita' } });
    expect(addRequest(known)).toBeNull();

    const other = run([{ type: 'addFailed', error: { code: 'other' } }], adding);
    expect(addRequest(other)).toMatchObject({ handle: 'Ana Torres' });
  });

  it('starts over on reset', () => {
    expect(run([{ type: 'reset' }], previewed())).toEqual({ kind: 'idle' });
  });
});

describe('addFailureOf', () => {
  it('reads the reason out of what probe_node rejects with', () => {
    expect(addFailureOf({ code: 'name_taken', message: 'x' })).toEqual({ code: 'name_taken' });
    expect(addFailureOf({ code: 'already_contact', message: 'x', handle: 'Anita' })).toEqual({
      code: 'already_contact',
      handle: 'Anita',
    });
    expect(addFailureOf({ code: 'io', message: 'x' })).toEqual({ code: 'other' });
    expect(addFailureOf('bundle signature invalid')).toEqual({ code: 'other' });
  });
});
