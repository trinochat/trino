import { describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_THEME_STORAGE_KEY,
  MODES,
  cssVariables,
  loadAppearance,
  resolveMode,
  resolveTokens,
  saveAppearance,
  type Appearance,
} from './appearance';
import {
  ACCENTS,
  ACCENT_PALETTES,
  RESOLVED_MODES,
  STYLES,
  THEMES,
  type AccentPalette,
  type AlternativeAccent,
  type ThemeTokens,
} from './tokens';

// The approved prototype's tokens, copied verbatim from the R0 canvas. tokens.ts
// must not drift from them: change both on purpose, or neither.
const PROTOTYPE = {
  'calma-light': { bg: '#F5F7F6', side: '#FFFFFF', surface: '#FFFFFF', raised: '#EEF2F0', line: '#DDE3E0', ink: '#111815', muted: '#56635C', accent: '#0F7B4A', accentInk: '#FFFFFF', accentText: '#0F7B4A', accentSoft: '#E3F2EA', ok: '#0F7B4A', warn: '#8A5A00', warnBg: '#FFF4DB', danger: '#B3261E', dangerBg: '#FDECEA', badge: '#0F7B4A', badgeInk: '#FFFFFF', avatarBg: '#DDF0E5', avatarFg: '#0B5E38', bubbleIn: '#EEF2F0', bubbleInInk: '#111815', bubbleInLine: '#EEF2F0', bubbleMe: '#DDF0E5', bubbleMeInk: '#111815', bubbleMeMuted: '#3F5A4B', bubbleMeLine: '#DDF0E5', outer: '#E7ECE9', font: "'Atkinson Hyperlegible Next', system-ui, sans-serif", display: "'Atkinson Hyperlegible Next', system-ui, sans-serif", mono: "'Atkinson Hyperlegible Mono', ui-monospace, monospace", radius: '10px', radiusLg: '14px', bubbleRadius: '16px', avatarRadius: '999px', scan: 'none', labelFont: "'Atkinson Hyperlegible Next', system-ui, sans-serif", labelTransform: 'none', labelSpacing: '0', wordmark: 'Trino', shadow: '0 1px 2px rgba(17,24,21,0.06), 0 8px 24px rgba(17,24,21,0.06)' },
  'calma-dark': { bg: '#0F1311', side: '#131815', surface: '#161B18', raised: '#1E2521', line: '#28302B', ink: '#E6ECE8', muted: '#9AA8A0', accent: '#3FD68A', accentInk: '#04170C', accentText: '#3FD68A', accentSoft: '#183526', ok: '#3FD68A', warn: '#F2B45A', warnBg: '#2C2416', danger: '#FF8A8A', dangerBg: '#3A1E1E', badge: '#3FD68A', badgeInk: '#04170C', avatarBg: '#1F3B2C', avatarFg: '#BFF0D4', bubbleIn: '#1E2521', bubbleInInk: '#E6ECE8', bubbleInLine: '#1E2521', bubbleMe: '#1F3B2C', bubbleMeInk: '#E6F5EC', bubbleMeMuted: '#A8C9B6', bubbleMeLine: '#1F3B2C', outer: '#0A0D0B', font: "'Atkinson Hyperlegible Next', system-ui, sans-serif", display: "'Atkinson Hyperlegible Next', system-ui, sans-serif", mono: "'Atkinson Hyperlegible Mono', ui-monospace, monospace", radius: '10px', radiusLg: '14px', bubbleRadius: '16px', avatarRadius: '999px', scan: 'none', labelFont: "'Atkinson Hyperlegible Next', system-ui, sans-serif", labelTransform: 'none', labelSpacing: '0', wordmark: 'Trino', shadow: '0 8px 24px rgba(0,0,0,0.35)' },
  'terminal-dark': { bg: '#0A0E0C', side: '#0E1411', surface: '#101613', raised: '#18221C', line: '#24302A', ink: '#D7E3DC', muted: '#93A69B', accent: '#22FF66', accentInk: '#03140A', accentText: '#22FF66', accentSoft: '#0F2A1A', ok: '#22FF66', warn: '#FFB547', warnBg: '#2A2110', danger: '#FF6B78', dangerBg: '#2C1216', badge: '#22FF66', badgeInk: '#03140A', avatarBg: '#18221C', avatarFg: '#22FF66', bubbleIn: '#151D19', bubbleInInk: '#D7E3DC', bubbleInLine: '#24302A', bubbleMe: '#0F2A1A', bubbleMeInk: '#DFFBE8', bubbleMeMuted: '#9CC9AE', bubbleMeLine: '#1E4A30', outer: '#060908', font: "'IBM Plex Sans', system-ui, sans-serif", display: "'JetBrains Mono', ui-monospace, monospace", mono: "'JetBrains Mono', ui-monospace, monospace", radius: '4px', radiusLg: '6px', bubbleRadius: '4px', avatarRadius: '4px', scan: 'repeating-linear-gradient(0deg, rgba(34,255,102,0.025) 0px, rgba(34,255,102,0.025) 1px, transparent 1px, transparent 4px)', labelFont: "'JetBrains Mono', ui-monospace, monospace", labelTransform: 'uppercase', labelSpacing: '0.08em', wordmark: 'trino', shadow: 'none' },
  'terminal-light': { bg: '#F2F4EF', side: '#E9ECE5', surface: '#FFFFFF', raised: '#E9EDE5', line: '#D3D9CF', ink: '#121A15', muted: '#4E5B53', accent: '#08743A', accentInk: '#FFFFFF', accentText: '#08743A', accentSoft: '#E1F0E6', ok: '#08743A', warn: '#8A5A00', warnBg: '#FFF4DB', danger: '#B3261E', dangerBg: '#FBE9E8', badge: '#08743A', badgeInk: '#FFFFFF', avatarBg: '#DDE5DA', avatarFg: '#08743A', bubbleIn: '#EEF1EA', bubbleInInk: '#121A15', bubbleInLine: '#D3D9CF', bubbleMe: '#08743A', bubbleMeInk: '#FFFFFF', bubbleMeMuted: '#D2F2DF', bubbleMeLine: '#08743A', outer: '#DDE2DA', font: "'IBM Plex Sans', system-ui, sans-serif", display: "'JetBrains Mono', ui-monospace, monospace", mono: "'JetBrains Mono', ui-monospace, monospace", radius: '4px', radiusLg: '6px', bubbleRadius: '4px', avatarRadius: '4px', scan: 'none', labelFont: "'JetBrains Mono', ui-monospace, monospace", labelTransform: 'uppercase', labelSpacing: '0.08em', wordmark: 'trino', shadow: 'none' },
};

