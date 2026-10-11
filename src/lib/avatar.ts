/**
 * Your profile photo, made small enough to travel to your contacts (K12): a
 * JPEG data URL of at most 20 KiB once decoded, which is what the backend
 * takes. Redrawing it through a canvas also drops its metadata (EXIF: where,
 * when, which camera), as media.ts does for the pictures you send. The first
 * run (W1) and Settings (W5) use this instead of `processFile(…).thumb`.
 */

/**
 * At most this many bytes once the base64 is decoded: the backend's
 * `PHOTO_MAX_BYTES` (src-tauri/src/profile.rs). The ratchet writes its
 * ciphertext in hex, so a photo of 24 KiB would make a relay frame over the
 * 64 KB the relays accept (docs/perfil-v1.md, "Size").
 */
export const AVATAR_MAX_BYTES = 20 * 1024;
/** The longest side in px, from the first step to the last. */
export const AVATAR_SIZES = [240, 192, 160] as const;
/** The JPEG qualities tried at each size, from the first step to the last. */
export const AVATAR_QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;

/** A decoded picture, and how to encode it. */
export interface AvatarImage {
  /** Its own size in px. */
  width: number;
  height: number;
  /** The picture drawn at `width` × `height` px, as a JPEG data URL of that quality (0 to 1). */
  toJpeg(width: number, height: number, quality: number): string;
  /** Frees what decoding took. */
  close(): void;
}

/** What `makeAvatar` needs from the webview. jsdom has no canvas, so the tests bring their own. */
export interface AvatarDeps {
  /** Decodes the file; rejects when the webview cannot read it as a picture. */
  load(file: File): Promise<AvatarImage>;
}

const JPEG_PREFIX = 'data:image/jpeg;base64,';

/**
 * The file as a profile photo: the first JPEG that fits in `AVATAR_MAX_BYTES`.
 * When one does not fit, the quality goes down first and then the size: every
 * quality at 240 px on the longest side, then at 192 and at 160. The shape is
 * kept and a small picture is never enlarged. Rejects when the file is not a
 * picture, cannot be decoded, or fits at no step.
 */
export async function makeAvatar(file: File, deps: AvatarDeps = { load: loadWithCanvas }): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('avatar: the file is not a picture');
  const image = await deps.load(file);
  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('avatar: the picture has no size');
    for (const side of AVATAR_SIZES) {
      const [width, height] = fit(image.width, image.height, side);
      for (const quality of AVATAR_QUALITIES) {
        const url = image.toJpeg(width, height, quality);
        if (!url.startsWith(JPEG_PREFIX)) throw new Error('avatar: the picture was not encoded as a JPEG');
        if (decodedBytes(url) <= AVATAR_MAX_BYTES) return url;
      }
    }
    throw new Error(`avatar: the picture fits in ${AVATAR_MAX_BYTES} bytes at no step`);
  } finally {
    image.close();
  }
}

/** `width` × `height` scaled down, never up, so its longest side is at most `max`, in whole px. */
function fit(width: number, height: number, max: number): [number, number] {
  const scale = Math.min(1, max / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** The bytes the base64 payload of a data URL decodes to. */
function decodedBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** The webview's own decoder and a canvas. */
function loadWithCanvas(file: File): Promise<AvatarImage> {
  return new Promise((resolve, reject) => {
    const src = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () =>
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        toJpeg: (width, height, quality) => {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('avatar: no 2d canvas');
          // A photo shrinks to a tenth of its size or less: smooth it well.
          context.imageSmoothingQuality = 'high';
          context.drawImage(img, 0, 0, width, height);
          return canvas.toDataURL('image/jpeg', quality);
        },
        close: () => URL.revokeObjectURL(src),
      });
    img.onerror = () => {
      URL.revokeObjectURL(src);
      reject(new Error('avatar: the picture could not be decoded'));
    };
    img.src = src;
  });
}
