/**
 * Tor in the app (Tor design §2.4, §2.8, §5, §6; TOR-6): the network's
 * state, its commands and its events, as src-tauri gives them
 * (net_cmds.rs, commands.rs, bridges_cmds.rs and updater.rs). Every
 * connection of the app goes through Tor unless the person chose "Conectar
 * sin protección" for this run; nothing here ever goes direct by itself.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { NewsFreeze } from './announcements';

/** How Tor is reached: straight, or through a bridge of one kind (status.rs). */
export type TransportKind = 'none' | 'snowflake' | 'obfs4' | 'webtunnel' | 'meek';

/** Why Tor seems not to connect, Arti's rough diagnosis (§2.4): the texts say "parece". */
export type BlockKind = 'offline' | 'filtering' | 'cantReachTor' | 'clockSkewed' | 'cantBootstrap' | 'noProgress';

/**
 * The network's state (`NetStatus` in trino-net's status.rs), as
 * `net_status` answers and `net-changed` tells every change.
 *
 * - off: Tor not started (before the first run's "Conexión" step, or after a stop);
 * - starting: how far, from 0 to 100;
 * - ready: connected, through `transport`;
 * - blocked: it does not connect and keeps trying underneath, never direct;
 * - ptMissing: the bridge program is missing or not the one shipped (an antivirus);
 * - obsolete: this version of Arti is too old for the Tor network (§6.5);
 * - direct: "Conectar sin protección", until Trino closes or the way back.
 */
export type NetStatus =
  | { state: 'off' }
  | { state: 'starting'; pct: number }
  | { state: 'ready'; transport: TransportKind }
  | { state: 'blocked'; kind: BlockKind; pct: number }
  | { state: 'ptMissing' }
  | { state: 'obsolete'; confirmed: boolean }
  | { state: 'direct' };

/** When Tor starts: when Trino opens, or only after the unlock (settings.rs). */
export type StartWhen = 'open' | 'on_unlock';

/** The bridges as the UI gets them (bridges_cmds.rs `BridgesInfo`): never the lines themselves. */
export interface BridgesInfo {
  /** The kind in use: the private lines' when there are some. */
  transport: TransportKind;
  /** Whether private lines are in use; null while an account is locked. */
  private: boolean | null;
  lines: number;
  start: StartWhen;
  /** Whether this build has the bridge program at all. */
  program: boolean;
  /** The built-in kinds, in the order "Probar otra forma de conectarse" tries them. */
  builtin: TransportKind[];
}

/** A choice of bridges (bridges_cmds.rs `BridgeChoice`). */
export type BridgeChoice =
  | { kind: 'none' }
  | { kind: 'builtin'; transport: TransportKind }
  | { kind: 'private'; text: string };

/** What keeping a choice did. */
export interface BridgesSet {
  saved: boolean;
  errors: { line: number; error: unknown }[];
  status: NetStatus;
}

/** Why an update gave nothing (updater.rs `UpdateFailure`). */
export type UpdateFailure = 'withoutTor' | 'torNotReady' | 'noAnswer' | 'download' | 'signature' | 'io' | 'install';

/** Where the updater is (updater.rs `UpdateState`). */
export type UpdateState =
  | { state: 'unsupported' }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'saved'; version: string; file: string }
  | { state: 'waitingForCall'; version: string }
  | { state: 'installing'; version: string }
  | { state: 'failed'; reason: UpdateFailure };

/** The updater as the UI gets it (updater.rs `UpdateInfo`). */
export interface UpdateInfo {
  state: UpdateState;
  /** The version running. */
  installed: string;
  /** "Buscar actualizaciones cada día". */
  daily: boolean;
  freeze: NewsFreeze | null;
}

/**
 * What `open_link` did (links_cmds.rs `LinkAnswer`): ask first, showing the
 * address as it will open; or opened, with "No volver a preguntar" kept or not.
 */
export type LinkAnswer = { state: 'ask'; address: string } | { state: 'opened'; remembered: boolean };

/** The commands. Tauri turns the camelCase keys into the Rust parameters. */
export const netApi = {
  status: (): Promise<NetStatus> => invoke('net_status'),
  /** Start Tor: the first run's "Conexión" step. Nothing if it runs already. */
  start: (): Promise<NetStatus> => invoke('net_start'),
  /** "Volver a intentar": stop Tor and start it again. */
  retry: (): Promise<NetStatus> => invoke('net_retry'),
  /**
   * "Conectar sin protección", after its confirmation: everything without
   * Tor until Trino closes, the relays already open included. Never kept.
   */
  connectWithoutTor: (): Promise<NetStatus> => invoke('net_connect_without_tor'),
  /** "Volver a conectarse de forma privada": everything through Tor again. */
  backToTor: (): Promise<NetStatus> => invoke('net_back_to_tor'),
  /** "Conectarse solo después de desbloquear"; refused with private bridges, which always start then. */
  setStartOnUnlock: (on: boolean): Promise<BridgesInfo> => invoke('net_set_start_on_unlock', { on }),
  bridges: (): Promise<BridgesInfo> => invoke('net_bridges_get'),
  /** Keep a choice of bridges; Tor starts again with it if it was running. */
  setBridges: (choice: BridgeChoice): Promise<BridgesSet> => invoke('net_bridges_set', { choice }),
  /** "Probar otra forma de conectarse": start again through a built-in bridge, kept once it works. */
  tryBridge: (transport: TransportKind): Promise<NetStatus> => invoke('net_bridges_try', { transport }),
  updateStatus: (): Promise<UpdateInfo> => invoke('update_status'),
  /** "Buscar actualizaciones cada día". */
  setDailyUpdates: (on: boolean): Promise<UpdateInfo> => invoke('update_set_daily', { on }),
  /** "Revisar ahora" or "Intentar de nuevo": a check through Tor, in the background (`update-changed`). */
  checkUpdateNow: (): Promise<UpdateInfo> => invoke('update_check_now'),
  /** "Instalar y reiniciar": the yes. During a call it waits for the hang-up. */
  installUpdate: (): Promise<UpdateInfo> => invoke('update_install'),
  /**
   * "Descargarla sin protección…" on "Trino necesita actualizarse" (card 9),
   * after its confirmation: only while Arti is obsolete, to trinochat.org and
   * GitHub only, with the same signatures.
   */
  checkUpdateWithoutTor: (): Promise<UpdateInfo> => invoke('update_check_without_tor'),
  /**
   * A link in the browser, outside Tor (card 10): the backend asks first
   * unless the person said not to; `confirmed` is the yes to that question.
   */
  openLink: (url: string, confirmed: boolean, dontAskAgain: boolean): Promise<LinkAnswer> =>
    invoke('open_link', { url, confirmed, dontAskAgain }),
};

export type NetApi = typeof netApi;

/** Every change of the network's state. Resolves to the function that stops listening. */
export async function onNetChanged(cb: (status: NetStatus) => void): Promise<UnlistenFn> {
  return await listen<NetStatus>('net-changed', e => cb(e.payload));
}

/** Every change of the updater. */
export async function onUpdateChanged(cb: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return await listen<UpdateInfo>('update-changed', e => cb(e.payload));
}
