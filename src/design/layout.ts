/**
 * The shell's layout, decided with widths in rem (accesibilidad.md §4.7).
 * Media queries do not see the text size, so the shell measures its own
 * width (a ResizeObserver) and divides it by the root size, which
 * `useAccessibility()` gives as 16 px times the text scale in effect: larger
 * text turns two panes into one before anything is cut.
 *
 * | Window   | 100 %                       | 125 %          | 150 %          | 200 %          |
 * |----------|-----------------------------|----------------|----------------|----------------|
 * | 1024×700 | 64 rem: two panes, dialogs  | 51.2: two      | 42.7: one pane | 32: one pane   |
 * | 800×600  | 50: two panes               | 40: one pane   | 33.3: one pane | 25: one pane   |
 * | 640×480  | 40: one pane                | 32: one pane   | 26.7: one pane | 20 × 15 rem    |
 */

/** Two panes from 47.5 rem, and the details aside from 70 rem: 760 and 1120 px at 100 %. */
export const LAYOUT_REM = { twoPanes: 47.5, aside: 70 } as const;

export type ShellLayout = 'single' | 'double' | 'double-aside';

/** The root size at 100 %, for a root size that cannot be used. */
const DEFAULT_ROOT_PX = 16;

/** The layout for a shell `widthPx` wide, with the root at `rootPx`. */
export function layoutFor(widthPx: number, rootPx: number): ShellLayout {
  const root = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : DEFAULT_ROOT_PX;
  const rem = widthPx / root;
  if (rem >= LAYOUT_REM.aside) return 'double-aside';
  if (rem >= LAYOUT_REM.twoPanes) return 'double';
  return 'single';
}
