import { describe, expect, it } from 'vitest';
import { resolveTokens } from './appearance';
import { contrastRatio, relativeLuminance } from './color';
import { ACCENTS, RESOLVED_MODES, STYLES, THEMES, type ThemeId, type ThemeTokens } from './tokens';

type Pair = readonly [foreground: keyof ThemeTokens, background: keyof ThemeTokens];

/** Text pairs required by the redesign plan: WCAG 2.x AA, 4.5:1. */
const TEXT_PAIRS: readonly Pair[] = [
  ['ink', 'bg'],
  ['ink', 'surface'],
  ['ink', 'side'],
  ['muted', 'bg'],
  ['muted', 'surface'],
  ['muted', 'side'],
  ['accentInk', 'accent'],
  ['accentText', 'surface'],
  ['accentText', 'bg'],
  ['bubbleInInk', 'bubbleIn'],
  ['bubbleMeInk', 'bubbleMe'],
  ['bubbleMeMuted', 'bubbleMe'],
  ['warn', 'warnBg'],
  ['danger', 'surface'],
  ['danger', 'dangerBg'],
  ['badgeInk', 'badge'],
  ['avatarFg', 'avatarBg'],
];

/** More text pairs, found in the approved prototype's screens: also 4.5:1. */
const PROTOTYPE_TEXT_PAIRS: readonly Pair[] = [
  ['ink', 'raised'], // selected rows, key codes
  ['muted', 'raised'], // day separators, the preview of a selected row
  ['accentText', 'raised'], // "Borrador:" in a selected row
  ['muted', 'bubbleIn'], // time of incoming messages
  ['accentText', 'bubbleIn'], // sender names in groups
  ['ink', 'accentSoft'], // selected options
  ['muted', 'accentSoft'], // connection chip
  ['accentText', 'accentSoft'], // initials of your own avatar
];

/** Status indicators and control states (WCAG 1.4.11): 3:1. `line` is decorative. */
const NON_TEXT_PAIRS: readonly Pair[] = [
  ['ok', 'surface'], // status dot
  ['accent', 'surface'], // toggle on, selected segment
  ['accent', 'bg'],
];

/** Where a control can sit: panels, the app background, the sidebar and selected rows. */
const BACKGROUNDS = ['surface', 'bg', 'side', 'raised'] as const;

/**
 * The boundary that shows where a text field is (WCAG 1.4.11): `controlLine`,
 * or `danger` while the field is invalid, at 3:1 on every background.
 */
const BOUNDARY_PAIRS: readonly Pair[] = (['controlLine', 'danger'] as const).flatMap(boundary =>
  BACKGROUNDS.map((background): Pair => [boundary, background]),
);

const COMBINATIONS = STYLES.flatMap(style =>
  RESOLVED_MODES.flatMap(mode => ACCENTS.map(accent => ({ style, mode, accent }))),
);

const THEME_IDS = Object.keys(THEMES) as ThemeId[];

/** Every pair below `minimum`, named with both colours and the ratio. */
function failures(tokens: ThemeTokens, pairs: readonly Pair[], minimum: number): string[] {
  return pairs.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(tokens[foreground], tokens[background]);
    return ratio >= minimum
      ? []
      : [`${foreground} ${tokens[foreground]} on ${background} ${tokens[background]}: ${ratio.toFixed(2)}:1`];
  });
}

describe('WCAG 2.x relative luminance and contrast ratio', () => {
  it('spans 0 to 1 and 1:1 to 21:1', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 10);
    expect(contrastRatio('#0F7B4A', '#0F7B4A')).toBe(1);
  });

  it('matches reference values', () => {
    // sRGB transfer function: 128/255 linearises to 0.2158605.
    expect(relativeLuminance('#808080')).toBeCloseTo(0.21586, 5);
    // #777 on white is the classic grey that just misses AA.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
  });

  it('does not depend on the order or the case of the colours', () => {
    expect(contrastRatio('#ffffff', '#0f7b4a')).toBe(contrastRatio('#0F7B4A', '#FFFFFF'));
  });

  it('rejects anything but #RRGGBB', () => {
    expect(() => relativeLuminance('#FFF')).toThrow();
    expect(() => relativeLuminance('white')).toThrow();
  });
});

describe.each(COMBINATIONS)('contrast of $style $mode with $accent', ({ style, mode, accent }) => {
  it('text reaches 4.5:1', () => {
    const tokens = resolveTokens(style, mode, accent);
    expect(failures(tokens, [...TEXT_PAIRS, ...PROTOTYPE_TEXT_PAIRS], 4.5)).toEqual([]);
  });

  it('status indicators and control states reach 3:1', () => {
    const tokens = resolveTokens(style, mode, accent);
    expect(failures(tokens, NON_TEXT_PAIRS, 3)).toEqual([]);
  });

  it('text field boundaries, normal and invalid, reach 3:1 on every background', () => {
    const tokens = resolveTokens(style, mode, accent);
    expect(failures(tokens, BOUNDARY_PAIRS, 3)).toEqual([]);
  });
});

describe.each(COMBINATIONS)('the QR code in $style $mode with $accent', ({ style, mode, accent }) => {
  // Black on white whatever the theme: scanners expect dark modules on a light
  // quiet zone, and an inverted or low-contrast code fails on many phones.
  it('is black on white, 21:1', () => {
    const tokens = resolveTokens(style, mode, accent);
    expect([tokens.qrInk, tokens.qrPaper]).toEqual(['#000000', '#FFFFFF']);
    expect(contrastRatio(tokens.qrInk, tokens.qrPaper)).toBeCloseTo(21, 10);
  });
});

describe.each(THEME_IDS)('the control boundary of %s', id => {
  // As quiet as WCAG allows: a boundary, not a second muted text colour.
  it('stays between 3:1 and 3.6:1 on the background closest to it', () => {
    const theme = THEMES[id];
    const closest = Math.min(...BACKGROUNDS.map(background => contrastRatio(theme.controlLine, theme[background])));
    expect(closest).toBeGreaterThanOrEqual(3);
    expect(closest).toBeLessThanOrEqual(3.6);
  });
});
