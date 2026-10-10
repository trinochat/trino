/**
 * Shared checks for the `<area>.test.ts` contract tests of `src/lib/strings`.
 * Test-only: nothing in the app imports this file.
 */
import { expect } from 'vitest';
import { LANGS } from '../i18n';
import type { AreaStrings } from './types';

export const LANG_CODES = LANGS.map(l => l.code);

/** The `{name}` placeholders of a text, as a sorted set: what `interpolate` fills. */
export function placeholdersOf(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(/\{(\w+)\}/g), m => m[1]!))].sort();
}

/** Sentence case: the first letter, after an opening ¿ or ¡, is a capital. */
export function startsWithCapital(text: string): boolean {
  const first = text.replace(/^[¿¡]/, '').charAt(0);
  return first === first.toUpperCase();
}

export interface AreaContract {
  /** Every key of the area, no more and no fewer. */
  readonly keys: readonly string[];
  /** The placeholders of the keys that have any; the rest must have none. */
  readonly placeholders?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The contract between an area's texts and its screens, in every language:
 * exactly these keys, with these placeholders (so all languages match each
 * other), none of them empty and all in sentence case.
 */
export function expectAreaContract(area: AreaStrings, contract: AreaContract): void {
  const placeholders = contract.placeholders ?? {};
  expect(contract.keys.filter((key, i) => contract.keys.indexOf(key) !== i), 'keys listed twice').toEqual([]);
  expect(
    Object.keys(placeholders).filter(key => !contract.keys.includes(key)),
    'placeholders for keys outside the contract',
  ).toEqual([]);

  const expected = Object.fromEntries(contract.keys.map(key => [key, [...(placeholders[key] ?? [])].sort()]));
  expect(Object.keys(area).sort(), 'languages').toEqual([...LANG_CODES].sort());
  for (const lang of LANG_CODES) {
    const texts = Object.entries(area[lang]);
    const present = Object.fromEntries(texts.map(([key, text]) => [key, placeholdersOf(text)]));
    expect(present, `${lang}: keys and placeholders`).toEqual(expected);
    expect(
      texts.filter(([, text]) => !text.trim()).map(([key]) => key),
      `${lang}: empty texts`,
    ).toEqual([]);
    expect(
      texts.filter(([, text]) => !startsWithCapital(text)).map(([key]) => key),
      `${lang}: texts that do not start with a capital letter`,
    ).toEqual([]);
  }
}
