/**
 * Accessibility layers over the design tokens (accesibilidad.md §4): the safe
 * colours for colour vision deficiencies and the "more contrast" values. They
 * apply in a fixed order, theme → accent → vision → contrast, in
 * `resolveTokens` (appearance.ts); `a11y-tokens.test.ts` holds all 64
 * combinations (4 themes × 4 accents × 2 visions × 2 contrasts) to their
 * contrast levels and the safe colours to their distances.
 *
 * They live apart from tokens.ts on purpose: the mobile app's drift test reads
 * tokens.ts after `export const ACCENT_PALETTES` by its `light:` and `dark:`
 * blocks, and a second table with those keys there would quietly replace the
 * accent palettes it reads.
 *
 * What no layer changes: bg, side, surface, raised, ink, accentInk,
 * accentSoft, bubbleIn, bubbleInInk, bubbleMeInk, warnBg and dangerBg; the
 * fonts, radii, shadows, QR colours and wordmark. `scan` only ever turns to
 * `none`. The vision layer never touches the accent: it is each person's
 * choice.
 */
import type { AccentPalette, AlternativeAccent, ResolvedMode, ThemeId, ThemeTokens } from './tokens';

export const VISIONS = ['standard', 'safe'] as const;
/** `safe` swaps ok, warn and danger for the colours below; more choices could follow. */
export type Vision = (typeof VISIONS)[number];

export const CONTRASTS = ['standard', 'more'] as const;
export type Contrast = (typeof CONTRASTS)[number];

/** What `resolveTokens` takes on top of the style, mode and accent. */
export interface A11yLayers {
  vision: Vision;
  contrast: Contrast;
  /** Terminal dark's scan lines; on unless switched off (Appearance). */
  scanLines?: boolean;
}

/** No layer at all: what three arguments to `resolveTokens` give. */
export const STANDARD_A11Y: Readonly<Required<A11yLayers>> = Object.freeze({
  vision: 'standard',
  contrast: 'standard',
  scanLines: true,
});

export type StatusTokens = Pick<ThemeTokens, 'ok' | 'warn' | 'danger'>;

/**
 * Status colours told apart by people with protanopia, deuteranopia or
 * tritanopia (CIEDE2000 of 10 or more between any two): `ok` turns blue (from
 * Okabe-Ito's #0072B2), `warn` stays amber, as light as 4.5:1 allows, and
 * `danger` goes a much darker red (vermilion in dark mode). Shared by Calma
 * and Terminal, per mode and contrast. With them, "verified" is written in
 * `ok` instead of the accent.
 */
export const SAFE_STATUS: Readonly<Record<ResolvedMode, Readonly<Record<Contrast, Readonly<StatusTokens>>>>> = {
  light: {
    standard: { ok: '#026EAB', warn: '#8D6013', danger: '#93021E' },
    more: { ok: '#015180', warn: '#664804', danger: '#600110' },
  },
  dark: {
    standard: { ok: '#5CB6FA', warn: '#F0E442', danger: '#EF752C' },
    more: { ok: '#79C4FF', warn: '#F0E442', danger: '#FF965E' },
  },
};

/**
 * More contrast, per theme, only what changes: text at 7:1 (WCAG 1.4.6), the
 * fills that carry text darkened or lightened until their text reaches 7:1,
 * `line` at 3:1 on bg, surface and side, so separators show, and
 * `controlLine` at 4.5:1. Each keeps its hue and chroma (OKLCH); only the
 * lightness moves, as little as it must. A missing token already passes.
 */
export const MORE_CONTRAST: Readonly<Record<ThemeId, Readonly<Partial<ThemeTokens>>>> = {
  'calma-light': {
    muted: '#44504A',
    line: '#8A8F8D',
    controlLine: '#666F6B',
    accent: '#03663C',
    badge: '#03663C',
    accentText: '#025B35',
    bubbleMeMuted: '#395345',
    warn: '#6C4501',
    danger: '#A20E0C',
    avatarFg: '#025934',
  },
  'calma-dark': {
    muted: '#B2C0B8',
    line: '#606963',
    controlLine: '#818E86',
    bubbleMeMuted: '#ACCDBA',
    danger: '#FF9291',
  },
  'terminal-dark': {
    muted: '#AEC2B6',
    line: '#596760',
    controlLine: '#7B8B82',
    danger: '#FE878E',
  },
  'terminal-light': {
    muted: '#445049',
    line: '#82877E',
    controlLine: '#636C65',
    accent: '#046632',
    badge: '#046632',
    accentText: '#02592B',
    bubbleMe: '#025528',
    bubbleMeMuted: '#CCEBD9',
    warn: '#6C4501',
    danger: '#9E0506',
    avatarFg: '#025428',
  },
};

/** More contrast for the alternative accents, per mode, only what changes. */
export const MORE_CONTRAST_ACCENTS: Readonly<
  Record<ResolvedMode, Readonly<Record<AlternativeAccent, Readonly<Partial<AccentPalette>>>>>
> = {
  light: {
    azul: { accent: '#1354B3', badge: '#1354B3', accentText: '#0248A7', bubbleMeMuted: '#3F4B5E' },
    morado: { accent: '#6A3DB6', badge: '#6A3DB6', accentText: '#5F30A9', bubbleMeMuted: '#504662' },
    naranja: { accent: '#904203', badge: '#904203', accentText: '#7F3902', bubbleMeMuted: '#5D4834' },
  },
  dark: {
    azul: { accentText: '#7EB4FF', bubbleMeMuted: '#AFBCCE' },
    morado: { accentText: '#BB9FFE' },
    naranja: {},
  },
};