// Tokens added after the prototype was approved, each for a need the canvas did
// not cover. Pinned here too, and never a replacement for a prototype value.
const ADDED_AFTER_PROTOTYPE: Record<keyof typeof PROTOTYPE, Partial<ThemeTokens>> = {
  // controlLine: the boundary of the text fields, 3:1 on every background
  // (WCAG 1.4.11), where the prototype's `line` gave about 1.2:1.
  'calma-light': { controlLine: '#818B86' },
  'calma-dark': { controlLine: '#66726B' },
  'terminal-dark': { controlLine: '#607067' },
  'terminal-light': { controlLine: '#7D877F' },
};

const ALTERNATIVES = ACCENTS.filter((accent): accent is AlternativeAccent => accent !== 'verde');
const PALETTE_KEYS = Object.keys(ACCENT_PALETTES.light.azul) as (keyof AccentPalette)[];

function memoryStorage(entries: Record<string, string> = {}) {
  const data = new Map(Object.entries(entries));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
  };
}

function withLegacyTheme(preset: unknown, accent: unknown = '#22ff66') {
  return memoryStorage({ [LEGACY_THEME_STORAGE_KEY]: JSON.stringify({ preset, accent }) });
}

describe('default appearance', () => {
  it('is Calma, light and verde', () => {
    expect(DEFAULT_APPEARANCE).toEqual({ style: 'calma', mode: 'light', accent: 'verde' });
  });

  it('applies when nothing is stored', () => {
    expect(loadAppearance(memoryStorage())).toEqual(DEFAULT_APPEARANCE);
  });
});

