/**
 * A single choice shown as cards in a row that wraps: the language of the
 * welcome step and the style of Onboarding:128-140. A WAI-ARIA radio group
 * (one Tab stop, the arrows move and select), as RadioCardGroup, but laid out
 * as the boards draw these cards. Each card is named by its label and
 * described by its description; anything else inside is decoration.
 *
 * The checked card shows it three ways: the accent border, a dot drawn as a
 * thick ring (a thin one when not checked), and the system's selection colour
 * on the border under forced colours. Never by colour alone (§3 of
 * accesibilidad.md).
 */
import { useId, type ReactNode } from 'react';
import { FOCUS_RING, cx, useRovingChoice } from '../../../ui';

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
  /** The language of the label, such as `en` for "English". */
  lang?: string;
}

type GroupName = { 'aria-label': string; 'aria-labelledby'?: never } | { 'aria-labelledby': string; 'aria-label'?: never };

export interface ChoiceItem {
  checked: boolean;
  /** Put on the element with the label: it names the card. */
  labelId: string;
  /** Put on the element with the description, when the option has one. */
  descriptionId: string;
}

export type ChoiceGroupProps<T extends string> = GroupName & {
  options: readonly ChoiceOption<T>[];
  value: T;
  onValueChange(value: T): void;
  /** The row of cards. */
  className?: string;
  /** Each card's layout, shape and padding. */
  itemClassName?: string;
  /** More for the checked card, such as a soft fill. */
  checkedClassName?: string;
  renderItem(option: ChoiceOption<T>, item: ChoiceItem): ReactNode;
};

export function ChoiceGroup<T extends string>(props: ChoiceGroupProps<T>) {
  const { options, value, onValueChange, className, itemClassName, checkedClassName, renderItem } = props;
  const baseId = useId();
  const { selectedIndex, tabStop, select, itemRef, onItemKeyDown } = useRovingChoice<T, HTMLButtonElement>(
    options,
    value,
    onValueChange,
    'both',
  );
  return (
    <div role="radiogroup" aria-label={props['aria-label']} aria-labelledby={props['aria-labelledby']} className={className}>
      {options.map((option, index) => {
        const checked = index === selectedIndex;
        const labelId = `${baseId}${index}-label`;
        const descriptionId = `${baseId}${index}-description`;
        return (
          <button
            key={option.value}
            ref={itemRef(index)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-labelledby={labelId}
            aria-describedby={option.description ? descriptionId : undefined}
            tabIndex={index === tabStop ? 0 : -1}
            lang={option.lang}
            onClick={() => select(index)}
            onKeyDown={onItemKeyDown(index)}
            className={cx(
              'border-2 font-ui text-ui-ink transition-colors reduce-motion:transition-none',
              checked
                ? cx('border-ui-accent-text forced-colors:border-[color:Highlight]', checkedClassName)
                : 'border-ui-line hover:bg-ui-raised',
              FOCUS_RING,
              itemClassName,
            )}
          >
            {renderItem(option, { checked, labelId, descriptionId })}
          </button>
        );
      })}
    </div>
  );
}

/** The radio's dot: a thick ring when checked, a thin one when not, so the choice shows by its shape. */
export function ChoiceDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'h-[1.125rem] w-[1.125rem] shrink-0 rounded-full',
        checked ? 'border-[0.3125rem] border-ui-accent-text' : 'border-2 border-ui-muted',
      )}
    />
  );
}
