/**
 * A file in a message. A sticker shows as its picture; a photo or a video as
 * its preview, which opens the viewer; any other file as its name and size.
 * Each one but the sticker can be saved with Descargar.
 *
 * Only inline JPEG, PNG, GIF and WebP pictures and MP4, WebM and Ogg videos
 * reach an <img> or a <video> (safe-media.ts): no SVG and no remote address.
 * The whole file comes from the shell's `fetchFile`, once. Inside your bubble
 * everything keeps the bubble's ink, with `bubbleMeMuted` for the size.
 */
import { CircleAlert, Download, FileText, Play } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileRef } from '../../../lib/api';
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

export interface AttachmentProps {
  file: FileRef;
  /** In your own bubble: everything takes its ink. */
  mine: boolean;
  /** The whole file as a data URL (the shell decrypts it). */
  fetchFile(f: FileRef): Promise<string>;
}

export function Attachment({ file, mine, fetchFile }: AttachmentProps) {
  const kind = fileKind(file);
  return kind === 'sticker' ? (
    <StickerPicture file={file} fetchFile={fetchFile} />
  ) : (
    <FileCard file={file} kind={kind} mine={mine} fetchFile={fetchFile} />
  );
}

/** A sticker: its inline picture, or the file, downloaded as soon as it shows. */
function StickerPicture({ file, fetchFile }: Omit<AttachmentProps, 'mine'>) {
  const t = useT();
  const inline = safeInlineRasterSrc(file.thumb);
  const [fetched, setFetched] = useState<string>();
  const [failed, setFailed] = useState(false);
  const latest = useLatest({ file, fetchFile });

  useEffect(() => {
    if (inline) return;
    let live = true;
    const { file: current, fetchFile: fetch } = latest.current;
    fetch(current).then(
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
  }, [inline, file.url, file.sha256, latest]);

  const src = inline ?? fetched;
  if (src) return <img src={src} alt={t('media.sticker')} className="max-h-[9.375rem] max-w-[9.375rem] object-contain" />;
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
function FileCard({ file, kind, mine, fetchFile }: AttachmentProps & { kind: Exclude<FileKind, 'sticker'> }) {
  const t = useT();
  const { lang } = useLang();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const full = useRef<Promise<string> | null>(null);
  const preview = kind === 'file' ? undefined : safeInlineRasterSrc(file.thumb);
  const muted = mine ? 'text-ui-bubble-me-muted' : 'text-ui-muted';

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
  const download = () => run(url => saveAs(url, file.name));
  const action = cx('inline-flex min-h-11 items-center gap-1.5 rounded-ui px-2 text-ui-md font-semibold underline', BUBBLE_RING);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {preview && (
        <button
          type="button"
          onClick={view}
          aria-label={t('media.view', { name: file.name })}
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
          {!preview && <span className="font-semibold [overflow-wrap:anywhere]">{file.name}</span>}
          <span className={cx('text-ui-sm', muted)}>
            {busy ? `${sizeText(file.size, lang)} · ${t('media.downloading')}` : sizeText(file.size, lang)}
          </span>
        </span>
        <button
          type="button"
          onClick={download}
          disabled={busy}
          aria-label={t('media.downloadName', { name: file.name })}
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
          name={file.name}
          url={viewing}
          video={kind === 'video'}
          onClose={() => setViewing(null)}
          onDownload={() => saveAs(viewing, file.name)}
        />
      )}
    </div>
  );
}
