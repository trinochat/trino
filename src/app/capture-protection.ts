/**
 * Keeping the window out of screenshots, recordings and screen sharing (SC-1;
 * David, 12 Oct: on by default, and anyone can turn it off in Settings ›
 * Privacidad).
 *
 * Tauri's `setContentProtected` does it: on Windows, tao sets the window's
 * display affinity to `WDA_EXCLUDEFROMCAPTURE`, so a capture of the screen
 * leaves Trino out and a capture of the window comes out black; on macOS it
 * sets the window's sharing type to none, which some recorders of recent
 * versions ignore; on Linux it does nothing. It never stops a photo of the
 * screen taken with another phone.
 *
 * The window is created protected (`contentProtected` in tauri.conf.json), so
 * nothing is captured before a script runs, the unlock screen included. The
 * choice lives with the appearance in this device's storage (src/lib/prefs.ts),
 * readable before unlocking: main.tsx applies it as the app starts, and the
 * switch applies each change at once, without restarting.
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { prefs as devicePrefs, type Prefs } from '../lib/prefs';

/** The part of the window this needs: `getCurrentWindow()` in the app. */
export interface CaptureWindow {
  setContentProtected(protect: boolean): Promise<void>;
}

/**
 * The app's window, looked up on each call. Outside Tauri the lookup throws,
 * and the call rejects instead.
 */
export const appWindow: CaptureWindow = {
  setContentProtected: async protect => getCurrentWindow().setContentProtected(protect),
};

/**
 * Applies the stored choice to the window; resolves to whether the window
 * took it. It never throws: when the window refuses, it stays as it was
 * created, protected.
 */
export async function applyStoredCaptureProtection(
  prefs: Pick<Prefs, 'getBlockCaptures'> = devicePrefs,
  win: CaptureWindow = appWindow,
): Promise<boolean> {
  try {
    await win.setContentProtected(prefs.getBlockCaptures());
    return true;
  } catch {
    return false;
  }
}
