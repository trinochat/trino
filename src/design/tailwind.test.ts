import postcss from 'postcss';
import tailwindcss, { type Config } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js?raw';
import { cssVariables, resolveTokens } from './appearance';
import { ICON_SIZE, TYPE_SCALE, type IconSizeName } from './type';

// Components reach the tokens through Tailwind classes such as `bg-ui-surface`,
// so every colour, radius and font family token needs its entry in
// tailwind.config.js, pointing at the CSS variable.
const variables = cssVariables(resolveTokens('calma', 'light', 'verde'));
const colours = Object.keys(variables).filter(name => variables[name].startsWith('#'));
const shapesAndFonts = [
  '--t-radius',
  '--t-radius-lg',
  '--t-bubble-radius',
  '--t-avatar-radius',
  '--t-font',
  '--t-display',
  '--t-mono',
  '--t-label-font',
];

describe('Tailwind namespace for the design tokens', () => {
  it('covers every colour token', () => {
    expect(colours.length).toBeGreaterThan(20);
    expect(colours.filter(name => !tailwindConfig.includes(`var(${name})`))).toEqual([]);
  });

  it('covers the radii and font families', () => {
    expect(shapesAndFonts.filter(name => !tailwindConfig.includes(`var(${name})`))).toEqual([]);
  });
});

/** The real config, as Tailwind loads it. */
const [config] = Object.values(
  import.meta.glob<Config>('../../tailwind.config.js', { eager: true, import: 'default' }),
);

/** The utilities Tailwind builds from the real config for one class list. */
async function compile(classes: string): Promise<string> {
  const plugin = tailwindcss({ ...config, content: [{ raw: `<div class="${classes}"></div>` }] });
  return (await postcss([plugin]).process('@tailwind utilities;', { from: undefined })).css;
}

// The accessibility settings mark <html> (apply.ts, applyAccessibility), and
// these variants read the marks, so the app's own settings decide: also
// `more-contrast:` and `reduce-motion:` rather than Tailwind's media variants.
describe('Tailwind variants for the accessibility settings', () => {
  it.each([
    ['safe-colors', ':root[data-vision="safe"]'],
    ['more-contrast', ':root[data-contrast="more"]'],
    ['reduce-motion', ':root[data-motion="reduce"]'],
    ['full-motion', ':root[data-motion="full"]'],
    ['wide-spacing', ':root[data-spacing="wide"]'],
  ])('%s: applies under %s', async (variant, root) => {
    const css = await compile(`${variant}:underline`);
    // Tailwind escapes the colon of the class name in the selector.
    expect(css).toContain(`${root} .${variant}\\:underline {`);
  });

  it('stack with the state variants, as the focus ring needs', async () => {
    const css = await compile('more-contrast:focus-visible:outline-[3px]');
    expect(css).toContain(
      String.raw`:root[data-contrast="more"] .more-contrast\:focus-visible\:outline-\[3px\]:focus-visible {`,
    );
  });
});

// The type scale (type.ts) reaches the components as `text-ui-xs` …
// `text-ui-title`: the same size and line height, in rem.
describe('the type scale in Tailwind', () => {
  it('gives every step a text-ui-* class with its size and line height', async () => {
    const names = Object.keys(TYPE_SCALE) as (keyof typeof TYPE_SCALE)[];
    const css = (await compile(names.map(name => `text-ui-${name}`).join(' '))).replace(/\s+/g, ' ');
    const missing = names.filter(name => {
      const { size, lineHeight } = TYPE_SCALE[name];
      return !css.includes(`.text-ui-${name} { font-size: ${size}; line-height: ${lineHeight} }`);
    });
    expect(missing).toEqual([]);
  });
});

// An icon's size reaches the page as its class (iconSize, type.ts), which
// beats the width and height attributes in px: the class has to exist.
describe('the icon sizes in Tailwind', () => {
  it('turn the class of every step into its width and height in rem', async () => {
    const names = Object.keys(ICON_SIZE) as IconSizeName[];
    const sizes = await Promise.all(
      names.map(async name => {
        const css = (await compile(ICON_SIZE[name].className)).replace(/\s+/g, ' ');
        const rem = `${ICON_SIZE[name].px / 16}rem`;
        return [name, css.includes(`{ width: ${rem}; height: ${rem} }`)] as const;
      }),
    );
    expect(sizes.filter(([, found]) => !found).map(([name]) => name)).toEqual([]);
  });
});
