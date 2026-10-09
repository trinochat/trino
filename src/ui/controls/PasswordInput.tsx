import { Eye, EyeOff } from 'lucide-react';
import { forwardRef, useState, type InputHTMLAttributes } from 'react';
import { cx } from '../cx';
import { useFieldControl } from './field-context';
import { IconButton } from './IconButton';
import { DISABLED, FIELD_BOX, FOCUS_RING, fieldBorder } from './styles';

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Accessible name of the show/hide toggle, such as "Mostrar contraseña". It stays the same; aria-pressed tells the state. */
  toggleLabel: string;
}

/**
 * A password input with a show/hide toggle. The ref, the other props and the
 * Field wiring go to the input; `className` goes to the wrapper. The shown
 * password is kept away from spell checking and autocorrection.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { toggleLabel, className, disabled, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const { controlProps, invalid } = useFieldControl(rest);
  return (
    <div className={cx('relative', className)}>
      <input
        ref={ref}
        type={visible ? 'text' : 'password'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        {...rest}
        {...controlProps}
        className={cx('min-h-12 pl-3.5 pr-14 font-ui', FIELD_BOX, fieldBorder(invalid), FOCUS_RING, DISABLED)}
      />
      <IconButton
        aria-label={toggleLabel}
        pressed={visible}
        variant="muted"
        disabled={disabled}
        icon={visible ? <EyeOff size={20} /> : <Eye size={20} />}
        onClick={() => setVisible(shown => !shown)}
        className="absolute right-0.5 top-1/2 -translate-y-1/2"
      />
    </div>
  );
});
