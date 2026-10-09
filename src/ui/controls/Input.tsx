import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '../cx';
import { useFieldControl } from './field-context';
import { DISABLED, FIELD_BOX, FOCUS_RING, fieldBorder } from './styles';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The monospace font, for keys and codes only. */
  mono?: boolean;
}

/** A 48 px text input. Inside a Field it takes the Field's id, description and error state. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono = false, type = 'text', className, ...rest },
  ref,
) {
  const { controlProps, invalid } = useFieldControl(rest);
  return (
    <input
      ref={ref}
      type={type}
      {...rest}
      {...controlProps}
      className={cx(
        'min-h-12 px-3.5',
        FIELD_BOX,
        mono ? 'font-ui-mono' : 'font-ui',
        fieldBorder(invalid),
        FOCUS_RING,
        DISABLED,
        className,
      )}
    />
  );
});
