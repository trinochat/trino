/**
 * Appearance engine of the redesign: the style, mode and accent the user chose,
 * how they are stored, and the tokens and CSS variables they produce. Pure:
 * storage is passed in, and the DOM side lives in `apply.ts`.
 */
import { hueAndChroma, isHexColor } from './color';
import {
  ACCENTS,
  ACCENT_PALETTES,
  STYLES,
  THEMES,
  type Accent,
  type ResolvedMode,
  type Style,
  type ThemeTokens,
} from './tokens';

export type { Accent, ResolvedMode, Style } from './tokens';

export const MODES = ['light', 'dark', 'system'] as const;
export type Mode = (typeof MODES)[number];

export interface Appearance {
  style: Style;
  mode: Mode;
  accent: Accent;
}

/** The part of `Storage` the engine uses; `window.localStorage` fits. */
export type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const APPEARANCE_STORAGE_KEY = 'trino.appearance';
/** Written by the legacy theme (`src/lib/theme.ts`); read to migrate. */
export const LEGACY_THEME_STORAGE_KEY = 'appearance.theme';

/** The user's choice for a fresh install: Calma, light, verde. */
export const DEFAULT_APPEARANCE: Readonly<Appearance> = Object.freeze({
  style: 'calma',
  mode: 'light',
  accent: 'verde',
});

export function resolveMode(mode: Mode, prefersDark: boolean): ResolvedMode {
  if (mode === 'system') return prefersDark ? 'dark' : 'light';
  return mode;
}

/** The tokens of a style and mode with an accent, as a new object. */
export function resolveTokens(style: Style, mode: ResolvedMode, accent: Accent): ThemeTokens {
  const theme = THEMES[`${style}-${mode}`];
  if (accent === 'verde') return { ...theme };
  const palette = ACCENT_PALETTES[mode][accent];
  return {
    ...theme,
    ...palette,
    // Calma draws no border around your bubbles; Terminal does.
    bubbleMeLine: style === 'calma' ? palette.bubbleMe : palette.bubbleMeLine,
  };
}

/** Tokens that are content, not style, so they get no CSS variable. */
const CONTENT_TOKENS: ReadonlySet<keyof ThemeTokens> = new Set<keyof ThemeTokens>(['wordmark']);

/** `bubbleMeMuted` → `--t-bubble-me-muted`. */
function cssVariableName(token: keyof ThemeTokens): string {
  return `--t-${token.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
}

export function cssVariables(tokens: ThemeTokens): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of Object.keys(tokens) as (keyof ThemeTokens)[]) {
    if (!CONTENT_TOKENS.has(token)) variables[cssVariableName(token)] = tokens[token];
  }
  return variables;
}

/**
 * The stored appearance, field by field: a missing or invalid field takes its
 * default. Until the new key exists, the legacy theme is migrated on every
 * read; nothing is written here.
 */
export function loadAppearance(storage: AppearanceStorage): Appearance {
  const stored = read(storage, APPEARANCE_STORAGE_KEY);
  if (stored !== null) return normalize(parseJson(stored));
  const legacy = read(storage, LEGACY_THEME_STORAGE_KEY);
  if (legacy !== null) return migrateLegacyTheme(parseJson(legacy));
  return { ...DEFAULT_APPEARANCE };
}

/** Stores the appearance; returns false if storage refused it. */
export function saveAppearance(storage: AppearanceStorage, value: Appearance): boolean {
  const { style, mode, accent } = normalize(value);
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ style, mode, accent }));
    return true;
  } catch {
    return false;
  }
}

function read(storage: AppearanceStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function normalize(value: unknown): Appearance {
  const fields = fieldsOf(value);
  return {
    style: isOneOf(STYLES, fields.style) ? fields.style : DEFAULT_APPEARANCE.style,
    mode: isOneOf(MODES, fields.mode) ? fields.mode : DEFAULT_APPEARANCE.mode,
    accent: isOneOf(ACCENTS, fields.accent) ? fields.accent : DEFAULT_APPEARANCE.accent,
  };
}

/**
 * Legacy presets (`src/lib/theme.ts`, `App.css`): `trino` was the dark terminal
 * look, `corporate` a light sans theme and `simple` a dark sans theme.
 */
const LEGACY_PRESETS = new Map<string, Pick<Appearance, 'style' | 'mode'>>([
  ['trino', { style: 'terminal', mode: 'dark' }],
  ['corporate', { style: 'calma', mode: 'light' }],
  ['simple', { style: 'calma', mode: 'dark' }],
]);

function migrateLegacyTheme(value: unknown): Appearance {
  const fields = fieldsOf(value);
  const preset = typeof fields.preset === 'string' ? LEGACY_PRESETS.get(fields.preset) : undefined;
  return {
    style: preset?.style ?? DEFAULT_APPEARANCE.style,
    mode: preset?.mode ?? DEFAULT_APPEARANCE.mode,
    accent: nearestAccent(fields.accent),
  };
}

/** Below this chroma a colour reads as grey and has no useful hue. */
const MIN_CHROMA = 0.1;

const ACCENT_HUES = ACCENTS.map(accent => {
  const button = accent === 'verde' ? THEMES['calma-light'].accent : ACCENT_PALETTES.light[accent].accent;
  return [accent, hueAndChroma(button).hue] as const;
});

/** The accent nearest in hue to a legacy colour; greys and non-colours get verde. */
function nearestAccent(color: unknown): Accent {
  if (!isHexColor(color)) return DEFAULT_APPEARANCE.accent;
  const { hue, chroma } = hueAndChroma(color);
  if (chroma < MIN_CHROMA) return DEFAULT_APPEARANCE.accent;
  let nearest: Accent = DEFAULT_APPEARANCE.accent;
  let shortest = Infinity;
  for (const [accent, accentHue] of ACCENT_HUES) {
    const gap = Math.abs(hue - accentHue);
    const distance = Math.min(gap, 360 - gap);
    if (distance < shortest) {
      nearest = accent;
      shortest = distance;
    }
  }
  return nearest;
}
