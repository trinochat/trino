import { describe, expect, it } from 'vitest';
import { ICON_SIZE } from '../design/type';

/**
 * Sizes follow the text, and the app's own settings decide motion and layout
 * (accesibilidad.md §4.5, §4.7 and §5.1). In the component library (src/ui),
 * the redesigned screens (src/screens) and the app around them (src/app):
 *
 * - no text size in px (`text-[13px]`): the type scale, `text-ui-*`, or rem;
 * - every lucide icon sized with `{...iconSize('md')}` (src/design/type.ts),
 *   which puts px in the attributes and rem in a class that beats them, and
 *   no `size` or `className` of its own beside it: a number would stay in px,
 *   older WebKit draws a rem string in the attributes at 100 %, and a class
 *   would replace the size's (extra classes go in `iconSize('md', '…')`).
 *   SasIcon and SasSymbol take a step's key (`size="lg"`) or nothing, never a
 *   number or a CSS length. The `size` of <Avatar> is a size key, and the one
 *   of QRCodeSVG and QRCodeCanvas is not a size on screen, so they are left
 *   alone;
 * - no box size in px in an arbitrary value (`h-[22px]`, `max-w-[480px]`,
 *   `p-[10px]`, `gap-[5px]`): rem, or Tailwind's own steps, which are rem;
 * - no `motion-reduce:` or `motion-safe:`, which only hear the system:
 *   `reduce-motion:` and `full-motion:` follow the app's setting too;
 * - no width media queries, in CSS or as Tailwind's `sm:` to `2xl:`, which
 *   do not see the text size: `layoutFor` (src/design/layout.ts) decides.
 *
 * Borders, radii and the focus offset stay in px.
 */
const SOURCES: Record<string, string> = {
  ...import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>(
    ['../screens/**/*.{ts,tsx}', '!../screens/**/*.test.{ts,tsx}', '../app/**/*.{ts,tsx}', '!../app/**/*.test.{ts,tsx}'],
    { query: '?raw', import: 'default', eager: true },
  ),
};

type Rule = 'text-px' | 'icon-size' | 'box-px' | 'motion-variant' | 'width-query';

interface Finding {
  rule: Rule;
  line: number;
  text: string;
}

const CLASS_RULES: ReadonlyArray<readonly [Rule, RegExp]> = [
  ['text-px', /(?<![\w-])text-\[\d*\.?\d+px\]/g],
  // h-, w-, size-, min-*, max-*, the paddings and the gaps, with px anywhere inside the brackets.
  ['box-px', /(?<![\w-])(?:h|w|size|min-[hw]|max-[hw]|p[xytrblse]?|gap(?:-[xy])?)-\[[^\]\s]*?\d(?:\.\d+)?px[^\]\s]*\]/g],
  ['motion-variant', /(?<![\w-])motion-(?:reduce|safe):/g],
  ['width-query', /@media[^{]*\((?:min|max)-width/g],
  // `md:flex`, but not an object key such as `{ md: 'max-w-…' }` or `text-ui-md`.
  ['width-query', /(?<![\w-])(?:sm|md|lg|xl|2xl):(?=[\w[!-])/g],
];

type State = 'code' | 'line-comment' | 'block-comment' | "'" | '"' | '`';

/**
 * The source with its comments blanked out: same length and line breaks, so
 * findings keep their line. A heuristic, as in no-hardcoded-colors.test.ts.
 */
function withoutComments(source: string): string {
  let state: State = 'code';
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && (next === '/' || next === '*')) {
        state = next === '/' ? 'line-comment' : 'block-comment';
        result += '  ';
        index += 1;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') state = char;
      result += char;
    } else if (state === 'line-comment') {
      if (char === '\n') state = 'code';
      result += char === '\n' ? '\n' : ' ';
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        state = 'code';
        result += '  ';
        index += 1;
        continue;
      }
      result += char === '\n' ? '\n' : ' ';
    } else {
      if (char === '\\') {
        result += char + (next ?? '');
        index += 1;
        continue;
      }
      if (char === state || (char === '\n' && state !== '`')) state = 'code';
      result += char;
    }
  }
  return result;
}

