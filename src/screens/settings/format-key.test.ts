import { describe, expect, it } from 'vitest';
import { formatKey } from './format-key';

// "Tu clave" in Settings > Advanced (Settings:264-267): the fingerprint the
// backend gives as lowercase hex in groups of four joined by dots.
describe('formatKey', () => {
  it('writes the fingerprint in capitals, in groups of four', () => {
    expect(formatKey('70a5.83c6.766d.aad7')).toBe('70A5 83C6 766D AAD7');
  });

  it('takes any separator, or none', () => {
    expect(formatKey('70a5:83c6 766d-aad7')).toBe('70A5 83C6 766D AAD7');
    expect(formatKey('70a583c6766daad7')).toBe('70A5 83C6 766D AAD7');
  });

  it('keeps a last group that is shorter', () => {
    expect(formatKey('70a5.83')).toBe('70A5 83');
  });

  it('leaves out what is not hex, and gives nothing for no key', () => {
    expect(formatKey('70a5.83c6…')).toBe('70A5 83C6');
    expect(formatKey('')).toBe('');
  });
});
