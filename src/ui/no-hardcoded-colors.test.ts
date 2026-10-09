import { describe, expect, it } from 'vitest';

/**
 * Principle 2 of the redesign: no hand-written colours. Colours live in the
 * tokens (`src/design/tokens.ts`) and reach the screens through the `ui-*`
 * Tailwind classes and the `--t-*` CSS variables, so the component library
 * and the design engine hold no colour literals. Only the tokens, the colour
 * maths (`color.ts`) and the tests may write one.
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
};

/** `#abc`, `#abcd`, `#aabbcc` and `#aabbccdd`, but not `page#add` or `&#123;`. */
const HEX_COLOUR = /(?<![\w&])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
const COLOUR_FUNCTION = /\b(?:rgba?|hsla?)\(/gi;

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

/** The colour literals outside comments, with their 1-based line. */
function colourLiterals(source: string): Array<{ line: number; literal: string }> {
  return withoutComments(source)
    .split('\n')
    .flatMap((text, index) =>
      [...text.matchAll(HEX_COLOUR), ...text.matchAll(COLOUR_FUNCTION)].map(match => ({
        line: index + 1,
        literal: match[0],
      })),
    );
}

/** `./controls/Button.tsx` → `src/ui/controls/Button.tsx`, `../design/apply.ts` → `src/design/apply.ts`. */
function repositoryPath(key: string): string {
  return key.startsWith('./') ? `src/ui/${key.slice(2)}` : key.replace(/^\.\.\//, 'src/');
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
});

describe('the component library and the design engine', () => {
  it('are all scanned, except the tokens, the colour maths and the tests', () => {
    const scanned = Object.keys(SOURCES);
    expect(scanned).toEqual(
      expect.arrayContaining(['./cx.ts', './controls/Button.tsx', '../design/appearance.ts', '../design/apply.ts']),
    );
    expect(scanned.filter(key => /\.test\.tsx?$|\/(tokens|color)\.ts$/.test(key))).toEqual([]);
  });

  it('hold no colour literals', () => {
    const found = Object.entries(SOURCES).flatMap(([key, source]) =>
      colourLiterals(source).map(({ line, literal }) => `${repositoryPath(key)}:${line}: ${literal}`),
    );
    expect(found).toEqual([]);
  });
});
