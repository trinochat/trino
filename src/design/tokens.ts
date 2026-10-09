/**
 * Design tokens of the redesign: the single source of truth for colour, type,
 * shape and depth of both styles (Calma and Terminal), each in light and dark,
 * plus the alternative accents.
 *
 * The four theme sets are the approved prototype's values, unchanged, plus
 * `controlLine`, added after it (`appearance.test.ts` compares them with the
 * prototype). `contrast.test.ts` checks the text pairs against WCAG 2.x AA and
 * the control boundaries against 3:1 for every style, mode and accent. The
 * engine in `appearance.ts` turns them into `--t-*` CSS variables.
 */

export const STYLES = ['calma', 'terminal'] as const;
export type Style = (typeof STYLES)[number];

export const RESOLVED_MODES = ['light', 'dark'] as const;
/** A concrete colour scheme; the `system` preference resolves to one of these. */
export type ResolvedMode = (typeof RESOLVED_MODES)[number];

export const ACCENTS = ['verde', 'azul', 'morado', 'naranja'] as const;
export type Accent = (typeof ACCENTS)[number];
/** `verde` is each theme's own palette; the others replace part of it. */
export type AlternativeAccent = Exclude<Accent, 'verde'>;

export type ThemeId = `${Style}-${ResolvedMode}`;

export interface ThemeTokens {
  /** App background. */
  bg: string;
  /** Sidebar background. */
  side: string;
  /** Panels, cards, dialogs and inputs. */
  surface: string;
  /** Selected rows, chips, day separators and code blocks. */
  raised: string;
  /** Borders and dividers. Decorative, so not a contrast pair. */
  line: string;
  /**
   * Boundary of the text fields, which shows where to type (WCAG 1.4.11): 3:1
   * on bg, side, surface and raised, kept just above that so it stays quiet.
   * Between `line` and `muted`. Not in the prototype; no accent changes it.
   */
  controlLine: string;
  ink: string;
  muted: string;
  /** Fill of primary buttons, toggles and selected segments. */
  accent: string;
  /** Text and icons on `accent`. */
  accentInk: string;
  /** Accent-coloured text and icons on surfaces. */
  accentText: string;
  /** Tinted background: chips, selected options, your own avatar. */
  accentSoft: string;
  /** Status colours are semantic: they never follow the accent. */
  ok: string;
  warn: string;
  warnBg: string;
  danger: string;
  dangerBg: string;
  badge: string;
  badgeInk: string;
  avatarBg: string;
  avatarFg: string;
  bubbleIn: string;
  bubbleInInk: string;
  bubbleInLine: string;
  bubbleMe: string;
  bubbleMeInk: string;
  /** Time and status inside your own bubbles. */
  bubbleMeMuted: string;
  bubbleMeLine: string;
  /** Around the app window (prototype frame). */
  outer: string;
  /** Reading text. */
  font: string;
  /** Headings and the wordmark. */
  display: string;
  /** Keys, codes and times only. */
  mono: string;
  radius: string;
  radiusLg: string;
  bubbleRadius: string;
  avatarRadius: string;
  /** Scan-line background image (Terminal dark only), or `none`. */
  scan: string;
  labelFont: string;
  labelTransform: string;
  labelSpacing: string;
  /** Text of the wordmark. Content, not style: it is not a CSS variable. */
  wordmark: string;
  shadow: string;
}

const ATKINSON = "'Atkinson Hyperlegible Next', system-ui, sans-serif";
const ATKINSON_MONO = "'Atkinson Hyperlegible Mono', ui-monospace, monospace";
const PLEX_SANS = "'IBM Plex Sans', system-ui, sans-serif";
const JETBRAINS_MONO = "'JetBrains Mono', ui-monospace, monospace";

