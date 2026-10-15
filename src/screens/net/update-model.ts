/**
 * What the updater's state shows in the inbox (PropTorSimple, card 8; Tor
 * design §6.3, §6.4, §10.7), as a pure function: the compact notice of a
 * new version, its one main action, and "Más tarde" only where the person
 * may leave it for later. Nothing installs without the person's yes: the
 * notice only offers.
 *
 * TOR-10's freeze (the news expired, or nothing fresh for over 14 days, or
 * a version the news name that no mirror offers) shows here too, since
 * what it means is that Trino may be missing a version.
 */
import type { TVars } from '../../lib/i18n';
import type { UpdateInfo } from '../../lib/net';

/** What the main button does: install the held version, or check again. */
export type UpdateRun = 'install' | 'checkNow';

export interface UpdateNotice {
  key: string;
  vars?: TVars;
  action: { key: string; run: UpdateRun } | null;
  /** "Más tarde": hides it until the state changes. */
  later: boolean;
}

/** Fewer days than this say no count ("Hace 1 días" reads wrong, and 0 says nothing). */
const COUNTED_FROM = 2;

/** The notice for `info`; null while all is well, while it checks or downloads, or without Tor. */
export function updateNoticeOf(info: UpdateInfo | null): UpdateNotice | null {
  if (!info) return null;
  const { state, freeze } = info;
  switch (state.state) {
    case 'ready':
      return { key: 'net.update.ready', action: { key: 'net.update.install', run: 'install' }, later: true };
    case 'waitingForCall':
      return { key: 'net.update.waitingForCall', action: null, later: false };
    case 'installing':
      return { key: 'net.update.installing', action: null, later: false };
    case 'saved':
      return { key: 'net.update.saved', action: null, later: true };
    case 'failed':
      if (state.reason === 'install') {
        return { key: 'net.update.installFailed', action: { key: 'net.update.tryAgain', run: 'install' }, later: false };
      }
      if (state.reason === 'download' || state.reason === 'signature' || state.reason === 'io') {
        return notDownloaded();
      }
      break;
    default:
      break;
  }
  if (!freeze) return null;
  if (freeze.kind === 'notOffered') return notDownloaded();
  const action = { key: 'net.update.checkNow', run: 'checkNow' } as const;
  return freeze.days >= COUNTED_FROM
    ? { key: 'net.update.unchecked', vars: { n: freeze.days }, action, later: false }
    : { key: 'net.update.uncheckedRecent', action, later: false };
}

function notDownloaded(): UpdateNotice {
  return { key: 'net.update.notDownloaded', action: { key: 'net.update.tryAgain', run: 'checkNow' }, later: false };
}
