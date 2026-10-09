/**
 * Modal dialog of the redesign: a scrim over the app and a surface panel, with
 * the focus kept inside while it is open and given back to the opener after.
 * Every text, the close button's name included, comes from the screen.
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cx } from '../cx';
import { FOCUS_RING, focusableWithin } from '../focus';

export interface DialogProps {
  open: boolean;
  /** Called by Escape, a scrim click and the close button, each when enabled. */
  onClose: () => void;
  /** Visible heading that names the dialog. Or render your own and pass `labelledBy`. */
  title?: ReactNode;
  /** Text under the title that describes the dialog. Or pass `describedBy`. */
  description?: ReactNode;
  /** Id of a heading inside `children` that names the dialog, instead of `title`. */
  labelledBy?: string;
  /** Id of text inside `children` that describes the dialog, instead of `description`. */
  describedBy?: string;
  /** `alertdialog` for a question that interrupts, such as confirming a deletion. */
  role?: 'dialog' | 'alertdialog';
  /** Gets the focus on open; by default the first focusable element, else the panel. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Escape closes the dialog. Default true. */
  closeOnEscape?: boolean;
  /** A click on the scrim closes the dialog. Default true; false for `alertdialog`, which waits for an answer. */
  closeOnScrimClick?: boolean;
  /** Accessible name of the close button in the corner; without it there is no such button. */
  closeLabel?: string;
  /** Maximum width: sm 420 px, md 480 px (default), lg 620 px. */
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
  /** Extra classes for the panel. */
  className?: string;
}

const WIDTHS = { sm: 'max-w-[420px]', md: 'max-w-[480px]', lg: 'max-w-[620px]' } as const;

/**
 * The scrim dims the app with tokens only. `ink` is dark in light mode but
 * light in dark mode, where it would wash the app out, so dark mode dims with
 * `outer`, the darkest colour of the theme (`data-mode` is set on <html> by
 * src/design/apply.ts). Opacity instead of `color-mix()` keeps older WebKit
 * (macOS and Linux WebViews) dimming too.
 */
const SCRIM =
  'absolute inset-0 bg-ui-ink opacity-[0.45] [[data-mode=dark]_&]:bg-ui-outer [[data-mode=dark]_&]:opacity-[0.7]';

/** Open dialogs, oldest first; only the newest one handles the keyboard. */
const openDialogs: object[] = [];

export function Dialog(props: DialogProps) {
  return props.open ? <OpenDialog {...props} /> : null;
}

function OpenDialog({
  onClose,
  title,
  description,
  labelledBy,
  describedBy,
  role = 'dialog',
  initialFocusRef,
  closeOnEscape = true,
  closeOnScrimClick = role === 'dialog',
  closeLabel,
  size = 'md',
  children,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  // The keyboard listener lives as long as the dialog is open; it reads the latest props.
  const latest = useRef({ onClose, closeOnEscape });
  useLayoutEffect(() => {
    latest.current = { onClose, closeOnEscape };
  });

  // Once per opening: the opener and the initial focus belong to that moment.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const opener = document.activeElement;
    const entry = {};
    openDialogs.push(entry);
    (initialFocusRef?.current ?? focusableWithin(panel)[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (openDialogs[openDialogs.length - 1] !== entry || event.defaultPrevented) return;
      if (event.key === 'Escape' && !event.isComposing && latest.current.closeOnEscape) {
        event.preventDefault();
        latest.current.onClose();
      } else if (event.key === 'Tab') {
        keepTabInside(event, panel);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      openDialogs.splice(openDialogs.indexOf(entry), 1);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center p-4 font-ui text-ui-ink motion-safe:animate-fade-in">
      <div aria-hidden="true" data-scrim="" className={SCRIM} onClick={closeOnScrimClick ? () => onClose() : undefined} />
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title != null ? titleId : undefined)}
        aria-describedby={describedBy ?? (description != null ? descriptionId : undefined)}
        tabIndex={-1}
        className={cx(
          'relative flex max-h-full w-full flex-col gap-4 overflow-y-auto rounded-ui-lg border border-ui-line bg-ui-surface p-7 outline-none [box-shadow:var(--t-shadow)]',
          WIDTHS[size],
          className,
        )}
      >
        {title != null && (
          <h2 id={titleId} className={cx('font-ui-display text-[22px] font-bold leading-tight', closeLabel && 'pr-10')}>
            {title}
          </h2>
        )}
        {description != null && (
          <div id={descriptionId} className="text-[15px] leading-normal text-ui-muted">
            {description}
          </div>
        )}
        {children}
        {/* Last in the DOM, so Tab reaches the content first; placed in the corner. */}
        {closeLabel && (
          <button
            type="button"
            aria-label={closeLabel}
            onClick={() => onClose()}
            className={cx(
              'absolute right-5 top-5 flex h-11 w-11 items-center justify-center rounded-ui text-ui-ink hover:bg-ui-raised',
              FOCUS_RING,
            )}
          >
            <X size={20} aria-hidden="true" />
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Wraps Tab and Shift+Tab around the panel, and pulls a focus that escaped back in. */
function keepTabInside(event: KeyboardEvent, panel: HTMLElement) {
  const focusables = focusableWithin(panel);
  if (focusables.length === 0) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const inside = active !== null && panel.contains(active);
  const leaving = event.shiftKey
    ? !inside || active === first || (first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
    : !inside || active === last || (last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  if (leaving) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}
