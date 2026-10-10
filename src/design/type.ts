/**
 * The type scale and the icon sizes of the redesign (accesibilidad.md §4.7),
 * in rem, so they grow with the text size: the root is 16 px times the text
 * scale (apply.ts). tailwind.config.js turns the scale into `text-ui-xs` …
 * `text-ui-title`, and tailwind.test.ts keeps the two the same. Nothing goes
 * under 0.75 rem, 12 px at 100 % (principle 3).
 *
 * Bigger display text, such as the first run's titles, takes an arbitrary
 * rem value (`text-[1.625rem]`); never px.
 */

export interface TypeStep {
  /** Font size in rem. */
  size: string;
  /** Unitless, so it follows the size. */
  lineHeight: string;
}

export const TYPE_SCALE = {
  /** 12 px: times, unread counts, labels. */
  xs: { size: '0.75rem', lineHeight: '1.35' },
  /** 13 px: a sender's name in a group, footnotes. */
  sm: { size: '0.8125rem', lineHeight: '1.35' },
  /** 14 px: previews, banners, toasts, descriptions. */
  md: { size: '0.875rem', lineHeight: '1.4' },
  /** 15 px: names, messages, fields and controls. */
  base: { size: '0.9375rem', lineHeight: '1.45' },
  /** 16 px: group titles in Settings. */
  lg: { size: '1rem', lineHeight: '1.4' },
  /** 22 px: dialog and section titles. */
  title: { size: '1.375rem', lineHeight: '1.25' },
} as const satisfies Record<string, TypeStep>;

export type TypeStepName = keyof typeof TYPE_SCALE;

/**
 * Icon sizes for lucide's `size`, which takes a string: 10, 14, 16, 20 and
 * 24 px at 100 %. Never a number, which would stay in px.
 */
export const ICON_SIZE = {
  xs: '0.625rem',
  sm: '0.875rem',
  md: '1rem',
  lg: '1.25rem',
  xl: '1.5rem',
} as const;

export type IconSizeName = keyof typeof ICON_SIZE;
