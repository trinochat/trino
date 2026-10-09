/** Joins class names, skipping falsy parts and collapsing stray whitespace. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .map((p) => p.trim().replace(/\s+/g, ' '))
    .join(' ');
}
