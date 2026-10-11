import { describe, expect, it } from 'vitest';
import { capScalars, countScalars } from './scalars';

// The limits of a name and of "Sobre mí" count Unicode scalars, as the
// backend does (K12): an emoji is one, not the two UTF-16 units of `length`.
describe('countScalars', () => {
  it('counts an emoji as one', () => {
    expect(countScalars('hola')).toBe(4);
    expect(countScalars('😀')).toBe(1);
    expect('😀'.length).toBe(2);
  });
});

describe('capScalars', () => {
  it('keeps at most `max` scalars, never half an emoji', () => {
    expect(capScalars('ab😀cd', 3)).toBe('ab😀');
    expect(capScalars('ab', 3)).toBe('ab');
  });
});
