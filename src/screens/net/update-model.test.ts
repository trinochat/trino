import { describe, expect, it } from 'vitest';
import type { UpdateInfo, UpdateState } from '../../lib/net';
import { updateNoticeOf } from './update-model';

// The compact notice of a new version in the inbox (PropTorSimple, card 8;
// Tor design §6.3, §6.4, §10.7): one main action, and "Más tarde" only
// when a version is ready. Nothing installs without the person's yes.

const info = (state: UpdateState, freeze: UpdateInfo['freeze'] = null): UpdateInfo => ({
  state,
  installed: '0.1.0',
  daily: true,
  freeze,
});

describe('the notice of a new version (card 8)', () => {
  it('offers to install a version that is ready, with "Más tarde"', () => {
    expect(updateNoticeOf(info({ state: 'ready', version: '0.2.0' }))).toEqual({
      key: 'net.update.ready',
      action: { key: 'net.update.install', run: 'install' },
      later: true,
    });
  });

  it('says it waits for the call to end, with nothing to press', () => {
    expect(updateNoticeOf(info({ state: 'waitingForCall', version: '0.2.0' }))).toEqual({
      key: 'net.update.waitingForCall',
      action: null,
      later: false,
    });
    expect(updateNoticeOf(info({ state: 'installing', version: '0.2.0' }))).toEqual({
      key: 'net.update.installing',
      action: null,
      later: false,
    });
  });

  it('says a version could not be downloaded, and tries again on its button', () => {
    for (const reason of ['download', 'signature', 'io'] as const) {
      expect(updateNoticeOf(info({ state: 'failed', reason }))).toEqual({
        key: 'net.update.notDownloaded',
        action: { key: 'net.update.tryAgain', run: 'checkNow' },
        later: false,
      });
    }
    // The news name a version no mirror offers (§6.4): the same words.
    expect(updateNoticeOf(info({ state: 'upToDate' }, { kind: 'notOffered', latest: '0.3.0' }))).toEqual({
      key: 'net.update.notDownloaded',
      action: { key: 'net.update.tryAgain', run: 'checkNow' },
      later: false,
    });
  });

  it('says the installer did not start, and offers to install again', () => {
    expect(updateNoticeOf(info({ state: 'failed', reason: 'install' }))).toEqual({
      key: 'net.update.installFailed',
      action: { key: 'net.update.tryAgain', run: 'install' },
      later: false,
    });
  });

  // TOR-10's freeze: the news expired, or nothing fresh for over 14 days.
  it('says how many days Trino could not check, with "Revisar ahora"', () => {
    for (const kind of ['unchecked', 'expired'] as const) {
      expect(updateNoticeOf(info({ state: 'idle' }, { kind, days: 16 }))).toEqual({
        key: 'net.update.unchecked',
        vars: { n: 16 },
        action: { key: 'net.update.checkNow', run: 'checkNow' },
        later: false,
      });
    }
    // An expired feed seen a day ago has no count worth saying.
    expect(updateNoticeOf(info({ state: 'idle' }, { kind: 'expired', days: 1 }))).toEqual({
      key: 'net.update.uncheckedRecent',
      action: { key: 'net.update.checkNow', run: 'checkNow' },
      later: false,
    });
  });

  it('says where a Linux download was left', () => {
    expect(updateNoticeOf(info({ state: 'saved', version: '0.2.0', file: '/home/ana/Descargas/x.AppImage' }))).toEqual({
      key: 'net.update.saved',
      action: null,
      later: true,
    });
  });

  it('a version ready wins over a freeze', () => {
    expect(updateNoticeOf(info({ state: 'ready', version: '0.2.0' }, { kind: 'unchecked', days: 20 }))?.key).toBe(
      'net.update.ready',
    );
  });

  it('shows nothing while all is well, while it checks or downloads, or without Tor', () => {
    for (const state of [
      { state: 'idle' },
      { state: 'checking' },
      { state: 'upToDate' },
      { state: 'downloading', version: '0.2.0' },
      { state: 'unsupported' },
      { state: 'failed', reason: 'withoutTor' },
      { state: 'failed', reason: 'torNotReady' },
      { state: 'failed', reason: 'noAnswer' },
    ] as UpdateState[]) {
      expect(updateNoticeOf(info(state)), JSON.stringify(state)).toBeNull();
    }
    expect(updateNoticeOf(null)).toBeNull();
  });
});
