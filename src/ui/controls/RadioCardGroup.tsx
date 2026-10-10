import { useId, type ReactNode } from 'react';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { hasContent } from './aria';
import { useRovingChoice } from './roving';
import { DISABLED } from './styles';

export interface RadioCardOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  /** Language of the label, such as `en` for "English" in a language list. */
  lang?: string;
}

/** The group needs an accessible name: a visible label, an aria-label or an aria-labelledby. */
type GroupName =
  | { label: ReactNode; 'aria-label'?: never; 'aria-labelledby'?: never }
  | { 'aria-label': string; label?: never; 'aria-labelledby'?: never }
  | { 'aria-labelledby': string; label?: never; 'aria-label'?: never };

export type RadioCardGroupProps<T extends string> = GroupName & {
  options: readonly RadioCardOption<T>[];
  /** The checked option, or null while none is. */
  value: T | null;
  onValueChange: (value: T) => void;
  className?: string;
};

/**
 * A single choice among a few options shown as cards, each with an optional
 * description (Settings: what notifications show, who can write to you, the
 * language). A WAI-ARIA radio group: one Tab stop, the arrows move and select
 * (wrapping around), Home and End go to the ends, Space selects. The checked
 * card has a 2 px accent border, the soft fill and a filled dot.
 */
export function RadioCardGroup<T extends string>(props: RadioCardGroupProps<T>) {
  const { options, value, onValueChange, className, label } = props;
  const baseId = useId();
  const hasLabel = hasContent(label);
  const { selectedIndex, tabStop, select, itemRef, onItemKeyDown } = useRovingChoice<T, HTMLButtonElement>(
    options,
    value,
    onValueChange,
    'both',
  );

  const group = (
    <div
      role="radiogroup"
      aria-label={props['aria-label']}
      aria-labelledby={hasLabel ? `${baseId}label` : props['aria-labelledby']}
      className={cx('flex flex-col gap-2', !hasLabel && className)}
    >
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        const labelId = `${baseId}option${index}`;
        const descriptionId = hasContent(option.description) ? `${labelId}-description` : undefined;
        return (
          <button
            key={option.value}
            ref={itemRef(index)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={descriptionId}
            tabIndex={index === tabStop ? 0 : -1}
            disabled={option.disabled}
            lang={option.lang}
            onClick={() => select(index)}
            onKeyDown={onItemKeyDown(index)}
            className={cx(
              'flex w-full items-center gap-3 rounded-ui border-2 px-3.5 text-left font-ui text-ui-ink',
              'transition-colors reduce-motion:transition-none',
              descriptionId ? 'min-h-14 py-2.5' : 'min-h-12 py-2',
              checked ? 'border-ui-accent-text bg-ui-accent-soft' : 'border-ui-line bg-transparent enabled:hover:bg-ui-raised',
              FOCUS_RING,
              DISABLED,
            )}
          >
            <span
              aria-hidden="true"
              data-part="dot"
              className={cx(
                'h-[1.125rem] w-[1.125rem] shrink-0 rounded-full border-2',
                checked ? 'border-ui-accent-text bg-ui-accent-text' : 'border-ui-muted bg-transparent',
              )}
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span id={labelId} className="text-ui-base font-semibold">
                {option.label}
              </span>
              {descriptionId ? (
                <span id={descriptionId} className="text-ui-md text-ui-muted">
                  {option.description}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );

  if (!hasLabel) return group;
  return (
    <div className={cx('flex flex-col gap-2', className)}>
      <span id={`${baseId}label`} className="font-ui text-ui-lg font-bold text-ui-ink">
        {label}
      </span>
      {group}
    </div>
  );
}
