/**
 * The root size in px: 16 px times the text size in effect, as apply.ts sets
 * it on <html>. Lengths in rem are worked out from it in scripts, which media
 * queries cannot do (accesibilidad.md §4.7). 16 when it cannot be read.
 */
export function rootPx(doc: Document): number {
  return parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? '') || 16;
}