export const THEMES: Readonly<Record<ThemeId, Readonly<ThemeTokens>>> = {
  'calma-light': {
    bg: '#F5F7F6', side: '#FFFFFF', surface: '#FFFFFF', raised: '#EEF2F0', line: '#DDE3E0',
    controlLine: '#818B86',
    ink: '#111815', muted: '#56635C',
    accent: '#0F7B4A', accentInk: '#FFFFFF', accentText: '#0F7B4A', accentSoft: '#E3F2EA',
    ok: '#0F7B4A', warn: '#8A5A00', warnBg: '#FFF4DB', danger: '#B3261E', dangerBg: '#FDECEA',
    badge: '#0F7B4A', badgeInk: '#FFFFFF', avatarBg: '#DDF0E5', avatarFg: '#0B5E38',
    bubbleIn: '#EEF2F0', bubbleInInk: '#111815', bubbleInLine: '#EEF2F0',
    bubbleMe: '#DDF0E5', bubbleMeInk: '#111815', bubbleMeMuted: '#3F5A4B', bubbleMeLine: '#DDF0E5',
    outer: '#E7ECE9',
    font: ATKINSON, display: ATKINSON, mono: ATKINSON_MONO,
    radius: '10px', radiusLg: '14px', bubbleRadius: '16px', avatarRadius: '999px',
    scan: 'none',
    labelFont: ATKINSON, labelTransform: 'none', labelSpacing: '0',
    wordmark: 'Trino',
    shadow: '0 1px 2px rgba(17,24,21,0.06), 0 8px 24px rgba(17,24,21,0.06)',
  },
  'calma-dark': {
    bg: '#0F1311', side: '#131815', surface: '#161B18', raised: '#1E2521', line: '#28302B',
    controlLine: '#66726B',
    ink: '#E6ECE8', muted: '#9AA8A0',
    accent: '#3FD68A', accentInk: '#04170C', accentText: '#3FD68A', accentSoft: '#183526',
    ok: '#3FD68A', warn: '#F2B45A', warnBg: '#2C2416', danger: '#FF8A8A', dangerBg: '#3A1E1E',
    badge: '#3FD68A', badgeInk: '#04170C', avatarBg: '#1F3B2C', avatarFg: '#BFF0D4',
    bubbleIn: '#1E2521', bubbleInInk: '#E6ECE8', bubbleInLine: '#1E2521',
    bubbleMe: '#1F3B2C', bubbleMeInk: '#E6F5EC', bubbleMeMuted: '#A8C9B6', bubbleMeLine: '#1F3B2C',
    outer: '#0A0D0B',
    font: ATKINSON, display: ATKINSON, mono: ATKINSON_MONO,
    radius: '10px', radiusLg: '14px', bubbleRadius: '16px', avatarRadius: '999px',
    scan: 'none',
    labelFont: ATKINSON, labelTransform: 'none', labelSpacing: '0',
    wordmark: 'Trino',
    shadow: '0 8px 24px rgba(0,0,0,0.35)',
  },
  'terminal-dark': {
    bg: '#0A0E0C', side: '#0E1411', surface: '#101613', raised: '#18221C', line: '#24302A',
    controlLine: '#607067',
    ink: '#D7E3DC', muted: '#93A69B',
    accent: '#22FF66', accentInk: '#03140A', accentText: '#22FF66', accentSoft: '#0F2A1A',
    ok: '#22FF66', warn: '#FFB547', warnBg: '#2A2110', danger: '#FF6B78', dangerBg: '#2C1216',
    badge: '#22FF66', badgeInk: '#03140A', avatarBg: '#18221C', avatarFg: '#22FF66',
    bubbleIn: '#151D19', bubbleInInk: '#D7E3DC', bubbleInLine: '#24302A',
    bubbleMe: '#0F2A1A', bubbleMeInk: '#DFFBE8', bubbleMeMuted: '#9CC9AE', bubbleMeLine: '#1E4A30',
    outer: '#060908',
    font: PLEX_SANS, display: JETBRAINS_MONO, mono: JETBRAINS_MONO,
    radius: '4px', radiusLg: '6px', bubbleRadius: '4px', avatarRadius: '4px',
    scan: 'repeating-linear-gradient(0deg, rgba(34,255,102,0.025) 0px, rgba(34,255,102,0.025) 1px, transparent 1px, transparent 4px)',
    labelFont: JETBRAINS_MONO, labelTransform: 'uppercase', labelSpacing: '0.08em',
    wordmark: 'trino',
    shadow: 'none',
  },
  'terminal-light': {
    bg: '#F2F4EF', side: '#E9ECE5', surface: '#FFFFFF', raised: '#E9EDE5', line: '#D3D9CF',
    controlLine: '#7D877F',
    ink: '#121A15', muted: '#4E5B53',
    accent: '#08743A', accentInk: '#FFFFFF', accentText: '#08743A', accentSoft: '#E1F0E6',
    ok: '#08743A', warn: '#8A5A00', warnBg: '#FFF4DB', danger: '#B3261E', dangerBg: '#FBE9E8',
    badge: '#08743A', badgeInk: '#FFFFFF', avatarBg: '#DDE5DA', avatarFg: '#08743A',
    bubbleIn: '#EEF1EA', bubbleInInk: '#121A15', bubbleInLine: '#D3D9CF',
    bubbleMe: '#08743A', bubbleMeInk: '#FFFFFF', bubbleMeMuted: '#D2F2DF', bubbleMeLine: '#08743A',
    outer: '#DDE2DA',
    font: PLEX_SANS, display: JETBRAINS_MONO, mono: JETBRAINS_MONO,
    radius: '4px', radiusLg: '6px', bubbleRadius: '4px', avatarRadius: '4px',
    scan: 'none',
    labelFont: JETBRAINS_MONO, labelTransform: 'uppercase', labelSpacing: '0.08em',
    wordmark: 'trino',
    shadow: 'none',
  },
};

