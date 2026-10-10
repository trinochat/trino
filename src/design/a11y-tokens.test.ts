import { describe, expect, it } from 'vitest';
import {
  CONTRASTS,
  MORE_CONTRAST,
  MORE_CONTRAST_ACCENTS,
  SAFE_STATUS,
  STANDARD_A11Y,
  VISIONS,
  type Contrast,
  type Vision,
} from './a11y-tokens';
import { resolveTokens } from './appearance';
import { DEFICIENCIES, colorDistance, contrastRatio, isHexColor } from './color';
import { ACCENTS, RESOLVED_MODES, STYLES, THEMES, type ThemeId, type ThemeTokens } from './tokens';

/**
 * The accessibility layers over the 4 themes and 4 accents: 4 × 4 × 2 visions
 * × 2 contrasts = 64 combinations, each held to the levels of the
 * specification (accesibilidad.md §4.6). Text reaches 4.5:1, or 7:1 with more
 * contrast (WCAG 1.4.6); indicators and boundaries 3:1; with the safe colours
 * the three status colours stay apart under protanopia, deuteranopia and
 * tritanopia. The pair lists of contrast.test.ts are repeated here on purpose,
 * so each file reads on its own; that file keeps checking the standard layers.
 */

type Pair = readonly [foreground: keyof ThemeTokens, background: keyof ThemeTokens];

/** The text pairs of contrast.test.ts: the plan's and the prototype's (25). */
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
  ['ink', 'raised'],
  ['muted', 'raised'],
  ['accentText', 'raised'],
  ['muted', 'bubbleIn'],
  ['accentText', 'bubbleIn'],
  ['ink', 'accentSoft'],
  ['muted', 'accentSoft'],
  ['accentText', 'accentSoft'],
];

/** Text the accessibility work adds: warnings and errors wherever they sit, ink on the soft tones. */
const NEW_TEXT_PAIRS: readonly Pair[] = [
  ['warn', 'surface'],
  ['warn', 'bg'],
  ['warn', 'side'],
  ['warn', 'raised'],
  ['warn', 'accentSoft'],
  ['danger', 'bg'],
  ['danger', 'side'],
  ['danger', 'raised'],
  ['ink', 'warnBg'],
  ['ink', 'dangerBg'],
  ['accentText', 'side'],
];

/** With the safe colours "verified" is written in `ok`, so `ok` becomes text. */
const SAFE_TEXT_PAIRS: readonly Pair[] = [
  ['ok', 'surface'],
  ['ok', 'bg'],
  ['ok', 'side'],
  ['ok', 'raised'],
  ['ok', 'accentSoft'],
];

/** Indicators and control states (WCAG 1.4.11): the connection icons sit on the accent tint. */
const NON_TEXT_PAIRS: readonly Pair[] = [
  ['ok', 'surface'],
  ['accent', 'surface'],
  ['accent', 'bg'],
  ['ok', 'accentSoft'],
  ['warn', 'accentSoft'],
  ['danger', 'accentSoft'],
];

const BACKGROUNDS = ['surface', 'bg', 'side', 'raised'] as const;

const field = (boundary: keyof ThemeTokens): Pair[] => BACKGROUNDS.map((background): Pair => [boundary, background]);

/** Separators and bubble borders, which only have to show with more contrast. */
const MORE_LINE_PAIRS: readonly Pair[] = [
  ['line', 'bg'],
  ['line', 'surface'],
  ['line', 'side'],
  ['bubbleInLine', 'bg'],
  ['bubbleMeLine', 'bg'],
];

const STATUS_PAIRS = [
  ['ok', 'warn'],
  ['ok', 'danger'],
  ['warn', 'danger'],
] as const;

/** A project rule, not a standard: about 1 is the smallest difference people see. */
const MIN_STATUS_DISTANCE = 10;

const THEME_IDS = Object.keys(THEMES) as ThemeId[];

const COMBINATIONS = STYLES.flatMap(style =>
  RESOLVED_MODES.flatMap(mode =>
    ACCENTS.flatMap(accent =>
      VISIONS.flatMap(vision =>
        CONTRASTS.map(contrast => ({ style, mode, accent, vision: vision as Vision, contrast: contrast as Contrast })),
      ),
    ),
  ),
);

/** Every pair below `minimum`, named with both colours and the ratio. */
function failures(tokens: ThemeTokens, pairs: readonly Pair[], minimum: number): string[] {
  return pairs.flatMap(([foreground, background]) => {
    const ratio = contrastRatio(tokens[foreground], tokens[background]);
    return ratio >= minimum
      ? []
      : [`${foreground} ${tokens[foreground]} on ${background} ${tokens[background]}: ${ratio.toFixed(2)}:1`];
  });
}

