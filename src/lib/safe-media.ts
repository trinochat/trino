/**
 * Guards for media shown inline: only base64 data: URLs of a few raster and
 * video types, under a size limit, reach an <img> or a <video>. No SVG and no
 * remote URLs. Moved out of App.tsx unchanged.
 */
export const SAFE_RASTER_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const SAFE_VIDEO_MIMES = new Set(['video/mp4', 'video/webm', 'video/ogg']);
export const INLINE_THUMB_MAX_CHARS = 180_000;
export const INLINE_STICKER_MAX_CHARS = 7_100_000;
export const INLINE_MEDIA_MAX_CHARS = 35_000_000;

export function safeInlineRasterSrc(
  src?: string | null,
  maxChars = INLINE_THUMB_MAX_CHARS,
): string | undefined {
  if (!src || src.length > maxChars) return undefined;
  const match = src.match(
    /^data:image\/(jpeg|png|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  return match ? src : undefined;
}

export function safeInlineVideoSrc(src?: string | null): string | undefined {
  if (!src || src.length > INLINE_MEDIA_MAX_CHARS) return undefined;
  const match = src.match(/^data:video\/(mp4|webm|ogg);base64,([A-Za-z0-9+/]+={0,2})$/);
  return match ? src : undefined;
}
