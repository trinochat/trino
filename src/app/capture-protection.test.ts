import { describe, expect, it, vi } from 'vitest';
import { createPrefs } from '../lib/prefs';
import { memoryStorage } from '../screens/settings/test-utils';
import { applyStoredCaptureProtection, type CaptureWindow } from './capture-protection';

function fakeWindow(fails = false): CaptureWindow & { setContentProtected: ReturnType<typeof vi.fn> } {
  return {
    setContentProtected: vi.fn(async () => {
      if (fails) throw new Error('window gone');
    }),
  };
}

// SC-1: the choice of Settings › Privacidad is kept with the appearance, in
// this device's storage, so it is read before unlocking and applied to the
// window as the app starts.
describe('applyStoredCaptureProtection', () => {
  it('protects the window when nothing was chosen', async () => {
    const win = fakeWindow();
    await expect(applyStoredCaptureProtection(createPrefs(memoryStorage()), win)).resolves.toBe(true);
    expect(win.setContentProtected.mock.calls).toEqual([[true]]);
  });

  it('lets captures through when you turned it off', async () => {
    const win = fakeWindow();
    await applyStoredCaptureProtection(createPrefs(memoryStorage({ 'trino.pref.blockCaptures': '0' })), win);
    expect(win.setContentProtected.mock.calls).toEqual([[false]]);
  });

  it('protects the window when the storage cannot be read', async () => {
    const win = fakeWindow();
    const broken = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    await applyStoredCaptureProtection(createPrefs(broken), win);
    expect(win.setContentProtected.mock.calls).toEqual([[true]]);
  });

  // The window was created protected (tauri.conf.json), so a failure leaves
  // it protected; the app starts anyway.
  it('never throws when the window refuses', async () => {
    const win = fakeWindow(true);
    await expect(applyStoredCaptureProtection(createPrefs(memoryStorage({ 'trino.pref.blockCaptures': '0' })), win)).resolves.toBe(false);
  });
});
