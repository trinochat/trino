import { describe, expect, it } from 'vitest';
import { DEFICIENCIES, colorDistance, deltaE2000, simulateCvd, toLab, type Deficiency, type Lab } from './color';

/** The channels of a #RRGGBB colour, 0–255. */
function channels(hex: string): number[] {
  return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
}

/** Within one step per channel: the reference rounds halves to even, JavaScript rounds them up. */
function expectHexClose(actual: string, expected: string) {
  expect(actual).toMatch(/^#[0-9A-F]{6}$/);
  const gaps = channels(actual).map((channel, index) => Math.abs(channel - channels(expected)[index]));
  expect(Math.max(...gaps), `${actual} against ${expected}`).toBeLessThanOrEqual(1);
}

describe('deltaE2000', () => {
  // Sharma, Wu and Dalal (2005), "The CIEDE2000 colour-difference formula",
  // test data: pair 1 is the one the specification quotes, the others reach
  // the branches of the hue maths (a grey, hue wrapping around 0°, big steps).
  it.each([
    [1, [50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [7, [50, 0, 0], [50, -1, 2], 2.3669],
    [11, [50, 2.5, 0], [50, 0, -2.5], 4.3065],
    [13, [50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [17, [50, 2.5, 0], [73, 25, -18], 27.1492],
    [25, [60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ] as const)('gives Sharma pair %i its published value', (_pair, first, second, expected) => {
    expect(deltaE2000(first as Lab, second as Lab)).toBeCloseTo(expected, 4);
    expect(deltaE2000(second as Lab, first as Lab)).toBeCloseTo(expected, 4);
  });

  it('is 0 for the same colour', () => {
    expect(deltaE2000([45.3, -40.5, 19], [45.3, -40.5, 19])).toBe(0);
  });
});

describe('toLab', () => {
  it('puts white at L 100 and black at 0, both neutral (D65)', () => {
    const [whiteL, whiteA, whiteB] = toLab('#FFFFFF');
    expect(whiteL).toBeCloseTo(100, 4);
    expect(Math.abs(whiteA) + Math.abs(whiteB)).toBeLessThan(1e-3);
    for (const value of toLab('#000000')) expect(value).toBeCloseTo(0, 10);
  });

  it('matches the reference for the Calma green', () => {
    const [l, a, b] = toLab('#0F7B4A');
    expect(l).toBeCloseTo(45.3048, 3);
    expect(a).toBeCloseTo(-40.5167, 3);
    expect(b).toBeCloseTo(18.9736, 3);
  });
});

describe('simulateCvd', () => {
  // From the independent Python implementation (Viénot 1999 for protan and
  // deutan, Brettel 1997 for tritan, libDaltonLens matrices).
  it.each([
    ['#3FD68A', 'protan', '#CCCC89'],
    ['#3FD68A', 'deutan', '#BABA8D'],
    ['#3FD68A', 'tritan', '#69C9E7'],
    ['#B3261E', 'protan', '#4A4A20'],
    ['#B3261E', 'deutan', '#6B6B0B'],
    ['#B3261E', 'tritan', '#B41E40'],
    ['#FF0000', 'protan', '#5E5E0D'],
    ['#FF0000', 'deutan', '#939300'],
    ['#FF0000', 'tritan', '#FF004E'],
    ['#0000FF', 'tritan', '#006288'],
  ] as const)('turns %s into the reference colour under %s', (hex, deficiency, expected) => {
    expectHexClose(simulateCvd(hex, deficiency), expected);
  });

  it.each(DEFICIENCIES)('leaves white, grey and black alone under %s', deficiency => {
    for (const grey of ['#FFFFFF', '#808080', '#000000']) expectHexClose(simulateCvd(grey, deficiency), grey);
  });

  it('rejects anything but #RRGGBB', () => {
    expect(() => simulateCvd('#FFF', 'deutan')).toThrow();
  });
});

describe('colorDistance', () => {
  // The pairs of the audit: Calma dark's ok and danger, and the light themes'
  // warn and danger, which deuteranopia almost merges.
  it('measures the distance a person with normal vision sees', () => {
    expect(colorDistance('#3FD68A', '#FF8A8A')).toBeCloseTo(66.39, 2);
  });

  it.each([
    ['#3FD68A', '#FF8A8A', 'deutan', 1.48],
    ['#8A5A00', '#B3261E', 'deutan', 0.86],
    ['#8A5A00', '#B3261E', 'tritan', 12.27],
  ] as const)('measures %s against %s under %s on the unrounded simulation', (a, b, deficiency, expected) => {
    expect(colorDistance(a, b, deficiency as Deficiency)).toBeCloseTo(expected, 2);
  });
});
