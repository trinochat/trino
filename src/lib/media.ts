// media.ts — client-side media prep before sending.
//
// Images are redrawn through a <canvas>, which DROPS all EXIF metadata (GPS
// location, camera model, timestamps) — "sending clean". A small thumbnail is
// produced too, so the recipient sees a preview without downloading the full
// file. Videos: we capture a first-frame thumbnail; the container itself is sent
// as-is (stripping video metadata would need ffmpeg-level tooling).

export interface ProcessedFile {
  name: string;
  mime: string;
  dataB64: string; // full file, base64 (no data: prefix)
  thumb: string | null; // small preview as a data: URL
}

const THUMB_MAX = 240; // px, longest side
const FULL_IMAGE_MAX = 4096;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function processFile(file: File): Promise<ProcessedFile> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error('el archivo supera el límite de 25 MB');
  }
  if (file.type.startsWith('image/')) return processImage(file);
  if (file.type.startsWith('video/')) return processVideo(file);
  return {
    name: file.name,
    mime: file.type || 'application/octet-stream',
    dataB64: await fileToBase64(file),
    thumb: null,
  };
}

async function processImage(file: File): Promise<ProcessedFile> {
  const img = await loadImage(file);
  // Redrawing strips EXIF; capping dimensions also avoids huge canvas allocations.
  const [fullWidth, fullHeight] = fit(
    img.naturalWidth,
    img.naturalHeight,
    FULL_IMAGE_MAX,
  );
  const full = drawToCanvas(img, fullWidth, fullHeight);
  const cleanB64 = stripPrefix(full.toDataURL('image/jpeg', 0.9));
  // Thumbnail.
  const [tw, th] = fit(img.naturalWidth, img.naturalHeight, THUMB_MAX);
  const thumb = drawToCanvas(img, tw, th).toDataURL('image/jpeg', 0.5);
  URL.revokeObjectURL(img.src);
  const base = file.name.replace(/\.[^.]+$/, '') || 'image';
  return { name: `${base}.jpg`, mime: 'image/jpeg', dataB64: cleanB64, thumb };
}

async function processVideo(file: File): Promise<ProcessedFile> {
  let thumb: string | null = null;
  try {
    thumb = await videoThumbnail(file);
  } catch {
    thumb = null;
  }
  return {
    name: file.name,
    mime: file.type || 'video/mp4',
    dataB64: await fileToBase64(file),
    thumb,
  };
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = URL.createObjectURL(file);
  });
}

function drawToCanvas(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function fit(w: number, h: number, max: number): [number, number] {
  if (w <= max && h <= max) return [w, h];
  const scale = max / Math.max(w, h);
  return [w * scale, h * scale];
}

function stripPrefix(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(stripPrefix(String(reader.result)));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function videoThumbnail(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      if (err) reject(err);
    };
    video.onloadeddata = () => {
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
      } catch {
        done(new Error('seek failed'));
      }
    };
    video.onseeked = () => {
      try {
        const [tw, th] = fit(video.videoWidth || THUMB_MAX, video.videoHeight || THUMB_MAX, THUMB_MAX);
        const thumb = drawToCanvas(video, tw, th).toDataURL('image/jpeg', 0.5);
        settled = true;
        URL.revokeObjectURL(url);
        resolve(thumb);
      } catch {
        done(new Error('draw failed'));
      }
    };
    video.onerror = () => done(new Error('video load failed'));
    video.src = url;
  });
}
