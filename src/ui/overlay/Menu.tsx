/**
 * Menu button (WAI-ARIA pattern): a trigger and a short list of actions, such
 * as the options of a message. The arrows, Home and End move between items;
 * Escape closes and returns the focus to the trigger; Tab and a click outside
 * close. Every text comes from the screen.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Ellipsis } from 'lucide-react';
import { cx } from '../cx';
import { FOCUS_RING, FOCUS_RING_INSET } from './focus';

export interface MenuItem {
  /** Stable key of the item. */
  id: string;
  label: string;
  /** `danger` for destructive actions, such as deleting for everyone. */
  tone?: 'default' | 'danger';
  onSelect: () => void;
  /** The footnote explains this item: screen readers read it as the item's description. */
  describedByFootnote?: boolean;
}

export interface MenuProps {
  /** Accessible name of the trigger, which also names the menu; it must contain any visible trigger text. */
  label: string;
  /** What the trigger shows; an ellipsis icon by default. */
  trigger?: ReactNode;
  items: readonly MenuItem[];
  /** Small print under the items, such as the limits of deleting for everyone. */
  footnote?: ReactNode;
  /** The edge of the trigger the menu lines up with. Default `end`. */
  align?: 'start' | 'end';
  /** Extra classes for the trigger. */
  triggerClassName?: string;
  /** Extra classes for the wrapper. */
  className?: string;
}

type Edge = 'first' | 'last';

export function Menu({ label, trigger, items, footnote, align = 'end', triggerClassName, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<Edge>('first');
  const triggerId = useId();
  const menuId = useId();
  const footnoteId = useId();
  const hasFootnote = footnote != null;
  const footnoteHasItem = items.some(item => item.describedByFootnote);

  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  const focusEdge = (edge: Edge) => {
    const list = menuItems();
    (edge === 'first' ? list[0] : list[list.length - 1])?.focus();
  };
  const openAt = (edge: Edge) => {
    if (open) {
      focusEdge(edge);
      return;
    }
    focusOnOpen.current = edge;
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const select = (item: MenuItem) => {
    // Focus goes back first, so a dialog that onSelect opens returns it to the trigger.
    close(true);
    item.onSelect();
  };

  // On open: open upwards if the menu would leave the window, then focus an item.
  useLayoutEffect(() => {
    if (!open) return;
    const popup = popupRef.current;
    const button = triggerRef.current;
    if (popup && button) {
      const height = popup.getBoundingClientRect().height;
      const { top, bottom } = button.getBoundingClientRect();
      setAbove(bottom + height > window.innerHeight && top >= height);
    }
    focusEdge(focusOnOpen.current);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || !wrapperRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const onTriggerKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    openAt(event.key === 'ArrowDown' ? 'first' : 'last');
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    const list = menuItems();
    const index = list.findIndex(element => element === document.activeElement);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case 'ArrowDown':
        next = list[index < 0 ? 0 : (index + 1) % list.length];
        break;
      case 'ArrowUp':
        next = list[index <= 0 ? list.length - 1 : index - 1];
        break;
      case 'Home':
        next = list[0];
        break;
      case 'End':
        next = list[list.length - 1];
        break;
      case 'Escape':
        // Handled here, so a dialog around the menu stays open.
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  };

  return (
    <div ref={wrapperRef} className={cx('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(true) : openAt('first'))}
        onKeyDown={onTriggerKeyDown}
        className={cx(
          'inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded-ui px-2 text-ui-muted hover:bg-ui-raised hover:text-ui-ink',
          FOCUS_RING,
          triggerClassName,
        )}
      >
        {trigger ?? <Ellipsis size={20} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={popupRef}
          className={cx(
            'absolute z-30 flex w-[280px] max-w-[calc(100vw-32px)] flex-col rounded-ui border border-ui-line bg-ui-surface p-1.5 font-ui [box-shadow:var(--t-shadow)]',
            align === 'end' ? 'right-0' : 'left-0',
            above ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            aria-describedby={hasFootnote && !footnoteHasItem ? footnoteId : undefined}
            onKeyDown={onMenuKeyDown}
            className="flex flex-col"
          >
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-describedby={hasFootnote && item.describedByFootnote ? footnoteId : undefined}
                onClick={() => select(item)}
                className={cx(
                  'flex min-h-[44px] w-full items-center rounded-ui px-3 text-left text-[15px] hover:bg-ui-raised focus:bg-ui-raised',
                  FOCUS_RING_INSET,
                  item.tone === 'danger' ? 'font-semibold text-ui-danger' : 'text-ui-ink',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
          {hasFootnote && (
            <p id={footnoteId} className="mx-3 mb-2 mt-1 text-[13px] leading-[1.45] text-ui-muted">
              {footnote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
