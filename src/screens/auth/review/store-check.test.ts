import { describe, expect, it } from 'vitest';
import type { IntegrityFinding, UnsealResponse } from '../../../lib/api';
import { itemOf, needsReview, reviewOf, storeCheckOf } from './store-check';

const finding = (file: string, what: IntegrityFinding['what'], action: IntegrityFinding['action']): IntegrityFinding => ({
  file,
  what,
  action,
});

const UNSEALED: UnsealResponse = {
  handle: 'Ana',
  fingerprint: 'f1f2',
  nostr_pub: 'cc',
  relay_connection_started: true,
  prefs_import: 'done',
  custom_data_dir: false,
};

// What the one dialog at unlock shows (design §6.1, §6.2 and §11.4), from
// the report the backend sends (src-tauri/src/store/report.rs).
describe('storeCheckOf', () => {
  it('shows nothing without findings', () => {
    expect(storeCheckOf(undefined)).toBeNull();
    expect(storeCheckOf({ findings: [] })).toBeNull();
  });

  // "Una sola pregunta para todo lo que no se pudo comprobar, no una por archivo."
  it('asks one question for every file that waits, older copies apart from unverified ones', () => {
    const older = storeCheckOf({ findings: [finding('account', 'olderCopy', 'ask')] });
    expect(older?.question).toEqual({ kind: 'older', files: ['account'], items: ['account'] });

    const unverified = storeCheckOf({
      findings: [
        finding('index', 'missing', 'notice'),
        finding('account', 'unverified', 'ask'),
        finding('prefs', 'unverified', 'ask'),
        finding('history', 'unverified', 'ask'),
        finding('sessions', 'unverified', 'newSessions'),
      ],
    });
    expect(unverified?.question).toEqual({
      kind: 'unverified',
      files: ['account', 'prefs', 'history'],
      items: ['account', 'prefs', 'history'],
    });
    expect(unverified?.notices).toEqual([
      { item: 'index', kind: 'index' },
      { item: 'sessions', kind: 'newSessions' },
    ]);
  });

  it('asks about older copies only when every file that waits is one', () => {
    const mixed = storeCheckOf({
      findings: [finding('account', 'olderCopy', 'ask'), finding('history', 'behind', 'ask')],
    });
    expect(mixed?.question?.kind).toBe('unverified');
  });

  it('tells what Trino did by itself, once per kind of file', () => {
    const check = storeCheckOf({
      findings: [
        finding('history', 'altered', 'setAside'),
        finding('sticker:' + 'a'.repeat(32), 'altered', 'setAside'),
        finding('sticker:' + 'b'.repeat(32), 'altered', 'setAside'),
        finding('sticker:' + 'c'.repeat(32), 'olderCopy', 'setAside'),
        finding('sticker:' + 'd'.repeat(32), 'unverified', 'use'),
        finding('profiles', 'unlisted', 'setAside'),
        finding('account', 'missing', 'empty'),
        finding('prefs', 'missing', 'defaults'),
        finding('sticker:' + 'e'.repeat(32), 'missing', 'notice'),
        finding('account', 'unreadable', 'keepForLater'),
        finding('history', 'altered', 'keepForLater'),
        finding('vault', 'vaultChanged', 'notice'),
        finding('vault', 'totpFlag', 'notice'),
      ],
    });
    expect(check?.question).toBeNull();
    expect(check?.plainFiles).toBe(false);
    expect(check?.notices).toEqual([
      { item: 'history', kind: 'altered' },
      { item: 'stickers', kind: 'altered' },
      { item: 'stickers', kind: 'olderAside' },
      { item: 'profiles', kind: 'unlisted' },
      { item: 'account', kind: 'missing' },
      { item: 'prefs', kind: 'missingPrefs' },
      { item: 'stickers', kind: 'missingStickers' },
      { item: 'account', kind: 'unreadable' },
      { item: 'history', kind: 'held' },
      { item: 'vault', kind: 'vaultChanged' },
      { item: 'vault', kind: 'totpFlag' },
    ]);
  });

  it('names the whole store and the files of an earlier version', () => {
    const check = storeCheckOf({
      findings: [
        finding('store', 'otherAccount', 'setAside'),
        finding('store', 'missing', 'empty'),
        finding('friends.json', 'altered', 'setAside'),
        finding('legacy', 'plainFiles', 'offerImport'),
      ],
    });
    expect(check?.notices).toEqual([
      { item: 'store', kind: 'otherAccount' },
      { item: 'store', kind: 'storeMissing' },
      { item: 'account', kind: 'altered' },
    ]);
    expect(check?.plainFiles).toBe(true);
  });

  // A sticker that could not be checked is used: it opens only under its
  // own name (design §6.1). Nothing to tell.
  it('says nothing about what it used', () => {
    expect(storeCheckOf({ findings: [finding('sticker:' + 'a'.repeat(32), 'unverified', 'use')] })).toBeNull();
  });
});

describe('itemOf', () => {
  it('names each file as the dialog does, the files of earlier versions too', () => {
    expect(['account', 'config.json', 'friends.json', 'groups.json', 'group_invites.json'].map(itemOf)).toEqual(
      Array(5).fill('account'),
    );
    expect(['history', 'history.bin'].map(itemOf)).toEqual(['history', 'history']);
    expect(['sessions', 'ratchets.bin'].map(itemOf)).toEqual(['sessions', 'sessions']);
    expect(['profiles', 'profiles.bin', 'profiles.bin.damaged'].map(itemOf)).toEqual(Array(3).fill('profiles'));
    expect(['sticker:' + 'a'.repeat(32), 'stickers/ab12.png'].map(itemOf)).toEqual(['stickers', 'stickers']);
    expect(['prefs', 'index', 'vault', 'store', 'something.else'].map(itemOf)).toEqual(['prefs', 'index', 'vault', 'store', 'other']);
    // Solicitudes (UR-4): requests.bin, which never asks.
    expect(itemOf('requests')).toBe('requests');
  });
});

describe('needsReview', () => {
  it('stops before the chats for a finding or the note after the migration, and only then', () => {
    expect(needsReview(UNSEALED)).toBe(false);
    expect(needsReview({ ...UNSEALED, integrity: { findings: [] } })).toBe(false);
    expect(needsReview({ ...UNSEALED, integrity: { findings: [finding('account', 'olderCopy', 'ask')] } })).toBe(true);
    expect(needsReview({ ...UNSEALED, migration: { contacts: 2, groups: 1, stickers: 0, notes: 3 } })).toBe(true);
  });

  it('keeps what the dialog and the note need, never the preferences', () => {
    const review = reviewOf({
      ...UNSEALED,
      prefs: { 'note:Bob': 'Primo' },
      custom_data_dir: true,
      integrity: { findings: [finding('account', 'olderCopy', 'ask')] },
      migration: { contacts: 2, groups: 1, stickers: 0, notes: 3 },
    });
    expect(review).toEqual({
      integrity: { findings: [finding('account', 'olderCopy', 'ask')] },
      migration: { contacts: 2, groups: 1, stickers: 0, notes: 3 },
      customDataDir: true,
    });
  });
});
