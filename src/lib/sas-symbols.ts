/**
 * The SAS v2 symbols: 64 outline icons, each with a word in es, en and pt.
 *
 * They live in assets/sas/sas-v2.json, generated from lucide-react by
 * scripts/gen-sas-assets.mjs, so the desktop app, the mobile app and the
 * website draw exactly the same thing. The table is part of the human
 * protocol, not of i18n: the words never change with a translation pass.
 */
import table from '../../assets/sas/sas-v2.json';
import type { Lang } from './i18n';

/** One SVG element: its tag and its attributes (geometry, or `fill="currentColor"`). */
export type SasNode = readonly [tag: string, attrs: Readonly<Record<string, string>>];

export interface SasSymbolData {
  index: number;
  /** The lucide-react component the drawing comes from. */
  lucide: string;
  nodes: readonly SasNode[];
  words: Readonly<Record<Lang, string>>;
}

export interface SasTable {
  version: 2;
  /** Where the drawings come from: `lucide-react@<version>`. */
  source: string;
  viewBox: string;
  strokeWidth: number;
  /** How every symbol is drawn: no fill (except nodes that say `fill`), round caps and joins. */
  fill: 'none';
  strokeLinecap: 'round';
  strokeLinejoin: 'round';
  symbols: readonly SasSymbolData[];
}

export const SAS_TABLE = table as unknown as SasTable;
export const SAS_SYMBOLS: readonly SasSymbolData[] = SAS_TABLE.symbols;

/** The symbol at an index from 0 to 63. */
export function sasSymbol(index: number): SasSymbolData {
  const symbol = Number.isInteger(index) ? SAS_SYMBOLS[index] : undefined;
  if (!symbol) throw new RangeError(`no SAS symbol ${index}`);
  return symbol;
}

/** The word for a symbol in a language. */
export function sasWord(index: number, lang: Lang): string {
  return sasSymbol(index).words[lang];
}

/** The words for a SAS, in order: what a screen reader says and what people read aloud. */
export function sasWords(indices: readonly number[], lang: Lang): string[] {
  return indices.map(index => sasWord(index, lang));
}
