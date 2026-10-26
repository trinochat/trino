/**
 * The contract of Settings (W5): what the screen needs from the backend, and
 * the props the shell gives it on top of the slot's (src/screens/types.ts).
 * The API is injected, so the tests use a fake one and nothing mocks
 * `invoke`; the integration passes the real wrappers of src/lib/api.ts.
 */
import type {
  ConnectionStatus,
  EmergencyAlertEvent,
  EmergencyNetworkChoice,
  EmergencyNetworkView,
  BlockedView,
  NodeInfo,
  NotificationTest,
  ProfileResponse,
  RelayObservation,
  StatusResponse,
  TotpBeginResponse,
} from '../../lib/api';
import type { Prefs } from '../../lib/prefs';
import type { NetScreensApi } from '../net/net-api';
import type { SettingsSectionId, SettingsSlotProps } from '../types';

export interface SettingsApi {
  getProfile(): Promise<ProfileResponse>;
  /** `about` (K12) only with the shared profile; left out, the payload older backends take. */
  updateProfile(handle: string, avatar: string | null, about?: string): Promise<void>;
  status(): Promise<StatusResponse>;
  totpBegin(label?: string): Promise<TotpBeginResponse>;
  totpVerify(code: string): Promise<boolean>;
  totpEnable(passphrase: string): Promise<void>;
  totpDisable(passphrase: string, code: string): Promise<void>;
  changePassphrase(current: string, next: string, totpCode?: string | null): Promise<void>;
  /** The emergency key (CE-5): configure or change it, with your password (and code). */
  setEmergencyKey(current: string, key: string, totpCode?: string | null): Promise<void>;
  /** "Probar sin borrar": whether `candidate` is the key. Writes and counts nothing. */
  testEmergencyKey(candidate: string): Promise<boolean>;
  /** "Quitar": the same answer with a key or without one. */
  removeEmergencyKey(current: string, totpCode?: string | null): Promise<void>;
  /** "Qué pasa en la red", only once your password (and code) opened it. */
  emergencyNetwork(passphrase: string, totpCode?: string | null): Promise<EmergencyNetworkView>;
  /** "Guardar" there (CE-6): `wrong_passphrase` once it closed. */
  saveEmergencyNetwork(choice: EmergencyNetworkChoice): Promise<EmergencyNetworkView>;
  /** The same again while it is open, without the password (CE-6b): `wrong_passphrase` once it closed. */
  refreshEmergencyNetwork(): Promise<EmergencyNetworkView>;
  /** A contact asked, answered, withdrew, or its warning came. Resolves to the function that stops listening. */
  onEmergencyAlert(cb: (event: EmergencyAlertEvent) => void): Promise<() => void>;
  wipe(): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(enable: boolean): Promise<void>;
  connectionStatus(): Promise<ConnectionStatus>;
  relayInspectStart(): Promise<string[]>;
  relayInspectStop(): Promise<void>;
  /** Resolves to the function that stops listening. */
  onRelayEvent(cb: (event: RelayObservation) => void): Promise<() => void>;
  /** "Probar notificación": sends one, and says what the system did with it. */
  testNotification(title: string, body: string): Promise<NotificationTest>;
  /** The app's version, from Tauri (`getVersion` of @tauri-apps/api/app). */
  getVersion(): Promise<string>;
  /** For the blocked contacts and for who does not get your profile yet. */
  listNodes(): Promise<NodeInfo[]>;
  blockNode(handle: string, blocked: boolean): Promise<void>;
  /** Privacidad › Bloqueados (UR-2): whom you blocked, contacts or not, and unblocking one by its key. */
  listBlocked(): Promise<BlockedView[]>;
  unblockIdentity(key: string): Promise<BlockedView>;
  /**
   * Keeps the window out of screenshots, recordings and screen sharing, or
   * lets them see it, at once (SC-1): Tauri's `setContentProtected` on the
   * app's window (src/app/capture-protection.ts).
   */
  setContentProtected(protect: boolean): Promise<void>;
}

/**
 * What the backend can do, so nothing is faked (plan §3): a missing piece
 * hides its control. The integration fills it from src/app/capabilities.ts.
 */
export interface SettingsCapabilities {
  /** Turning TOTP on and off (K5). */
  totp: boolean;
  /** Changing the passphrase (K6). */
  changePassphrase: boolean;
  /** The emergency key's page of Cuenta y seguridad (CE-5). Left out, it is not there. */
  emergencyKey?: boolean;
  /** The real state of each relay (K3). */
  relayStatus: boolean;
  /** Your profile reaches your contacts (K12): "Sobre mí" and its honest line. */
  profileSync: boolean;
  /**
   * The backend writes trino-gui-debug.log on this device. After T3 (W7) a release
   * build writes nothing, so the line that says so only shows with this.
   */
  diagnosticLog?: boolean;
}

export type SettingsPlatform = 'windows' | 'macos' | 'linux';

export type SettingsScreenProps = SettingsSlotProps & {
  api: SettingsApi;
  platform: SettingsPlatform;
  capabilities: SettingsCapabilities;
  /** The preferences of this device: the real ones unless a test passes its own. */
  prefs?: Prefs;
  /** Turns a picked file into the profile photo: `makeAvatar` (src/lib/avatar.ts) unless a test passes its own. */
  makeAvatar?(file: File): Promise<string>;
  /** The screen's width in px, to choose one pane or two; measured when left out. */
  width?: number;
  /** Tor's state and commands (TOR-6): Privacidad › Conexión. Left out, Privacidad has no "Conexión". */
  net?: NetScreensApi;
};

export type { SettingsSectionId };
