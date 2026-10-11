/**
 * A panel over the composer, such as the emoji or the stickers: a non-modal
 * dialog that opens above its button. On open the focus goes inside, unless
 * its content already took it. Escape closes it, and so does a press
 * outside; a press on its own button is the button's, which toggles it.
 * The focus leaving for anything but the panel and its button closes it
 * too, so it never hides the control that has the focus (WCAG 2.4.11); a
 * focus that goes nowhere, as when the window loses it, leaves it open.
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { focusableWithin } from '../../../ui';

export type PopoverClose = 'escape' | 'outside';

export interface PopoverProps {
  /** Its accessible name, such as "Emojis". */
  label: string;
  /** The button that opens it. */
  anchor: RefObject<HTMLElement | null>;
  onClose(reason: PopoverClose): void;
  children: ReactNode;
}

export function Popover({ label, anchor, onClose, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const panel = ref.current;
    if (panel && !panel.contains(document.activeElement)) focusableWithin(panel)[0]?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || ref.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current('outside');
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [anchor]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      onKeyDown={event => {
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
        // Handled here, so nothing around the chat closes as well.
        event.preventDefault();
        event.stopPropagation();
        close.current('escape');
      }}
      onBlur={event => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || ref.current?.contains(next) || anchor.current?.contains(next)) return;
        close.current('outside');
      }}
      className="absolute bottom-full start-0 z-30 mb-2 flex max-h-[min(24rem,60vh)] w-[19.5rem] max-w-full flex-col overflow-hidden rounded-ui-lg border border-ui-line bg-ui-surface font-ui text-ui-ink [box-shadow:var(--t-shadow)]"
    >
      {children}
    </div>
  );
}
