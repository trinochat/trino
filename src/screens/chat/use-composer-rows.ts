/**
 * How many lines the composer shows before its text scrolls: 6, or 3 when
 * the chat is shorter than 22 rem, so a short window, or a large text size,
 * still leaves room for the conversation (accesibilidad.md §4.7, rule 6).
 * A ResizeObserver hears the window; the text size changes the root's size
 * and not the pane's, so the style of <html> is watched too.
 */
import { useEffect, useState, type RefObject } from 'react';
import { rootPx } from './root-size';

const SHORT_PANE_REM = 22;
export const COMPOSER_ROWS = { normal: 6, short: 3 } as const;

export function useComposerRows(pane: RefObject<HTMLElement | null>): number {
  const [short, setShort] = useState(false);

  useEffect(() => {
    const element = pane.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const doc = element.ownerDocument;
    const check = () => {
      const height = element.clientHeight;
      setShort(height > 0 && height < SHORT_PANE_REM * rootPx(doc));
    };
    const resize = new ResizeObserver(check);
    resize.observe(element);
    const textSize = new MutationObserver(check);
    textSize.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'] });
    check();
    return () => {
      resize.disconnect();
      textSize.disconnect();
    };
  }, [pane]);

  return short ? COMPOSER_ROWS.short : COMPOSER_ROWS.normal;
}
