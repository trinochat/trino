import { describe, expect, it, vi } from 'vitest';
import type { Prefs } from '../../lib/prefs';
import { REINFORCED_VALUES, turnOffReinforced, turnOnReinforced } from './reinforced';
import { memoryPrefs } from './test-utils';

const BEFORE = {
  autolock: '15',
  'trino.pref.lockWithSystem': '0',
  'trino.pref.notifPreview': 'full',
  'trino.pref.blockCaptures': '0',
};

function deps(stored: Record<string, string> = {}, prefsOver: Partial<Prefs> = {}) {
  const memory = memoryPrefs(stored);
  const prefs: Prefs = { ...memory.prefs, ...prefsOver };
  const setContentProtected = vi.fn(async (_protect: boolean) => {});
  return { prefs, data: memory.storage.data, setContentProtected };
}

// Cifrado local CL-6b, design §10 (David's decision 5): Protección reforzada
// sets stricter values together; each can still be changed on its own.
describe('Protección reforzada', () => {
  it('has the values of design §10', () => {
    expect(REINFORCED_VALUES).toEqual({ autolockMinutes: 1, lockWithSystem: true, notifPreview: 'none', blockCaptures: true });
  });

  it('turns on the stricter values together and remembers what they were', async () => {
    const d = deps(BEFORE);
    expect(await turnOnReinforced(d)).toEqual({ ok: true });
    expect(d.prefs.getReinforced()).toBe(true);
    expect(d.prefs.getAutolockMinutes()).toBe(1);
    expect(d.prefs.getLockWithSystem()).toBe(true);
    // "Nada": notifications say only "Trino Chat: Nuevo mensaje", in groups too.
    expect(d.prefs.getNotifPreview()).toBe('none');
    expect(d.prefs.getBlockCaptures()).toBe(true);
    expect(d.setContentProtected).toHaveBeenCalledWith(true);
    expect(d.prefs.getReinforcedBefore()).toEqual({
      autolockMinutes: 15,
      lockWithSystem: false,
      notifPreview: 'full',
      blockCaptures: false,
    });
  });

  it('turned on twice, still remembers the values of before the first', async () => {
    const d = deps(BEFORE);
    await turnOnReinforced(d);
    await turnOnReinforced(d);
    expect(d.prefs.getReinforcedBefore()?.autolockMinutes).toBe(15);
  });

  it('turning off gives back what it changed and leaves what you changed after', async () => {
    const d = deps(BEFORE);
    await turnOnReinforced(d);
    d.prefs.setNotifPreview('name');
    d.setContentProtected.mockClear();
    expect(await turnOffReinforced(d)).toEqual({ ok: true });
    expect(d.prefs.getReinforced()).toBe(false);
    expect(d.prefs.getReinforcedBefore()).toBeNull();
    expect(d.prefs.getAutolockMinutes()).toBe(15);
    expect(d.prefs.getLockWithSystem()).toBe(false);
    expect(d.prefs.getNotifPreview()).toBe('name');
    expect(d.prefs.getBlockCaptures()).toBe(false);
    expect(d.setContentProtected).toHaveBeenCalledWith(false);
  });

  it('turning off keeps a value that was already as strict before', async () => {
    const d = deps({ ...BEFORE, 'trino.pref.blockCaptures': '1' });
    await turnOnReinforced(d);
    d.setContentProtected.mockClear();
    await turnOffReinforced(d);
    expect(d.prefs.getBlockCaptures()).toBe(true);
    expect(d.setContentProtected).not.toHaveBeenCalled();
  });

  it('turning off with nothing remembered only turns it off', async () => {
    const d = deps({ 'trino.pref.reinforced': '1', autolock: '1', 'trino.pref.notifPreview': 'none' });
    expect(await turnOffReinforced(d)).toEqual({ ok: true });
    expect(d.prefs.getReinforced()).toBe(false);
    expect(d.prefs.getAutolockMinutes()).toBe(1);
    expect(d.prefs.getNotifPreview()).toBe('none');
    expect(d.setContentProtected).not.toHaveBeenCalled();
  });

  it('says so when the window refuses, keeping the captures as they were and changing the rest', async () => {
    const d = deps(BEFORE);
    d.setContentProtected.mockRejectedValue(new Error('window'));
    expect(await turnOnReinforced(d)).toEqual({ ok: false });
    expect(d.prefs.getBlockCaptures()).toBe(false);
    expect(d.prefs.getAutolockMinutes()).toBe(1);
    expect(d.prefs.getNotifPreview()).toBe('none');
    expect(d.prefs.getReinforced()).toBe(true);
  });

  it('says so when a value cannot be kept', async () => {
    const d = deps(BEFORE, { setNotifPreview: () => false });
    expect(await turnOnReinforced(d)).toEqual({ ok: false });
    expect(d.prefs.getAutolockMinutes()).toBe(1);
  });
});
