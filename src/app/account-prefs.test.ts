import { describe, expect, it, vi } from 'vitest';
import type { ForgeResponse, UnsealResponse } from '../lib/api';
import { createPrefsSession, type LocalStore, type PrefsMap } from '../lib/prefs-session';
import { withAccountPrefs, type AccountPrefsApi } from './account-prefs';

const UNSEALED: UnsealResponse = {
  handle: 'Ana',
  fingerprint: 'f1f2',
  nostr_pub: 'cc',
  relay_connection_started: true,
  prefs: { 'ttl:Bob': '30' },
  prefs_import: 'pending',
  custom_data_dir: false,
};

function memoryLocal(seed: PrefsMap = {}): LocalStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

function backend(answer: UnsealResponse = UNSEALED) {
  return {
    unseal: vi.fn(async (_passphrase: string, _totpCode?: string | null) => answer),
    createIdentity: vi.fn(
      async (_handle: string, _passphrase: string, _useTotp: boolean): Promise<ForgeResponse> => ({ ...answer, bundle_json: '{}' }),
    ),
    prefsSave: vi.fn(async (_prefs: PrefsMap) => {}),
    prefsImport: vi.fn(async (entries: PrefsMap) => ({
      taken: entries,
      saved: true,
      notes: Object.keys(entries).filter(key => key.startsWith('note:')).length,
    })),
    clearBrowsingData: vi.fn(async () => {}),
  } satisfies AccountPrefsApi;
}

describe('unlocking with the account’s preferences', () => {
  it('resolves once the session holds them and the import is done', async () => {
    const api = backend();
    const session = createPrefsSession();
    const local = memoryLocal({ 'note:Bob': 'Primo' });

    const response = await withAccountPrefs(api, session, () => local).unseal('pass', null);

    expect(response.handle).toBe('Ana');
    expect(api.unseal).toHaveBeenCalledWith('pass', null);
    expect(session.mode).toBe('store');
    expect(session.getItem('ttl:Bob')).toBe('30');
    expect(session.getItem('note:Bob')).toBe('Primo');
    expect(local.data.size).toBe(0);
  });

  it('does the same for a new identity', async () => {
    const api = backend({ ...UNSEALED, prefs: undefined });
    const session = createPrefsSession();

    const response = await withAccountPrefs(api, session, () => memoryLocal()).createIdentity('Ana', 'pass', false);

    expect(response.bundle_json).toBe('{}');
    expect(api.createIdentity).toHaveBeenCalledWith('Ana', 'pass', false);
    expect(session.mode).toBe('store');
  });

  // Design §11.5: "{notas} notas" comes from the frontend's import.
  it('adds the notes the import took to the note after the migration', async () => {
    const api = backend({ ...UNSEALED, migration: { contacts: 2, groups: 1, stickers: 0 } });
    const local = memoryLocal({ 'note:Bob': 'Primo', 'note:Eva': 'Tía' });

    const response = await withAccountPrefs(api, createPrefsSession(), () => local).unseal('pass');

    expect(response.migration).toEqual({ contacts: 2, groups: 1, stickers: 0, notes: 2 });
  });

  it('saves the changes through the backend', async () => {
    const api = backend({ ...UNSEALED, prefs_import: 'done' });
    const session = createPrefsSession();
    await withAccountPrefs(api, session, () => memoryLocal()).unseal('pass');

    session.setItem('autolock', '1');
    await session.flush();

    expect(api.prefsSave).toHaveBeenCalledWith({ 'ttl:Bob': '30', autolock: '1' });
  });

  it('opens the WebView’s own for an account not moved to the store yet', async () => {
    const api = backend({ ...UNSEALED, prefs: undefined, prefs_import: 'unavailable' });
    const session = createPrefsSession();

    await withAccountPrefs(api, session, () => memoryLocal()).unseal('pass');

    expect(session.mode).toBe('legacy');
    expect(api.prefsImport).not.toHaveBeenCalled();
  });
});