describe('loadAppearance', () => {
  it('stores under trino.appearance', () => {
    expect(APPEARANCE_STORAGE_KEY).toBe('trino.appearance');
  });

  it('reads a stored appearance', () => {
    const stored = { style: 'terminal', mode: 'system', accent: 'morado' };
    const storage = memoryStorage({ [APPEARANCE_STORAGE_KEY]: JSON.stringify(stored) });
    expect(loadAppearance(storage)).toEqual(stored);
  });

  it.each([
    ['not JSON', '{style:'],
    ['null', 'null'],
    ['a string', '"terminal"'],
    ['a number', '42'],
    ['an array', '["terminal","dark","azul"]'],
    ['an empty object', '{}'],
  ])('falls back to the defaults when the stored value is %s', (_label, raw) => {
    expect(loadAppearance(memoryStorage({ [APPEARANCE_STORAGE_KEY]: raw }))).toEqual(DEFAULT_APPEARANCE);
  });

  it('replaces only the fields that are invalid', () => {
    const raw = JSON.stringify({ style: 'terminal', mode: 'neon', accent: 42 });
    expect(loadAppearance(memoryStorage({ [APPEARANCE_STORAGE_KEY]: raw }))).toEqual({
      style: 'terminal',
      mode: 'light',
      accent: 'verde',
    });
  });

  it('falls back to the defaults when storage throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    expect(loadAppearance(storage)).toEqual(DEFAULT_APPEARANCE);
  });

  it('returns a fresh object, never the shared default', () => {
    const appearance = loadAppearance(memoryStorage());
    appearance.style = 'terminal';
    expect(DEFAULT_APPEARANCE.style).toBe('calma');
  });

  it('never writes to storage', () => {
    const storage = withLegacyTheme('trino');
    loadAppearance(storage);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('migration from the legacy theme', () => {
  it('reads the key that lib/theme.ts writes', () => {
    expect(LEGACY_THEME_STORAGE_KEY).toBe('appearance.theme');
  });

  it.each([
    ['trino', 'terminal', 'dark'],
    ['corporate', 'calma', 'light'],
    // "simple" was a dark theme with a sans font: keep the user in dark.
    ['simple', 'calma', 'dark'],
  ])('maps the %s preset to %s %s', (preset, style, mode) => {
    expect(loadAppearance(withLegacyTheme(preset))).toEqual({ style, mode, accent: 'verde' });
  });

  it.each([
    ['#22ff66', 'verde'], // the old default green
    ['#55a7f1', 'azul'],
    ['#f0be55', 'naranja'], // amber: the nearest warm accent
    ['#e56c78', 'naranja'], // coral red: the nearest warm accent
    ['#aa8be8', 'morado'],
    ['#9baa9f', 'verde'], // grey-green: too little colour to pick a hue
    ['#3366FF', 'azul'], // custom colours, in any case
    ['#FF00FF', 'morado'],
    ['#808080', 'verde'],
  ])('maps the accent %s to %s', (accent, expected) => {
    expect(loadAppearance(withLegacyTheme('corporate', accent)).accent).toBe(expected);
  });

  it.each([['green'], [7], [null], ['#22ff6']])('maps the invalid accent %s to verde', accent => {
    expect(loadAppearance(withLegacyTheme('trino', accent)).accent).toBe('verde');
  });

  it.each([['neon'], ['toString'], ['__proto__'], [null]])(
    'keeps the default style and mode for the unknown preset %s',
    preset => {
      expect(loadAppearance(withLegacyTheme(preset, '#55a7f1'))).toEqual({
        style: 'calma',
        mode: 'light',
        accent: 'azul',
      });
    },
  );

  it('falls back to the defaults when the legacy value is not JSON', () => {
    expect(loadAppearance(memoryStorage({ [LEGACY_THEME_STORAGE_KEY]: 'oops' }))).toEqual(DEFAULT_APPEARANCE);
  });

  it('is ignored once a new appearance is stored', () => {
    const storage = memoryStorage({
      [LEGACY_THEME_STORAGE_KEY]: JSON.stringify({ preset: 'trino', accent: '#55a7f1' }),
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({ style: 'calma', mode: 'system', accent: 'naranja' }),
    });
    expect(loadAppearance(storage)).toEqual({ style: 'calma', mode: 'system', accent: 'naranja' });
  });
});

describe('saveAppearance', () => {
  it('writes the three fields as JSON under trino.appearance', () => {
    const storage = memoryStorage();
    expect(saveAppearance(storage, { style: 'terminal', mode: 'dark', accent: 'azul' })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      APPEARANCE_STORAGE_KEY,
      '{"style":"terminal","mode":"dark","accent":"azul"}',
    );
  });

  it('round-trips every combination through loadAppearance', () => {
    for (const style of STYLES) {
      for (const mode of MODES) {
        for (const accent of ACCENTS) {
          const storage = memoryStorage();
          saveAppearance(storage, { style, mode, accent });
          expect(loadAppearance(storage)).toEqual({ style, mode, accent });
        }
      }
    }
  });

  it('drops fields that are not part of the appearance', () => {
    const storage = memoryStorage();
    const value = { style: 'calma', mode: 'light', accent: 'verde', extra: 1 } as Appearance;
    saveAppearance(storage, value);
    expect(JSON.parse(storage.data.get(APPEARANCE_STORAGE_KEY) ?? '')).toEqual(DEFAULT_APPEARANCE);
  });

  it('reports failure instead of throwing when storage is full', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(saveAppearance(storage, DEFAULT_APPEARANCE)).toBe(false);
  });
});

describe('resolveMode', () => {
  it('follows the system preference for system', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
  });

  it('keeps an explicit mode whatever the system prefers', () => {
    for (const prefersDark of [true, false]) {
      expect(resolveMode('light', prefersDark)).toBe('light');
      expect(resolveMode('dark', prefersDark)).toBe('dark');
    }
  });
});

describe('resolveTokens', () => {
  for (const style of STYLES) {
    for (const mode of RESOLVED_MODES) {
      it(`${style} ${mode} with verde is the prototype's theme, unchanged, plus the tokens added since`, () => {
        const id = `${style}-${mode}` as const;
        const added = Object.keys(ADDED_AFTER_PROTOTYPE[id]);
        expect(added.filter(token => token in PROTOTYPE[id])).toEqual([]);
        expect(resolveTokens(style, mode, 'verde')).toEqual({ ...PROTOTYPE[id], ...ADDED_AFTER_PROTOTYPE[id] });
      });

      // The friend's report: the chosen accent never reached the message bubbles.
      for (const accent of ALTERNATIVES) {
        it(`${accent} recolours the accent and your bubbles in ${style} ${mode}`, () => {
          const palette = ACCENT_PALETTES[mode][accent];
          const tokens = resolveTokens(style, mode, accent);
          expect(tokens.accent).toBe(palette.accent);
          expect(tokens.bubbleMe).toBe(palette.bubbleMe);
          expect(tokens.bubbleMeInk).toBe(palette.bubbleMeInk);
          expect(tokens.bubbleMe).not.toBe(THEMES[`${style}-${mode}`].bubbleMe);
        });
      }
    }
  }

  it('changes only accent tokens, never ok, warn or danger', () => {
    for (const style of STYLES) {
      for (const mode of RESOLVED_MODES) {
        const base = THEMES[`${style}-${mode}`];
        for (const accent of ALTERNATIVES) {
          const tokens = resolveTokens(style, mode, accent);
          const changed = (Object.keys(base) as (keyof ThemeTokens)[]).filter(key => tokens[key] !== base[key]);
          expect(changed.filter(key => !(PALETTE_KEYS as string[]).includes(key))).toEqual([]);
          for (const key of ['ok', 'warn', 'warnBg', 'danger', 'dangerBg'] as const) {
            expect(tokens[key]).toBe(base[key]);
          }
        }
      }
    }
  });

  it('draws the border of your bubbles the way each default theme does', () => {
    for (const accent of ALTERNATIVES) {
      for (const mode of RESOLVED_MODES) {
        const calma = resolveTokens('calma', mode, accent);
        expect(calma.bubbleMeLine).toBe(calma.bubbleMe);
      }
      const terminalLight = resolveTokens('terminal', 'light', accent);
      expect(terminalLight.bubbleMeLine).toBe(terminalLight.accent);
      const terminalDark = resolveTokens('terminal', 'dark', accent);
      expect(terminalDark.bubbleMeLine).toBe(ACCENT_PALETTES.dark[accent].bubbleMeLine);
      expect(terminalDark.bubbleMeLine).not.toBe(terminalDark.bubbleMe);
    }
  });

  it('returns a copy, so callers cannot change the themes', () => {
    const tokens = resolveTokens('calma', 'light', 'verde');
    tokens.accent = '#000000';
    expect(THEMES['calma-light'].accent).toBe('#0F7B4A');
  });
});

describe('cssVariables', () => {
  const tokens = () => resolveTokens('calma', 'light', 'verde');

  it('names each token --t-<kebab-case>', () => {
    const vars = cssVariables(tokens());
    expect(vars['--t-bg']).toBe('#F5F7F6');
    expect(vars['--t-accent']).toBe('#0F7B4A');
    expect(vars['--t-accent-ink']).toBe('#FFFFFF');
    expect(vars['--t-bubble-me-muted']).toBe('#3F5A4B');
    expect(vars['--t-control-line']).toBe('#818B86');
    expect(vars['--t-radius-lg']).toBe('14px');
    expect(vars['--t-label-font']).toBe("'Atkinson Hyperlegible Next', system-ui, sans-serif");
  });

  it('emits every style token and leaves out the wordmark text', () => {
    const vars = cssVariables(tokens());
    const names = Object.keys(vars);
    expect(names).toHaveLength(Object.keys(tokens()).length - 1);
    expect(names.filter(name => !/^--t-[a-z]+(-[a-z]+)*$/.test(name))).toEqual([]);
    expect(vars).not.toHaveProperty('--t-wordmark');
  });

  it('carries an alternative accent into the bubble variables', () => {
    const verde = cssVariables(tokens());
    const azul = cssVariables(resolveTokens('calma', 'light', 'azul'));
    expect(azul['--t-accent']).toBe('#1F5FBF');
    expect(azul['--t-bubble-me']).toBe('#DCE8FA');
    expect(azul['--t-danger']).toBe(verde['--t-danger']);
  });
});
