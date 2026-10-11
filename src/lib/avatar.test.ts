import { describe, expect, it, vi } from 'vitest';
import {
  AVATAR_MAX_BYTES,
  AVATAR_QUALITIES,
  AVATAR_SIZES,
  makeAvatar,
  type AvatarDeps,
  type AvatarImage,
} from './avatar';

// jsdom has no canvas, so these tests inject the decoder and encoder. What
// the webview's canvas really draws is checked in the app (W1 and W5).

/** A JPEG data URL whose payload decodes to exactly `bytes` bytes. */
const jpegOf = (bytes: number) => 'data:image/jpeg;base64,' + btoa('\xff'.repeat(bytes));

/**
 * A decoded picture of `width` × `height` px whose JPEG weighs, at each step,
 * what `weigh(longest side, quality)` says. It records every encoding.
 */
function picture(width: number, height: number, weigh: (side: number, quality: number) => number) {
  const encoded: [width: number, height: number, quality: number][] = [];
  const close = vi.fn();
  const image: AvatarImage = {
    width,
    height,
    toJpeg: (w, h, quality) => {
      encoded.push([w, h, quality]);
      return jpegOf(weigh(Math.max(w, h), quality));
    },
    close,
  };
  const load = vi.fn(async () => image);
  const deps: AvatarDeps = { load };
  return { deps, load, close, encoded };
}

const photo = (type = 'image/png') => new File([new Uint8Array([137, 80, 78, 71])], 'foto.png', { type });

// What the backend takes (`PHOTO_MAX_BYTES` in src-tauri/src/profile.rs). The
// ratchet writes its ciphertext in hex, so a photo of 24 KiB makes a relay
// frame of about 66 KB, over the 64 KB the relays accept (docs/perfil-v1.md).
const BACKEND_PHOTO_MAX_BYTES = 20 * 1024;

describe('the steps of an avatar', () => {
  it('are 240, 192 and 160 px, with qualities that only go down, under 20 KiB decoded', () => {
    expect(AVATAR_SIZES).toEqual([240, 192, 160]);
    expect(AVATAR_MAX_BYTES).toBe(BACKEND_PHOTO_MAX_BYTES);
    expect(AVATAR_QUALITIES.length).toBeGreaterThan(1);
    expect(AVATAR_QUALITIES.every((q, i) => q > 0 && q <= 1 && (i === 0 || q < AVATAR_QUALITIES[i - 1]!))).toBe(true);
  });
});

describe('makeAvatar', () => {
  it('keeps the first step that fits: 240 px on the longest side, at the best quality', async () => {
    const { deps, encoded, close } = picture(1000, 800, () => 9_000);
    await expect(makeAvatar(photo(), deps)).resolves.toBe(jpegOf(9_000));
    expect(encoded).toEqual([[240, 192, AVATAR_QUALITIES[0]]]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('lowers the quality first, then the size', async () => {
    const last = AVATAR_QUALITIES[AVATAR_QUALITIES.length - 1]!;
    // Only the smallest size at the lowest quality fits.
    const { deps, encoded } = picture(1000, 800, (side, q) => (side === 160 && q === last ? 20_000 : 30_000));
    await expect(makeAvatar(photo(), deps)).resolves.toBe(jpegOf(20_000));
    expect(encoded).toEqual([
      ...AVATAR_QUALITIES.map(q => [240, 192, q]),
      ...AVATAR_QUALITIES.map(q => [192, 154, q]),
      ...AVATAR_QUALITIES.map(q => [160, 128, q]),
    ]);
  });

  it('takes exactly 20 KiB decoded and refuses one byte more', async () => {
    const { deps, encoded } = picture(1000, 800, (_side, q) =>
      q === AVATAR_QUALITIES[0] ? BACKEND_PHOTO_MAX_BYTES + 1 : BACKEND_PHOTO_MAX_BYTES,
    );
    await expect(makeAvatar(photo(), deps)).resolves.toBe(jpegOf(BACKEND_PHOTO_MAX_BYTES));
    expect(encoded).toHaveLength(2);
  });

  it('fails when no step fits, and still frees the picture', async () => {
    const { deps, encoded, close } = picture(1000, 800, () => AVATAR_MAX_BYTES + 1);
    await expect(makeAvatar(photo(), deps)).rejects.toThrow();
    expect(encoded).toHaveLength(AVATAR_SIZES.length * AVATAR_QUALITIES.length);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the shape of a portrait picture and never enlarges a small one', async () => {
    const portrait = picture(600, 1200, () => 9_000);
    await makeAvatar(photo('image/jpeg'), portrait.deps);
    expect(portrait.encoded).toEqual([[120, 240, AVATAR_QUALITIES[0]]]);

    const small = picture(120, 90, () => 3_000);
    await makeAvatar(photo('image/webp'), small.deps);
    expect(small.encoded).toEqual([[120, 90, AVATAR_QUALITIES[0]]]);
  });

  it('refuses a file that is not an image without decoding it', async () => {
    const { deps, load } = picture(1000, 800, () => 9_000);
    await expect(makeAvatar(photo('text/plain'), deps)).rejects.toThrow();
    await expect(makeAvatar(photo(''), deps)).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });

  it('fails when the picture cannot be decoded', async () => {
    const deps: AvatarDeps = { load: vi.fn(async () => Promise.reject(new Error('decode failed'))) };
    await expect(makeAvatar(photo(), deps)).rejects.toThrow();
  });

  // An SVG without a size of its own decodes to 0 × 0: no 1 px avatar.
  it('fails, and frees the picture, when it has no size', async () => {
    const { deps, encoded, close } = picture(0, 0, () => 1_000);
    await expect(makeAvatar(photo('image/svg+xml'), deps)).rejects.toThrow();
    expect(encoded).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  // The backend takes only JPEG, PNG or WebP data URLs (K12). A canvas that
  // could not draw gives "data:,"; nothing else may pass for a JPEG.
  it('fails, and frees the picture, when the encoder does not give a JPEG data URL', async () => {
    for (const url of ['data:,', 'data:image/png;base64,iVBORw0KGgo=']) {
      const close = vi.fn();
      const deps: AvatarDeps = { load: async () => ({ width: 100, height: 100, toJpeg: () => url, close }) };
      await expect(makeAvatar(photo(), deps), url).rejects.toThrow();
      expect(close).toHaveBeenCalledTimes(1);
    }
  });
});
