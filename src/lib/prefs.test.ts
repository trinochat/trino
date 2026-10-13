import { describe, expect, expectTypeOf, it } from 'vitest';
import * as prefsModule from './prefs';
import { PREF_DEFAULTS, STICKER_RECENTS_MAX, createPrefs, type Prefs, type PrefsStorage } from './prefs';

/** A `localStorage` stand-in that keeps what is written, readable by key. */
function memoryStorage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  const storage: PrefsStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: key => void data.delete(key),
  };
  return { storage, data };
}

/** A storage that refuses everything, like a webview with storage blocked. */
const brokenStorage: PrefsStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
};

describe('preferences that already exist', () => {
  // The keys App.tsx writes today: changing one would lose what people saved.
  // A verification of 0.1.0 is still read as it was saved, but it no longer
  // counts (see "verification marks" below).
  it('read the values the current screens saved, under the same keys', () => {
    const { storage } = memoryStorage({
      'verified:Ana': 'ab12cd34',
      'note:Ana': 'Vecina del 3',
      'ttl:Ana': '30',
      'ttl:grp:9f3a': '3600',
      autolock: '15',
      'updates.muted': '1',
      'updates.lastRead': '2026-10-01-beta2',
      'sticker-recents': '["s1","s2"]',
    });
    const prefs = createPrefs(storage);
    expect(prefs.getVerified('Ana')).toBe('ab12cd34');
    expect(prefs.isVerified('Ana', 'ab12cd34')).toBe(false);
    expect(prefs.getNote('Ana')).toBe('Vecina del 3');
    expect(prefs.getTtl('Ana')).toBe(30);
    expect(prefs.getTtl('grp:9f3a')).toBe(3600);
    expect(prefs.getAutolockMinutes()).toBe(15);
    expect(prefs.getUpdatesMuted()).toBe(true);
    expect(prefs.getUpdatesLastRead()).toBe('2026-10-01-beta2');
    expect(prefs.getStickerRecents()).toEqual(['s1', 's2']);
  });

  it('write them the way the current screens read them', () => {
    const { storage, data } = memoryStorage();
    const prefs = createPrefs(storage);
    prefs.setVerified('Ana', 'ab12cd34');
    prefs.setNote('Ana', 'Vecina del 3');
    prefs.setTtl('grp:9f3a', 300);
    prefs.setAutolockMinutes(0);
    prefs.setUpdatesMuted(false);
    prefs.setUpdatesLastRead('x1');
    prefs.pushStickerRecent('s1');
    expect(Object.fromEntries(data)).toEqual({
      'verified:Ana': 'call:ab12cd34',
      'note:Ana': 'Vecina del 3',
      'ttl:grp:9f3a': '300',
      autolock: '0',
      'updates.muted': '0',
      'updates.lastRead': 'x1',
      'sticker-recents': '["s1"]',
    });
  });

  it('have the defaults of the current screens', () => {
    const prefs = createPrefs(memoryStorage().storage);
    expect(prefs.getVerified('Ana')).toBeNull();
    expect(prefs.isVerified('Ana', '')).toBe(false);
    expect(prefs.getNote('Ana')).toBe('');
    expect(prefs.getTtl('Ana')).toBe(0);
    expect(prefs.getAutolockMinutes()).toBe(5);
    expect(prefs.getUpdatesMuted()).toBe(false);
    expect(prefs.getUpdatesLastRead()).toBe('');
    expect(prefs.getStickerRecents()).toEqual([]);
  });

  it('read a ttl like ttlFor did: anything but a positive number is off', () => {
    for (const value of ['0', '-30', 'abc', '', 'Infinity']) {
      expect(createPrefs(memoryStorage({ 'ttl:Ana': value }).storage).getTtl('Ana'), value).toBe(0);
    }
  });

  it('remove the ttl when it is turned off', () => {
    const { storage, data } = memoryStorage({ 'ttl:Ana': '30' });
    createPrefs(storage).setTtl('Ana', 0);
    expect(data.has('ttl:Ana')).toBe(false);
  });

  it('keep 0 as "never lock" and fall back to 5 minutes for a value that is not a number', () => {
    expect(createPrefs(memoryStorage({ autolock: '0' }).storage).getAutolockMinutes()).toBe(0);
    expect(createPrefs(memoryStorage({ autolock: 'x' }).storage).getAutolockMinutes()).toBe(5);
    expect(createPrefs(memoryStorage({ autolock: '-1' }).storage).getAutolockMinutes()).toBe(5);
  });

  it('keep the most recent stickers first, without repeats, up to the limit', () => {
    const { storage } = memoryStorage();
    const prefs = createPrefs(storage);
    for (let i = 0; i < STICKER_RECENTS_MAX + 3; i += 1) prefs.pushStickerRecent(`s${i}`);
    prefs.pushStickerRecent('s5');
    const recents = prefs.getStickerRecents();
    expect(STICKER_RECENTS_MAX).toBe(24);
    expect(recents).toHaveLength(STICKER_RECENTS_MAX);
    expect(recents[0]).toBe('s5');
    expect(recents.filter(id => id === 's5')).toHaveLength(1);
  });

  it('ignore saved sticker recents that are not a list of ids', () => {
    for (const value of ['{', '{"a":1}', '[1,2]', 'null']) {
      expect(createPrefs(memoryStorage({ 'sticker-recents': value }).storage).getStickerRecents(), value).toEqual([]);
    }
  });
});

