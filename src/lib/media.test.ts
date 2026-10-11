import { describe, expect, it, vi } from 'vitest';
import { THUMB_MAX_CHARS, fitThumb } from './media';

/** A JPEG data URL of `chars` characters. */
const jpegOf = (chars: number) => 'data:image/jpeg;base64,' + 'A'.repeat(chars - 'data:image/jpeg;base64,'.length);

describe('fitThumb', () => {
  it('keeps the first preview that fits, starting at 240 px', () => {
    const encode = vi.fn((side: number) => jpegOf(side === 240 ? THUMB_MAX_CHARS : 100));
    expect(fitThumb(encode)).toBe(jpegOf(THUMB_MAX_CHARS));
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledWith(240, expect.any(Number));
  });

  it('lowers the size and the quality, step by step, until the preview fits', () => {
    const encode = vi.fn((side: number, _quality: number) => jpegOf(side > 160 ? THUMB_MAX_CHARS + 1 : 9000));
    expect(fitThumb(encode)).toBe(jpegOf(9000));
    expect(encode.mock.calls.map(([side]) => side)).toEqual([240, 200, 160]);
    const qualities = encode.mock.calls.map(([, quality]) => quality);
    expect([...qualities].sort((a, b) => b - a)).toEqual(qualities);
  });

  it('gives no preview when none fits: the file still goes, without one', () => {
    expect(fitThumb(() => jpegOf(THUMB_MAX_CHARS + 1))).toBeNull();
  });

  it('never keeps a preview over the ceiling the relays allow', () => {
    for (const chars of [THUMB_MAX_CHARS - 1, THUMB_MAX_CHARS, THUMB_MAX_CHARS + 1, 60_000]) {
      const kept = fitThumb(() => jpegOf(chars));
      expect(kept === null || kept.length <= THUMB_MAX_CHARS, String(chars)).toBe(true);
    }
  });
});
