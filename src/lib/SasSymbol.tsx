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
  /** Width and height in px. Default 20. */
  size?: number;
  className?: string;
}

/** The icon alone, for a row of symbols that is labelled as a whole. */
export function SasIcon({ index, size = 20, className }: SasIconProps) {
  const symbol = sasSymbol(index);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={SAS_TABLE.viewBox}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={SAS_TABLE.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
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

/** The icon above its word in the current language. */
export function SasSymbol({ index, size = 20, lang, className }: SasSymbolProps) {
  const current = useLang().lang;
  const word = sasSymbol(index).words[lang ?? current];
  return (
    <span className={className ? `inline-flex flex-col items-center gap-1 ${className}` : 'inline-flex flex-col items-center gap-1'}>
      <SasIcon index={index} size={size} />
      <span>{word}</span>
    </span>
  );
}