describe('a contact renamed or removed', () => {
  it('carries its note, ttl and verification to the new name', () => {
    const { storage, data } = memoryStorage({
      'note:Ana': 'n',
      'ttl:Ana': '30',
      'verified:Ana': 'fp',
      'note:Otro': 'o',
    });
    createPrefs(storage).renameContact('Ana', 'Ana T');
    expect(Object.fromEntries(data)).toEqual({
      'note:Ana T': 'n',
      'ttl:Ana T': '30',
      'verified:Ana T': 'fp',
      'note:Otro': 'o',
    });
  });

  it('loses everything stored for it, and nothing else', () => {
    const { storage, data } = memoryStorage({
      'note:Ana': 'n',
      'ttl:Ana': '30',
      'verified:Ana': 'fp',
      'note:Otro': 'o',
    });
    createPrefs(storage).forgetContact('Ana');
    expect(Object.fromEntries(data)).toEqual({ 'note:Otro': 'o' });
  });
});

// docs/sas-v2.md, "Marks made before v2": a contact is verified only by
// "Coinciden" on a call's SAS or by a QR scanned in person, and the mark
// says which, with the fingerprint the contact had then. The bare
// fingerprint 0.1.0 stored after its weak checks no longer counts.
describe('verification marks', () => {
  const FP = 'ab12.cd34.ef56.7890';
  const OTHER = '0000.1111.2222.3333';

  it('store "Coinciden" on a call as the mark of a call, with the contact’s fingerprint now', () => {
    const { storage, data } = memoryStorage();
    const prefs = createPrefs(storage);
    expect(prefs.setVerified('Ana', FP)).toBe(true);
    expect(data.get('verified:Ana')).toBe(`call:${FP}`);
    expect(prefs.getVerified('Ana')).toBe(`call:${FP}`);
    expect(prefs.isVerified('Ana', FP)).toBe(true);
  });

  it('verify only while the fingerprint is still the contact’s', () => {
    const prefs = createPrefs(memoryStorage({ 'verified:Ana': `call:${FP}`, 'verified:Beto': `qr:${FP}` }).storage);
    expect(prefs.isVerified('Ana', FP)).toBe(true);
    expect(prefs.isVerified('Beto', FP)).toBe(true);
    expect(prefs.isVerified('Ana', OTHER)).toBe(false);
    expect(prefs.isVerified('Ana', '')).toBe(false);
  });

  it('never count a mark of 0.1.0, the bare fingerprint', () => {
    const prefs = createPrefs(memoryStorage({ 'verified:Ana': FP }).storage);
    expect(prefs.getVerified('Ana')).toBe(FP);
    expect(prefs.isVerified('Ana', FP)).toBe(false);
  });

  it('name the contacts whose mark comes from 0.1.0, in the order given', () => {
    const prefs = createPrefs(
      memoryStorage({ 'verified:Ana': FP, 'verified:Beto': `call:${FP}`, 'verified:Diego': OTHER }).storage,
    );
    expect(prefs.legacyVerified(['Diego', 'Ana', 'Beto', 'Carla'])).toEqual(['Diego', 'Ana']);
    expect(prefs.legacyVerified([])).toEqual([]);
  });

  // Once told (LegacyVerificationNotice), the old marks go. A call that
  // verified one of those contacts meanwhile wrote a mark that stays.
  it('clear only the marks that are still of 0.1.0', () => {
    const { storage, data } = memoryStorage({ 'verified:Ana': FP, 'verified:Beto': `call:${FP}`, 'verified:Diego': OTHER });
    const prefs = createPrefs(storage);
    prefs.setVerified('Diego', OTHER);
    prefs.clearLegacyVerified(['Ana', 'Beto', 'Diego', 'Carla']);
    expect(Object.fromEntries(data)).toEqual({ 'verified:Beto': `call:${FP}`, 'verified:Diego': `call:${OTHER}` });
    expect(prefs.legacyVerified(['Ana', 'Beto', 'Diego'])).toEqual([]);
  });
});

