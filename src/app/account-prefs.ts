/**
 * The account's preferences around unlocking (cifrado local CL-2a, design
 * §5.3): the session that `unseal` or `forge` opened gets its preferences in
 * memory, and the WebView's copy of before is imported once, before the
 * unlock screen or the first run hands over to the chats. So the first
 * message already has its timer and the first notification its level.
 */
import type { ForgeResponse, IntegrityReport, UnsealResponse } from '../lib/api';
import {
  deviceLocalStore,
  settleLegacyPrefs,
  type LocalStore,
  type PrefsImported,
  type PrefsMap,
  type PrefsSession,
} from '../lib/prefs-session';

/** The logical name of the preferences' file in the store (`prefs.bin`). */
const PREFS_FILE = 'prefs';

/** What the preferences need from the backend: `api` of src/lib/api.ts. */
export interface AccountPrefsApi {
  unseal(passphrase: string, totpCode?: string | null): Promise<UnsealResponse>;
  createIdentity(handle: string, passphrase: string, useTotp: boolean): Promise<ForgeResponse>;
  prefsSave(prefs: PrefsMap): Promise<void>;
  prefsImport(entries: PrefsMap): Promise<PrefsImported>;
  clearBrowsingData(): Promise<void>;
  /** "Usar esa copia" or "Seguir sin ella" in the dialog at unlock (CL-2b). */
  storeChoose(file: string, useIt: boolean): Promise<IntegrityReport>;
  /** The session's preferences as the backend has them now. */
  prefsGet(): Promise<unknown>;
}

/**
 * `backend` with `unseal` and `createIdentity` that resolve once `session`
 * holds the account's preferences and the one import is done. The note after
 * the migration gets the number of notes the import took (design §11.5).
 *
 * And with `storeChoose` that, once the user took a copy of the preferences
 * in the dialog at unlock, gives it to the session. If that copy cannot be
 * read, the session is dropped unsaved: its own copy must never be saved
 * over the one the user chose, so the preferences give the defaults until
 * the next unlock.
 */
export function withAccountPrefs<T extends AccountPrefsApi>(
  backend: T,
  session: PrefsSession,
  local: () => LocalStore = deviceLocalStore,
): T {
  const opened = async <R extends UnsealResponse>(response: R): Promise<R> => {
    session.open({
      prefs: response.prefs ?? null,
      mode: response.prefs_import === 'unavailable' ? 'legacy' : 'store',
      save: prefs => backend.prefsSave(prefs),
    });
    const { notes } = await settleLegacyPrefs({
      state: response.prefs_import,
      customDataDir: response.custom_data_dir,
      session,
      local: local(),
      prefsImport: entries => backend.prefsImport(entries),
      clearBrowsingData: () => backend.clearBrowsingData(),
    });
    return response.migration ? { ...response, migration: { ...response.migration, notes } } : response;
  };
  return {
    ...backend,
    unseal: (passphrase: string, totpCode?: string | null) => backend.unseal(passphrase, totpCode).then(opened),
    createIdentity: (handle: string, passphrase: string, useTotp: boolean) =>
      backend.createIdentity(handle, passphrase, useTotp).then(opened),
    storeChoose: async (file: string, useIt: boolean) => {
      const left = await backend.storeChoose(file, useIt);
      if (file === PREFS_FILE && useIt) {
        try {
          session.adopt(await backend.prefsGet());
        } catch {
          console.warn('prefs_get failed after choosing a copy');
          session.discard();
        }
      }
      return left;
    },
  };
}