/**
 * The tokens an alternative accent replaces. Status colours (`ok`, `warn`,
 * `danger`) and the contact avatars keep the theme's own values.
 */
export interface AccentPalette {
  accent: string;
  accentInk: string;
  accentText: string;
  accentSoft: string;
  badge: string;
  badgeInk: string;
  bubbleMe: string;
  bubbleMeInk: string;
  bubbleMeMuted: string;
  /** Visible border of your own bubbles in Terminal; Calma uses the fill. */
  bubbleMeLine: string;
}

/**
 * Alternative accents per mode, shared by both styles.
 *
 * From the prototype: `accent` (the button colour), `bubbleMe`, `bubbleMeInk`,
 * and `accentInk` (#FFFFFF in light, #0B0B0B in dark). `accentText` and
 * `badge` are the button colour, and `badgeInk` is `accentInk`, as in the
 * default themes. Derived here, and checked by `contrast.test.ts`:
 * - `accentSoft`: `bubbleMe` with 18% white (light) or 15% black (dark), which
 *   reproduces the Calma defaults within a few units per channel;
 * - `bubbleMeMuted`: 28% of the way from `bubbleMeInk` to `bubbleMe`;
 * - `bubbleMeLine`: the accent in light, as in Terminal light; in dark, 20% of
 *   the way from `bubbleMe` to the accent, like Terminal dark's own border.
 */
export const ACCENT_PALETTES: Readonly<
  Record<ResolvedMode, Readonly<Record<AlternativeAccent, Readonly<AccentPalette>>>>
> = {
  light: {
    azul: {
      accent: '#1F5FBF', accentInk: '#FFFFFF', accentText: '#1F5FBF', accentSoft: '#E2ECFB',
      badge: '#1F5FBF', badgeInk: '#FFFFFF',
      bubbleMe: '#DCE8FA', bubbleMeInk: '#0F1A2E', bubbleMeMuted: '#485467', bubbleMeLine: '#1F5FBF',
    },
    morado: {
      accent: '#6B3FB8', accentInk: '#FFFFFF', accentText: '#6B3FB8', accentSoft: '#EFE8FB',
      badge: '#6B3FB8', badgeInk: '#FFFFFF',
      bubbleMe: '#ECE3FA', bubbleMeInk: '#1D1230', bubbleMeMuted: '#574D69', bubbleMeLine: '#6B3FB8',
    },
    naranja: {
      accent: '#A14A00', accentInk: '#FFFFFF', accentText: '#A14A00', accentSoft: '#FCEBDB',
      badge: '#A14A00', badgeInk: '#FFFFFF',
      bubbleMe: '#FBE6D3', bubbleMeInk: '#2B1600', bubbleMeMuted: '#65503B', bubbleMeLine: '#A14A00',
    },
  },
  dark: {
    azul: {
      accent: '#7AB2FF', accentInk: '#0B0B0B', accentText: '#7AB2FF', accentSoft: '#17273F',
      badge: '#7AB2FF', badgeInk: '#0B0B0B',
      bubbleMe: '#1B2E4A', bubbleMeInk: '#E6F0FF', bubbleMeMuted: '#ADBACC', bubbleMeLine: '#2E486E',
    },
    morado: {
      accent: '#B99BFF', accentInk: '#0B0B0B', accentText: '#B99BFF', accentSoft: '#271C3D',
      badge: '#B99BFF', badgeInk: '#0B0B0B',
      bubbleMe: '#2E2148', bubbleMeInk: '#F1EBFF', bubbleMeMuted: '#BAB2CC', bubbleMeLine: '#4A396D',
    },
    naranja: {
      accent: '#FFB070', accentInk: '#0B0B0B', accentText: '#FFB070', accentSoft: '#342414',
      badge: '#FFB070', badgeInk: '#0B0B0B',
      bubbleMe: '#3D2A18', bubbleMeInk: '#FFF1E4', bubbleMeMuted: '#C9B9AB', bubbleMeLine: '#64452A',
    },
  },
};
