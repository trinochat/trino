import type { ReactNode } from 'react';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { useRovingChoice } from './roving';
import { DISABLED } from './styles';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

/** The group needs an accessible name. */
type SegmentedName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export type SegmentedProps<T extends string> = SegmentedName & {
  options: readonly SegmentedOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  className?: string;
};

/**
 * The selected segment: the accent fill, which reaches 3:1 against the
 * surface, and bold text. Forced colours repaint the fill with the system's
 * background, so it keeps the system's selection colours instead; with more
 * contrast it gains an inner border.
 */
const SELECTED =
  'bg-ui-accent font-bold text-ui-accent-ink forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:[forced-color-adjust:none] more-contrast:ring-2 more-contrast:ring-inset more-contrast:ring-ui-accent-ink';

/**
 * A compact single choice in one row, such as Calma or Terminal, light or
 * dark. A radio group like RadioCardGroup: one Tab stop, the arrows move and
 * select, Home and End go to the ends. The selected segment is filled with
 * the accent and set in bold, the others in normal weight: a difference of
 * shape, not only of colour (600 against 700 would hardly show). A hidden
 * bold copy of a text label (`data-label`) keeps each segment as wide as its
 * bold label, so nothing moves when the selection does.
 */
export function Segmented<T extends string>(props: SegmentedProps<T>) {
  const { options, value, onValueChange, className } = props;
  const { selectedIndex, tabStop, select, itemRef, onItemKeyDown } = useRovingChoice<T, HTMLButtonElement>(
    options,
    value,
    onValueChange,
    'both',
  );

  return (
    <div
      role="radiogroup"
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      className={cx('inline-flex gap-1 rounded-ui-lg border border-ui-line bg-ui-surface p-1', className)}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        return (
          <button
            key={option.value}
            ref={itemRef(index)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={option.disabled}
            data-label={typeof option.label === 'string' ? option.label : undefined}
            onClick={() => select(index)}
            onKeyDown={onItemKeyDown(index)}
            className={cx(
              'inline-flex min-h-11 flex-col items-center justify-center rounded-ui px-4 font-ui text-ui-base',
              'after:invisible after:h-0 after:font-bold after:content-[attr(data-label)]',
              'transition-colors reduce-motion:transition-none',
              checked ? SELECTED : 'bg-transparent font-normal text-ui-ink enabled:hover:bg-ui-raised',
              FOCUS_RING,
              DISABLED,
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
