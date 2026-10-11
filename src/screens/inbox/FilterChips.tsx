/**
 * The filter chips of the inbox (Main:82-86) and of the call log
 * (PropLlamadas:55-59): toggle buttons, one pressed, built from a list so a
 * later filter (such as message requests) is one more entry.
 *
 * One Tab stop on the pressed chip; the arrows, Home and End move and choose,
 * as in the other single-choice groups of the library. 44 px tall, where the
 * boards drew 36. The pressed chip is told by more than its raised fill and
 * accent border: it is bold while the others are not, and with a Windows
 * contrast theme it takes the system's highlight colours. A hidden bold copy
 * of each label keeps the chips from moving when the choice does.
 */
import { cx, FOCUS_RING, useRovingChoice } from '../../ui';

export interface FilterChip<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  'aria-label': string;
  chips: readonly FilterChip<T>[];
  value: T;
  onValueChange(value: T): void;
  className?: string;
}

const PRESSED =
  'border-ui-accent-text bg-ui-raised font-bold forced-colors:border-[color:Highlight] forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:[forced-color-adjust:none]';

export function FilterChips<T extends string>({ chips, value, onValueChange, className, ...name }: FilterChipsProps<T>) {
  const { selectedIndex, tabStop, select, itemRef, onItemKeyDown } = useRovingChoice<T, HTMLButtonElement>(
    chips,
    value,
    onValueChange,
    'horizontal',
  );
  return (
    <div role="group" aria-label={name['aria-label']} className={cx('flex flex-wrap gap-1.5', className)}>
      {chips.map((chip, index) => {
        const pressed = index === selectedIndex;
        return (
          <button
            key={chip.value}
            ref={itemRef(index)}
            type="button"
            aria-pressed={pressed}
            tabIndex={index === tabStop ? 0 : -1}
            data-label={chip.label}
            onClick={() => select(index)}
            onKeyDown={onItemKeyDown(index)}
            className={cx(
              'inline-flex min-h-11 flex-col items-center justify-center rounded-full border px-3 font-ui text-ui-md text-ui-ink',
              'after:invisible after:h-0 after:font-bold after:content-[attr(data-label)]',
              'transition-colors reduce-motion:transition-none',
              pressed ? PRESSED : 'border-ui-line bg-transparent font-normal hover:bg-ui-raised',
              FOCUS_RING,
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}
