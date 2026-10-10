import { describe, expect, it } from 'vitest';
import { PREF_DEFAULTS, STICKER_RECENTS_MAX, createPrefs, type PrefsStorage } from './prefs';

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
    expect(prefs.isVerified('Ana', 'ab12cd34')).toBe(true);
    expect(prefs.isVerified('Ana', 'ffff0000')).toBe(false);
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
      'verified:Ana': 'ab12cd34',
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
  it('carries its note, ttl, verification and IP warning to the new name', () => {
    const { storage, data } = memoryStorage({
      'note:Ana': 'n',
      'ttl:Ana': '30',
      'verified:Ana': 'fp',
      'trino.pref.ipWarned:Ana': '1',
      'note:Otro': 'o',
    });
    createPrefs(storage).renameContact('Ana', 'Ana T');
    expect(Object.fromEntries(data)).toEqual({
      'note:Ana T': 'n',
      'ttl:Ana T': '30',
      'verified:Ana T': 'fp',
      'trino.pref.ipWarned:Ana T': '1',
      'note:Otro': 'o',
    });
  });

  it('loses everything stored for it, and nothing else', () => {
    const { storage, data } = memoryStorage({
      'note:Ana': 'n',
      'ttl:Ana': '30',
      'verified:Ana': 'fp',
      'trino.pref.ipWarned:Ana': '1',
      'note:Otro': 'o',
    });
    createPrefs(storage).forgetContact('Ana');
    expect(Object.fromEntries(data)).toEqual({ 'note:Otro': 'o' });
  });
});

describe('preferences of the redesign', () => {
  it('have the defaults of the approved Settings screen', () => {
    const prefs = createPrefs(memoryStorage().storage);
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.getMessageSound()).toBe(true);
    expect(prefs.getCallNotifyHidden()).toBe(true);
    expect(prefs.getCallIpWarn()).toBe('once');
    expect(prefs.getIpWarned('Ana')).toBe(false);
    expect(prefs.getRingtone()).toBe('soft');
    expect(prefs.getRingVolume()).toBe(60);
    expect(prefs.getMuteGroupsByDefault()).toBe(false);
    expect(prefs.getGroupMuted('9f3a')).toBe(false);
    expect(prefs.getTextSize()).toBe('normal');
    expect(PREF_DEFAULTS).toEqual({
      notifPreview: 'name',
      messageSound: true,
      callNotifyHidden: true,
      callIpWarn: 'once',
      ringtone: 'soft',
      ringVolume: 60,
      muteGroupsByDefault: false,
      textSize: 'normal',
    });
  });

  it('are stored under trino.pref.*', () => {
    const { storage, data } = memoryStorage();
    const prefs = createPrefs(storage);
    prefs.setNotifPreview('full');
    prefs.setMessageSound(false);
    prefs.setCallNotifyHidden(false);
    prefs.setCallIpWarn('always');
    prefs.setIpWarned('Ana', true);
    prefs.setRingtone('silent');
    prefs.setRingVolume(35);
    prefs.setMuteGroupsByDefault(true);
    prefs.setGroupMuted('9f3a', true);
    prefs.setTextSize('large');
    expect(Object.fromEntries(data)).toEqual({
      'trino.pref.notifPreview': 'full',
      'trino.pref.messageSound': '0',
      'trino.pref.callNotifyHidden': '0',
      'trino.pref.callIpWarn': 'always',
      'trino.pref.ipWarned:Ana': '1',
      'trino.pref.ringtone': 'silent',
      'trino.pref.ringVolume': '35',
      'trino.pref.muteGroupsByDefault': '1',
      'trino.pref.groupMuted:9f3a': '1',
      'trino.pref.textSize': 'large',
    });
    expect(prefs.getNotifPreview()).toBe('full');
    expect(prefs.getMessageSound()).toBe(false);
    expect(prefs.getCallNotifyHidden()).toBe(false);
    expect(prefs.getCallIpWarn()).toBe('always');
    expect(prefs.getIpWarned('Ana')).toBe(true);
    expect(prefs.getRingtone()).toBe('silent');
    expect(prefs.getRingVolume()).toBe(35);
    expect(prefs.getMuteGroupsByDefault()).toBe(true);
    expect(prefs.getGroupMuted('9f3a')).toBe(true);
    expect(prefs.getTextSize()).toBe('large');
  });

  it('fall back to the default for a value they do not know', () => {
    const prefs = createPrefs(
      memoryStorage({
        'trino.pref.notifPreview': 'everything',
        'trino.pref.callIpWarn': 'sometimes',
        'trino.pref.ringtone': 'bell',
        'trino.pref.ringVolume': 'loud',
        'trino.pref.textSize': 'huge',
        'trino.pref.messageSound': 'yes',
      }).storage,
    );
    expect(prefs.getNotifPreview()).toBe('name');
    expect(prefs.getCallIpWarn()).toBe('once');
    expect(prefs.getRingtone()).toBe('soft');
    expect(prefs.getRingVolume()).toBe(60);
    expect(prefs.getTextSize()).toBe('normal');
    expect(prefs.getMessageSound()).toBe(true);
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
    expect(() => prefs.renameContact('Ana', 'B')).not.toThrow();
    expect(() => prefs.forgetContact('Ana')).not.toThrow();
    expect(() => prefs.pushStickerRecent('s1')).not.toThrow();
  });

  it('reports a write it could not make', () => {
    const prefs = createPrefs(brokenStorage);
    expect(prefs.setNote('Ana', 'x')).toBe(false);
    expect(prefs.setTextSize('large')).toBe(false);
    expect(createPrefs(memoryStorage().storage).setTextSize('large')).toBe(true);
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
      expect(prefs.getTextSize()).toBe('normal');
      expect(prefs.setTextSize('large')).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
