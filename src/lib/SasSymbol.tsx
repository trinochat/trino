/**
 * One SAS v2 symbol (docs/sas-v2.md): the outline icon from the frozen table,
 * stroked in `currentColor` so it takes the text colour of wherever it sits,
 * and its word. The icon is decoration for screen readers; the word carries
 * the meaning.
 */
import { createElement } from 'react';
import { iconSize, type IconSizeName } from '../design/type';
import type { Lang } from './i18n';
import { useLang } from './i18n-context';
import { SAS_TABLE, sasSymbol } from './sas-symbols';

export interface SasIconProps {
  /** Index into the table, 0 to 63. */
  index: number;
  /**
   * A step of the icon sizes (src/design/type.ts), which grows with the text
   * size: `lg`, 20 px at 100 %, wherever two people compare symbols, and
   * `2xl`, 28 px, in the comparison panel and the contact verification
   * dialog (docs/sas-v2.md). Without it, `1.25em`: the icon follows the font
   * size around it (20 px at 16 px text). Never a number, which would stay
   * in px, nor a rem string, which older WebKit rejects in the attributes.
   */
  size?: IconSizeName;
  className?: string;
}

/** The default icon size: relative to the text, 20 px at 16 px text. */
export const SAS_ICON_SIZE = '1.25em';

/** The icon alone, for a row of symbols that is labelled as a whole. */
export function SasIcon({ index, size, className }: SasIconProps) {
  const symbol = sasSymbol(index);
  // A step puts px in the attributes and rem in a class that beats them; the
  // default em is an SVG 1.1 length, which every engine takes as it is.
  const sized = size ? iconSize(size, className) : { size: SAS_ICON_SIZE, className };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={SAS_TABLE.viewBox}
      width={sized.size}
      height={sized.size}
      fill={SAS_TABLE.fill}
      stroke="currentColor"
      strokeWidth={SAS_TABLE.strokeWidth}
      strokeLinecap={SAS_TABLE.strokeLinecap}
      strokeLinejoin={SAS_TABLE.strokeLinejoin}
      aria-hidden="true"
      focusable="false"
      data-sas={symbol.lucide}
      className={sized.className ? `shrink-0 ${sized.className}` : 'shrink-0'}
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
export function SasSymbol({ index, size, lang, className }: SasSymbolProps) {
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
