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
