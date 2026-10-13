/**
 * The account's preferences around unlocking (cifrado local CL-2a, design
 * §5.3): the session that `unseal` or `forge` opened gets its preferences in
 * memory, and the WebView's copy of before is imported once, before the
 * unlock screen or the first run hands over to the chats. So the first
 * message already has its timer and the first notification its level.
 */
import type { ForgeResponse, UnsealResponse } from '../lib/api';
import {
  deviceLocalStore,
  settleLegacyPrefs,
  type LocalStore,
  type PrefsImported,
  type PrefsMap,
  type PrefsSession,
} from '../lib/prefs-session';

/** What the preferences need from the backend: `api` of src/lib/api.ts. */
export interface AccountPrefsApi {
  unseal(passphrase: string, totpCode?: string | null): Promise<UnsealResponse>;
  createIdentity(handle: string, passphrase: string, useTotp: boolean): Promise<ForgeResponse>;
  prefsSave(prefs: PrefsMap): Promise<void>;
  prefsImport(entries: PrefsMap): Promise<PrefsImported>;
  clearBrowsingData(): Promise<void>;
}

/**
 * `backend` with `unseal` and `createIdentity` that resolve once `session`
 * holds the account's preferences and the one import is done. The note after
 * the migration gets the number of notes the import took (design §11.5).
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
  };
}
