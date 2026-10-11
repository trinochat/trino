/**
 * The scrolling of a log of messages: it opens at the newest one and follows
 * new ones while you are at the end, or when the new one is yours. When you
 * scrolled up to read, it stays there, and `away` asks for a button to go
 * back to the newest. The glide follows the motion setting of the app
 * (`prefersReducedMotion`): with less motion it jumps.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from '../../design/apply';

/** How close to the end, in rem, still counts as at the end: a few lines. */
const NEAR_END_REM = 6;

/** The root size in px, which grows with the text size: 16 px at 100 %. */
function rootPx(doc: Document): number {
  return parseFloat(doc.defaultView?.getComputedStyle(doc.documentElement).fontSize ?? '') || 16;
}

function nearEnd(element: HTMLElement): boolean {
  const below = element.scrollHeight - element.scrollTop - element.clientHeight;
  return below <= NEAR_END_REM * rootPx(element.ownerDocument);
}

export interface StickyScroll {
  ref: RefObject<HTMLDivElement | null>;
  onScroll(): void;
  /** You scrolled up, away from the newest message. */
  away: boolean;
  /** Back to the newest message. */
  toEnd(): void;
}

/**
 * `lastKey` is the key of the newest message, `lastMine` whether it is yours:
 * when it changes, the log follows it, or stays where you are reading.
 */
export function useStickyScroll(lastKey: string | undefined, lastMine: boolean): StickyScroll {
  const ref = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  /** A glide to the end is under way: the scroll events on its way are not you leaving. */
  const gliding = useRef(false);
  const lastTop = useRef(0);
  const seen = useRef(lastKey);
  const [away, setAway] = useState(false);

  const settle = useCallback((end: boolean) => {
    atEnd.current = end;
    setAway(!end);
  }, []);

  const scrollToEnd = useCallback(
    (smooth: boolean) => {
      const element = ref.current;
      if (!element) return;
      const glide = smooth && !prefersReducedMotion(element.ownerDocument);
      gliding.current = glide;
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top: element.scrollHeight, behavior: glide ? 'smooth' : 'auto' });
      } else {
        element.scrollTop = element.scrollHeight;
      }
      settle(true);
    },
    [settle],
  );

  // Open at the newest message, before the first paint.
  useLayoutEffect(() => scrollToEnd(false), [scrollToEnd]);

  useEffect(() => {
    if (lastKey === seen.current) return;
    seen.current = lastKey;
    if (atEnd.current || lastMine) scrollToEnd(true);
  }, [lastKey, lastMine, scrollToEnd]);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const wentUp = element.scrollTop < lastTop.current;
    lastTop.current = element.scrollTop;
    if (nearEnd(element)) {
      gliding.current = false;
      settle(true);
    } else if (!gliding.current || wentUp) {
      // You moved away; a glide only ever goes down.
      gliding.current = false;
      settle(false);
    }
  }, [settle]);

  return { ref, onScroll, away, toEnd: useCallback(() => scrollToEnd(true), [scrollToEnd]) };
}
