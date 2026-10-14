/**
 * What the screens of Tor take from the app: the commands of src/lib/net.ts
 * and its two events, injected, so the tests pass a fake and nobody mocks
 * `invoke`. The app passes `netScreensApi`, the real ones.
 */
import { netApi, onNetChanged, onUpdateChanged, type NetApi } from '../../lib/net';

export type NetScreensApi = Pick<
  NetApi,
  | 'status'
  | 'retry'
  | 'bridges'
  | 'tryBridge'
  | 'connectWithoutTor'
  | 'backToTor'
  | 'setStartOnUnlock'
  | 'updateStatus'
  | 'setDailyUpdates'
> & {
  onNetChanged: typeof onNetChanged;
  onUpdateChanged: typeof onUpdateChanged;
};

/** The real backend. */
export const netScreensApi: NetScreensApi = {
  status: netApi.status,
  retry: netApi.retry,
  bridges: netApi.bridges,
  tryBridge: netApi.tryBridge,
  connectWithoutTor: netApi.connectWithoutTor,
  backToTor: netApi.backToTor,
  setStartOnUnlock: netApi.setStartOnUnlock,
  updateStatus: netApi.updateStatus,
  setDailyUpdates: netApi.setDailyUpdates,
  onNetChanged,
  onUpdateChanged,
};