/** Every status pair closer than the rule under some colour vision deficiency, named. */
function closeStatuses(tokens: ThemeTokens): string[] {
  return STATUS_PAIRS.flatMap(([a, b]) =>
    DEFICIENCIES.flatMap(deficiency => {
      const distance = colorDistance(tokens[a], tokens[b], deficiency);
      return distance >= MIN_STATUS_DISTANCE ? [] : [`${a}/${b} under ${deficiency}: ΔE00 ${distance.toFixed(1)}`];
    }),
  );
}

describe('the layers', () => {
  it('make 64 combinations: 4 themes, 4 accents, 2 visions and 2 contrasts', () => {
    expect(VISIONS).toEqual(['standard', 'safe']);
    expect(CONTRASTS).toEqual(['standard', 'more']);
    expect(COMBINATIONS).toHaveLength(64);
  });

  it('hold #RRGGBB colours only', () => {
    const values = [
      ...THEME_IDS.flatMap(id => Object.values(MORE_CONTRAST[id])),
      ...RESOLVED_MODES.flatMap(mode => Object.values(MORE_CONTRAST_ACCENTS[mode]).flatMap(Object.values)),
      ...RESOLVED_MODES.flatMap(mode => CONTRASTS.flatMap(contrast => Object.values(SAFE_STATUS[mode][contrast]))),
    ];
    expect(values.length).toBeGreaterThan(50);
    expect(values.filter(value => !isHexColor(value))).toEqual([]);
  });

  it('leave everything alone by default', () => {
    expect(STANDARD_A11Y).toEqual({ vision: 'standard', contrast: 'standard', scanLines: true });
  });
});

describe.each(COMBINATIONS)('$style $mode with $accent, $vision vision, $contrast contrast', combination => {
  const { style, mode, accent, vision, contrast } = combination;
  const tokens = resolveTokens(style, mode, accent, { vision, contrast });
  const text = contrast === 'more' ? 7 : 4.5;

  it(`text reaches ${text}:1`, () => {
    expect(failures(tokens, [...TEXT_PAIRS, ...NEW_TEXT_PAIRS], text)).toEqual([]);
  });

  if (vision === 'safe') {
    it(`"verified", written in ok, reaches ${text}:1`, () => {
      expect(failures(tokens, SAFE_TEXT_PAIRS, text)).toEqual([]);
    });
  }

  it('indicators and control states reach 3:1', () => {
    expect(failures(tokens, NON_TEXT_PAIRS, 3)).toEqual([]);
  });

  it('text field boundaries reach 3:1, or 4.5:1 with more contrast', () => {
    expect(failures(tokens, field('danger'), 3)).toEqual([]);
    expect(failures(tokens, field('controlLine'), contrast === 'more' ? 4.5 : 3)).toEqual([]);
  });

  if (contrast === 'more') {
    it('separators and bubble borders reach 3:1', () => {
      expect(failures(tokens, MORE_LINE_PAIRS, 3)).toEqual([]);
    });
  }

  if (vision === 'safe') {
    it(`ok, warn and danger stay ΔE00 ${MIN_STATUS_DISTANCE} apart under every deficiency`, () => {
      expect(closeStatuses(tokens)).toEqual([]);
    });
  }
});

