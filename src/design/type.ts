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
 * The icon sizes: 10, 14, 16, 20 and 24 px at 100 %, and 28 px for the SAS
 * symbols in the comparison panel (docs/sas-v2.md). Each one twice: in px
 * for the `width` and `height` attributes, and in rem as a class. Older
 * WebKit (WebKitGTK before about 2.50, older WKWebView) rejects rem in those
 * attributes and draws the icon at 100 % of its box, so they stay in px; the
 * class beats them in every engine and grows with the text. Reach them
 * through `iconSize`.
 */
export const ICON_SIZE = {
  xs: { px: 10, className: 'size-[0.625rem]' },
  sm: { px: 14, className: 'size-[0.875rem]' },
  md: { px: 16, className: 'size-[1rem]' },
  lg: { px: 20, className: 'size-[1.25rem]' },
  xl: { px: 24, className: 'size-[1.5rem]' },
  '2xl': { px: 28, className: 'size-[1.75rem]' },
} as const satisfies Record<string, { px: number; className: string }>;

export type IconSizeName = keyof typeof ICON_SIZE;

/** What `iconSize` gives an icon: lucide's own props, so it can be spread. */
export interface IconSizeProps {
  /** Width and height attributes in px: what an engine draws without the class. */
  size: number;
  /** The size in rem, then the caller's classes. */
  className: string;
}

/**
 * Sizes a lucide icon: `<Check {...iconSize('md')} aria-hidden="true" />`.
 * Other classes for the icon go in the second argument,
 * `iconSize('md', 'shrink-0')`: a `className` beside the spread would
 * replace the size's class, or lose its own. Nor a `size` of its own.
 * a11y-classes.test.ts holds src/ui, src/screens and src/app to this.
 * SasIcon and SasSymbol take the step's name as their `size` instead.
 */
export function iconSize(name: IconSizeName, className?: string): IconSizeProps {
  const step = ICON_SIZE[name];
  return { size: step.px, className: className ? `${step.className} ${className}` : step.className };
}
