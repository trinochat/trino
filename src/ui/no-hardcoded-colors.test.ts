import { describe, expect, it } from 'vitest';

/**
 * Principle 2 of the redesign: no hand-written colours. Colours live in the
 * tokens (`src/design/tokens.ts`) and reach the screens through the `ui-*`
 * Tailwind classes and the `--t-*` CSS variables, so the component library,
 * the design engine, the redesigned screens (`src/screens`) and the app
 * around them (`src/app`) hold no colour literals: no hex, no rgb() or hsl(),
 * and no colour class outside the tokens (`bg-white`, `text-gray-500`). Only
 * the tokens, the colour maths (`color.ts`) and the tests may write one.
 */
const SOURCES: Record<string, string> = {
  ...import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  ...import.meta.glob<string>(
    ['../design/**/*.{ts,tsx}', '!../design/**/*.test.{ts,tsx}', '!../design/tokens.ts', '!../design/color.ts'],
    { query: '?raw', import: 'default', eager: true },
  ),
  ...import.meta.glob<string>(
    ['../screens/**/*.{ts,tsx}', '!../screens/**/*.test.{ts,tsx}', '../app/**/*.{ts,tsx}', '!../app/**/*.test.{ts,tsx}'],
    { query: '?raw', import: 'default', eager: true },
  ),
};