describe('what each layer changes', () => {
  /** What no layer touches (§4.1): the backgrounds, the ink on them, the soft tones and the style. */
  const FIXED: readonly (keyof ThemeTokens)[] = [
    'bg',
    'side',
    'surface',
    'raised',
    'ink',
    'accentInk',
    'accentSoft',
    'bubbleIn',
    'bubbleInInk',
    'bubbleMeInk',
    'warnBg',
    'dangerBg',
    'font',
    'display',
    'mono',
    'radius',
    'radiusLg',
    'bubbleRadius',
    'avatarRadius',
    'labelFont',
    'labelTransform',
    'labelSpacing',
    'wordmark',
    'shadow',
    'qrInk',
    'qrPaper',
  ];

  it.each(COMBINATIONS)(
    'keeps the backgrounds, the ink, the soft tones and the style of $style $mode $accent ($vision, $contrast)',
    ({ style, mode, accent, vision, contrast }) => {
      const plain = resolveTokens(style, mode, accent);
      const layered = resolveTokens(style, mode, accent, { vision, contrast });
      expect(FIXED.filter(token => layered[token] !== plain[token])).toEqual([]);
    },
  );

  it('the vision layer changes ok, warn and danger only, never the accent', () => {
    for (const { style, mode, accent, contrast } of COMBINATIONS) {
      const standard = resolveTokens(style, mode, accent, { vision: 'standard', contrast });
      const safe = resolveTokens(style, mode, accent, { vision: 'safe', contrast });
      const changed = (Object.keys(standard) as (keyof ThemeTokens)[]).filter(key => safe[key] !== standard[key]);
      expect(changed.filter(key => !['ok', 'warn', 'danger'].includes(key))).toEqual([]);
      expect(safe).toMatchObject(SAFE_STATUS[mode][contrast]);
    }
  });

  it('three arguments give exactly the standard layers', () => {
    for (const style of STYLES) {
      for (const mode of RESOLVED_MODES) {
        for (const accent of ACCENTS) {
          expect(resolveTokens(style, mode, accent)).toEqual(resolveTokens(style, mode, accent, STANDARD_A11Y));
          expect(resolveTokens(style, mode, accent)).toEqual(
            resolveTokens(style, mode, accent, { vision: 'standard', contrast: 'standard' }),
          );
        }
      }
    }
  });

  it('more contrast draws a border around every bubble', () => {
    for (const style of STYLES) {
      for (const mode of RESOLVED_MODES) {
        for (const accent of ACCENTS) {
          const tokens = resolveTokens(style, mode, accent, { vision: 'standard', contrast: 'more' });
          expect(tokens.bubbleInLine).toBe(tokens.controlLine);
          // Terminal light's own bubble is the accent's fill: its border is that fill.
          const ownLine = style === 'terminal' && mode === 'light' && accent === 'verde' ? tokens.bubbleMe : tokens.accentText;
          expect(tokens.bubbleMeLine).toBe(ownLine);
        }
      }
    }
  });

  it('returns a copy, so callers cannot change the layers', () => {
    const tokens = resolveTokens('calma', 'light', 'verde', { vision: 'safe', contrast: 'more' });
    tokens.ok = '#000000';
    tokens.muted = '#000000';
    expect(SAFE_STATUS.light.more.ok).toBe('#015180');
    expect(MORE_CONTRAST['calma-light'].muted).toBe('#44504A');
  });
});

describe('the scan lines of Terminal dark', () => {
  it('stay with the standard contrast while their switch is on', () => {
    const scan = THEMES['terminal-dark'].scan;
    expect(scan).not.toBe('none');
    for (const accent of ACCENTS) {
      for (const vision of VISIONS) {
        expect(resolveTokens('terminal', 'dark', accent, { vision, contrast: 'standard', scanLines: true }).scan).toBe(scan);
        expect(resolveTokens('terminal', 'dark', accent, { vision, contrast: 'standard' }).scan).toBe(scan);
      }
    }
  });

  it('go with their switch off, in all 64 combinations', () => {
    for (const { style, mode, accent, vision, contrast } of COMBINATIONS) {
      expect(resolveTokens(style, mode, accent, { vision, contrast, scanLines: false }).scan).toBe('none');
    }
  });

  it('go with more contrast, whatever the switch says', () => {
    for (const accent of ACCENTS) {
      expect(resolveTokens('terminal', 'dark', accent, { vision: 'standard', contrast: 'more', scanLines: true }).scan).toBe(
        'none',
      );
    }
  });
});

describe('pairs measured but not required', () => {
  // Your bubble in Terminal light is the accent's own fill, so accent-coloured
  // text on it vanishes. W3 writes everything inside your bubble in
  // bubbleMeInk or bubbleMeMuted instead (§3.2); this pins why.
  it('accentText on bubbleMe is left out on purpose: 1:1 in Terminal light', () => {
    const tokens = resolveTokens('terminal', 'light', 'verde');
    expect(contrastRatio(tokens.accentText, tokens.bubbleMe)).toBeLessThan(1.1);
  });

  // The accent is each person's choice, so a primary button next to an
  // error is told apart by shape (outlined danger, dangerSolid with an
  // icon) and words. Reported, not required.
  it('reports how close the accent comes to warn and danger under each deficiency', () => {
    const report = COMBINATIONS.filter(({ vision }) => vision === 'safe').flatMap(({ style, mode, accent, contrast }) => {
      const tokens = resolveTokens(style, mode, accent, { vision: 'safe', contrast });
      return (['warn', 'danger'] as const).flatMap(status =>
        DEFICIENCIES.map(deficiency => ({
          distance: colorDistance(tokens.accent, tokens[status], deficiency),
          what: `accent/${status} ${style}-${mode} ${accent} ${contrast} ${deficiency}`,
        })),
      );
    });
    const closest = [...report].sort((a, b) => a.distance - b.distance).slice(0, 3);
    console.info(
      'Closest accent/status pairs with the safe colours:',
      closest.map(({ distance, what }) => `${what}: ΔE00 ${distance.toFixed(1)}`).join('; '),
    );
    expect(report.every(({ distance }) => Number.isFinite(distance))).toBe(true);
  });
});
