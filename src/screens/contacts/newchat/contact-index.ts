/**
 * The contacts of "Nuevo chat" from A to Z (PropNuevoChat:81-107): grouped
 * under their first letter, sorted as the app's language sorts, and
 * filtered as you type. Pure, so the dialog only draws it.
 */
import type { NodeInfo } from '../../../lib/api';
import type { Lang } from '../../../lib/i18n';

export interface ContactLetter {
  /** "A" to "Z", "Ñ" in Spanish, or "#" for names that start with no letter. */
  letter: string;
  nodes: NodeInfo[];
}

/** The heading of the names that start with a digit, a symbol or another script. */
export const OTHER_LETTER = '#';

const MARKS = /\p{M}/gu;

/** Lowercase and without accents: what the search compares. */
export function foldForSearch(text: string, lang: Lang): string {
  return text.normalize('NFD').replace(MARKS, '').toLocaleLowerCase(lang);
}

/**
 * The letter a name goes under: its first letter without its accent, so Á
 * goes under A. In Spanish Ñ is a letter of its own; in English and
 * Portuguese it goes under N, as their alphabets and collations have it.
 */
export function letterOf(name: string, lang: Lang): string {
  const first = [...name.normalize('NFC').trimStart()][0] ?? '';
  if (lang === 'es' && (first === 'Ñ' || first === 'ñ')) return 'Ñ';
  const base = first.normalize('NFD').replace(MARKS, '').toUpperCase();
  return /^[A-Z]$/.test(base) ? base : OTHER_LETTER;
}

/**
 * Your contacts that match `query`, by letter: the letters in the order of
 * the language and "#" last, the names in each sorted with `Intl.Collator`
 * (case and accents aside, numbers as numbers). Blocked contacts are left
 * out. The search ignores accents, case and the spaces around it, and looks
 * in the name, and in what `alias` gives for a contact, with or without an
 * @ in front: the seam for the @names that come with the invitations
 * (plan-cambios-11oct §8).
 */
export function contactIndex(
  nodes: readonly NodeInfo[],
  query: string,
  lang: Lang,
  alias?: (handle: string) => string | undefined,
): ContactLetter[] {
  const q = foldForSearch(query.trim(), lang);
  const qAlias = q.replace(/^@/, '');
  const matches = (node: NodeInfo) => {
    if (q === '') return true;
    if (foldForSearch(node.handle, lang).includes(q)) return true;
    const other = alias?.(node.handle);
    return other !== undefined && qAlias !== '' && foldForSearch(other.replace(/^@/, ''), lang).includes(qAlias);
  };

  const collator = new Intl.Collator(lang, { sensitivity: 'base', numeric: true });
  const byName = (a: NodeInfo, b: NodeInfo) =>
    collator.compare(a.handle, b.handle) || (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0);

  const groups = new Map<string, NodeInfo[]>();
  for (const node of nodes) {
    if (node.blocked || !matches(node)) continue;
    const letter = letterOf(node.handle, lang);
    groups.set(letter, [...(groups.get(letter) ?? []), node]);
  }
  return [...groups.keys()]
    .sort((a, b) => (a === OTHER_LETTER ? 1 : b === OTHER_LETTER ? -1 : collator.compare(a, b)))
    .map(letter => ({ letter, nodes: groups.get(letter)!.sort(byName) }));
}
