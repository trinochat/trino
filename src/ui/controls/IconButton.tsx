import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from '../cx';
import { DISABLED, FOCUS_RING } from './styles';

/**
 * `ghost` for header actions, `muted` for secondary tools such as the
 * composer's, `secondary` outlined, `primary` for the one main action (send),
 * `danger` for removals in a list.
 */
export type IconButtonVariant = 'ghost' | 'muted' | 'secondary' | 'primary' | 'danger';
export type IconButtonSize = 'md' | 'sm';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'aria-pressed' | 'children'> {
  /** The accessible name: an icon-only button has no other. */
  'aria-label': string;
  /** The icon, such as a lucide icon; hidden from assistive technology. */
  icon: ReactNode;
  variant?: IconButtonVariant;
  /** `md` is a 44 px target; `sm` (36 px) is for dense rows only. */
  size?: IconButtonSize;
  /** Makes it a toggle button: sets aria-pressed and the pressed look. */
  pressed?: boolean;
}

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'border-transparent bg-transparent text-ui-ink enabled:hover:bg-ui-raised',
  muted: 'border-transparent bg-transparent text-ui-muted enabled:hover:bg-ui-raised enabled:hover:text-ui-ink',
  secondary: 'border-ui-line bg-ui-surface text-ui-ink enabled:hover:bg-ui-raised',
  primary: 'border-transparent bg-ui-accent text-ui-accent-ink enabled:hover:brightness-95',
  danger: 'border-transparent bg-transparent text-ui-danger enabled:hover:bg-ui-danger-bg',
};

/** accentText on accentSoft reaches 4.5:1 in every theme. */
const PRESSED = 'border-transparent bg-ui-accent-soft text-ui-accent-text';

const SIZES: Record<IconButtonSize, string> = {
  md: 'h-11 w-11',
  sm: 'h-9 w-9',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, variant = 'ghost', size = 'md', pressed, type = 'button', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-pressed={pressed}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-ui border transition-colors motion-reduce:transition-none',
        SIZES[size],
        pressed ? PRESSED : VARIANTS[variant],
        FOCUS_RING,
        DISABLED,
        className,
      )}
      {...rest}
    >
      <span aria-hidden="true" className="inline-flex">
        {icon}
      </span>
    </button>
  );
});
