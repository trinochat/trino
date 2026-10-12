/**
 * What the menu button (Menu) and the right-click menu (ContextMenu) share,
 * so both look and behave as one menu (PropMenuContextual, approved by David
 * on 12 Oct 2026): the box, the items and the keys that move between them.
 *
 * - **The box:** the surface with the theme's shadow and a hairline border.
 *   Terminal has no shadow, so its border takes the control line, which
 *   keeps 3:1 on every background.
 * - **The items:** 44 px, an icon of 16 px in the muted colour (the danger
 *   item's takes its red), the label, and a shortcut only where the app has
 *   one, as a hint the item also states in `aria-keyshortcuts`. An item that
 *   deletes is red and bold, after a separator: the colour is never the only
 *   sign. The item under the focus is marked by its background, and under
 *   forced colours, which drop backgrounds, by an outline in Highlight.
 * - **A choice:** items with `checked` choose one of several, such as the
 *   microphone of a call. They are `menuitemradio`, and the chosen one has
 *   `aria-checked` and a check in the place of the icon, a shape that does
 *   not rest on colour; the others keep that place empty, so the labels line
 *   up.
 */
import { Check, type LucideIcon } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { iconSize } from '../../design/type';
import { cx } from '../cx';
import { FOCUS_RING_INSET } from '../focus';

export interface MenuItem {
  /** Stable key of the item. */
  id: string;
  label: string;
  /** Drawn at 16 px before the label; lucide's, in the current colour. */
  icon?: LucideIcon;
  /** `danger` for destructive actions, such as deleting a message. */
  tone?: 'default' | 'danger';
  /** A shortcut that does the same: its hint ("Ctrl + C") and its keys for `aria-keyshortcuts` ("Control+C"). */
  shortcut?: { label: string; keys: string };
  onSelect: () => void;
  /** The footnote explains this item: screen readers read it as the item's description. */
  describedByFootnote?: boolean;
  /** Set on every item of a menu that chooses one of several: whether this one is the chosen. */
  checked?: boolean;
}

/** A line between groups of items, such as before the ones that delete. */
export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

export const isSeparator = (entry: MenuEntry): entry is MenuSeparator => 'separator' in entry;

/** The items of a menu, whether they act or choose. */
export const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"]';

/** The box of a menu: its surface, border, shadow and padding. */
export const MENU_BOX =
  'flex flex-col rounded-ui border border-ui-line terminal:border-ui-control-line bg-ui-surface p-1.5 font-ui [box-shadow:var(--t-shadow)]';

const MENU_ITEM = cx(
  'flex min-h-11 w-full items-center gap-3 rounded-ui px-3 text-left text-ui-base hover:bg-ui-raised focus:bg-ui-raised',
  'forced-colors:focus:outline forced-colors:focus:outline-2 forced-colors:focus:outline-offset-[-2px] forced-colors:focus:outline-[color:Highlight]',
  FOCUS_RING_INSET,
);

export interface MenuEntriesProps {
  entries: readonly MenuEntry[];
  onSelect(item: MenuItem): void;
  /** The id of the footnote, for the items it explains. */
  footnoteId?: string;
}

/** The items and separators of a menu, inside its `role="menu"`. */
export function MenuEntries({ entries, onSelect, footnoteId }: MenuEntriesProps) {
  return (
    <>
      {entries.map(entry => {
        if (isSeparator(entry)) {
          return <div key={entry.id} role="separator" className="mx-1 my-1.5 border-t border-ui-line" />;
        }
        const Icon = entry.icon;
        const danger = entry.tone === 'danger';
        const choice = entry.checked !== undefined;
        return (
          <button
            key={entry.id}
            type="button"
            role={choice ? 'menuitemradio' : 'menuitem'}
            aria-checked={choice ? entry.checked : undefined}
            tabIndex={-1}
            aria-keyshortcuts={entry.shortcut?.keys}
            aria-describedby={footnoteId && entry.describedByFootnote ? footnoteId : undefined}
            onClick={() => onSelect(entry)}
            className={cx(MENU_ITEM, danger ? 'font-semibold text-ui-danger' : 'text-ui-ink')}
          >
            {choice &&
              (entry.checked ? (
                <Check {...iconSize('md', 'shrink-0 text-ui-accent-text')} aria-hidden="true" />
              ) : (
                <span data-check-space="" aria-hidden="true" className="size-[1rem] shrink-0" />
              ))}
            {Icon && <Icon {...iconSize('md', danger ? 'shrink-0' : 'shrink-0 text-ui-muted')} aria-hidden="true" />}
            <span className="min-w-0 flex-1">{entry.label}</span>
            {entry.shortcut && (
              <span aria-hidden="true" className="shrink-0 font-ui-mono text-ui-sm text-ui-muted">
                {entry.shortcut.label}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}

/**
 * The arrows, Home and End inside a menu: they move the focus between its
 * items, wrapping at both ends, and skip the separators. Returns whether the
 * key was one of them.
 */
export function moveInMenu(event: ReactKeyboardEvent, menu: HTMLElement | null): boolean {
  const list = Array.from(menu?.querySelectorAll<HTMLElement>(MENU_ITEMS) ?? []);
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
    default:
      return false;
  }
  event.preventDefault();
  next?.focus();
  return true;
}
