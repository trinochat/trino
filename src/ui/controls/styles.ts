/**
 * Class strings shared by the controls. Tailwind finds classes by scanning the
 * source, so each one stays a whole literal here.
 */

/**
 * Keyboard focus (WCAG 2.4.7): a 2 px outline in the accent text colour, 2 px
 * away from the control, which reaches 4.5:1 on every surface. `shadow-none`
 * drops the glow that the legacy stylesheet adds to every focused element.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ui-accent-text focus-visible:shadow-none';

/** A disabled control is dimmed and shows a not-allowed cursor. */
export const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-50';

/** The box of the text fields (Input, PasswordInput, Textarea, Select), minus the border colour. */
export const FIELD_BOX = 'w-full rounded-ui border bg-ui-bg text-base text-ui-ink placeholder:text-ui-muted';

/** The border colour of a text field: danger while invalid. */
export function fieldBorder(invalid: boolean): string {
  return invalid ? 'border-ui-danger' : 'border-ui-line';
}
