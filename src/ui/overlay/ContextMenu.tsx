/**
 * The right-click menu (MC-2, PropMenuContextual, approved by David on 12 Oct
 * 2026): the menu of the thing you right-click, at the pointer, or with Shift
 * + F10 or the menu key under the element that has the focus. It is the same
 * menu as the menu button's (Menu, menu-parts.tsx), with the same keys:
 * the arrows, Home and End move between the items, Enter chooses one, and
 * Escape or Tab closes it and gives the focus back to what had it. It flips
 * to the left or up to stay inside the window, and closes on a click outside,
 * a scroll, a resize or the window losing the focus.
 *
 * A screen spreads `triggerProps` on an element and builds the menu of what
 * was hit inside it; `null` opens nothing, as on a blank area, and leaves the
 * event to the guard of MC-1 (src/app/browser-chrome.ts), which takes the
 * webview's menu away. A right-click or a key the hook handles has its
 * default prevented, so the guard and any menu around it leave it alone, and
 * the native menu never shows. Text fields keep the system's menu.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx';
import { isEditableTarget } from '../editable';
import { MENU_BOX, MENU_ITEMS, MenuEntries, isSeparator, moveInMenu, type MenuEntry, type MenuItem } from './menu-parts';

export interface ContextMenuRequest {
  /** The menu's accessible name, such as "Opciones del mensaje". */
  label: string;
  entries: readonly MenuEntry[];
}

/** The menu of what a right-click or the menu key hit, or `null` for none. */
export type ContextMenuBuild = (target: Element) => ContextMenuRequest | null;

/** A box on screen, in px from the window's top left corner; a point is a box with no size. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

/** How far the menu stays from the window's edges, in px. */
const EDGE = 8;

/**
 * One axis of the placement: after the anchor if the menu fits there, else
 * before it, else on the side with more room; always inside the window,
 * from its start edge when it is larger than the window.
 */
function placeOnAxis(before: number, after: number, size: number, view: number): number {
  let start: number;
  if (after + size <= view - EDGE) start = after;
  else if (before - size >= EDGE) start = before - size;
  else start = view - after >= before ? after : before - size;
  return Math.max(EDGE, Math.min(start, view - size - EDGE));
}

/**
 * Where the menu opens: at a point, to its right and below, or under an
 * element, from its left edge; flipped to the left or up when it would leave
 * the window, and kept inside it.
 */
export function placeMenu(anchor: Box, size: Size, view: Size): { left: number; top: number } {
  return {
    left: placeOnAxis(anchor.right, anchor.left, size.width, view.width),
    top: placeOnAxis(anchor.top, anchor.bottom, size.height, view.height),
  };
}

/** Shift + F10 and the menu key: the keyboard's right-click. */
function isMenuKey(event: ReactKeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

interface Open {
  request: ContextMenuRequest;
  anchor: Box;
  /** What had the focus when the menu opened, to give it back. */
  returnTo: HTMLElement | null;
}

/** Where the popup first renders, before it is measured and placed. */
const UNPLACED = { left: 0, top: 0 };

export interface ContextMenuTriggerProps {
  onContextMenu(event: ReactMouseEvent): void;
  onKeyDown(event: ReactKeyboardEvent): void;
  onKeyUp(event: ReactKeyboardEvent): void;
}

export interface ContextMenuHandle {
  /** Spread on the element whose right-click and menu key open the menu. */
  triggerProps: ContextMenuTriggerProps;
  /** The menu while it is open, as a portal: render it anywhere. */
  menu: ReactNode;
  /** Whether the menu is open, for the screen to mark what it belongs to. */
  open: boolean;
}

export function useContextMenu(build: ContextMenuBuild): ContextMenuHandle {
  const [open, setOpen] = useState<Open | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ build, open });
  useLayoutEffect(() => {
    latest.current = { build, open };
  });
  /** The menu key opened the menu: its key-up, which Windows turns into a native menu, is taken too. */
  const keyOpened = useRef(false);

  const show = (target: Element, anchor: Box, returnTo: HTMLElement | null): boolean => {
    const request = latest.current.build(target);
    if (!request || request.entries.every(isSeparator)) return false;
    setOpen({ request, anchor, returnTo });
    return true;
  };

  const close = (returnFocus: boolean) => {
    const returnTo = latest.current.open?.returnTo;
    setOpen(null);
    if (returnFocus && returnTo?.isConnected) returnTo.focus({ preventScroll: true });
  };

  const select = (item: MenuItem) => {
    // The focus goes back first, so a dialog that onSelect opens returns it there.
    close(true);
    item.onSelect();
  };

  const triggerProps: ContextMenuTriggerProps = {
    onContextMenu: event => {
      if (event.isDefaultPrevented()) return;
      const target = event.target;
      if (!(target instanceof Element) || isEditableTarget(target)) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const point = { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY };
      if (show(target, point, active)) event.preventDefault();
    },
    onKeyDown: event => {
      if (event.isDefaultPrevented() || !isMenuKey(event)) return;
      keyOpened.current = false;
      const target = event.target;
      if (!(target instanceof HTMLElement) || isEditableTarget(target)) return;
      const { left, top, right, bottom } = target.getBoundingClientRect();
      if (!show(target, { left, top, right, bottom }, target)) return;
      event.preventDefault();
      keyOpened.current = event.key === 'ContextMenu';
    },
    onKeyUp: event => {
      if (event.key === 'ContextMenu' && keyOpened.current) event.preventDefault();
    },
  };

  // Placed once measured, before it paints; then the first item takes the focus.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!open || !popup) return;
    const { width, height } = popup.getBoundingClientRect();
    const { left, top } = placeMenu(open.anchor, { width, height }, { width: window.innerWidth, height: window.innerHeight });
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    menuRef.current?.querySelector<HTMLElement>(MENU_ITEMS)?.focus();
  }, [open]);

  // `close` reads the open menu through `latest`, so these listeners only follow `open`.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && !!popupRef.current?.contains(target);
    // A click elsewhere puts the focus where it lands.
    const onMouseDown = (event: MouseEvent) => {
      if (!inside(event.target)) close(false);
    };
    // What the menu belongs to may have moved: the menu goes, and the focus goes back without scrolling.
    const onScroll = (event: Event) => {
      if (!inside(event.target)) close(true);
    };
    const onLeave = () => close(true);
    document.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, [open]);

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    // The keys stay with the menu: the screen around it, or a dialog, never hears them.
    event.stopPropagation();
    if (moveInMenu(event, menuRef.current)) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close(true);
    } else if (isMenuKey(event)) {
      event.preventDefault();
      keyOpened.current = event.key === 'ContextMenu';
    }
  };

  const menu =
    open &&
    createPortal(
      <div
        ref={popupRef}
        data-context-menu=""
        style={UNPLACED}
        className={cx(
          'fixed z-50 max-h-[calc(100vh-1rem)] w-max min-w-[14rem] max-w-[calc(100vw-1rem)] overflow-y-auto',
          MENU_BOX,
        )}
        onContextMenu={event => {
          // A right-click inside the menu opens nothing, here or around it.
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={onMenuKeyDown}
        onKeyUp={event => {
          event.stopPropagation();
          if (event.key === 'ContextMenu' && keyOpened.current) event.preventDefault();
        }}
      >
        <div ref={menuRef} role="menu" aria-label={open.request.label} className="flex flex-col">
          <MenuEntries entries={open.request.entries} onSelect={select} />
        </div>
      </div>,
      document.body,
    );

  return { triggerProps, menu, open: open !== null };
}
