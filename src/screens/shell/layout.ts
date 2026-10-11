/**
 * The shell's layout, from its width in rem of the text size in effect
 * (accesibilidad.md §4.7): one pane below 47.5 rem, two from there, and the
 * details beside them from 70 rem. The width is measured with a
 * ResizeObserver; the root size comes from useAccessibility(), because a
 * larger text does not change the window's width, so an observer alone
 * would not notice. Tests inject both.
 */
import { useLayoutEffect, useState, type RefObject } from 'react';
import { ROOT_PX } from '../../design/apply';
import { layoutFor, type ShellLayout } from '../../design/layout';
import { useAccessibility } from '../../design/useAppearance';

/** The element's width in px: measured, or `fixed` when given. */
function useWidth(ref: RefObject<HTMLElement | null>, fixed: number | undefined): number {
  const [measured, setMeasured] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  useLayoutEffect(() => {
    const element = ref.current;
    if (fixed !== undefined || !element) return;
    const read = () => {
      const width = element.getBoundingClientRect().width;
      // Zero before the first layout: keep the window's width until there is one.
      if (width > 0) setMeasured(width);
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, fixed]);
  return fixed ?? measured;
}

export function useShellLayout(ref: RefObject<HTMLElement | null>, width?: number, rootPx?: number): ShellLayout {
  const { effective } = useAccessibility();
  return layoutFor(useWidth(ref, width), rootPx ?? ROOT_PX * effective.textScale);
}
