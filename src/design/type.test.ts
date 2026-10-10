import { describe, expect, it } from 'vitest';
import { ICON_SIZE, TYPE_SCALE } from './type';

/** `0.875rem` → 0.875; anything but a rem length throws. */
function rem(value: string): number {
  const match = /^(\d*\.?\d+)rem$/.exec(value);
  if (!match) throw new Error(`Expected a rem length, got ${JSON.stringify(value)}`);
  return Number(match[1]);
}

/** The px each entry measures at 100 %, with the 16 px root. */
const pxAt100 = (sizes: Record<string, string>) =>
  Object.fromEntries(Object.entries(sizes).map(([name, size]) => [name, rem(size) * 16]));

describe('the type scale', () => {
  it('has six steps in rem: 12, 13, 14, 15, 16 and 22 px at 100 %', () => {
    const sizes = Object.fromEntries(Object.entries(TYPE_SCALE).map(([name, step]) => [name, step.size]));
    expect(pxAt100(sizes)).toEqual({ xs: 12, sm: 13, md: 14, base: 15, lg: 16, title: 22 });
  });

  // Principle 3 of the redesign: nothing under 12 px.
  it('never goes under 0.75 rem', () => {
    expect(Math.min(...Object.values(TYPE_SCALE).map(step => rem(step.size)))).toBe(0.75);
  });

  it('grows from one step to the next', () => {
    const sizes = Object.values(TYPE_SCALE).map(step => rem(step.size));
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(new Set(sizes).size).toBe(sizes.length);
  });

  it('gives each step a unitless line height, which grows with the text', () => {
    expect(Object.fromEntries(Object.entries(TYPE_SCALE).map(([name, step]) => [name, step.lineHeight]))).toEqual({
      xs: '1.35',
      sm: '1.35',
      md: '1.4',
      base: '1.45',
      lg: '1.4',
      title: '1.25',
    });
  });
});

describe('the icon sizes', () => {
  // Lucide takes a string as its size, so icons grow with the text.
  it('are in rem: 10, 14, 16, 20 and 24 px at 100 %', () => {
    expect(pxAt100(ICON_SIZE)).toEqual({ xs: 10, sm: 14, md: 16, lg: 20, xl: 24 });
  });
});
