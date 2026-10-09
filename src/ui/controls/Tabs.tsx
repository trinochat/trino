import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import { useRovingChoice } from './roving';
import { FOCUS_RING } from './styles';

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
 * prototype plus an accent bar, since the pill alone stays under 3:1 against
 * the track.
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
        className="flex gap-1 rounded-ui-lg bg-ui-raised p-1"
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
                'relative inline-flex min-h-11 flex-1 items-center justify-center rounded-ui px-2.5 text-center font-ui text-sm font-semibold',
                'transition-colors motion-reduce:transition-none',
                selected
                  ? 'bg-ui-surface text-ui-ink [box-shadow:var(--t-shadow)] after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:bg-ui-accent-text'
                  : 'bg-transparent text-ui-muted hover:text-ui-ink',
                FOCUS_RING,
              )}
            >
              {item.label}
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
