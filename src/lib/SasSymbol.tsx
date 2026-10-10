/**
 * One SAS v2 symbol (docs/sas-v2.md): the outline icon from the frozen table,
 * stroked in `currentColor` so it takes the text colour of wherever it sits,
 * and its word. The icon is decoration for screen readers; the word carries
 * the meaning.
 */
import { createElement } from 'react';
import type { Lang } from './i18n';
import { useLang } from './i18n-context';
import { SAS_TABLE, sasSymbol } from './sas-symbols';

export interface SasIconProps {
  /** Index into the table, 0 to 63. */
  index: number;
  /**
   * Width and height: a number is px, a string any CSS length. The default,
   * `1.25em`, follows the font size around it (20 px at 16 px text), so the
   * icon grows with the text scale instead of shrinking beside its word.
   */
  size?: number | string;
  className?: string;
}

/** The default icon size: relative to the text, 20 px at 16 px text. */
export const SAS_ICON_SIZE = '1.25em';

/** The icon alone, for a row of symbols that is labelled as a whole. */
export function SasIcon({ index, size = SAS_ICON_SIZE, className }: SasIconProps) {
  const symbol = sasSymbol(index);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={SAS_TABLE.viewBox}
      width={size}
      height={size}
      fill={SAS_TABLE.fill}
      stroke="currentColor"
      strokeWidth={SAS_TABLE.strokeWidth}
      strokeLinecap={SAS_TABLE.strokeLinecap}
      strokeLinejoin={SAS_TABLE.strokeLinejoin}
      aria-hidden="true"
      focusable="false"
      data-sas={symbol.lucide}
      className={className ? `shrink-0 ${className}` : 'shrink-0'}
    >
      {symbol.nodes.map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
    </svg>
  );
}

export interface SasSymbolProps extends SasIconProps {
  /** The word's language. Default: the app's current language. */
  lang?: Lang;
}

/**
 * The icon above its word in the current language. The word carries `lang`,
 * so a screen reader reads it with the right voice even when `lang` differs
 * from the app's language.
 */
export function SasSymbol({ index, size = SAS_ICON_SIZE, lang, className }: SasSymbolProps) {
  const current = useLang().lang;
  const wordLang = lang ?? current;
  const word = sasSymbol(index).words[wordLang];
  return (
    <span className={className ? `inline-flex flex-col items-center gap-1 ${className}` : 'inline-flex flex-col items-center gap-1'}>
      <SasIcon index={index} size={size} />
      <span lang={wordLang}>{word}</span>
    </span>
  );
}
