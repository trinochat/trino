/**
 * Keyboard focus in a grid of buttons, such as the emoji and the stickers:
 * the grid is one Tab stop, the arrows move by one or by a row, and Home and
 * End go to the ends. At an edge the focus stays. Keys with Alt, Ctrl or
 * Meta are left to the browser and the system.
 */
import { useRef, useState, type KeyboardEvent } from 'react';

/** Where a key moves the focus from `index`, among `count` items in rows of `columns`; null for other keys. */
export function gridStep(key: string, index: number, count: number, columns: number): number | null {
  const targets: Record<string, number> = {
    ArrowRight: index + 1,
    ArrowLeft: index - 1,
    ArrowDown: index + columns,
    ArrowUp: index - columns,
    Home: 0,
    End: count - 1,
  };
  const target = targets[key];
  if (target === undefined) return null;
  return target >= 0 && target < count ? target : index;
}

export interface GridItemProps {
  ref(node: HTMLButtonElement | null): void;
  tabIndex: number;
  onFocus(): void;
  onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}

export function useGridFocus(count: number, columns: number) {
  const [active, setActive] = useState(0);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.min(active, Math.max(0, count - 1));
  return {
    /** The props of the item at `index`: its ref, its Tab stop and its keys. */
    itemProps(index: number): GridItemProps {
      return {
        ref: node => {
          items.current[index] = node;
        },
        tabIndex: index === current ? 0 : -1,
        onFocus: () => setActive(index),
        onKeyDown: event => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const next = gridStep(event.key, index, count, columns);
          if (next === null) return;
          event.preventDefault();
          setActive(next);
          items.current[next]?.focus();
        },
      };
    },
    /** Puts the focus on the item that holds the Tab stop. */
    focusCurrent() {
      items.current[current]?.focus();
    },
  };
}
