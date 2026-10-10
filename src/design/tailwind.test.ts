import postcss from 'postcss';
import tailwindcss, { type Config } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import tailwindConfig from '../../tailwind.config.js?raw';
import { cssVariables, resolveTokens } from './appearance';

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