const lineAt = (source: string, index: number) => source.slice(0, index).split('\n').length;

/**
 * The JSX tags that draw an icon in a file: what it imports from
 * lucide-react, SasIcon and SasSymbol, and, where lucide-react is imported,
 * any component named `…Icon`, such as the `Icon` a component takes from a
 * table of lucide icons.
 */
function isIconTag(name: string, source: string): boolean {
  if (name === 'SasIcon' || name === 'SasSymbol') return true;
  const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]lucide-react['"]/g)];
  if (imports.length === 0) return false;
  if (/Icon$/.test(name)) return true;
  return imports.some(
    ([, typeOnly, names]) =>
      !typeOnly &&
      names
        .split(',')
        .map(part => part.trim())
        .filter(part => part && !part.startsWith('type '))
        .some(part => part.split(/\s+as\s+/).pop() === name),
  );
}

/** Where the opening tag that starts at `from` ends: the first `>` outside braces and quotes. */
function endOfTag(source: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = from; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
    } else if (char === '>' && depth === 0) {
      return index + 1;
    }
  }
  return source.length;
}

/** `size=` and its value: a quoted string, or an expression in braces with no braces inside. */
const SIZE_ATTRIBUTE = /(?<![\w-])size=(?:"[^"]*"|'[^']*'|\{[^{}]*\})/;
/** A value that is one string literal: `"lg"`, `'lg'`, `{'lg'}` or `` {`lg`} ``. */
const STRING_SIZE = /^size=(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})$/;
const NUMBER_SIZE = /^size=\{\s*-?\d[\d.]*\s*\}$/;
const SIZE_KEYS: ReadonlySet<string> = new Set(Object.keys(ICON_SIZE));

/**
 * What is wrong with the size of one icon tag, with where in the tag, or
 * null. A lucide icon spreads `iconSize(…)` and has no `size` or `className`
 * of its own. SasIcon and SasSymbol take a step's key, or nothing for the
 * 1.25em that follows the text around them; an expression is left to
 * TypeScript, which only lets the keys through.
 */
