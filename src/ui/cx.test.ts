import { describe, expect, it } from 'vitest';
import { cx } from './cx';

describe('cx', () => {
  it('joins the truthy class names with single spaces', () => {
    expect(cx('a', false, 'b', undefined, null, '', 'c')).toBe('a b c');
  });

  it('returns an empty string when nothing is truthy', () => {
    expect(cx(false, undefined, null, '')).toBe('');
  });

  it('trims stray whitespace inside each part', () => {
    expect(cx('  a ', 'b  c')).toBe('a b c');
  });
});
