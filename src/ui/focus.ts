/**
 * Keyboard focus for the whole component library: the one focus ring, in two
 * placements, and the list of what Tab reaches. Controls, overlays and chat
 * pieces all import it from here; `focus.test.tsx` fails on a second definition.
 */

/**
 * Visible keyboard focus (WCAG 2.4.7): a 2 px outline in the accent text
 * colour, 2 px away from the element, which reaches 4.5:1 on every surface.
 * `shadow-none` drops the glow the legacy stylesheet adds to every focused
 * element.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-accent-text focus-visible:shadow-none';

/** The same ring drawn just inside the element, for full-width rows and menu items that would clip it. */
export const FOCUS_RING_INSET =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ui-accent-text focus-visible:shadow-none';

const CANDIDATES = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';

/** The elements inside `root` that Tab reaches, in document order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CANDIDATES)).filter(isTabbable);
}

function isTabbable(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false;
  if ('disabled' in element && element.disabled === true) return false;
  if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
  const tabIndex = element.getAttribute('tabindex');
  return tabIndex === null || Number(tabIndex) >= 0;
}
