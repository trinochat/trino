import { describe, expect, it } from 'vitest';
import { createPrefs, type PrefsStorage } from '../../lib/prefs';
import { GROUP_TTL_OPTIONS, groupPrefs } from './group-prefs';

function memoryStorage(): PrefsStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key),
  };
}

describe('groupPrefs', () => {
  it('keeps a group muted or not, on this device', () => {
    const storage = memoryStorage();
    const prefs = groupPrefs(createPrefs(storage));
    expect(prefs.isMuted('g1')).toBe(false);
    expect(prefs.setMuted('g1', true)).toBe(true);
    expect(prefs.isMuted('g1')).toBe(true);
    expect(prefs.isMuted('g2')).toBe(false);
    expect(storage.data.get('trino.pref.groupMuted:g1')).toBe('1');
  });

  // The key App.tsx already reads for a group's messages (prefs.getTtl('grp:' + gid)).
  it('keeps the time your new messages in a group last, under the key the chat reads', () => {
    const storage = memoryStorage();
    const prefs = groupPrefs(createPrefs(storage));
    expect(prefs.getTtl('g1')).toBe(0);
    prefs.setTtl('g1', 86400);
    expect(prefs.getTtl('g1')).toBe(86400);
    expect(storage.data.get('ttl:grp:g1')).toBe('86400');
    prefs.setTtl('g1', 0);
    expect(storage.data.has('ttl:grp:g1')).toBe(false);
  });

  it('mutes a new group only when Settings says new groups start muted', () => {
    const storage = memoryStorage();
    const device = createPrefs(storage);
    const prefs = groupPrefs(device);
    prefs.applyDefaults('g1');
    expect(prefs.isMuted('g1')).toBe(false);
    device.setMuteGroupsByDefault(true);
    prefs.applyDefaults('g2');
    expect(prefs.isMuted('g2')).toBe(true);
  });

  it('offers the times the chats already offer', () => {
    expect(GROUP_TTL_OPTIONS).toEqual([0, 30, 300, 3600, 86400, 604800]);
  });
});
