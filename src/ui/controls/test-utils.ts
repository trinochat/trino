/**
 * Helpers for the tests of the controls. Not part of the library: only test
 * files import this module.
 */
import { fireEvent } from '@testing-library/react';
import { resolveTokens } from '../../design/appearance';
import { contrastRatio, isHexColor } from '../../design/color';
import { ACCENTS, RESOLVED_MODES, STYLES, type ThemeTokens } from '../../design/tokens';

/**
 * Presses Enter or Space on a native button the way a browser does. jsdom has
 * no keyboard activation, so this follows the HTML rules: Enter clicks on
 * keydown and Space on keyup, unless a handler cancelled the key.
 */
export function pressActivationKey(element: Element, key: 'Enter' | ' '): void {
  const code = key === ' ' ? 'Space' : 'Enter';
  const down = fireEvent.keyDown(element, { key, code });
  if (key === 'Enter' && down) fireEvent.click(element);
  const up = fireEvent.keyUp(element, { key, code });
  if (key === ' ' && down && up) fireEvent.click(element);
}

/** The 16 appearances a user can pick: every style, mode and accent. */
export const APPEARANCES = STYLES.flatMap(style =>
  RESOLVED_MODES.flatMap(mode => ACCENTS.map(accent => ({ style, mode, accent }))),
);

type ColourToken = keyof ThemeTokens;
type ColourPrefix = 'bg' | 'text' | 'border';

const SAMPLE_TOKENS = resolveTokens('calma', 'light', 'verde');

/** The token after `ui-` in a class, in camel case (accentInk for ui-accent-ink), checked to be a colour. */
function tokenNamed(suffix: string): ColourToken {
  const token = suffix.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (!(token in SAMPLE_TOKENS) || !isHexColor(SAMPLE_TOKENS[token as ColourToken])) {
    throw new Error(`ui-${suffix} is not a colour token`);
  }
  return token as ColourToken;
}

/**
 * The colour tokens behind the `<prefix>-ui-*` classes of an element, with or
 * without variants: `text-ui-muted enabled:hover:text-ui-ink` → muted, ink.
 */
export function colourTokens(element: Element, prefix: ColourPrefix): ColourToken[] {
  const pattern = new RegExp(`^(?:[a-z-]+:)*${prefix}-ui-([a-z-]+)$`);
  return Array.from(element.classList).flatMap(name => {
    const match = pattern.exec(name);
    return match ? [tokenNamed(match[1])] : [];
  });
}

/** The colour token of the single `<prefix>-ui-*` class without a variant. */
export function colourToken(element: Element, prefix: ColourPrefix): ColourToken {
  const pattern = new RegExp(`^${prefix}-ui-([a-z-]+)$`);
  const suffixes = Array.from(element.classList).flatMap(name => pattern.exec(name)?.[1] ?? []);
  if (suffixes.length !== 1) {
    throw new Error(`Expected one ${prefix}-ui-* class in "${element.getAttribute('class')}"`);
  }
  return tokenNamed(suffixes[0]);
}

/** Every pair below `minimum` in any of the 16 appearances, readable in a failure. */
export function contrastFailures(
  pairs: ReadonlyArray<readonly [foreground: ColourToken, background: ColourToken]>,
  minimum: number,
): string[] {
  return APPEARANCES.flatMap(({ style, mode, accent }) => {
    const tokens = resolveTokens(style, mode, accent);
    return pairs.flatMap(([foreground, background]) => {
      const ratio = contrastRatio(tokens[foreground], tokens[background]);
      return ratio >= minimum
        ? []
        : [`${style}-${mode}-${accent}: ${foreground} on ${background} is ${ratio.toFixed(2)}:1`];
    });
  });
}

/** Where a control can sit: the app background, panels, the sidebar and selected rows. */
export const SURFACES: readonly ColourToken[] = ['surface', 'bg', 'side', 'raised'];

/** The text of the elements an element's aria-describedby points to, in order. */
export function descriptionsOf(element: Element): Array<string | null> {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(id => element.ownerDocument.getElementById(id)?.textContent ?? null);
}
