/**
 * Where the person types: a text field or editable content. Right-clicks and
 * the menu key there keep the system's own menu, the only one with the
 * spelling suggestions, besides Cortar, Copiar y Pegar (MC-1, MC-2).
 */

/** The input types that hold text to cut, copy and paste; a checkbox, a slider or a file field has none. */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/**
 * Whether an event's target is a text field or editable content
 * (`:read-write`) that is neither read-only nor disabled.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(target.type)) return false;
  return target.matches(':read-write') && !target.matches(':disabled');
}
