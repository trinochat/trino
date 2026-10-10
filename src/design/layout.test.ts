import { describe, expect, it } from 'vitest';
import { LAYOUT_REM, layoutFor } from './layout';

/**
 * Media queries do not see the text size, so the shell decides its layout
 * with widths in rem: the width of the shell over the size of the root
 * (accesibilidad.md §4.7).
 */
describe('layoutFor', () => {
  it('splits at 47.5 rem for two panes and at 70 rem for the aside: 760 and 1120 px at 100 %', () => {
    expect(LAYOUT_REM).toEqual({ twoPanes: 47.5, aside: 70 });
    expect(layoutFor(759, 16)).toBe('single');
    expect(layoutFor(760, 16)).toBe('double');
    expect(layoutFor(1119, 16)).toBe('double');
    expect(layoutFor(1120, 16)).toBe('double-aside');
  });

  // The windows of the specification, at 100, 125, 150 and 200 %.
  it.each([
    [1024, 16, 'double'],
    [1024, 20, 'double'],
    [1024, 24, 'single'],
    [1024, 32, 'single'],
    [800, 16, 'double'],
    [800, 20, 'single'],
    [640, 16, 'single'],
    [640, 32, 'single'],
    [1400, 20, 'double-aside'],
    [1400, 24, 'double'],
  ] as const)('gives a %i px shell with a %i px root the %s layout', (width, root, layout) => {
    expect(layoutFor(width, root)).toBe(layout);
  });

  it('moves the thresholds with the text: 950 and 1400 px at 125 %', () => {
    expect(layoutFor(949, 20)).toBe('single');
    expect(layoutFor(950, 20)).toBe('double');
    expect(layoutFor(1399, 20)).toBe('double');
    expect(layoutFor(1400, 20)).toBe('double-aside');
  });

  it('takes a root it cannot use as 16 px', () => {
    expect(layoutFor(760, 0)).toBe('double');
    expect(layoutFor(760, Number.NaN)).toBe('double');
    expect(layoutFor(759, -1)).toBe('single');
  });
});
