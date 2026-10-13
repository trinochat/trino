/**
 * The account's preferences while Trino is unlocked (cifrado local CL-2a,
 * design §5.3): notes, verified marks, timers, muted groups, recent
 * stickers, the consent record and the other settings of the account live
 * sealed in the store (`prefs.bin`), no longer in the WebView's
 * localStorage, where anyone who can read the folder could read them.
 *
 * - The unlock answer carries them, and the session keeps a copy in memory
 *   before the chats show: `prefs.ts` stays synchronous, a timer is right
 *   for the first message and a notification follows the level chosen.
 * - Each change goes to the backend, half a second after the last one, as
 *   the whole map; locking sends what is left and forgets the copy.
 * - Locked, the account's preferences give the defaults and nothing reaches
 *   the WebView's storage.
 * - Only what the screen before unlocking needs stays in the WebView: the
 *   language, the appearance and the accessibility settings (`DEVICE_KEYS`).
 * - Once, after the first unlock with this version, what the WebView kept
 *   for the account goes to the store (`settleLegacyPrefs`), only this
 *   account's, and then the WebView's copy is removed and its data cleared.
 * - An account that has not moved to the store yet (a migration that
 *   stopped before its commit) keeps them where earlier versions did, until
 *   a later unlock moves it.
 */
import { ACCESSIBILITY_STORAGE_KEY, LEGACY_TEXT_SIZE_STORAGE_KEY, SYSTEM_TEXT_SCALE_STORAGE_KEY } from '../design/accessibility';
import { APPEARANCE_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY } from '../design/appearance';
import { DEV_ALLOW_LAN_KEY } from './ice-privacy';
import type { PrefsStorage } from './prefs';

export type PrefsMap = Record<string, string>;
/** Where the one import stands: `UnsealResponse.prefs_import`. */
export type PrefsImportState = 'done' | 'pending' | 'unavailable';
/** No session; the store's copy in memory; or the WebView, for an account not moved yet. */
export type SessionMode = 'closed' | 'store' | 'legacy';

/** What `prefs_import` answers. */
export interface PrefsImported {
  /** The entries that are this account's, as they were sent. */
  taken: PrefsMap;
  /** Whether the store has them, with the note that the import is done. */
  saved: boolean;
  /** How many notes it took, for the one note after the migration. */
  notes: number;
}

/** The keys of the screen before unlocking, which stay in the WebView (design §2). */
export const DEVICE_KEYS: readonly string[] = Object.freeze([
  'lang',
  APPEARANCE_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  ACCESSIBILITY_STORAGE_KEY,
  SYSTEM_TEXT_SCALE_STORAGE_KEY,
  LEGACY_TEXT_SIZE_STORAGE_KEY,
  // Terminal's scan lines and keeping the window out of captures (SC-1):
  // main.tsx applies both as the app starts, before unlocking.
  'trino.pref.scanLines',
  'trino.pref.blockCaptures',
  // A developer switch of calls, never set in a release.
  DEV_ALLOW_LAN_KEY,
]);

export function isDeviceKey(key: string): boolean {
  return DEVICE_KEYS.includes(key);
}

const ACCOUNT_PREFIXES = ['note:', 'verified:', 'ttl:', 'updates.', 'trino.pref.'];
const ACCOUNT_KEYS = ['sticker-recents', 'trino.consent', 'autolock', 'trino:announcements:minSeq'];

/** An entry an earlier version kept for the account in the WebView (design §5.3). */
export function isAccountKey(key: string): boolean {
  if (isDeviceKey(key)) return false;
  return ACCOUNT_PREFIXES.some(prefix => key.startsWith(prefix)) || ACCOUNT_KEYS.includes(key);
}

/** The part of `Storage` the import walks; `window.localStorage` fits. */
export type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key'> & { readonly length: number };

/** The WebView's localStorage, or one that holds nothing when it is refused. */
export function deviceLocalStore(): LocalStore {
  try {
    return globalThis.localStorage;
  } catch {
    return {
      length: 0,
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error('no storage');
      },
      removeItem: () => {},
    };
  }
}

export interface OpenOptions {
  /** `UnsealResponse.prefs`: a map of text, or nothing. */
  prefs: unknown;
  mode: Exclude<SessionMode, 'closed'>;
  /** `prefs_save`: keeps the whole map in the store. */
  save(prefs: PrefsMap): Promise<void>;
}

