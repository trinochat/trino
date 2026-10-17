/**
 * A file in a message. A sticker shows as its picture; a photo or a video as
 * its preview, which opens the viewer; any other file as its name and size.
 * Each one but the sticker can be saved with Descargar.
 *
 * Only inline JPEG, PNG, GIF and WebP pictures and MP4, WebM and Ogg videos
 * reach an <img> or a <video> (safe-media.ts): no SVG and no remote address.
 * The whole file comes from the shell's `fetchFile`, once. Inside your bubble
 * everything keeps the bubble's ink, with `bubbleMeMuted` for the size.
 *
 * The message's right-click menu (MC-2) reaches the card's own actions
 * through its `ref`: Ver, Descargar and, for a photo, its picture as a PNG
 * for Copiar imagen. A sticker has no card, so its menu is the message's.
 */
import { CircleAlert, Download, FileText, Play } from 'lucide-react';
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import type { FileRef } from '../../../lib/api';
import { pngOf } from '../../../lib/clipboard-image';
import { fileExtension, shownFileName } from '../../../lib/file-name';
import type { Lang } from '../../../lib/i18n';
import { useT } from '../../../lib/i18n';
import { useLang } from '../../../lib/i18n-context';
import {
  INLINE_MEDIA_MAX_CHARS,
  INLINE_STICKER_MAX_CHARS,
  SAFE_RASTER_MIMES,
  SAFE_VIDEO_MIMES,
  safeInlineRasterSrc,
  safeInlineVideoSrc,
} from '../../../lib/safe-media';
import { cx, iconSize } from '../../../ui';
import { BUBBLE_RING } from '../bubble-ring';
import { MediaViewer } from './MediaViewer';

export type FileKind = 'sticker' | 'image' | 'video' | 'file';

/** A sticker travels as a picture whose name starts with this mark. */
const STICKER_MARK = 'sticker::';
/**
 * The largest sticker fetched as soon as it shows, by the size its sender
 * declared and by the bytes the download may take (TRN-APP-02). A larger one
 * waits for a tap.
 */
export const STICKER_AUTO_MAX_BYTES = 512 * 1024;
/** The largest sticker there is (`MAX_STICKER_BYTES` in the engine): the cap of one fetched on a tap. */
export const STICKER_MAX_BYTES = 5 * 1024 * 1024;

/** What a file is to the chat: a sticker, a picture, a video or any other file. */
export function fileKind(file: Pick<FileRef, 'mime' | 'name'>): FileKind {
  if (SAFE_RASTER_MIMES.has(file.mime)) return file.name.startsWith(STICKER_MARK) ? 'sticker' : 'image';
  if (SAFE_VIDEO_MIMES.has(file.mime)) return 'video';
  return 'file';
}

/** "2 kB", "1,4 MB": the size in the language of the app. */
function sizeText(bytes: number, lang: Lang): string {
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) {
    return new Intl.NumberFormat(lang, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 }).format(
      Math.max(1, Math.round(kilobytes)),
    );
  }
  return new Intl.NumberFormat(lang, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(
    kilobytes / 1024,
  );
}

/** Saves a data URL under a name, as the webview's download. */
function saveAs(url: string, name: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.rel = 'noopener';
  link.click();
}

/** The latest value, for an effect that must not start again when it changes. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** What the card of a photo, a video or any other file offers the message's menu. */
export interface AttachmentHandle {
  kind: Exclude<FileKind, 'sticker'>;
  /** The file's name, which names its menu. */
  name: string;
  /** Opens the viewer: only where the card shows a preview. */
  view?(): void;
  download(): void;
  /** The whole picture as a PNG, for the clipboard: only for a photo with a preview. */
  copyImage?(): Promise<Blob>;
}

export interface AttachmentProps {
  file: FileRef;
  /** In your own bubble: everything takes its ink. */
  mine: boolean;
  /** The whole file as a data URL (the shell decrypts it), refused past `maxBytes` when given. */
  fetchFile(f: FileRef, maxBytes?: number): Promise<string>;
  /** The card's actions, for the message's menu; a sticker leaves it empty. */
  ref?: Ref<AttachmentHandle | null>;
}

export function Attachment({ file, mine, fetchFile, ref }: AttachmentProps) {
  const kind = fileKind(file);
  return kind === 'sticker' ? (
    <StickerPicture file={file} fetchFile={fetchFile} />
  ) : (
    <FileCard file={file} kind={kind} mine={mine} fetchFile={fetchFile} ref={ref} />
  );
}

/**
 * A sticker: its inline picture, or the file, downloaded as soon as it shows
 * when it is small; a larger one on a tap (TRN-APP-02).
 */
