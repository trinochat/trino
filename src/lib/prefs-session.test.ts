import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCESSIBILITY_STORAGE_KEY, LEGACY_TEXT_SIZE_STORAGE_KEY, SYSTEM_TEXT_SCALE_STORAGE_KEY } from '../design/accessibility';
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY } from '../design/appearance';
import { CONSENT_STORAGE_KEY } from '../screens/auth/onboarding/consent';
import { DEV_ALLOW_LAN_KEY } from './ice-privacy';
import { createPrefs } from './prefs';
import {
  DEVICE_KEYS,
  accountStorage,
  createPrefsSession,
  isAccountKey,
  isDeviceKey,
  settleLegacyPrefs,
  type LocalStore,
  type PrefsImported,
  type PrefsMap,
  type PrefsSession,
} from './prefs-session';

/** The WebView's localStorage in memory, counting every access by key. */
function localStore(seed: PrefsMap = {}) {
  const data = new Map(Object.entries(seed));
  const accesses: string[] = [];
  const store: LocalStore = {
    get length() {
      return data.size;
    },
    key: i => [...data.keys()][i] ?? null,
    getItem: key => {
      accesses.push(`get:${key}`);
      return data.get(key) ?? null;
    },
    setItem: (key, value) => {
      accesses.push(`set:${key}`);
      data.set(key, String(value));
    },
    removeItem: key => {
      accesses.push(`remove:${key}`);
      data.delete(key);
    },
  };
  return { store, data, accesses };
}

/** The accesses to keys of the account, not of the screen before unlocking. */
const accountAccesses = (accesses: string[]) => accesses.filter(access => !isDeviceKey(access.slice(access.indexOf(':') + 1)));

function openSession(prefs: unknown = {}, mode: 'store' | 'legacy' = 'store') {
  const saves: PrefsMap[] = [];
  const save = vi.fn(async (map: PrefsMap) => {
    saves.push({ ...map });
  });
  const session = createPrefsSession();
  session.open({ prefs, mode, save });
  return { session, save, saves };
}

const DEVICE_SEED: PrefsMap = {
  lang: 'es',
  [APPEARANCE_STORAGE_KEY]: '{"style":"calma","mode":"dark"}',
  [ACCESSIBILITY_STORAGE_KEY]: '{"textScale":1.25}',
  'trino.pref.scanLines': '0',
  'trino.pref.blockCaptures': '0',
};

const LEGACY_SEED: PrefsMap = {
  'note:Ana': 'Vecina del 3',
  'verified:Ana': 'call:f1f2',
  'ttl:Ana': '30',
  'ttl:grp:g1': '3600',
  'trino.pref.groupMuted:g1': '1',
  'note:Zoe': 'de otra cuenta',
  autolock: '15',
  'updates.lastRead': '2026-10-01',
  'sticker-recents': '["s1"]',
  'trino:announcements:minSeq': '4',
  'trino.pref.notifPreview': 'none',
  [CONSENT_STORAGE_KEY]: '{"format":1,"publicKey":"cc"}',
  'something.of.0.1.0': 'x',
};

