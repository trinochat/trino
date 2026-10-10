import { describe, expect, it } from 'vitest';
import { identityInitials } from './initials';

// Characterization of the avatar initials as App.tsx computed them at d8746ff.
describe('identityInitials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(identityInitials('Ana Torres')).toBe('AT');
    expect(identityInitials('ana-maría_lópez gómez')).toBe('AG');
    expect(identityInitials('juan.perez')).toBe('JP');
    expect(identityInitials('a  b')).toBe('AB');
  });

  it('takes the first two letters of a single word, in capitals', () => {
    expect(identityInitials('élan')).toBe('ÉL');
    expect(identityInitials('x')).toBe('X');
  });

  it('skips leading @ and # and surrounding spaces', () => {
    expect(identityInitials('  @maria ')).toBe('MA');
    expect(identityInitials('#general')).toBe('GE');
  });

  it('shows ? when nothing is left', () => {
    expect(identityInitials('')).toBe('?');
    expect(identityInitials('   ')).toBe('?');
    expect(identityInitials('@@')).toBe('?');
  });
});
