import { describe, expect, it } from 'vitest';
import type { NetStatus } from '../../lib/net';
import { failureOf, settingsStatusOf, torLineOf } from './net-model';

// What each state of the network shows (PropTorSimple, cards 2, 3 and 6;
// design tests 45 and 46).

describe('the inbox line (card 2)', () => {
  it('says how far it is while connecting, and goes once connected', () => {
    expect(torLineOf({ state: 'starting', pct: 40 })).toEqual({
      key: 'net.line.starting',
      vars: { pct: 40 },
      tone: 'muted',
      action: false,
    });
    expect(torLineOf({ state: 'ready', transport: 'none' })).toBeNull();
    expect(torLineOf({ state: 'ready', transport: 'snowflake' })).toBeNull();
  });

  it('waits for the internet with no action, since another way in would not help', () => {
    expect(torLineOf({ state: 'blocked', kind: 'offline', pct: 0 })).toEqual({
      key: 'net.line.waitingInternet',
      tone: 'muted',
      action: false,
    });
  });

  it.each<NetStatus>([
    { state: 'blocked', kind: 'filtering', pct: 10 },
    { state: 'blocked', kind: 'cantReachTor', pct: 10 },
    { state: 'blocked', kind: 'clockSkewed', pct: 10 },
    { state: 'blocked', kind: 'cantBootstrap', pct: 10 },
    { state: 'blocked', kind: 'noProgress', pct: 10 },
    { state: 'ptMissing' },
    { state: 'obsolete', confirmed: true },
    { state: 'obsolete', confirmed: false },
  ])('says it could not connect, with "Ver qué hacer", for %j', status => {
    expect(torLineOf(status)).toEqual({ key: 'net.line.failed', tone: 'alert', action: true });
  });

  it('says "Sin protección" for as long as it lasts', () => {
    expect(torLineOf({ state: 'direct' })).toEqual({ key: 'net.line.unprotected', tone: 'warn', action: false });
  });

  it('says nothing before Tor starts, or while the state is unknown', () => {
    expect(torLineOf({ state: 'off' })).toBeNull();
    expect(torLineOf(null)).toBeNull();
  });
});

describe('"No se pudo conectar" (card 3)', () => {
  it('offers another way to connect and the way out when the network seems to block Tor', () => {
    for (const kind of ['filtering', 'cantReachTor'] as const) {
      expect(failureOf({ state: 'blocked', kind, pct: 5 })).toEqual({
        key: 'net.failed.blocked',
        tryOther: true,
        escape: true,
      });
    }
  });

  it('offers the same when Tor does not finish connecting, in its own words', () => {
    for (const kind of ['cantBootstrap', 'noProgress'] as const) {
      expect(failureOf({ state: 'blocked', kind, pct: 5 })).toEqual({
        key: 'net.failed.slow',
        tryOther: true,
        escape: true,
      });
    }
  });

  it('asks to fix the clock, with no other way and no way out, which would not help', () => {
    expect(failureOf({ state: 'blocked', kind: 'clockSkewed', pct: 5 })).toEqual({
      key: 'net.failed.clock',
      tryOther: false,
      escape: false,
    });
  });

  it('names the antivirus when the bridge program is missing', () => {
    expect(failureOf({ state: 'ptMissing' })).toEqual({ key: 'net.failed.antivirus', tryOther: false, escape: true });
  });

  it('says Trino needs an update when Arti is too old', () => {
    expect(failureOf({ state: 'obsolete', confirmed: true })).toEqual({
      key: 'net.failed.obsolete',
      tryOther: false,
      escape: true,
    });
  });

  it('is nothing to show otherwise: connecting, connected, without internet or without protection', () => {
    for (const status of [
      { state: 'off' },
      { state: 'starting', pct: 3 },
      { state: 'ready', transport: 'none' },
      { state: 'blocked', kind: 'offline', pct: 0 },
      { state: 'direct' },
    ] satisfies NetStatus[]) {
      expect(failureOf(status)).toBeNull();
    }
  });
});

describe('the state in Ajustes › Privacidad › Conexión (card 6)', () => {
  it.each<[NetStatus | null, string]>([
    [{ state: 'ready', transport: 'none' }, 'net.settings.private'],
    [{ state: 'ready', transport: 'obfs4' }, 'net.settings.private'],
    [{ state: 'starting', pct: 70 }, 'net.settings.connecting'],
    [{ state: 'off' }, 'net.settings.connecting'],
    [null, 'net.settings.connecting'],
    [{ state: 'blocked', kind: 'offline', pct: 0 }, 'net.line.waitingInternet'],
    [{ state: 'blocked', kind: 'filtering', pct: 0 }, 'net.settings.failed'],
    [{ state: 'ptMissing' }, 'net.settings.failed'],
    [{ state: 'obsolete', confirmed: false }, 'net.settings.failed'],
    [{ state: 'direct' }, 'net.settings.unprotected'],
  ])('%j reads %s', (status, key) => {
    expect(settingsStatusOf(status)).toBe(key);
  });
});