export interface PrefsSession {
  readonly mode: SessionMode;
  open(options: OpenOptions): void;
  getItem(key: string): string | null;
  /** Throws with no session, so a setter of `prefs.ts` says it could not. */
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** Adds the entries the session does not have; what it has wins. */
  addUnder(entries: PrefsMap): void;
  /**
   * The copy chosen in the dialog at unlock ("Usar esa copia", CL-2b): its
   * entries replace the session's, what the session had beyond them stays,
   * and that is saved.
   */
  adopt(prefs: unknown): void;
  /** Sends the changes not saved yet, now; resolves once they went. */
  flush(): Promise<void>;
  /** At lock: sends what is left, then forgets the copy. */
  close(): Promise<void>;
  /** After a wipe: forgets the copy, saving nothing. */
  discard(): void;
}

export interface SessionOptions {
  /** How long after the last change the map goes to the backend. */
  delayMs?: number;
}

/** Only the entries that are text: what `prefs.bin` holds, as the WebView did. */
function textEntries(prefs: unknown): Map<string, string> {
  const entries = new Map<string, string>();
  if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) return entries;
  for (const [key, value] of Object.entries(prefs)) {
    if (typeof value === 'string') entries.set(key, value);
  }
  return entries;
}

/** A failure for the console: its code, never what the backend said in full. */
function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'not a command error';
}

export function createPrefsSession({ delayMs = 500 }: SessionOptions = {}): PrefsSession {
  let mode: SessionMode = 'closed';
  let data = new Map<string, string>();
  let save: OpenOptions['save'] = async () => {};
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Saves go one after the other, so an older map never lands last.
  let saving: Promise<void> = Promise.resolve();

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const flush = (): Promise<void> => {
    cancelTimer();
    if (mode !== 'store' || !dirty) return saving;
    // The map as it is now, taken before anything else changes it.
    const map = Object.fromEntries(data);
    const send = save;
    const sentFrom = data;
    dirty = false;
    saving = saving.then(() =>
      send(map).catch((error: unknown) => {
        console.warn('prefs_save failed:', codeOf(error));
        // Sent again with the next save, or at lock, while it is this copy.
        if (data === sentFrom) dirty = true;
      }),
    );
    return saving;
  };
  const changed = () => {
    dirty = true;
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };
  const forget = () => {
    cancelTimer();
    mode = 'closed';
    data = new Map();
    dirty = false;
    save = async () => {};
  };

  return {
    get mode() {
      return mode;
    },
    open(options) {
      forget();
      mode = options.mode;
      save = options.save;
      data = options.mode === 'store' ? textEntries(options.prefs) : new Map();
    },
    getItem: key => (mode === 'store' ? (data.get(key) ?? null) : null),
    setItem(key, value) {
      if (mode !== 'store') throw new Error('no session');
      data.set(key, String(value));
      changed();
    },
    removeItem(key) {
      if (mode !== 'store') throw new Error('no session');
      if (data.delete(key)) changed();
    },
    addUnder(entries) {
      if (mode !== 'store') return;
      for (const [key, value] of Object.entries(entries)) {
        if (!data.has(key) && typeof value === 'string') data.set(key, value);
      }
    },
    adopt(prefs) {
      if (mode !== 'store') return;
      const chosen = textEntries(prefs);
      const beyond = [...data].filter(([key]) => !chosen.has(key));
      data = new Map([...chosen, ...beyond]);
      if (beyond.length > 0) changed();
    },
    flush,
    close() {
      const sent = flush();
      forget();
      return sent;
    },
    discard: forget,
  };
}

/**
 * The storage `prefs.ts` reads and writes: the keys of the screen before
 * unlocking in the WebView, every other key in the session (or in the
 * WebView, for an account not moved yet); locked, nothing.
 */
export function accountStorage(session: PrefsSession, local: () => PrefsStorage = () => globalThis.localStorage): PrefsStorage {
  const where = (key: string): PrefsStorage | null => {
    if (isDeviceKey(key) || session.mode === 'legacy') return local();
    return session.mode === 'store' ? session : null;
  };
  return {
    getItem: key => where(key)?.getItem(key) ?? null,
    setItem: (key, value) => {
      const storage = where(key);
      if (storage === null) throw new Error('locked');
      storage.setItem(key, value);
    },
    removeItem: key => {
      const storage = where(key);
      if (storage === null) throw new Error('locked');
      storage.removeItem(key);
    },
  };
}

