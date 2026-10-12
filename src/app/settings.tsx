/**
 * What Settings (W5) takes from the app: the backend it talks to and the
 * platform it runs on. The chats (src/app/MainScreen.tsx) mount
 * SettingsScreen in the shell's main pane with these.
 */
import { getVersion } from '@tauri-apps/api/app';
import { api, notify, onRelayEvent } from '../lib/api';
import type { ContactsApi } from '../screens/contacts';
import type { SettingsApi, SettingsPlatform } from '../screens/settings';

/** What Settings asks of the backend, and the code it shares as "Tu código QR". */
export type SettingsBackend = SettingsApi & Pick<ContactsApi, 'shareBundle'>;

/** The real backend: src/lib/api.ts, and the app's version from Tauri. */
export const settingsBackend: SettingsBackend = {
  getProfile: api.getProfile,
  updateProfile: api.updateProfile,
  status: api.status,
  totpBegin: api.totpBegin,
  totpVerify: api.totpVerify,
  totpEnable: api.totpEnable,
  totpDisable: api.totpDisable,
  changePassphrase: api.changePassphrase,
  wipe: api.wipe,
  getAutostart: api.getAutostart,
  setAutostart: api.setAutostart,
  connectionStatus: api.connectionStatus,
  relayInspectStart: api.relayInspectStart,
  relayInspectStop: api.relayInspectStop,
  onRelayEvent,
  notify,
  getVersion,
  listNodes: api.listNodes,
  blockNode: api.blockNode,
  shareBundle: api.shareBundle,
};

/**
 * The platform, from the webview's user agent: WebView2 says Windows,
 * WKWebView says Mac (an iPhone's says "like Mac OS X"), and the rest,
 * WebKitGTK and Android, are Linux.
 */
export function platformOf(userAgent: string): SettingsPlatform {
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Macintosh|Mac OS X|iPhone|iPad|iPod/i.test(userAgent)) return 'macos';
  return 'linux';
}