function StickerPicture({ file, fetchFile }: Omit<AttachmentProps, 'mine' | 'ref'>) {
  const t = useT();
  const inline = safeInlineRasterSrc(file.thumb);
  const [fetched, setFetched] = useState<string>();
  const [failed, setFailed] = useState(false);
  const automatic = file.size <= STICKER_AUTO_MAX_BYTES;
  const [asked, setAsked] = useState(false);
  const latest = useLatest({ file, fetchFile });

  useEffect(() => {
    if (inline || !(automatic || asked)) return;
    let live = true;
    const { file: current, fetchFile: fetch } = latest.current;
    fetch(current, automatic ? STICKER_AUTO_MAX_BYTES : STICKER_MAX_BYTES).then(
      url => {
        if (!live) return;
        const safe = safeInlineRasterSrc(url, INLINE_STICKER_MAX_CHARS);
        if (safe) setFetched(safe);
        else setFailed(true);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [inline, automatic, asked, file.url, file.sha256, latest]);

  const src = inline ?? fetched;
  if (src) return <img src={src} alt={t('media.sticker')} className="max-h-[9.375rem] max-w-[9.375rem] object-contain" />;
  if (!automatic && !asked) {
    return (
      <button
        type="button"
        onClick={() => setAsked(true)}
        className={cx('inline-flex min-h-11 items-center gap-1.5 rounded-ui px-2 text-ui-md font-semibold underline', BUBBLE_RING)}
      >
        <Download {...iconSize('md')} aria-hidden="true" />
        {t('media.showSticker')}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-ui-sm">
      {failed && <CircleAlert {...iconSize('sm', 'shrink-0')} aria-hidden="true" />}
      {failed ? t('media.stickerFailed') : t('media.loading')}
    </span>
  );
}

type Problem = 'download' | 'unsafe';

/**
 * A picture or a video, whose preview opens the viewer, or any other file;
 * each with its size and Descargar. A picture without a safe preview is
 * saved, not shown.
 */
function FileCard({ file, kind, mine, fetchFile, ref }: AttachmentProps & { kind: Exclude<FileKind, 'sticker'> }) {
  const t = useT();
  const { lang } = useLang();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const full = useRef<Promise<string> | null>(null);
  const preview = kind === 'file' ? undefined : safeInlineRasterSrc(file.thumb);
  const muted = mine ? 'text-ui-bubble-me-muted' : 'text-ui-muted';
  // Shown and saved without bidi or control characters, with the real
  // extension on its own beside the size (TRN-APP-03).
  const name = shownFileName(file.name);
  const extension = preview ? undefined : fileExtension(name);

  /** The whole file, fetched once; a failure lets the next try fetch again. */
  const getFull = () => {
    full.current ??= fetchFile(file).catch(error => {
      full.current = null;
      throw error;
    });
    return full.current;
  };

  const run = async (then: (url: string) => void) => {
    setBusy(true);
    setProblem(null);
    try {
      then(await getFull());
    } catch {
      setProblem('download');
    } finally {
      setBusy(false);
    }
  };

  const view = () =>
    run(url => {
      const safe = kind === 'video' ? safeInlineVideoSrc(url) : safeInlineRasterSrc(url, INLINE_MEDIA_MAX_CHARS);
      if (safe) setViewing(safe);
      else setProblem('unsafe');
    });
  const download = () => run(url => saveAs(url, name));
  /** The whole picture, never more than the viewer would show, drawn as a PNG. */
  const copyImage = () =>
    getFull().then(url => {
      const safe = safeInlineRasterSrc(url, INLINE_MEDIA_MAX_CHARS);
      if (!safe) throw new Error('unsafe picture');
      return pngOf(safe);
    });
  useImperativeHandle(ref, () => ({
    kind,
    name,
    download,
    ...(preview ? { view } : {}),
    ...(preview && kind === 'image' ? { copyImage } : {}),
  }));
  const action = cx('inline-flex min-h-11 items-center gap-1.5 rounded-ui px-2 text-ui-md font-semibold underline', BUBBLE_RING);

  return (
    <div data-attachment="" className="flex min-w-0 flex-col gap-1">
      {preview && (
        <button
          type="button"
          onClick={view}
          aria-label={t('media.view', { name })}
          className={cx('relative block self-start overflow-hidden rounded-ui', BUBBLE_RING)}
        >
          <img src={preview} alt="" className="block max-h-52 max-w-[13.75rem] object-contain" />
          {kind === 'video' && (
            <span aria-hidden="true" className="absolute inset-0 grid place-items-center">
              <span className="grid h-11 w-11 place-items-center rounded-full bg-ui-surface text-ui-ink">
                <Play {...iconSize('lg')} />
              </span>
            </span>
          )}
        </button>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        {!preview && <FileText {...iconSize('lg', 'shrink-0')} aria-hidden="true" />}
        <span className="flex min-w-0 flex-1 flex-col">
          {!preview && <span className="font-semibold [overflow-wrap:anywhere]">{name}</span>}
          <span className="flex flex-wrap gap-x-1.5">
            <span className={cx('text-ui-sm', muted)}>
              {busy ? `${sizeText(file.size, lang)} · ${t('media.downloading')}` : sizeText(file.size, lang)}
            </span>
            {extension && <span className={cx('text-ui-sm font-semibold', muted)}>{extension}</span>}
          </span>
        </span>
        <button
          type="button"
          onClick={download}
          disabled={busy}
          aria-label={t('media.downloadName', { name })}
          className={action}
        >
          <Download {...iconSize('md')} aria-hidden="true" />
          {t('media.download')}
        </button>
      </div>
      {problem && (
        <p role="alert" className="flex items-center gap-1.5 text-ui-sm font-semibold">
          <CircleAlert {...iconSize('sm', 'shrink-0')} aria-hidden="true" />
          {t(problem === 'unsafe' ? 'media.unsafe' : 'media.downloadFailed')}
        </p>
      )}
      {viewing && (
        <MediaViewer
          open
          name={name}
          url={viewing}
          video={kind === 'video'}
          onClose={() => setViewing(null)}
          onDownload={() => saveAs(viewing, name)}
        />
      )}
    </div>
  );
}