/** `#abc`, `#abcd`, `#aabbcc` and `#aabbccdd`, but not `page#add` or `&#123;`. */
const HEX_COLOUR = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\(/gi;

/** The utilities that take a colour: `bg-*`, `text-*`, `border-x-*`, `ring-offset-*`... */
const COLOUR_UTILITY =
  'bg|text|border(?:-[xytrblse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|placeholder|divide';
/** Tailwind's default palette, whose colours come in shades: `gray-100`, `red-500`. */
const PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
/** The legacy theme's colours in tailwind.config.js (`text-phosphor`, `bg-bg-panel`), for the old screens only. */
const LEGACY = 'bg|ink|phosphor|cyan|magenta|amber|crimson';

/**
 * A colour utility class with a colour of its own, after any variant and with
 * any opacity: `bg-white`, `hover:text-gray-500`, `border-slate-300/50`. The
 * `ui-*` tokens, `transparent`, `current` and `inherit` are not colours of
 * their own, so they pass; so do `text-base`, `border-2` and the like.
 */
const COLOUR_CLASS = new RegExp(
  `(?<![\\w-])(?:${COLOUR_UTILITY})-(?:white|black|(?:${PALETTE})-\\d{2,3}|(?:${LEGACY})(?:-[a-z]+)?)(?:/[\\w.[\\]]+)?(?![\\w-])`,
  'g',
);

type State = 'code' | 'line-comment' | 'block-comment' | "'" | '"' | '`';

/**
 * The source with its comments blanked out: same length and line breaks, so
 * matches keep their line numbers. Strings and template literals stay, so
 * `//` in a URL is not a comment. A heuristic, not a parser: a quote inside a
 * regular expression literal can confuse it until the end of that line.
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
      // A quoted string ends at its quote, or at the line break it cannot cross.
      if (char === state || (char === '\n' && state !== '`')) state = 'code';
      result += char;
    }
  }
  return result;
}

/** The colour literals and colour classes outside comments, with their 1-based line. */
function colourLiterals(source: string): Array<{ line: number; literal: string }> {
  return withoutComments(source)
    .split('\n')
    .flatMap((text, index) =>
      [...text.matchAll(HEX_COLOUR), ...text.matchAll(COLOUR_FUNCTION), ...text.matchAll(COLOUR_CLASS)].map(
        match => ({ line: index + 1, literal: match[0] }),
      ),
    );
}

/** `./controls/Button.tsx` → `src/ui/controls/Button.tsx`, `../design/apply.ts` → `src/design/apply.ts`. */
function repositoryPath(key: string): string {
  return key.startsWith('./') ? `src/ui/${key.slice(2)}` : key.replace(/^\.\.\//, 'src/');
}

/** Every colour literal in the sources, as `path:line: literal`. */
function findings(sources: Record<string, string>): string[] {
  return Object.entries(sources).flatMap(([key, source]) =>
    colourLiterals(source).map(({ line, literal }) => `${repositoryPath(key)}:${line}: ${literal}`),
  );
}

/** A copy of a scanned source with one class swapped for another, and the line it lands on. */
function plant(key: string, from: string, to: string): { source: string; line: number } {
  const original = SOURCES[key];
  if (original === undefined || !original.includes(from)) throw new Error(`${from} is not in ${key}`);
  const source = original.replace(from, to);
  return { source, line: source.slice(0, source.indexOf(to)).split('\n').length };
}

describe('colourLiterals', () => {
  it('finds hex colours in strings, classes and templates, with their line', () => {
    const source = ["const a = 'bg-[#fff]';", 'const b = "#0F7B4A";', 'const c = `#0f7b4a80`;', "const d = '#abcd';"];
    expect(colourLiterals(source.join('\n'))).toEqual([
      { line: 1, literal: '#fff' },
      { line: 2, literal: '#0F7B4A' },
      { line: 3, literal: '#0f7b4a80' },
      { line: 4, literal: '#abcd' },
    ]);
  });

  it('finds rgb(), rgba(), hsl() and hsla()', () => {
    const source = ["shadow: 'rgba(0,0,0,0.3)',", "color: 'RGB(1, 2, 3)',", 'fill: `hsl(120 50% 50%)`,', "x: 'hsla(0,0%,0%,.5)'"];
    expect(colourLiterals(source.join('\n')).map(found => found.literal.toLowerCase())).toEqual([
      'rgba(',
      'rgb(',
      'hsl(',
      'hsla(',
    ]);
  });

  it('skips line and block comments but keeps the line numbers', () => {
    const source = [
      '// #fff in a comment',
      '/* rgb(0, 0, 0)',
      '   still a comment, #000 */ const x = "#123";',
      "const url = 'https://example.com'; const y = '#456'; // #789",
    ];
    expect(colourLiterals(source.join('\n'))).toEqual([
      { line: 3, literal: '#123' },
      { line: 4, literal: '#456' },
    ]);
  });

  it('ignores what only looks like a colour', () => {
    const source = [
      "const anchor = 'docs#add';",
      "const entity = '&#123;';",
      "const id = '#hello';",
      "const five = '#12345';",
      'const call = torgb(1);',
    ];
    expect(colourLiterals(source.join('\n'))).toEqual([]);
  });

  it('finds white, black and Tailwind palette classes, with variants and opacity, and their line', () => {
    const source = [
      "const a = 'flex bg-white p-2';",
      'const b = "text-gray-500 hover:bg-black";',
      'const c = `border-slate-300/50 ring-offset-white [&>option]:text-red-600`;',
      "const d = cx('border-x-sky-200', 'shadow-black/20', 'from-indigo-50 via-violet-950 to-white');",
      "const e = 'fill-black stroke-zinc-700 outline-rose-500 ring-teal-400 decoration-lime-300';",
      "const f = 'accent-emerald-600 caret-orange-500 placeholder:text-neutral-400 divide-stone-200';",
    ];
    expect(colourLiterals(source.join('\n'))).toEqual([
      { line: 1, literal: 'bg-white' },
      { line: 2, literal: 'text-gray-500' },
      { line: 2, literal: 'bg-black' },
      { line: 3, literal: 'border-slate-300/50' },
      { line: 3, literal: 'ring-offset-white' },
      { line: 3, literal: 'text-red-600' },
      { line: 4, literal: 'border-x-sky-200' },
      { line: 4, literal: 'shadow-black/20' },
      { line: 4, literal: 'from-indigo-50' },
      { line: 4, literal: 'via-violet-950' },
      { line: 4, literal: 'to-white' },
      { line: 5, literal: 'fill-black' },
      { line: 5, literal: 'stroke-zinc-700' },
      { line: 5, literal: 'outline-rose-500' },
      { line: 5, literal: 'ring-teal-400' },
      { line: 5, literal: 'decoration-lime-300' },
      { line: 6, literal: 'accent-emerald-600' },
      { line: 6, literal: 'caret-orange-500' },
      { line: 6, literal: 'text-neutral-400' },
      { line: 6, literal: 'divide-stone-200' },
    ]);
  });

  it("finds the legacy theme's colour classes, which the redesign replaces", () => {
    const source = ["'text-phosphor bg-bg-panel border-crimson text-ink-dim bg-amber-dim text-cyan'"];
    expect(colourLiterals(source.join('\n')).map(found => found.literal)).toEqual([
      'text-phosphor',
      'bg-bg-panel',
      'border-crimson',
      'text-ink-dim',
      'bg-amber-dim',
      'text-cyan',
    ]);
  });

  it('lets the token classes, transparent, current and inherit through, and classes in comments', () => {
    const source = [
      "const tokens = 'bg-ui-surface text-ui-ink border-ui-control-line outline-ui-accent-text hover:bg-ui-raised';",
      "const keywords = 'bg-transparent border-transparent fill-current stroke-current text-inherit';",
      "const others = 'text-base text-left text-[15px] border-2 border-b-2 ring-2 outline-none shadow-none';",
      "const more = 'outline-offset-2 ring-offset-2 divide-y from-50% bg-cover [box-shadow:var(--t-shadow)]';",
      "const native = '[accent-color:var(--t-accent)] [color-scheme:var(--t-color-scheme)]';",
      '// bg-white text-gray-500 in a comment',
    ];
    expect(colourLiterals(source.join('\n'))).toEqual([]);
  });
});

describe('the component library, the design engine and the screens', () => {
  it('are all scanned, except the tokens, the colour maths and the tests', () => {
    const scanned = Object.keys(SOURCES);
    expect(scanned).toEqual(
      expect.arrayContaining([
        './cx.ts',
        './controls/Button.tsx',
        '../design/appearance.ts',
        '../design/apply.ts',
        '../screens/types.ts',
      ]),
    );
    expect(scanned.filter(key => /\.test\.tsx?$|\/(tokens|color)\.ts$/.test(key))).toEqual([]);
  });

  it('hold no colour literals', () => {
    expect(findings(SOURCES)).toEqual([]);
  });

  // The redesigned screens (src/screens) and the app around them (src/app)
  // follow the rule from the first commit of each unit.
  it('report a colour in a screen or in the app with its path', () => {
    const planted = {
      '../screens/chat/ChatPane.tsx': "const row = 'flex bg-white';",
      '../app/MainScreen.tsx': 'const ink = "#fff";',
    };
    expect(findings(planted)).toEqual(['src/screens/chat/ChatPane.tsx:1: bg-white', 'src/app/MainScreen.tsx:1: #fff']);
  });

  // Mutation check: the same scan, on copies of real components with a colour planted.
  it('would report a bg-white or a text-gray-500 planted in a component', () => {
    const button = plant('./controls/Button.tsx', 'border-transparent bg-ui-accent ', 'border-transparent bg-white ');
    const select = plant('./controls/Select.tsx', 'text-ui-muted', 'text-gray-500');
    const planted = { ...SOURCES, './controls/Button.tsx': button.source, './controls/Select.tsx': select.source };
    expect(findings(planted)).toEqual([
      `src/ui/controls/Button.tsx:${button.line}: bg-white`,
      `src/ui/controls/Select.tsx:${select.line}: text-gray-500`,
    ]);
  });
});
