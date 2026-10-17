/**
 * A file name a peer chose, as the chat shows and saves it (TRN-APP-03).
 *
 * The engine cleans incoming names already (`shown_file_name`); this keeps a
 * name that reaches the WebView any other way from being shown raw. A
 * right-to-left override (U+202E) made "factura<RLO>fdp.exe" read as a PDF.
 */

/** Control and format characters, the bidi overrides and isolates among them; not the two joiners emoji need. */
const HIDDEN = /(?![\u200C\u200D])[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** What shows nothing by itself. */
const BLANK = /^[\s\u200C\u200D\u034F\uFE00-\uFE0F]*$/u;
/** The name of a file whose own name shows nothing, as the engine names it. */
export const FILE_NAME_FALLBACK = 'archivo';

/** `name` without control or format characters; `archivo` when nothing in it shows. */
export function shownFileName(name: string): string {
  const clean = name.replace(HIDDEN, '');
  return BLANK.test(clean) ? FILE_NAME_FALLBACK : clean;
}

/** The extension of a shown name, as "EXE", or undefined when it has none. */
export function fileExtension(name: string): string | undefined {
  return /\.([\p{L}\p{N}]{1,10})$/u.exec(name)?.[1].toUpperCase();
}
