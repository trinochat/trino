/**
 * What the screens of Tor take from the app: the commands of src/lib/net.ts
 * and its two events, injected, so the tests pass a fake and nobody mocks
 * `invoke`. The app passes `netScreensApi`, the real ones.
 */
import { netApi, onNetChanged, onUpdateChanged, type NetApi } from '../../lib/net';
import type { LinkApi } from './LinkOpener';

export type NetScreensApi = Pick<
  NetApi,
  | 'status'
  | 'retry'
  | 'bridges'
  | 'tryBridge'
  | 'setBridges'
  | 'checkBridges'
  | 'connectWithoutTor'
  | 'backToTor'
  | 'setStartOnUnlock'
  | 'updateStatus'
  | 'setDailyUpdates'
  | 'checkUpdateNow'
  | 'installUpdate'
  | 'checkUpdateWithoutTor'
> & {
  onNetChanged: typeof onNetChanged;
  onUpdateChanged: typeof onUpdateChanged;
};

/** Links in the browser, after the backend's question (card 10): `open_link`. */
export const linkBackend: LinkApi = { open: netApi.openLink };

/** The real backend. */
export const netScreensApi: NetScreensApi = {
  status: netApi.status,
  retry: netApi.retry,
  bridges: netApi.bridges,
  tryBridge: netApi.tryBridge,
  setBridges: netApi.setBridges,
  checkBridges: netApi.checkBridges,
  connectWithoutTor: netApi.connectWithoutTor,
  backToTor: netApi.backToTor,
  setStartOnUnlock: netApi.setStartOnUnlock,
  updateStatus: netApi.updateStatus,
  setDailyUpdates: netApi.setDailyUpdates,
  checkUpdateNow: netApi.checkUpdateNow,
  installUpdate: netApi.installUpdate,
  checkUpdateWithoutTor: netApi.checkUpdateWithoutTor,
  onNetChanged,
  onUpdateChanged,
};
