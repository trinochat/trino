import { describe, expect, it } from 'vitest';
import tauriConfig from '../../src-tauri/tauri.conf.json';
import { TEXT_SCALES } from '../design/accessibility';
import { layoutFor } from '../design/layout';

/**
 * The window of src-tauri/tauri.conf.json against the layout rules of
 * accesibilidad.md §4.7. The shell fills the window, so the window's width in
 * rem, at the text size in effect, decides how many panes it shows.
 */
const [main] = tauriConfig.app.windows;
const ROOT_PX = 16;
const LARGEST_TEXT = Math.max(...TEXT_SCALES);

describe('the main window', () => {
  // Plan §1.8, point 10: two panes from the start (64 rem at 100 %), and the
  // details of a chat in a dialog until the window reaches 70 rem.
  it('opens at 1024×700, with two panes and the details in a dialog', () => {
    expect([main.width, main.height]).toEqual([1024, 700]);
    expect(layoutFor(main.width, ROOT_PX)).toBe('double');
  });

  // At the largest text the narrowest window is 20 rem wide, 320 px at 100 %:
  // the width WCAG 1.4.10 asks content to reflow at. One pane there.
  it('shrinks to 640×480, which at the largest text is the 20 rem that reflow asks for', () => {
    expect([main.minWidth, main.minHeight]).toEqual([640, 480]);
    expect(main.minWidth / (ROOT_PX * LARGEST_TEXT)).toBe(20);
    expect(layoutFor(main.minWidth, ROOT_PX)).toBe('single');
  });
});
