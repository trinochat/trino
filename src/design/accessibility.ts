/**
 * The accessibility settings (accesibilidad.md §2): text size, colours for
 * colour blindness, more contrast, reduced motion and wide spacing. They are
 * stored on this device under their own key, in clear like the appearance
 * (they are not secrets), and apply before unlocking: whoever needs large text
 * needs it on the unlock screen too. Pure, like appearance.ts: storage and
 * the system signals are passed in, and the DOM side lives in `apply.ts`.
 *
 * Each setting except the colours and the spacing can follow the system, and
 * does by default; `resolveAccessibility` turns the settings and what the
 * system says into the values in effect.
 */
import { CONTRASTS, VISIONS, type Contrast, type Vision } from './a11y-tokens';
import type { AppearanceStorage } from './appearance';

export { CONTRASTS, VISIONS, type Contrast, type Vision };

/**
 * The steps of the text size, as a factor of the 16 px root. Nothing below
 * 100 %: 12 px text would drop under the 12 px floor of the type scale.
 * Nothing above 200 %, which is what WCAG 1.4.4 asks; beyond it there is the
 * system's magnifier.
 */
export const TEXT_SCALES = [1, 1.1, 1.25, 1.5, 1.75, 2] as const;
export type TextScale = (typeof TEXT_SCALES)[number];

export const MOTIONS = ['reduce', 'full'] as const;
export type Motion = (typeof MOTIONS)[number];

export const SPACINGS = ['standard', 'wide'] as const;
export type Spacing = (typeof SPACINGS)[number];

/** What the person chose; `system` follows the system's own setting. */
export interface Accessibility {
  textScale: 'system' | TextScale;
  vision: Vision;
  contrast: 'system' | Contrast;
  motion: 'system' | Motion;
  spacing: Spacing;
}

/** Follow the system, and change nothing else. */
export const DEFAULT_ACCESSIBILITY: Readonly<Accessibility> = Object.freeze({
  textScale: 'system',
  vision: 'standard',
  contrast: 'system',
  motion: 'system',
  spacing: 'standard',
});

/** What the system says; injected in the tests. */
export interface SystemSignals {
  /** The system's text size as a factor, such as 1.25 for Windows at 125 %. */
  textScale: number;
  /** `prefers-contrast: more`. */
  moreContrast: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** `forced-colors: active`: a contrast theme of Windows draws the colours. */
  forcedColors: boolean;
}

/** The values in effect, once `system` is replaced with what the system says. */
export interface EffectiveAccessibility {
  textScale: number;
  vision: Vision;
  contrast: Contrast;
  motion: Motion;
  spacing: Spacing;
}

export const ACCESSIBILITY_STORAGE_KEY = 'trino.accessibility';
/**
 * The last text size read from the system. Reading it takes a moment (a Tauri
 * command, `system_text_scale`), so the first paint uses this one and the
 * page is corrected if it changed.
 */
export const SYSTEM_TEXT_SCALE_STORAGE_KEY = 'trino.accessibility.systemTextScale';
/** Where E0 kept the text size (`'normal' | 'large'`); read to migrate. */
export const LEGACY_TEXT_SIZE_STORAGE_KEY = 'trino.pref.textSize';

const MIN_TEXT_SCALE = TEXT_SCALES[0];
const MAX_TEXT_SCALE = TEXT_SCALES[TEXT_SCALES.length - 1];

export function resolveAccessibility(settings: Accessibility, system: SystemSignals): EffectiveAccessibility {
  return {
    textScale: settings.textScale === 'system' ? systemTextScale(system.textScale) : settings.textScale,
    vision: settings.vision,
    contrast: settings.contrast === 'system' ? (system.moreContrast ? 'more' : 'standard') : settings.contrast,
    motion: settings.motion === 'system' ? (system.reducedMotion ? 'reduce' : 'full') : settings.motion,
    spacing: settings.spacing,
  };
}

/**
 * The system's factor between 100 and 200 %, as it is: Windows can say 135 %,
 * and that is what the person set, so it is not rounded to a step.
 */
function systemTextScale(factor: number): number {
  return Number.isFinite(factor) ? Math.min(MAX_TEXT_SCALE, Math.max(MIN_TEXT_SCALE, factor)) : MIN_TEXT_SCALE;
}

/**
 * The stored settings, field by field: a missing or invalid field takes its
 * default, and broken storage gives the defaults, so start-up never fails.
 * Until the key exists, E0's text size is migrated on every read; nothing is
 * written here.
 */
export function loadAccessibility(storage: AppearanceStorage): Accessibility {
  const stored = read(storage, ACCESSIBILITY_STORAGE_KEY);
  if (stored !== null) return normalize(parseJson(stored));
  const legacy = read(storage, LEGACY_TEXT_SIZE_STORAGE_KEY);
  return { ...DEFAULT_ACCESSIBILITY, textScale: legacy === 'large' ? 1.25 : 'system' };
}

/** Stores the settings; returns false if storage refused them. */
export function saveAccessibility(storage: AppearanceStorage, value: Accessibility): boolean {
  try {
    storage.setItem(ACCESSIBILITY_STORAGE_KEY, JSON.stringify(normalize(value)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The text size one step up or down from a factor, within 100 and 200 %:
 * Ctrl + `+` and Ctrl + `-`. From a factor between steps, such as Windows'
 * 135 %, it goes to the next step in that direction. Ctrl + 0 is no step: it
 * follows the system again (apply.ts).
 */
export function stepTextScale(current: number, step: 'up' | 'down'): TextScale {
  if (step === 'up') return TEXT_SCALES.find(scale => scale > current) ?? MAX_TEXT_SCALE;
  return [...TEXT_SCALES].reverse().find(scale => scale < current) ?? MIN_TEXT_SCALE;
}

/** The step nearest to a factor; the lower one when it falls halfway. */
export function nearestTextScale(factor: number): TextScale {
  return TEXT_SCALES.reduce<TextScale>(
    (nearest, step) => (Math.abs(step - factor) < Math.abs(nearest - factor) ? step : nearest),
    MIN_TEXT_SCALE,
  );
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

function isOneOf<T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (options as readonly string[]).includes(value);
}

function normalize(value: unknown): Accessibility {
  const fields: Record<string, unknown> =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const { textScale, vision, contrast, motion, spacing } = fields;
  return {
    textScale:
      typeof textScale === 'number' && Number.isFinite(textScale)
        ? nearestTextScale(textScale)
        : DEFAULT_ACCESSIBILITY.textScale,
    vision: isOneOf(VISIONS, vision) ? vision : DEFAULT_ACCESSIBILITY.vision,
    contrast: contrast === 'system' || isOneOf(CONTRASTS, contrast) ? contrast : DEFAULT_ACCESSIBILITY.contrast,
    motion: motion === 'system' || isOneOf(MOTIONS, motion) ? motion : DEFAULT_ACCESSIBILITY.motion,
    spacing: isOneOf(SPACINGS, spacing) ? spacing : DEFAULT_ACCESSIBILITY.spacing,
  };
}
