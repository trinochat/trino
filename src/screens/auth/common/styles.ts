/**
 * Class strings the auth screens share. Tailwind finds classes by scanning
 * the source, so each stays a whole literal.
 */

/**
 * The theme's label style at 13 px (Onboarding:325): Atkinson in sentence
 * case in Calma, JetBrains Mono in spaced capitals in Terminal.
 */
export const LABEL_TEXT =
  'font-ui-label text-ui-sm font-semibold text-ui-muted [letter-spacing:var(--t-label-spacing)] [text-transform:var(--t-label-transform)]';

/** A link-like button or a link in the accent colour, underlined so it is not told by colour alone. */
export const LINK_TEXT = 'font-semibold text-ui-accent-text underline underline-offset-2';
