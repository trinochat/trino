/**
 * How big a sticker's picture may be to travel inside its message. Past the
 * ceiling the message would be over the relays' 64 KB and vanish, so the
 * picture stays out and the contact downloads the sticker from the file
 * server instead (Attachment does). App.tsx sent up to 60,000 characters:
 * twice what fits (sticker-limits.test.ts works it out).
 *
 * The shell's `onSendSticker` sends `stickerThumb(s)` as the file's preview.
 */
import type { StickerInfo } from '../../../lib/api';
import { THUMB_MAX_CHARS } from '../../../lib/media';
import { safeInlineRasterSrc } from '../../../lib/safe-media';

/** The longest inline sticker picture, in characters of its data URL: the same as any preview. */
export const STICKER_INLINE_MAX: number = THUMB_MAX_CHARS;

/**
 * The picture to send inline with a sticker, or null to send it without one:
 * when it is too big, or not an inline JPEG, PNG, GIF or WebP, which the
 * backend would refuse, failing the whole sticker.
 */
export function stickerThumb(s: Pick<StickerInfo, 'data_url'>): string | null {
  return safeInlineRasterSrc(s.data_url, STICKER_INLINE_MAX) ?? null;
}
