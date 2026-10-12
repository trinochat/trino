/**
 * Menu button (WAI-ARIA pattern): a trigger and a short list of actions, such
 * as the options of a message. The arrows, Home and End move between items;
 * Escape closes and returns the focus to the trigger; Tab and a click outside
 * close. Every text comes from the screen. Its items and box are the
 * right-click menu's too (menu-parts.tsx, ContextMenu.tsx).
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
import { iconSize } from '../../design/type';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { MENU_BOX, MENU_ITEMS, MenuEntries, isSeparator, moveInMenu, type MenuEntry, type MenuItem } from './menu-parts';

export type { MenuEntry, MenuItem, MenuSeparator } from './menu-parts';

export interface MenuProps {
  /** Accessible name of the trigger, which also names the menu; it must contain any visible trigger text. */
  label: string;
  /** What the trigger shows; an ellipsis icon by default. */
  trigger?: ReactNode;
  /** The items, with separators between groups, such as before the ones that delete. */
  items: readonly MenuEntry[];
  /** Small print under the items, such as the limits of deleting for everyone. */
  footnote?: ReactNode;
  /** The edge of the trigger the menu lines up with. Default `end`. */
  align?: 'start' | 'end';
  /** Extra classes for the trigger. */
  triggerClassName?: string;
  /**
   * `bare` keeps only the trigger's 44 px target and focus ring, and leaves its
   * shape and colours to `triggerClassName`, such as a chevron in the pill of
   * a call's control. Default `ghost`.
   */
  triggerStyle?: 'ghost' | 'bare';
  /** Extra classes for the wrapper. */
  className?: string;
}

type Edge = 'first' | 'last';

export function Menu({
  label,
  trigger,
  items,
  footnote,
  align = 'end',
  triggerClassName,
  triggerStyle = 'ghost',
  className,
}: MenuProps) {
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
  const footnoteHasItem = items.some(item => !isSeparator(item) && item.describedByFootnote);

  const menuItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
  // A choice opens on the chosen item; ArrowUp still goes to the last one.
  const focusEdge = (edge: Edge) => {
    const list = menuItems();
    const chosen = list.find(element => element.getAttribute('aria-checked') === 'true');
    (edge === 'first' ? (chosen ?? list[0]) : list[list.length - 1])?.focus();
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
    if (moveInMenu(event, menuRef.current)) return;
    if (event.key === 'Escape') {
      // Handled here, so a dialog around the menu stays open.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    }
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
          'inline-flex min-h-11 min-w-11 items-center justify-center gap-1',
          triggerStyle === 'ghost' && 'rounded-ui px-2 text-ui-muted hover:bg-ui-raised hover:text-ui-ink',
          FOCUS_RING,
          triggerClassName,
        )}
      >
        {trigger ?? <Ellipsis {...iconSize('lg')} aria-hidden="true" />}
      </button>
      {open && (
        <div
          ref={popupRef}
          className={cx(
            'absolute z-30 w-[17.5rem] max-w-[calc(100vw-2rem)]',
            MENU_BOX,
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
            <MenuEntries entries={items} onSelect={select} footnoteId={hasFootnote ? footnoteId : undefined} />
          </div>
          {hasFootnote && (
            <p id={footnoteId} className="mx-3 mb-2 mt-1 text-ui-sm leading-[1.45] text-ui-muted">
              {footnote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
