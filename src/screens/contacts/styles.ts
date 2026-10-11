/**
 * Class strings the contacts and group screens share. Tailwind finds classes
 * by scanning the source, so each stays a whole literal.
 */

/**
 * The theme's label style, as src/ui/chat/label.ts has it (not in the
 * barrel): Atkinson in sentence case in Calma, JetBrains Mono in spaced
 * capitals in Terminal. At 13 px, as the boards' labels.
 */
export const LABEL =
  'font-ui-label text-ui-sm font-semibold text-ui-muted [letter-spacing:var(--t-label-spacing)] [text-transform:var(--t-label-transform)]';

/** A card on a dialog's surface (Contacts:61, 92 and 110). */
export const CARD = 'flex flex-col gap-3 rounded-ui border border-ui-line bg-ui-bg p-4';

/** A key or a code in mono: never wider than the panel, at any text size. */
export const MONO_KEY = 'font-ui-mono text-ui-lg tracking-[0.06em] [overflow-wrap:anywhere]';

/** An error line of a panel: an icon and the text, read out as an alert. */
export const ERROR_LINE = 'm-0 flex items-start gap-1.5 text-ui-md font-semibold text-ui-danger';