/** Every preference there is. Only the parent changes prefs.ts, and this list with it. */
const MEMBERS = [
  'getVerified', 'isVerified', 'setVerified', 'clearVerified', 'legacyVerified', 'clearLegacyVerified',
  'getNote', 'setNote', 'getTtl', 'setTtl',
  'getAutolockMinutes', 'setAutolockMinutes',
  'getUpdatesMuted', 'setUpdatesMuted', 'getUpdatesLastRead', 'setUpdatesLastRead',
  'getStickerRecents', 'pushStickerRecent', 'renameContact', 'forgetContact',
  'getNotifPreview', 'setNotifPreview', 'getMessageSound', 'setMessageSound',
  'getCallNotifyHidden', 'setCallNotifyHidden', 'getCallsSeenAt', 'setCallsSeenAt',
  'getRingtone', 'setRingtone', 'getRingVolume', 'setRingVolume',
  'getMuteGroupsByDefault', 'setMuteGroupsByDefault', 'getGroupMuted', 'setGroupMuted',
  'getScanLines', 'setScanLines',
  'getBlockCaptures', 'setBlockCaptures',
  'getLockWithSystem', 'setLockWithSystem',
] as const;

// With TURN the contact never sees your IP, so the warning "once per
// contact" went away with its two settings (plan-cambios-11oct §1.2). The
// question of calling directly is asked on every call and never remembered:
// a preference that skipped or remembered it could let a call go direct
// without consent. So the preferences are a closed set, and none is about it.
describe('the preferences, a closed set since TURN retired the IP warning', () => {
  it('are exactly these, in the type and at run time', () => {
    expectTypeOf<keyof Prefs>().toEqualTypeOf<(typeof MEMBERS)[number]>();
    expect(Object.keys(createPrefs(memoryStorage().storage)).sort()).toEqual([...MEMBERS].sort());
  });

  it('come with nothing but their option lists, defaults and limits', () => {
    expect(Object.keys(prefsModule).sort()).toEqual([
      'DEFAULT_AUTOLOCK_MINUTES',
      'NOTIF_PREVIEWS',
      'PREF_DEFAULTS',
      'RINGTONES',
      'STICKER_RECENTS_MAX',
      'createPrefs',
      'prefs',
    ]);
  });
});

