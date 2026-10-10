import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { hasContent, joinIds } from './aria';
import { COLOR_SCHEME } from './styles';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
}

/**
 * A native checkbox in the accent colour, with its label. The whole label is
 * the target (at least 44 px tall) and dims as a whole when disabled; the
 * label names the box and the description describes it. The ref and the
 * other props go to the input; `className` goes to the label.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, id, className, disabled, 'aria-describedby': ownDescribedBy, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? `${generated}checkbox`;
  const labelId = `${inputId}-label`;
  const descriptionId = `${inputId}-description`;
  const hasDescription = hasContent(description);
  return (
    <label
      className={cx(
        'flex min-h-11 items-start gap-3 py-2.5 font-ui',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={joinIds(hasDescription && descriptionId, ownDescribedBy)}
        className={cx(
          'mt-0.5 h-5 w-5 shrink-0 cursor-[inherit] [accent-color:var(--t-accent)]',
          COLOR_SCHEME,
          FOCUS_RING,
        )}
        {...rest}
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-base text-ui-ink">
          {label}
        </span>
        {hasDescription ? (
          <span id={descriptionId} className="text-ui-md text-ui-muted">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  );
});
