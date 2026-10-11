/**
 * Your stickers, to send one (plan §1.2): the recent ones, newest first, and
 * all of them, in two tabs. "Agregar stickers" adds JPG, PNG, GIF or WebP
 * pictures of up to 5 MB to the library; "Editar" turns each sticker into a
 * button that takes it out. The stickers are one Tab stop, and the arrows
 * move through them. Only safe inline pictures are shown (safe-media.ts).
 */
import { CircleAlert, ImageOff, ImagePlus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StickerInfo } from '../../../lib/api';
import { useT } from '../../../lib/i18n';
import { prefs, type Prefs } from '../../../lib/prefs';
import { INLINE_STICKER_MAX_CHARS, safeInlineRasterSrc } from '../../../lib/safe-media';
import { Button, FOCUS_RING, Tabs, cx, iconSize } from '../../../ui';
import type { StickerApi } from '../../types';
import { useGridFocus } from './grid-focus';

/** What the library takes, as App.tsx said: bigger pictures are refused before they are read. */
const STICKER_MAX_BYTES = 5 * 1024 * 1024;
const COLUMNS = 4;

/** Where your recent stickers are kept: `prefs` (`sticker-recents`), or a test's own. */
export type StickerRecents = Pick<Prefs, 'getStickerRecents' | 'pushStickerRecent'>;

type Tab = 'recent' | 'all';

export interface StickerPickerProps {
  api: StickerApi;
  /** Sends the sticker. */
  onPick(sticker: StickerInfo): void;
  recents?: StickerRecents;
}

export function StickerPicker({ api, onPick, recents = prefs }: StickerPickerProps) {
  const t = useT();
  const [stickers, setStickers] = useState<StickerInfo[] | null>(null);
  const [recentIds, setRecentIds] = useState(() => recents.getStickerRecents());
  const [tab, setTab] = useState<Tab>(() => (recentIds.length > 0 ? 'recent' : 'all'));
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setStickers(await api.list());
    } catch {
      setStickers([]);
      setProblem(t('sticker2.loadFailed'));
    }
  }, [api, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const recent = stickers ? recentIds.flatMap(id => stickers.find(sticker => sticker.id === id) ?? []) : [];
  const shown = tab === 'recent' ? recent : (stickers ?? []);
  const grid = useGridFocus(shown.length, COLUMNS);

  const pick = (sticker: StickerInfo) => {
    recents.pushStickerRecent(sticker.id);
    setRecentIds(recents.getStickerRecents());
    onPick(sticker);
  };

  const remove = async (sticker: StickerInfo) => {
    setProblem(null);
    try {
      await api.remove(sticker.id);
    } catch {
      setProblem(t('sticker2.removeFailed'));
    }
    await load();
  };

  const add = async (files: readonly File[]) => {
    setAdding(true);
    setProblem(null);
    const problems: string[] = [];
    for (const file of files) {
      if (file.size > STICKER_MAX_BYTES) {
        problems.push(t('sticker2.tooBig', { name: file.name }));
        continue;
      }
      try {
        await api.importFile(file);
      } catch {
        problems.push(t('sticker2.addFailed', { name: file.name }));
      }
    }
    await load();
    setTab('all');
    setAdding(false);
    if (problems.length > 0) setProblem(problems.join(' '));
  };

  const empty = tab === 'recent' ? t('sticker2.emptyRecent') : t('sticker2.emptyAll');
  const panel =
    stickers === null ? (
      <p role="status" className="p-3 text-ui-md text-ui-muted">
        {t('sticker2.loading')}
      </p>
    ) : shown.length === 0 ? (
      <p className="p-3 text-ui-md text-ui-muted">{empty}</p>
    ) : (
      <div className="grid grid-cols-4 gap-1 p-2">
        {shown.map((sticker, position) => {
          const src = safeInlineRasterSrc(sticker.data_url, INLINE_STICKER_MAX_CHARS);
          return (
            <button
              key={sticker.id}
              type="button"
              {...grid.itemProps(position)}
              aria-label={t(editing ? 'sticker2.remove' : 'sticker2.send', { n: position + 1 })}
              onClick={() => (editing ? void remove(sticker) : pick(sticker))}
              className={cx(
                'relative flex aspect-square min-h-11 min-w-0 items-center justify-center rounded-ui p-1 hover:bg-ui-raised',
                FOCUS_RING,
              )}
            >
              {src ? (
                <img src={src} alt="" className="max-h-full max-w-full object-contain" />
              ) : (
                <ImageOff {...iconSize('lg', 'text-ui-muted')} aria-hidden="true" />
              )}
              {editing && (
                <span
                  aria-hidden="true"
                  className="absolute end-0.5 top-0.5 grid h-6 w-6 place-items-center rounded-full bg-ui-danger text-ui-surface"
                >
                  <Trash2 {...iconSize('sm')} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    );

  return (
    <div className="flex min-h-0 flex-col">
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        accept="image/jpeg,image/png,image/gif,image/webp"
        onChange={event => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) void add(files);
        }}
      />
      <Tabs
        aria-label={t('sticker2.tabs')}
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'recent', label: t('sticker2.recent'), panel },
          { value: 'all', label: t('sticker2.all'), panel },
        ]}
        className="min-h-0 flex-1 gap-1 p-2"
        panelClassName="min-h-0 overflow-y-auto"
      />
      {problem && (
        <p role="alert" className="mx-3 flex items-start gap-1.5 text-ui-sm font-semibold text-ui-danger">
          <CircleAlert {...iconSize('sm', 'mt-0.5 shrink-0')} aria-hidden="true" />
          {problem}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ui-line p-2">
        <Button
          variant="ghost"
          loading={adding}
          leadingIcon={<ImagePlus {...iconSize('md')} aria-hidden="true" />}
          onClick={() => fileInput.current?.click()}
        >
          {adding ? t('sticker2.adding') : t('sticker2.add')}
        </Button>
        <Button variant="ghost" aria-pressed={editing} disabled={!stickers?.length} onClick={() => setEditing(on => !on)}>
          {t('sticker2.edit')}
        </Button>
      </div>
    </div>
  );
}