describe('preferences of the redesign', () => {
  it('have the defaults of the approved Settings screen', () => {
    const prefs = createPrefs(memoryStorage().storage);
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.getMessageSound()).toBe(true);
    expect(prefs.getCallNotifyHidden()).toBe(true);
    expect(prefs.getRingtone()).toBe('soft');
    expect(prefs.getRingVolume()).toBe(60);
    expect(prefs.getMuteGroupsByDefault()).toBe(false);
    expect(prefs.getGroupMuted('9f3a')).toBe(false);
    expect(prefs.getScanLines()).toBe(true);
    expect(prefs.getCallsSeenAt()).toBe(0);
    // SC-1 (David, 12 Oct): screenshots are blocked unless you turn it off.
    expect(prefs.getBlockCaptures()).toBe(true);
    expect(PREF_DEFAULTS).toEqual({
      notifPreview: 'name',
      messageSound: true,
      callNotifyHidden: true,
      ringtone: 'soft',
      ringVolume: 60,
      muteGroupsByDefault: false,
      scanLines: true,
      blockCaptures: true,
      lockWithSystem: true,
    });
  });

  // Cifrado local CL-6a (David's decision 4): Trino locks when Windows
  // locks, sleeps or hibernates unless you turn it off.
  it('lock Trino with Windows unless turned off, under trino.pref.lockWithSystem', () => {
    const { storage, data } = memoryStorage();
    const prefs = createPrefs(storage);
    expect(prefs.getLockWithSystem()).toBe(true);
    expect(prefs.setLockWithSystem(false)).toBe(true);
    expect(data.get('trino.pref.lockWithSystem')).toBe('0');
    expect(prefs.getLockWithSystem()).toBe(false);
    prefs.setLockWithSystem(true);
    expect(data.get('trino.pref.lockWithSystem')).toBe('1');
    expect(prefs.getLockWithSystem()).toBe(true);
  });

  it('are stored under trino.pref.*', () => {
    const { storage, data } = memoryStorage();
    const prefs = createPrefs(storage);
    prefs.setNotifPreview('full');
    prefs.setMessageSound(false);
    prefs.setCallNotifyHidden(false);
    prefs.setRingtone('silent');
    prefs.setRingVolume(35);
    prefs.setMuteGroupsByDefault(true);
    prefs.setGroupMuted('9f3a', true);
    prefs.setScanLines(false);
    prefs.setCallsSeenAt(1760000000);
    prefs.setBlockCaptures(false);
    expect(Object.fromEntries(data)).toEqual({
      'trino.pref.notifPreview': 'full',
      'trino.pref.messageSound': '0',
      'trino.pref.callNotifyHidden': '0',
      'trino.pref.ringtone': 'silent',
      'trino.pref.ringVolume': '35',
      'trino.pref.muteGroupsByDefault': '1',
      'trino.pref.groupMuted:9f3a': '1',
      'trino.pref.scanLines': '0',
      'trino.pref.callsSeenAt': '1760000000',
      'trino.pref.blockCaptures': '0',
    });
    expect(prefs.getNotifPreview()).toBe('full');
    expect(prefs.getMessageSound()).toBe(false);
    expect(prefs.getCallNotifyHidden()).toBe(false);
    expect(prefs.getRingtone()).toBe('silent');
    expect(prefs.getRingVolume()).toBe(35);
    expect(prefs.getMuteGroupsByDefault()).toBe(true);
    expect(prefs.getGroupMuted('9f3a')).toBe(true);
    expect(prefs.getScanLines()).toBe(false);
    expect(prefs.getCallsSeenAt()).toBe(1760000000);
    expect(prefs.getBlockCaptures()).toBe(false);
  });

  it('fall back to the default for a value they do not know', () => {
    const prefs = createPrefs(
      memoryStorage({
        'trino.pref.notifPreview': 'everything',
        'trino.pref.ringtone': 'bell',
        'trino.pref.ringVolume': 'loud',
        'trino.pref.scanLines': 'off',
        'trino.pref.messageSound': 'yes',
        'trino.pref.callsSeenAt': 'later',
        'trino.pref.blockCaptures': 'no',
      }).storage,
    );
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.getRingtone()).toBe('soft');
    expect(prefs.getRingVolume()).toBe(60);
    expect(prefs.getScanLines()).toBe(true);
    expect(prefs.getMessageSound()).toBe(true);
    expect(prefs.getCallsSeenAt()).toBe(0);
    expect(prefs.getBlockCaptures()).toBe(true);
  });

  // W2 counts the missed calls after this moment ("Llamadas · N"); opening
  // the Calls tab moves it to now. Epoch seconds, like `Msg.ts`.
  it('keep when the call log was last seen, from 0, never negative', () => {
    const { storage } = memoryStorage();
    const prefs = createPrefs(storage);
    expect(prefs.getCallsSeenAt()).toBe(0);
    expect(prefs.setCallsSeenAt(1760000123.5)).toBe(true);
    expect(prefs.getCallsSeenAt()).toBe(1760000123.5);
    for (const ts of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(prefs.setCallsSeenAt(ts), String(ts)).toBe(false);
    }
    expect(prefs.getCallsSeenAt()).toBe(1760000123.5);
    for (const value of ['-5', '', 'NaN', 'Infinity']) {
      expect(createPrefs(memoryStorage({ 'trino.pref.callsSeenAt': value }).storage).getCallsSeenAt(), value).toBe(0);
    }
  });

  it('keep the ring volume a whole number from 0 to 100', () => {
    const { storage } = memoryStorage();
    const prefs = createPrefs(storage);
    prefs.setRingVolume(140);
    expect(prefs.getRingVolume()).toBe(100);
    prefs.setRingVolume(-3);
    expect(prefs.getRingVolume()).toBe(0);
    prefs.setRingVolume(42.6);
    expect(prefs.getRingVolume()).toBe(43);
    expect(createPrefs(memoryStorage({ 'trino.pref.ringVolume': '250' }).storage).getRingVolume()).toBe(100);
  });
});

describe('storage that fails', () => {
  it('gives the defaults and never throws', () => {
    const prefs = createPrefs(brokenStorage);
    expect(prefs.getTtl('Ana')).toBe(0);
    expect(prefs.getAutolockMinutes()).toBe(5);
    expect(prefs.getStickerRecents()).toEqual([]);
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.isVerified('Ana', 'fp')).toBe(false);
    expect(prefs.legacyVerified(['Ana'])).toEqual([]);
    expect(prefs.getCallsSeenAt()).toBe(0);
    expect(() => prefs.renameContact('Ana', 'B')).not.toThrow();
    expect(() => prefs.forgetContact('Ana')).not.toThrow();
    expect(() => prefs.clearLegacyVerified(['Ana'])).not.toThrow();
    expect(() => prefs.pushStickerRecent('s1')).not.toThrow();
  });

  it('reports a write it could not make', () => {
    const prefs = createPrefs(brokenStorage);
    expect(prefs.setNote('Ana', 'x')).toBe(false);
    expect(prefs.setScanLines(false)).toBe(false);
    expect(prefs.setCallsSeenAt(1760000000)).toBe(false);
    expect(createPrefs(memoryStorage().storage).setScanLines(false)).toBe(true);
  });

  it('gives the defaults when there is no storage at all', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      const prefs = createPrefs();
      expect(prefs.getScanLines()).toBe(true);
      expect(prefs.setScanLines(false)).toBe(false);
      // Without storage the window stays protected.
      expect(prefs.getBlockCaptures()).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
