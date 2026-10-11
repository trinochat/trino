import { describe, expect, it } from 'vitest';
import { STRENGTH_BARS, passphraseStrength, type Strength } from './passphrase-strength';

const ofLength = (n: number) => 'a'.repeat(n);

describe('passphraseStrength', () => {
  it('has nothing to say about an empty password', () => {
    expect(passphraseStrength('')).toBeNull();
  });

  // The plan's thresholds: under the policy's 10 is weak, 10–14 fair,
  // 15–19 good, 20 or more strong (plan §1.1).
  it.each<[number, Strength]>([
    [1, 'weak'],
    [9, 'weak'],
    [10, 'fair'],
    [14, 'fair'],
    [15, 'good'],
    [19, 'good'],
    [20, 'strong'],
    [64, 'strong'],
  ])('rates %i characters as %s', (length, strength) => {
    expect(passphraseStrength(ofLength(length))).toBe(strength);
  });

  // The policy lives in Rust (passphrase.rs): when it said no, the meter
  // cannot say good, however long the password is.
  it('is weak whenever the policy rejected the password', () => {
    expect(passphraseStrength(ofLength(25), { failsPolicy: true })).toBe('weak');
    expect(passphraseStrength(ofLength(25), { failsPolicy: false })).toBe('strong');
  });

  // Counted as Unicode scalars, as the backend does: an emoji is one, not
  // the two UTF-16 units of `length`.
  it('counts an emoji as one character', () => {
    expect('😀'.repeat(9).length).toBe(18);
    expect(passphraseStrength('😀'.repeat(9))).toBe('weak');
    expect(passphraseStrength('😀'.repeat(10))).toBe('fair');
    expect(passphraseStrength('ñandú'.repeat(3))).toBe('good');
  });
});

describe('STRENGTH_BARS', () => {
  // The meter draws the level with how many of its four bars are full, not
  // with their colour (accesibilidad.md §3.2).
  it('fills one more bar for each level', () => {
    expect(STRENGTH_BARS).toEqual({ weak: 1, fair: 2, good: 3, strong: 4 });
  });
});