/** A backend that takes what is Ana's and g1's and the general settings, as prefs_cmds.rs does. */
function fakeImport(saved = true) {
  return vi.fn(async (entries: PrefsMap): Promise<PrefsImported> => {
    const taken = Object.fromEntries(Object.entries(entries).filter(([key]) => !key.endsWith('Zoe')));
    const notes = Object.keys(taken).filter(key => key.startsWith('note:')).length;
    return { taken, saved, notes };
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the keys', () => {
  // Design §12.5, test 41: a list of what may stay in the WebView.
  it('that stay in the WebView are only the language, the appearance and the accessibility', () => {
    expect([...DEVICE_KEYS].sort()).toEqual(
      [
        'lang',
        APPEARANCE_STORAGE_KEY,
        LEGACY_THEME_STORAGE_KEY,
        ACCESSIBILITY_STORAGE_KEY,
        SYSTEM_TEXT_SCALE_STORAGE_KEY,
        LEGACY_TEXT_SIZE_STORAGE_KEY,
        // Terminal's scan lines and keeping the window out of captures, which
        // the screen before unlocking applies (SC-1).
        'trino.pref.scanLines',
        'trino.pref.blockCaptures',
        // A developer switch, only in tests of calls.
        DEV_ALLOW_LAN_KEY,
      ].sort(),
    );
  });

  it('of the account are the ones design §5.3 lists', () => {
    for (const key of [
      'note:Ana',
      'verified:Ana',
      'ttl:Ana',
      'ttl:grp:g1',
      'sticker-recents',
      CONSENT_STORAGE_KEY,
      'autolock',
      'updates.muted',
      'updates.lastRead',
      'trino:announcements:minSeq',
      'trino.pref.notifPreview',
      'trino.pref.groupMuted:g1',
      'trino.pref.callsSeenAt',
    ]) {
      expect(isAccountKey(key), key).toBe(true);
      expect(isDeviceKey(key), key).toBe(false);
    }
    for (const key of DEVICE_KEYS) expect(isAccountKey(key), key).toBe(false);
    expect(isAccountKey('something.of.0.1.0')).toBe(false);
  });
});

describe('the preferences of the account', () => {
  // Design §12.5, test 39.
  it('give the defaults before unlocking and touch nothing in the WebView', () => {
    const local = localStore({ ...DEVICE_SEED, 'note:Ana': 'Vecina del 3', 'ttl:Ana': '30', autolock: '1' });
    const session = createPrefsSession();
    const prefs = createPrefs(accountStorage(session, () => local.store));

    expect(session.mode).toBe('closed');
    expect(prefs.getNote('Ana')).toBe('');
    expect(prefs.getTtl('Ana')).toBe(0);
    expect(prefs.getAutolockMinutes()).toBe(5);
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.setNote('Ana', 'otra')).toBe(false);
    expect(prefs.setTtl('Ana', 60)).toBe(false);
    expect(accountAccesses(local.accesses)).toEqual([]);
    // The screen before unlocking still reads its own.
    expect(prefs.getScanLines()).toBe(false);
    expect(prefs.getBlockCaptures()).toBe(false);
  });

  // Design §12.5, test 38.
  it('read the copy of the session after unlocking, never the WebView', () => {
    const local = localStore({ 'note:Ana': 'vieja', 'ttl:Ana': '5' });
    const { session } = openSession({ 'note:Ana': 'Vecina del 3', 'ttl:Ana': '30' });
    const prefs = createPrefs(accountStorage(session, () => local.store));

    expect(prefs.getNote('Ana')).toBe('Vecina del 3');
    expect(prefs.getTtl('Ana')).toBe(30);
    expect(prefs.setNote('Bob', 'Primo')).toBe(true);
    expect(prefs.getNote('Bob')).toBe('Primo');
    prefs.renameContact('Ana', 'Ana M');
    expect(prefs.getNote('Ana M')).toBe('Vecina del 3');
    expect(local.accesses).toEqual([]);
    expect(local.data.get('note:Ana')).toBe('vieja');
  });

  it('take only text from the unlock answer', () => {
    expect(openSession({ 'note:Ana': 'x', 'ttl:Ana': 30, bad: null }).session.getItem('ttl:Ana')).toBeNull();
    expect(openSession({ 'note:Ana': 'x' }).session.getItem('note:Ana')).toBe('x');
    for (const prefs of [null, undefined, 'text', ['note:Ana'], 7]) {
      const { session } = openSession(prefs);
      expect(session.mode).toBe('store');
      expect(session.getItem('note:Ana')).toBeNull();
    }
  });

  it('go to the backend half a second after the last change, the whole map at once', async () => {
    vi.useFakeTimers();
    const { session, save, saves } = openSession({ 'note:Ana': 'x' });

    session.setItem('ttl:Ana', '30');
    await vi.advanceTimersByTimeAsync(300);
    session.setItem('autolock', '1');
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);

    expect(saves).toEqual([{ 'note:Ana': 'x', 'ttl:Ana': '30', autolock: '1' }]);
    session.removeItem('ttl:Ana');
    await vi.advanceTimersByTimeAsync(500);
    expect(saves[1]).toEqual({ 'note:Ana': 'x', autolock: '1' });
    // Nothing changed, nothing sent.
    await session.flush();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('are saved in the order they changed, one save after the other', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const save = vi.fn(
      (map: PrefsMap) =>
        new Promise<void>(resolve => {
          order.push(`start ${map.autolock}`);
          release = () => {
            order.push(`end ${map.autolock}`);
            resolve();
          };
        }),
    );
    const session = createPrefsSession();
    session.open({ prefs: {}, mode: 'store', save });

    session.setItem('autolock', '1');
    const first = session.flush();
    session.setItem('autolock', '2');
    const second = session.flush();
    await Promise.resolve();
    expect(order).toEqual(['start 1']);
    release();
    await first;
    await vi.waitFor(() => expect(order).toEqual(['start 1', 'end 1', 'start 2']));
    release();
    await second;
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('that the backend could not take go again with the next save', async () => {
    const save = vi.fn().mockRejectedValueOnce({ code: 'io', message: 'prefs waits for a choice' }).mockResolvedValue(undefined);
    const session = createPrefsSession();
    session.open({ prefs: {}, mode: 'store', save });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    session.setItem('autolock', '1');
    await session.flush();
    await session.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ autolock: '1' });
  });

  it('are sent at lock and then forgotten', async () => {
    vi.useFakeTimers();
    const { session, saves } = openSession({ 'note:Ana': 'x' });
    session.setItem('ttl:Ana', '30');

    const closing = session.close();

    expect(session.mode).toBe('closed');
    expect(session.getItem('note:Ana')).toBeNull();
    expect(() => session.setItem('ttl:Ana', '60')).toThrow();
    await closing;
    expect(saves).toEqual([{ 'note:Ana': 'x', 'ttl:Ana': '30' }]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toHaveLength(1);
  });

  it('are forgotten without saving after a wipe', async () => {
    vi.useFakeTimers();
    const { session, save } = openSession({ 'note:Ana': 'x' });
    session.setItem('ttl:Ana', '30');

    session.discard();
    await vi.advanceTimersByTimeAsync(1000);

    expect(session.mode).toBe('closed');
    expect(session.getItem('note:Ana')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('add what the import took under what the session has', () => {
    const { session, save } = openSession({ 'note:Ana': 'nueva' });

    session.addUnder({ 'note:Ana': 'vieja', 'ttl:Ana': '30' });

    expect(session.getItem('note:Ana')).toBe('nueva');
    expect(session.getItem('ttl:Ana')).toBe('30');
    expect(save).not.toHaveBeenCalled();
  });

  // Part 1's error path: an account an earlier version created whose
  // migration stopped before its commit works as earlier versions did.
  it('stay in the WebView for an account that has not moved to the store yet', () => {
    const local = localStore({ 'note:Ana': 'Vecina del 3' });
    const { session, save } = openSession(null, 'legacy');
    const prefs = createPrefs(accountStorage(session, () => local.store));

    expect(prefs.getNote('Ana')).toBe('Vecina del 3');
    expect(prefs.setTtl('Ana', 30)).toBe(true);
    expect(local.data.get('ttl:Ana')).toBe('30');
    expect(save).not.toHaveBeenCalled();
  });

  // Design §12.5, test 42 (H5): the consent record is the account's.
  it('keep the consent record in the session, not in the WebView', () => {
    const local = localStore();
    const { session } = openSession();
    const storage = accountStorage(session, () => local.store);

    storage.setItem(CONSENT_STORAGE_KEY, '{"format":1,"publicKey":"cc"}');

    expect(session.getItem(CONSENT_STORAGE_KEY)).toBe('{"format":1,"publicKey":"cc"}');
    expect(local.data.size).toBe(0);
  });
});

describe('the one import from the WebView', () => {
  const settle = (
    local: LocalStore,
    session: PrefsSession,
    overrides: Partial<Parameters<typeof settleLegacyPrefs>[0]> = {},
  ) =>
    settleLegacyPrefs({
      state: 'pending',
      customDataDir: false,
      session,
      local,
      prefsImport: fakeImport(),
      clearBrowsingData: vi.fn(async () => {}),
      sleep: async () => {},
      ...overrides,
    });

  // Design §12.5, test 40, and 41.
  it('takes the account’s entries once, then the WebView keeps only the screen before unlocking', async () => {
    const local = localStore({ ...DEVICE_SEED, ...LEGACY_SEED });
    const { session } = openSession({ 'note:Ana': 'nueva' });
    const prefsImport = fakeImport();
    // Clearing the WebView's data takes its localStorage too.
    const clearBrowsingData = vi.fn(async () => {
      local.data.clear();
    });

    const settled = await settle(local.store, session, { prefsImport, clearBrowsingData });
    await settled.cleanup;

    expect(prefsImport).toHaveBeenCalledWith(
      Object.fromEntries(Object.entries(LEGACY_SEED).filter(([key]) => key !== 'something.of.0.1.0')),
    );
    expect(session.getItem('note:Ana')).toBe('nueva');
    expect(session.getItem('ttl:grp:g1')).toBe('3600');
    expect(session.getItem(CONSENT_STORAGE_KEY)).toBe(LEGACY_SEED[CONSENT_STORAGE_KEY]);
    expect(settled.notes).toBe(1);
    expect(clearBrowsingData).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(local.data)).toEqual(DEVICE_SEED);
  });

  it('removes what appears after it unread, and clears the WebView', async () => {
    const local = localStore({ ...DEVICE_SEED, 'note:Ana': 'plantada', 'ttl:Ana': '0' });
    const { session } = openSession({ 'note:Ana': 'Vecina del 3' });
    const prefsImport = fakeImport();
    const clearBrowsingData = vi.fn(async () => {});

    const settled = await settle(local.store, session, { state: 'done', prefsImport, clearBrowsingData });
    await settled.cleanup;

    expect(prefsImport).not.toHaveBeenCalled();
    expect(local.accesses).not.toContain('get:note:Ana');
    expect(local.accesses).not.toContain('get:ttl:Ana');
    expect(session.getItem('note:Ana')).toBe('Vecina del 3');
    expect(Object.fromEntries(local.data)).toEqual(DEVICE_SEED);
    expect(clearBrowsingData).toHaveBeenCalledTimes(1);
  });

  it('leaves the WebView alone when there is nothing to remove', async () => {
    const local = localStore(DEVICE_SEED);
    const { session } = openSession();
    const clearBrowsingData = vi.fn(async () => {});

    await (await settle(local.store, session, { state: 'done', clearBrowsingData })).cleanup;
    await (await settle(local.store, session, { prefsImport: vi.fn(async () => ({ taken: {}, saved: true, notes: 0 })), clearBrowsingData })).cleanup;

    expect(clearBrowsingData).not.toHaveBeenCalled();
    expect(Object.fromEntries(local.data)).toEqual(DEVICE_SEED);
  });

  it('keeps the WebView’s copy while the store could not take it, and adds it to the session', async () => {
    const local = localStore({ ...DEVICE_SEED, ...LEGACY_SEED });
    const { session } = openSession();
    const clearBrowsingData = vi.fn(async () => {});

    const settled = await settle(local.store, session, { prefsImport: fakeImport(false), clearBrowsingData });
    await settled.cleanup;

    expect(session.getItem('ttl:Ana')).toBe('30');
    expect(Object.fromEntries(local.data)).toEqual({ ...DEVICE_SEED, ...LEGACY_SEED });
    expect(clearBrowsingData).not.toHaveBeenCalled();
  });

  it('keeps the WebView’s copy when the import fails, and the chats still open', async () => {
    const local = localStore({ ...DEVICE_SEED, ...LEGACY_SEED });
    const { session } = openSession();
    const clearBrowsingData = vi.fn(async () => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settled = await settle(local.store, session, {
      prefsImport: vi.fn(async () => Promise.reject({ code: 'io', message: 'disk' })),
      clearBrowsingData,
    });
    await settled.cleanup;

    expect(settled.notes).toBe(0);
    expect(Object.fromEntries(local.data)).toEqual({ ...DEVICE_SEED, ...LEGACY_SEED });
    expect(clearBrowsingData).not.toHaveBeenCalled();
  });

  it('touches nothing for an account that has not moved to the store yet', async () => {
    const local = localStore({ ...DEVICE_SEED, ...LEGACY_SEED });
    const { session } = openSession(null, 'legacy');
    const prefsImport = fakeImport();
    const clearBrowsingData = vi.fn(async () => {});

    await (await settle(local.store, session, { state: 'unavailable', prefsImport, clearBrowsingData })).cleanup;

    expect(prefsImport).not.toHaveBeenCalled();
    expect(clearBrowsingData).not.toHaveBeenCalled();
    expect(local.accesses).toEqual([]);
  });

  // Design §5.6: with TRINO_HOME, other folders' entries stay, and the
  // WebView is cleared only once none is left.
  it('leaves the entries of other data folders, and clears the WebView once none is left', async () => {
    const local = localStore({ ...DEVICE_SEED, ...LEGACY_SEED });
    const { session } = openSession();
    const clearBrowsingData = vi.fn(async () => {});

    await (await settle(local.store, session, { customDataDir: true, clearBrowsingData })).cleanup;

    expect(Object.fromEntries(local.data)).toEqual({
      ...DEVICE_SEED,
      'note:Zoe': 'de otra cuenta',
      'something.of.0.1.0': 'x',
    });
    expect(clearBrowsingData).not.toHaveBeenCalled();

    // The other folder imported its own.
    local.data.delete('note:Zoe');
    local.data.delete('something.of.0.1.0');
    local.data.set('ttl:Ana', '0');
    await (await settle(local.store, session, { state: 'done', customDataDir: true, clearBrowsingData })).cleanup;
    expect(local.data.get('ttl:Ana')).toBe('0');
    expect(clearBrowsingData).not.toHaveBeenCalled();
  });

  // ClearBrowsingDataAll ends when WebView2 says so, after the call returns:
  // the screen's own settings are written back, as often as it takes them.
  it('writes back the language, appearance and accessibility the clearing took, and only those missing', async () => {
    const local = localStore({ ...DEVICE_SEED, 'note:Ana': 'x' });
    const { session } = openSession();
    let ticks = 0;
    const sleep = vi.fn(async () => {
      ticks += 1;
      // WebView2 finishes clearing after the call returned.
      if (ticks === 2) local.data.clear();
      // Meanwhile someone picks another style.
      if (ticks === 3) local.data.set(APPEARANCE_STORAGE_KEY, '{"style":"terminal"}');
    });

    await (await settle(local.store, session, { state: 'done', sleep })).cleanup;

    expect(Object.fromEntries(local.data)).toEqual({ ...DEVICE_SEED, [APPEARANCE_STORAGE_KEY]: '{"style":"terminal"}' });
  });

  it('opens the chats even when clearing the WebView fails', async () => {
    const local = localStore({ ...DEVICE_SEED, 'note:Ana': 'x' });
    const { session } = openSession();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const settled = await settle(local.store, session, {
      state: 'done',
      clearBrowsingData: vi.fn(async () => Promise.reject(new Error('no webview'))),
    });

    await expect(settled.cleanup).resolves.toBeUndefined();
    expect(Object.fromEntries(local.data)).toEqual(DEVICE_SEED);
  });
});

// Design §12.5, test 41, at the source: outside the screen before unlocking,
// nothing reads or writes the WebView's localStorage but the preferences.
describe('the WebView’s localStorage', () => {
  it('is used only by the modules of the screen before unlocking and the preferences', () => {
    const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/test-*.{ts,tsx}'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const users = Object.entries(sources)
      .filter(([, source]) => /\blocalStorage\b/.test(source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
      .map(([path]) => path)
      .sort();

    expect(users).toEqual(
      [
        // The language, and "Borrar todo" clearing it all.
        '../App.tsx',
        // The appearance and accessibility, before the first render.
        '../design/apply.ts',
        './i18n.ts',
        // The developer switch of calls.
        './call.ts',
        // The preferences: the screen's own in the WebView, the account's in the session.
        './prefs.ts',
        './prefs-session.ts',
      ].sort(),
    );
  });
});
