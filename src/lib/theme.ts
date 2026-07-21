export type ThemePreset = 'trino' | 'corporate' | 'simple';

export interface ThemePreference {
  preset: ThemePreset;
  accent: string;
}

export const DEFAULT_THEME: ThemePreference = {
  preset: 'trino',
  accent: '#22ff66',
};

export const ACCENT_OPTIONS = [
  '#22ff66',
  '#55a7f1',
  '#f0be55',
  '#e56c78',
  '#aa8be8',
  '#9baa9f',
] as const;

const THEME_STORAGE_KEY = 'appearance.theme';
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function loadThemePreference(): ThemePreference {
  try {
    const value = JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) || '{}') as Partial<ThemePreference>;
    const preset = isThemePreset(value.preset) ? value.preset : DEFAULT_THEME.preset;
    const accent = typeof value.accent === 'string' && HEX_COLOR.test(value.accent)
      ? value.accent.toLowerCase()
      : DEFAULT_THEME.accent;
    return { preset, accent };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveThemePreference(preference: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(preference));
  applyThemePreference(preference);
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  root.dataset.theme = preference.preset;
  const accent = parseHex(preference.accent);
  const bright = mix(accent, { r: 255, g: 255, b: 255 }, 0.34);
  const dim = mix(accent, preference.preset === 'corporate'
    ? { r: 25, g: 37, b: 29 }
    : { r: 138, g: 154, b: 144 }, 0.52);
  root.style.setProperty('--color-accent', rgbValue(accent));
  root.style.setProperty('--color-accent-bright', rgbValue(bright));
  root.style.setProperty('--color-accent-dim', rgbValue(dim));
}

function isThemePreset(value: unknown): value is ThemePreset {
  return value === 'trino' || value === 'corporate' || value === 'simple';
}

function parseHex(hex: string): { r: number; g: number; b: number } {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function mix(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  amount: number,
): { r: number; g: number; b: number } {
  return {
    r: Math.round(a.r + (b.r - a.r) * amount),
    g: Math.round(a.g + (b.g - a.g) * amount),
    b: Math.round(a.b + (b.b - a.b) * amount),
  };
}

function rgbValue(color: { r: number; g: number; b: number }): string {
  return `${color.r} ${color.g} ${color.b}`;
}
