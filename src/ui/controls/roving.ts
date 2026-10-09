/**
 * Roving tabindex for single-choice groups (RadioCardGroup, Segmented, Tabs):
 * the group is one Tab stop, and the arrow keys, Home and End move the focus
 * between its items, as the WAI-ARIA radio group and tabs patterns describe.
 */
import { useRef, type KeyboardEvent } from 'react';

/** Which arrows move: left/right, up/down, or all four (radio groups). */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

const FORWARD: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowRight'],
  vertical: ['ArrowDown'],
  both: ['ArrowRight', 'ArrowDown'],
};

const BACKWARD: Record<RovingOrientation, readonly string[]> = {
  horizontal: ['ArrowLeft'],
  vertical: ['ArrowUp'],
  both: ['ArrowLeft', 'ArrowUp'],
};

/**
 * The item a key moves the focus to, among `disabled.length` items: the
 * arrows go to the next or the previous enabled item, wrapping around, and
 * Home and End to the first and the last. Null when the key does not move or
 * no item is enabled.
 */
export function rovingIndex(
  key: string,
  current: number,
  disabled: readonly boolean[],
  orientation: RovingOrientation,
): number | null {
  const count = disabled.length;
  const enabled = (index: number) => !disabled[index];
  const step = (direction: 1 | -1, from: number): number | null => {
    for (let offset = 1; offset <= count; offset += 1) {
      const index = (((from + direction * offset) % count) + count) % count;
      if (enabled(index)) return index;
    }
    return null;
  };
  if (key === 'Home') return step(1, -1);
  if (key === 'End') return step(-1, count);
  if (FORWARD[orientation].includes(key)) return step(1, current);
  if (BACKWARD[orientation].includes(key)) return step(-1, current);
  return null;
}

/** The item that takes the Tab stop: the selected one if enabled, else the first enabled one, else -1. */
export function tabStopIndex(selected: number, disabled: readonly boolean[]): number {
  if (selected >= 0 && selected < disabled.length && !disabled[selected]) return selected;
  return disabled.indexOf(false);
}

interface RovingGroupOptions {
  disabled: readonly boolean[];
  orientation: RovingOrientation;
  /** Called with the item that just took the focus, to select it. */
  onNavigate: (index: number) => void;
}

/**
 * Refs and a keydown handler for the items of a roving group: a navigation key
 * focuses the target item and reports it, so the group can select it. Keys
 * with Alt, Ctrl or Meta are left to the browser and the system.
 */
export function useRovingGroup<E extends HTMLElement>({ disabled, orientation, onNavigate }: RovingGroupOptions) {
  const items = useRef<Array<E | null>>([]);
  return {
    itemRef: (index: number) => (node: E | null) => {
      items.current[index] = node;
    },
    onItemKeyDown: (index: number) => (event: KeyboardEvent<E>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = rovingIndex(event.key, index, disabled, orientation);
      if (target === null) return;
      event.preventDefault();
      items.current[target]?.focus();
      onNavigate(target);
    },
  };
}

interface Choice<T extends string> {
  value: T;
  disabled?: boolean;
}

/**
 * A single choice whose focus moves and selects at once, as radio groups and
 * tabs with automatic activation do. `select` reports a change only for an
 * enabled choice other than the current one.
 */
export function useRovingChoice<T extends string, E extends HTMLElement>(
  choices: readonly Choice<T>[],
  value: T | null,
  onValueChange: (value: T) => void,
  orientation: RovingOrientation,
) {
  const disabled = choices.map(choice => Boolean(choice.disabled));
  const selectedIndex = choices.findIndex(choice => choice.value === value);
  const select = (index: number) => {
    const choice = choices[index];
    if (choice && !choice.disabled && choice.value !== value) onValueChange(choice.value);
  };
  const { itemRef, onItemKeyDown } = useRovingGroup<E>({ disabled, orientation, onNavigate: select });
  return { selectedIndex, tabStop: tabStopIndex(selectedIndex, disabled), select, itemRef, onItemKeyDown };
}
