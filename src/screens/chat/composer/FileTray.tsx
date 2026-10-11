/**
 * The files about to go with the next message: one row each, with its
 * preview or a file icon, its name and "Quitar". While a file is being
 * prepared (its metadata stripped, its preview made) it says so. The list
 * scrolls on its own when it grows. A "Quitar" goes with its row, so the
 * focus it held goes to the next file's, or to the text box when none
 * follows.
 */
import { FileText, X } from 'lucide-react';
import { useRef } from 'react';
import { useT } from '../../../lib/i18n';
import type { ProcessedFile } from '../../../lib/media';
import { safeInlineRasterSrc } from '../../../lib/safe-media';
import { IconButton, iconSize } from '../../../ui';

export interface TrayItem {
  id: string;
  name: string;
  status: 'preparing' | 'ready';
  /** Once ready. */
  file?: ProcessedFile;
}

export interface FileTrayProps {
  items: readonly TrayItem[];
  /** The files are on their way: none can be taken out. */
  busy: boolean;
  onRemove(id: string): void;
  /** Puts the focus in the text box. */
  focusBox(): void;
}

export function FileTray({ items, busy, onRemove, focusBox }: FileTrayProps) {
  const t = useT();
  /** The "Quitar" button of each file, by its id. */
  const removers = useRef(new Map<string, HTMLButtonElement>());
  return (
    <ul aria-label={t('composer2.files')} className="flex max-h-[12rem] flex-col gap-1 overflow-y-auto">
      {items.map((item, index) => {
        const preview = safeInlineRasterSrc(item.file?.thumb);
        const next = items[index + 1];
        return (
          <li key={item.id} className="flex items-center gap-3 rounded-ui bg-ui-raised py-1 pe-1 ps-1.5">
            {preview ? (
              <img src={preview} alt="" className="h-11 w-11 shrink-0 rounded-ui object-cover" />
            ) : (
              <span className="grid h-11 w-11 shrink-0 place-items-center text-ui-muted">
                <FileText {...iconSize('lg')} aria-hidden="true" />
              </span>
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-ui-md font-semibold text-ui-ink [overflow-wrap:anywhere]">{item.name}</span>
              {item.status === 'preparing' && <span className="text-ui-sm text-ui-muted">{t('composer2.preparing')}</span>}
            </span>
            <IconButton
              ref={node => {
                if (node) removers.current.set(item.id, node);
                else removers.current.delete(item.id);
              }}
              aria-label={t('composer2.removeFile', { name: item.name })}
              variant="muted"
              icon={<X {...iconSize('lg')} />}
              disabled={busy}
              onClick={event => {
                const focused = event.currentTarget === document.activeElement;
                onRemove(item.id);
                if (!focused) return;
                const target = next && removers.current.get(next.id);
                if (target) target.focus();
                else focusBox();
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}
