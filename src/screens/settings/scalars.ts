/**
 * Text limits in Unicode scalars, as the backend counts them (K12: a name of
 * at most 64, "Sobre mí" of at most 140): an emoji is one, where `length`
 * would count its two UTF-16 units.
 */
export function countScalars(text: string): number {
  return [...text].length;
}

/** The text cut to at most `max` scalars, so an emoji is never split in half. */
export function capScalars(text: string, max: number): string {
  const scalars = [...text];
  return scalars.length > max ? scalars.slice(0, max).join('') : text;
}
