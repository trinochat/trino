import { describe, expect, it } from 'vitest';
import {
  INLINE_MEDIA_MAX_CHARS,
  INLINE_STICKER_MAX_CHARS,
  INLINE_THUMB_MAX_CHARS,
  SAFE_RASTER_MIMES,
  SAFE_VIDEO_MIMES,
  safeInlineRasterSrc,
  safeInlineVideoSrc,
} from './safe-media';

// Characterization of the media guards as App.tsx had them at d8746ff: only
// base64 data: URLs of a few raster and video types, under a size limit, ever
// reach an <img> or a <video>. No SVG, no remote URL, nothing else.

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('safeInlineRasterSrc', () => {
  it('lets JPEG, PNG, GIF and WebP data URLs through unchanged', () => {
    expect(safeInlineRasterSrc(PNG)).toBe(PNG);
    expect(safeInlineRasterSrc('data:image/jpeg;base64,/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ');
    expect(safeInlineRasterSrc('data:image/gif;base64,R0lGOD==')).toBe('data:image/gif;base64,R0lGOD==');
    expect(safeInlineRasterSrc('data:image/webp;base64,UklGRg')).toBe('data:image/webp;base64,UklGRg');
  });

  it('rejects SVG, other spellings, broken base64, remote URLs and nothing', () => {
    for (const src of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:image/PNG;base64,iVBO',
      'data:image/png;base64,abc def',
      'data:image/png,iVBO',
      'https://example.com/a.png',
      '',
      null,
      undefined,
    ]) {
      expect(safeInlineRasterSrc(src), String(src)).toBeUndefined();
    }
  });

  it('rejects anything longer than the limit, the thumbnail one by default', () => {
    expect(safeInlineRasterSrc(PNG, PNG.length)).toBe(PNG);
    expect(safeInlineRasterSrc(PNG, PNG.length - 1)).toBeUndefined();
    const padding = 'A'.repeat(INLINE_THUMB_MAX_CHARS);
    expect(safeInlineRasterSrc(`data:image/png;base64,${padding}`)).toBeUndefined();
    expect(safeInlineRasterSrc(`data:image/png;base64,${padding}`, INLINE_MEDIA_MAX_CHARS)).toBeDefined();
  });
});

describe('safeInlineVideoSrc', () => {
  it('lets MP4, WebM and Ogg data URLs through and rejects the rest', () => {
    expect(safeInlineVideoSrc('data:video/mp4;base64,AAAA')).toBe('data:video/mp4;base64,AAAA');
    expect(safeInlineVideoSrc('data:video/webm;base64,AAAA')).toBe('data:video/webm;base64,AAAA');
    expect(safeInlineVideoSrc('data:video/ogg;base64,AAAA')).toBe('data:video/ogg;base64,AAAA');
    for (const src of ['data:video/quicktime;base64,AAAA', 'data:image/png;base64,AAAA', '', null, undefined]) {
      expect(safeInlineVideoSrc(src), String(src)).toBeUndefined();
    }
  });
});

describe('the media limits and types', () => {
  it('are the ones App.tsx used', () => {
    expect(INLINE_THUMB_MAX_CHARS).toBe(180_000);
    expect(INLINE_STICKER_MAX_CHARS).toBe(7_100_000);
    expect(INLINE_MEDIA_MAX_CHARS).toBe(35_000_000);
    expect([...SAFE_RASTER_MIMES]).toEqual(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
    expect([...SAFE_VIDEO_MIMES]).toEqual(['video/mp4', 'video/webm', 'video/ogg']);
  });
});
