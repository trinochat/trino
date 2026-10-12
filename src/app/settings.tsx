/**
 * Settings in the old chats (plan §4, I2): SettingsScreen (W5) where
 * SettingsModal was, as a layer over the whole shell until the redesigned
 * shell (I6) gives it its main pane. The shell makes its panes inert while
 * the layer is open, so the keyboard and the screen reader stay in Settings.
 *
 * - The layer opens on Perfil, then on the section it was left on, and
 *   takes the focus as it opens. Closed (its button or Escape, which the
 *   layer hears too while it has the focus), it gives the focus back to what
 *   had it, once the shell's panes are no longer inert.
 * - "Tu código QR" is Contactos' share panel (W4), not a second QR.
 * - What only the app can do goes up: locking, the wipe (which clears what
 *   this device keeps), a new auto-lock time; and the shell reads your
 *   profile again after a save, and its contacts after an unblock.
 * - By default it shows what this build's backend can do
 *   (src/app/capabilities.ts), on the platform the webview reports.
 */
import { getVersion } from '@tauri-apps/api/app';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { api, notify, onRelayEvent } from '../lib/api';
import { makeAvatar as deviceMakeAvatar } from '../lib/avatar';
import { useT } from '../lib/i18n';
import { prefs as devicePrefs, type Prefs } from '../lib/prefs';
import { ShareCodePanel, type ContactsApi } from '../screens/contacts';
import { SettingsScreen, type SettingsApi, type SettingsCapabilities, type SettingsPlatform } from '../screens/settings';
import type { SettingsSectionId } from '../screens/types';
import { capabilities as buildCapabilities } from './capabilities';
import { downloadBlob } from './download';

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

export interface SettingsOptions {
  api: SettingsBackend;
  /** "Bloquear": the app asks first while a call holds the microphone. */
  onLockNow(): void;
  /** Everything was erased from this device: the app clears what it keeps and starts over. */
  onIdentityWiped(): void;
  /** A new auto-lock time: it applies at once. */
  onAutolockChanged(minutes: number): void;
  /** Your name, photo or "about" were saved: the shell reads your profile again. */
  onProfileChanged(): void;
  /** A contact was unblocked: the shell reads its contacts again. */
  onContactsChanged(): void;
  /** The platform the webview reports, unless a test says. */
  platform?: SettingsPlatform;
  /** What this build's backend can do, unless a test says. */
  capabilities?: SettingsCapabilities;
  /** The preferences of this device, unless a test brings its own. */
  prefs?: Prefs;
  /** Turns a picked file into the profile photo, unless a test brings its own. */
  makeAvatar?(file: File): Promise<string>;
  /** Saves the QR's PNG; the webview's download unless a test brings its own. */
  download?(name: string, blob: Blob): void;
}

export interface Settings {
  /** Opens Settings, on a section or on the one it was left on (Perfil at first). */
  open(section?: SettingsSectionId): void;
  /** Settings covers the shell: its panes are inert meanwhile. */
  isOpen: boolean;
  /** The layer while it is open, else nothing. */
  layer: ReactNode;
}

export function useSettings(options: SettingsOptions): Settings {
  const t = useT();
  // The handlers are read when they fire, so the shell may pass new ones on
  // every render.
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const [isOpen, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSectionId>('profile');
  const layerRef = useRef<HTMLElement>(null);
  /** What had the focus when Settings opened: it gets it back. */
  const opener = useRef<Element | null>(null);

  useLayoutEffect(() => {
    if (isOpen) layerRef.current?.focus();
  }, [isOpen]);

  // After the render that took Settings away, so the shell's panes are no
  // longer inert and can take the focus.
  useEffect(() => {
    if (isOpen) return;
    const back = opener.current;
    opener.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, [isOpen]);

  const open = (next?: SettingsSectionId) => {
    if (!isOpen) opener.current = document.activeElement;
    if (next) setSection(next);
    setOpen(true);
  };

  const layer = isOpen ? (
    <section
      ref={layerRef}
      aria-label={t('settings2.nav.title')}
      tabIndex={-1}
      // The screen hears Escape from inside it; here, from the layer itself,
      // which has the focus as Settings opens.
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.defaultPrevented || event.target !== event.currentTarget) return;
        event.preventDefault();
        setOpen(false);
      }}
      className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-ui-bg outline-none"
    >
      <SettingsScreen
        section={section}
        onSectionChange={setSection}
        onClose={() => setOpen(false)}
        onLockNow={() => latest.current.onLockNow()}
        onIdentityWiped={() => latest.current.onIdentityWiped()}
        onProfileChanged={() => latest.current.onProfileChanged()}
        onAutolockChanged={minutes => latest.current.onAutolockChanged(minutes)}
        onContactsChanged={() => latest.current.onContactsChanged()}
        renderShareCode={() => (
          <ShareCodePanel api={options.api} download={options.download ?? downloadBlob} />
        )}
        api={options.api}
        platform={options.platform ?? platformOf(navigator.userAgent)}
        capabilities={options.capabilities ?? buildCapabilities}
        prefs={options.prefs ?? devicePrefs}
        makeAvatar={options.makeAvatar ?? deviceMakeAvatar}
      />
    </section>
  ) : null;

  return { open, isOpen, layer };
}
