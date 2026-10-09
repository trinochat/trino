import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cx } from '../cx';
import { useFieldControl } from './field-context';
import { DISABLED, FIELD_BOX, FOCUS_RING, fieldBorder } from './styles';

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * A native select (the system's list, keyboard and screen reader support) with
 * the theme's box and a chevron. The ref, the other props and the Field wiring
 * go to the select; `className` goes to the wrapper, for its width.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  const { controlProps, invalid } = useFieldControl(rest);
  return (
    <div className={cx('relative inline-flex', className)}>
      <select
        ref={ref}
        {...rest}
        {...controlProps}
        className={cx(
          'min-h-11 cursor-pointer appearance-none pl-3 pr-10 font-ui [&>option]:bg-ui-surface [&>option]:text-ui-ink',
          FIELD_BOX,
          fieldBorder(invalid),
          FOCUS_RING,
          DISABLED,
        )}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        size={18}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ui-muted"
      />
    </div>
  );
});
