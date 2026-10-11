/**
 * The window's own title bar (the window has no decorations): the Trino mark
 * and the three window buttons, each with its name. It replaces the old bar
 * with TRINO://DESKTOP. The whole bar drags the window, and Tauri maximizes
 * it on a double click.
 *
 * Its height is min(2.25rem, 48px): 36 px at 100 %, growing with the text but
 * never past 48 px, so at 200 % it does not eat the window (accesibilidad.md
 * §4.7, rule 7). That cap is in px on purpose, hence the arbitrary property
 * rather than an `h-[…]` class.
 */
import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../../lib/i18n';
import { FOCUS_RING_INSET, TrinoLogo, cx, iconSize } from '../../../ui';
import { attempt } from '../common/attempt';

/** What the bar needs from the window: `getCurrentWindow()` in the app. */
export interface WindowApi {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
}

export interface WindowTitlebarProps {
  api: WindowApi;
}

/** How long the page has to stop resizing before the bar asks the window again, in ms. */
const RESIZE_PAUSE_MS = 100;

/** 46 px wide and as tall as the bar, like the system's own buttons. */
const BUTTON = cx(
  'inline-flex h-full w-[2.875rem] items-center justify-center text-ui-ink transition-colors reduce-motion:transition-none',
  FOCUS_RING_INSET,
);

export function WindowTitlebar({ api }: WindowTitlebarProps) {
  const t = useT();
  const [maximized, setMaximized] = useState(false);

  // Maximizing also happens outside the bar (a double click, Win + ↑), and
  // always resizes the page: ask again then. Dragging an edge resizes it many
  // times a second, so ask once the resizing pauses.
  useEffect(() => {
    let live = true;
    let pause: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      attempt(() => api.isMaximized()).then(
        value => {
          if (live) setMaximized(value);
        },
        () => {},
      );
    };
    const onResize = () => {
      clearTimeout(pause);
      pause = setTimeout(read, RESIZE_PAUSE_MS);
    };
    read();
    window.addEventListener('resize', onResize);
    return () => {
      live = false;
      clearTimeout(pause);
      window.removeEventListener('resize', onResize);
    };
  }, [api]);

  return (
    <div
      data-tauri-drag-region
      className="flex shrink-0 select-none items-center border-b border-ui-line bg-ui-side font-ui text-ui-ink [height:min(2.25rem,48px)]"
    >
      <TrinoLogo size={20} decorative className="pointer-events-none ms-3 size-[1.25rem] text-ui-accent-text" />
      <div className="ms-auto flex h-full">
        <button type="button" aria-label={t('titlebar.minimize')} onClick={() => api.minimize()} className={cx(BUTTON, 'hover:bg-ui-raised')}>
          <Minus aria-hidden="true" {...iconSize('md')} />
        </button>
        <button
          type="button"
          aria-label={maximized ? t('titlebar.restore') : t('titlebar.maximize')}
          onClick={() => api.toggleMaximize()}
          className={cx(BUTTON, 'hover:bg-ui-raised')}
        >
          {maximized ? <Copy aria-hidden="true" {...iconSize('sm')} /> : <Square aria-hidden="true" {...iconSize('sm')} />}
        </button>
        <button
          type="button"
          aria-label={t('titlebar.close')}
          onClick={() => api.close()}
          className={cx(BUTTON, 'hover:bg-ui-danger hover:text-ui-surface')}
        >
          <X aria-hidden="true" {...iconSize('md')} />
        </button>
      </div>
    </div>
  );
}