/** The session of this window, and the storage the app's preferences use. */
export const prefsSession: PrefsSession = createPrefsSession();
export const accountPrefsStorage: PrefsStorage = accountStorage(prefsSession);

export interface SettleOptions {
  state: PrefsImportState;
  /** `UnsealResponse.custom_data_dir`: other data folders may share the WebView. */
  customDataDir: boolean;
  session: PrefsSession;
  local: LocalStore;
  prefsImport(entries: PrefsMap): Promise<PrefsImported>;
  /** Clears the WebView's data, as `clearAllBrowsingData`. */
  clearBrowsingData(): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

export interface Settled {
  /** The notes the import took, for the one note after the migration. */
  notes: number;
  /** The clearing of the WebView's data, which the chats need not wait for. */
  cleanup: Promise<void>;
}

/** The keys in `local`, or none when it cannot be read. */
function keysOf(local: LocalStore): string[] {
  try {
    const found: string[] = [];
    for (let i = 0; i < local.length; i += 1) {
      const key = local.key(i);
      if (key !== null) found.push(key);
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Right after unlocking, before the chats: the one import of what the
 * WebView kept for this account, and the removal of what is left there.
 */
export async function settleLegacyPrefs({
  state,
  customDataDir,
  session,
  local,
  prefsImport,
  clearBrowsingData,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
}: SettleOptions): Promise<Settled> {
  const done = (notes: number): Settled => ({ notes, cleanup: Promise.resolve() });
  if (state === 'unavailable') return done(0);
  const remove = (key: string): boolean => {
    try {
      local.removeItem(key);
      return true;
    } catch {
      return false;
    }
  };

  let notes = 0;
  let removed = false;
  if (state === 'pending') {
    const entries: PrefsMap = {};
    for (const key of keysOf(local).filter(isAccountKey)) {
      try {
        const value = local.getItem(key);
        if (value !== null) entries[key] = value;
      } catch {
        // Unreadable now: the next unlock imports it.
      }
    }
    let imported: PrefsImported;
    try {
      imported = await prefsImport(entries);
    } catch (error) {
      console.warn('prefs_import failed:', codeOf(error));
      return done(0);
    }
    session.addUnder(imported.taken);
    notes = imported.notes;
    // Not in the store yet: the WebView keeps its copy for the next unlock.
    if (!imported.saved) return done(notes);
    for (const key of Object.keys(imported.taken)) removed = remove(key) || removed;
  }
  // What is left is no account's of this folder: removed unread (design
  // §5.3, point 4), unless another data folder may own it (design §5.6).
  if (!customDataDir) {
    for (const key of keysOf(local)) {
      if (!isDeviceKey(key)) removed = remove(key) || removed;
    }
  }
  const left = keysOf(local).some(key => !isDeviceKey(key));
  if (!removed || left) return done(notes);
  return { notes, cleanup: clearWebView(local, clearBrowsingData, sleep) };
}

/** How often, and how far apart, the screen's own settings are checked after clearing. */
const RESTORE_CHECKS = 8;
const RESTORE_EVERY_MS = 250;

/**
 * Clears the WebView's data, where removed values can linger until LevelDB
 * compacts (design §5.4), and writes back the screen's own settings. WebView2
 * ends the clearing after the call returns, so they are checked a few times
 * and written back when missing; one changed meanwhile is left as it is.
 */
async function clearWebView(local: LocalStore, clear: () => Promise<void>, sleep: (ms: number) => Promise<void>): Promise<void> {
  const kept = new Map<string, string>();
  for (const key of DEVICE_KEYS) {
    try {
      const value = local.getItem(key);
      if (value !== null) kept.set(key, value);
    } catch {
      // Nothing to keep.
    }
  }
  try {
    await clear();
  } catch (error) {
    console.warn('clearing the WebView failed:', codeOf(error));
    return;
  }
  const restore = () => {
    for (const [key, value] of kept) {
      try {
        if (local.getItem(key) === null) local.setItem(key, value);
      } catch {
        // Storage refused: the defaults until the person sets them again.
      }
    }
  };
  restore();
  for (let check = 0; check < RESTORE_CHECKS; check += 1) {
    await sleep(RESTORE_EVERY_MS);
    restore();
  }
}
