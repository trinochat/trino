/**
 * Class strings shared by the controls. Tailwind finds classes by scanning the
 * source, so each one stays a whole literal here. The focus ring is not here:
 * the whole library shares it from `../focus.ts`.
 */

/** A disabled control is dimmed and shows a not-allowed cursor. */
export const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * The parts the system draws (caret, selection, the select's list, the
 * checkbox, scrollbars) follow the light or dark mode: `--t-color-scheme` is
 * set on <html> by src/design/apply.ts. Without it they inherit, as before.
 */
export const COLOR_SCHEME = '[color-scheme:var(--t-color-scheme)]';

/** The box of the text fields (Input, PasswordInput, Textarea, Select), minus the border colour. */
export const FIELD_BOX = 'w-full rounded-ui border bg-ui-bg text-ui-base text-ui-ink placeholder:text-ui-muted';

/**
 * The border colour of a text field: `controlLine`, which shows where to type
 * at 3:1 on every surface (WCAG 1.4.11), or danger while invalid. The
 * decorative `line` would give about 1.2:1.
 */
export function fieldBorder(invalid: boolean): string {
  return invalid ? 'border-ui-danger' : 'border-ui-control-line';
}