function iconSizeProblem(name: string, tag: string): { at: number; text: string } | null {
  const size = SIZE_ATTRIBUTE.exec(tag);
  if (name === 'SasIcon' || name === 'SasSymbol') {
    if (!size) return null;
    const key = STRING_SIZE.exec(size[0])
      ?.slice(1)
      .find(part => part !== undefined);
    const wrong = NUMBER_SIZE.test(size[0]) || (key !== undefined && !SIZE_KEYS.has(key));
    return wrong ? { at: size.index, text: `<${name} ${size[0]}>` } : null;
  }
  if (size) return { at: size.index, text: `<${name} ${size[0]}>` };
  if (!/\{\s*\.\.\.iconSize\(/.test(tag)) return { at: 0, text: `<${name}> without {...iconSize()}` };
  const className = /(?<![\w-])className=/.exec(tag);
  return className ? { at: className.index, text: `<${name} className> beside {...iconSize()}` } : null;
}

/**
 * Icons sized any other way than the rule says, even when the tag spans
 * lines. A `<` right after a name opens type arguments (`Array<LucideIcon>`),
 * not a tag.
 */
function iconSizes(code: string): Finding[] {
  return [...code.matchAll(/(?<![\w$])<([A-Z][\w.]*)/g)].flatMap(match => {
    if (!isIconTag(match[1], code)) return [];
    const start = match.index ?? 0;
    const tag = code.slice(start, endOfTag(code, start + match[0].length));
    const problem = iconSizeProblem(match[1], tag);
    return problem ? [{ rule: 'icon-size' as const, line: lineAt(code, start + problem.at), text: problem.text }] : [];
  });
}

/** What breaks the rules in one source, outside comments, with its 1-based line. */
function scan(source: string): Finding[] {
  const code = withoutComments(source);
  const classes = CLASS_RULES.flatMap(([rule, pattern]) =>
    [...code.matchAll(pattern)].map(match => ({ rule, line: lineAt(code, match.index ?? 0), text: match[0] })),
  );
  return [...classes, ...iconSizes(code)].sort((a, b) => a.line - b.line);
}

/** `./controls/Switch.tsx` → `src/ui/controls/Switch.tsx`, `../screens/x.tsx` → `src/screens/x.tsx`. */
function repositoryPath(key: string): string {
  return key.startsWith('./') ? `src/ui/${key.slice(2)}` : key.replace(/^\.\.\//, 'src/');
}

/** Every finding of one rule in the sources, as `path:line: text`. */
function findings(sources: Record<string, string>, rule: Rule): string[] {
  return Object.entries(sources).flatMap(([key, source]) =>
    scan(source)
      .filter(found => found.rule === rule)
      .map(({ line, text }) => `${repositoryPath(key)}:${line}: ${text}`),
  );
}

describe('scan', () => {
  it('finds text sizes in px, with variants, and their line', () => {
    const source = ["const a = 'flex text-[13px]';", 'const b = "hover:text-[15.5px] text-ui-md";'];
    expect(scan(source.join('\n'))).toEqual([
      { rule: 'text-px', line: 1, text: 'text-[13px]' },
      { rule: 'text-px', line: 2, text: 'text-[15.5px]' },
    ]);
  });

  it('finds box sizes in px inside arbitrary values', () => {
    const source = [
      "'h-[22px] w-[22px] size-[20px] before:w-[3px]'",
      "'min-h-[44px] min-w-[20px] max-w-[min(72%,520px)] max-w-[calc(100vw-32px)] max-h-[90px]'",
      "'p-[10px] px-[14px] py-[9px] pt-[1px] ps-[2px] gap-[5px] gap-x-[3px]'",
    ];
    expect(scan(source.join('\n')).map(found => [found.line, found.text])).toEqual([
      [1, 'h-[22px]'],
      [1, 'w-[22px]'],
      [1, 'size-[20px]'],
      [1, 'w-[3px]'],
      [2, 'min-h-[44px]'],
      [2, 'min-w-[20px]'],
      [2, 'max-w-[min(72%,520px)]'],
      [2, 'max-w-[calc(100vw-32px)]'],
      [2, 'max-h-[90px]'],
      [3, 'p-[10px]'],
      [3, 'px-[14px]'],
      [3, 'py-[9px]'],
      [3, 'pt-[1px]'],
      [3, 'ps-[2px]'],
      [3, 'gap-[5px]'],
      [3, 'gap-x-[3px]'],
    ]);
  });

  it('lets rem sizes through, and px where it stays: borders, radii, offsets and positions', () => {
    const source = [
      "'h-[1.375rem] max-w-[min(72%,32.5rem)] text-[1.625rem] p-2.5 min-h-11 gap-[0.3125rem]'",
      "'border-[3px] border-s-[3px] rounded-[10px] outline-[3px] outline-offset-[-2px] top-[3px] translate-x-[2px]'",
    ];
    expect(scan(source.join('\n'))).toEqual([]);
  });

  it('finds the motion variants that only hear the system, and width queries', () => {
    const source = [
      "'motion-reduce:transition-none motion-safe:animate-fade-in'",
      "'sm:flex md:hidden lg:w-1/2 xl:px-4 2xl:gap-2'",
      'const css = `@media (min-width: 760px) { … } @media screen and (max-width:600px) {}`;',
    ];
    expect(scan(source.join('\n')).map(found => [found.rule, found.text])).toEqual([
      ['motion-variant', 'motion-reduce:'],
      ['motion-variant', 'motion-safe:'],
      ['width-query', 'sm:'],
      ['width-query', 'md:'],
      ['width-query', 'lg:'],
      ['width-query', 'xl:'],
      ['width-query', '2xl:'],
      ['width-query', '@media (min-width'],
      ['width-query', '@media screen and (max-width'],
    ]);
  });

  it("lets the app's own variants through, and what only looks like a width variant", () => {
    const source = [
      "'reduce-motion:transition-none full-motion:animate-fade-in more-contrast:outline-[3px]'",
      "const WIDTHS = { sm: 'max-w-[26.25rem]', md: 'max-w-[30rem]', lg: 'max-w-[38.75rem]' };",
      "const classes = 'text-ui-sm text-ui-md rounded-ui-lg';",
      "const time = '10:42'; const url = 'https://example.com';",
    ];
    expect(scan(source.join('\n'))).toEqual([]);
  });

  it('finds a lucide icon, or a table of them, given a size of its own: a number, a rem string or an expression', () => {
    const source = [
      "import { Check, ChevronDown, X as Close, type LucideIcon } from 'lucide-react';",
      'const a = <Check size={14} aria-hidden="true" />;',
      'const b = (',
      '  <ChevronDown',
      '    aria-hidden="true"',
      '    size="1rem"',
      '    onClick={() => open()}',
      '  />',
      ');',
      "const c = <Close {...iconSize('lg')} size={ICON_SIZE.lg} />;",
      'const { Icon } = KINDS[kind];',
      "const d = <Icon size={'0.875rem'} />;",
    ];
    expect(scan(source.join('\n')).map(found => [found.line, found.text])).toEqual([
      [2, '<Check size={14}>'],
      [6, '<ChevronDown size="1rem">'],
      [10, '<Close size={ICON_SIZE.lg}>'],
      [12, "<Icon size={'0.875rem'}>"],
    ]);
  });

  it('finds a lucide icon without iconSize, or with a class of its own beside it', () => {
    const source = [
      "import { Check, type LucideIcon } from 'lucide-react';",
      'const a = <Check aria-hidden="true" />;',
      'const { Icon } = KINDS[kind];',
      'const b = <Icon {...sized} />;',
      'const c = (',
      '  <Check',
      "    {...iconSize('md')}",
      '    className="mt-1"',
      '  />',
      ');',
      "const d = <Check className={cx('a', b)} {...iconSize('md')} />;",
    ];
    expect(scan(source.join('\n')).map(found => [found.line, found.text])).toEqual([
      [2, '<Check> without {...iconSize()}'],
      [4, '<Icon> without {...iconSize()}'],
      [8, '<Check className> beside {...iconSize()}'],
      [11, '<Check className> beside {...iconSize()}'],
    ]);
  });

  it('finds a number or a CSS length as the size of a SAS symbol', () => {
    const source = [
      'const a = <SasSymbol index={s} size={28} />;',
      'const b = <SasIcon index={3} size="1.75rem" />;',
      "const c = <SasIcon index={3} size={'1.25em'} />;",
    ];
    expect(scan(source.join('\n')).map(found => [found.line, found.text])).toEqual([
      [1, '<SasSymbol size={28}>'],
      [2, '<SasIcon size="1.75rem">'],
      [3, "<SasIcon size={'1.25em'}>"],
    ]);
  });

  it('lets icons sized with iconSize through, and the sizes that are not icon sizes', () => {
    const source = [
      "import { Check, type LucideIcon } from 'lucide-react';",
      "const a = <Check {...iconSize('sm')} />;",
      "const b = <Check aria-hidden=\"true\" {...iconSize('md', 'mt-0.5 shrink-0')} data-icon=\"check\" />;",
      'const c = <SasIcon index={3} size="2xl" />;',
      "const d = <SasSymbol index={3} size={compact ? 'lg' : '2xl'} />;",
      'const e = <SasSymbol index={3} />;',
      'const f = <Avatar {...avatar} size={44} />;',
      'const g = <QRCodeSVG value={code} size={160} />;',
      'const h = <QRCodeCanvas value={code} size={512} />;',
      'const i = <TrinoLogo size={32} />;',
      'const j = <input size={20} />;',
      'const icons: Array<LucideIcon> = [];',
    ];
    expect(scan(source.join('\n'))).toEqual([]);
  });

  it('skips comments but keeps the line numbers', () => {
    const source = ['// text-[13px] in a comment', '/* motion-reduce:', '   still */ const a = "h-[2px]";'];
    expect(scan(source.join('\n'))).toEqual([{ rule: 'box-px', line: 3, text: 'h-[2px]' }]);
  });
});

describe('the component library, the screens and the app', () => {
  // Every source of src/ui, src/screens and src/app but the tests, listed
  // apart from SOURCES and never loaded: a folder dropped from SOURCES fails here.
  it('are all scanned', () => {
    const everySource = Object.keys(import.meta.glob('../**/*.{ts,tsx}')).map(repositoryPath);
    const expected = everySource.filter(path => /^src\/(ui|screens|app)\//.test(path) && !/\.test\.tsx?$/.test(path));
    expect(expected).toEqual(expect.arrayContaining(['src/ui/controls/Switch.tsx', 'src/screens/types.ts']));
    expect(Object.keys(SOURCES).map(repositoryPath).sort()).toEqual(expected.sort());
  });

  it('size no text in px', () => {
    expect(findings(SOURCES, 'text-px')).toEqual([]);
  });

  it('size every icon with iconSize, or a SAS symbol with its key', () => {
    expect(findings(SOURCES, 'icon-size')).toEqual([]);
  });

  it('size no box in px', () => {
    expect(findings(SOURCES, 'box-px')).toEqual([]);
  });

  it("follow the app's motion setting", () => {
    expect(findings(SOURCES, 'motion-variant')).toEqual([]);
  });

  it('use no width media queries', () => {
    expect(findings(SOURCES, 'width-query')).toEqual([]);
  });

  // The avatar's size is a key, so the inbox row's avatar is not an icon.
  it('leave the size of <Avatar> alone', () => {
    expect(SOURCES['./chat/ChatRow.tsx']).toContain('<Avatar {...avatar} size={44} />');
    expect(scan(SOURCES['./chat/ChatRow.tsx']).filter(found => found.rule === 'icon-size')).toEqual([]);
  });

  // Mutation check: the same scan on a copy of a real component with px planted.
  it('would report a size in px planted in a component', () => {
    const original = SOURCES['./controls/Segmented.tsx'];
    const planted = original.replace('min-h-11', 'min-h-[44px] text-[15px]');
    expect(planted).not.toBe(original);
    const line = planted.slice(0, planted.indexOf('min-h-[44px]')).split('\n').length;
    expect(findings({ './controls/Segmented.tsx': planted }, 'box-px')).toEqual([
      `src/ui/controls/Segmented.tsx:${line}: min-h-[44px]`,
    ]);
    expect(findings({ './controls/Segmented.tsx': planted }, 'text-px')).toEqual([
      `src/ui/controls/Segmented.tsx:${line}: text-[15px]`,
    ]);
  });

  // The same for the icons: a real one sized with a rem string instead.
  it('would report an icon sized without iconSize in a component', () => {
    const original = SOURCES['./controls/Field.tsx'];
    const planted = original.replace(/\{\.\.\.iconSize\([^)]*\)\}/, 'size="1rem"');
    expect(planted).not.toBe(original);
    const line = planted.slice(0, planted.indexOf('size="1rem"')).split('\n').length;
    expect(findings({ './controls/Field.tsx': planted }, 'icon-size')).toEqual([
      `src/ui/controls/Field.tsx:${line}: <CircleAlert size="1rem">`,
    ]);
  });
});
