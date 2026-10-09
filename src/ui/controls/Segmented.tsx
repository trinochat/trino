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
 * A compact single choice in one row, such as Calma or Terminal, light or
 * dark. A radio group like RadioCardGroup: one Tab stop, the arrows move and
 * select, Home and End go to the ends. The selected segment is filled with
 * the accent, which reaches 3:1 against the surface.
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
            onClick={() => select(index)}
            onKeyDown={onItemKeyDown(index)}
            className={cx(
              'inline-flex min-h-11 items-center justify-center rounded-ui px-4 font-ui text-[15px] font-semibold',
              'transition-colors motion-reduce:transition-none',
              checked ? 'bg-ui-accent text-ui-accent-ink' : 'bg-transparent text-ui-ink enabled:hover:bg-ui-raised',
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
