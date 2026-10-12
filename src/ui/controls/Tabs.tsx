import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { useRovingChoice } from './roving';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** The content of the tab; mounted only while the tab is selected. */
  panel: ReactNode;
}

/** The tab list needs an accessible name. */
type TabsName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export type TabsProps<T extends string> = TabsName & {
  items: readonly TabItem<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
  panelClassName?: string;
};

/**
 * Tabs with their panels (WAI-ARIA tabs, automatic activation): one Tab stop
 * on the selected tab, Left and Right move and activate (wrapping around),
 * Home and End go to the ends, and the panel can take the focus. Each tab
 * controls its panel and names it. The selected tab is the raised pill of the
 * prototype plus an accent border at its foot, since the pill alone stays
 * under 3:1 against the track. A border, not a background: forced colours
 * keep it. They would also draw the clear border of the other tabs, so those
 * drop it there.
 *
 * Reflow (accesibilidad.md §4.7): the row never grows past its box, so
 * nothing scrolls sideways from 20 rem. Tabs that do not fit side by side, at
 * their longest word, go on to another row; each row shares its width out
 * equally, as one row does when they fit. A label breaks inside a word only
 * when that word alone is wider than the row.
 */
export function Tabs<T extends string>(props: TabsProps<T>) {
  const { items, value, onValueChange, className, panelClassName } = props;
  const baseId = useId();
  const tabId = (index: number) => `${baseId}tab${index}`;
  const panelId = (index: number) => `${baseId}panel${index}`;
  const { selectedIndex, tabStop, select, itemRef, onItemKeyDown } = useRovingChoice<T, HTMLButtonElement>(
    items,
    value,
    onValueChange,
    'horizontal',
  );

  return (
    <div className={cx('flex flex-col gap-4', className)}>
      <div
        role="tablist"
        aria-label={props['aria-label']}
        aria-labelledby={props['aria-labelledby']}
        className="flex flex-wrap gap-1 rounded-ui-lg bg-ui-raised p-1"
      >
        {items.map((item, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              key={item.value}
              ref={itemRef(index)}
              id={tabId(index)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(index)}
              tabIndex={index === tabStop ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={onItemKeyDown(index)}
              className={cx(
                'relative inline-flex min-h-11 max-w-full flex-1 items-center justify-center rounded-ui px-2.5 text-center font-ui text-sm font-semibold',
                'transition-colors reduce-motion:transition-none',
                'border-b-2',
                selected
                  ? 'border-ui-accent-text bg-ui-surface text-ui-ink [box-shadow:var(--t-shadow)]'
                  : 'border-transparent bg-transparent text-ui-muted hover:text-ui-ink forced-colors:border-b-0',
                FOCUS_RING,
              )}
            >
              <span className="min-w-0 break-words">{item.label}</span>
            </button>
          );
        })}
      </div>
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <div
            key={item.value}
            role="tabpanel"
            id={panelId(index)}
            aria-labelledby={tabId(index)}
            tabIndex={0}
            hidden={!selected}
            className={cx(FOCUS_RING, panelClassName)}
          >
            {selected ? item.panel : null}
          </div>
        );
      })}
    </div>
  );
}
