import { LoaderCircle } from 'lucide-react';
import { forwardRef, type ButtonHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { ICON_SIZE } from '../../design/type';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { DISABLED } from './styles';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerSolid';
export type ButtonSize = 'md' | 'lg';

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `md` is 44 px tall, `lg` 48 px. */
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Shows a spinner in place of the icon, sets aria-busy and disables the button without dimming it. */
  loading?: boolean;
}

export type ButtonProps = ButtonBaseProps &
  (
    | {
        /** `secondary` by default, so a view has to choose its one primary action. */
        variant?: Exclude<ButtonVariant, 'dangerSolid'>;
        /** A decorative icon before the label, such as a lucide icon. */
        leadingIcon?: ReactNode;
      }
    | {
        /**
         * A solid red button sits beside the green primary ones, and red and
         * green merge for many people: it always carries an icon, and its
         * label says what it does with a verb ("Eliminar contacto"). The
         * outlined `danger` differs by shape already.
         */
        variant: 'dangerSolid';
        leadingIcon: ReactElement;
      }
  );

/**
 * Text on its fill: accentInk on accent and surface on danger reach 4.5:1 in
 * every theme. The transparent variants sit on any surface and turn `raised`
 * (or `dangerBg`) on hover.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-ui-accent font-bold text-ui-accent-ink enabled:hover:brightness-95',
  secondary: 'border-ui-line bg-transparent font-semibold text-ui-ink enabled:hover:bg-ui-raised',
  ghost: 'border-transparent bg-transparent font-semibold text-ui-ink enabled:hover:bg-ui-raised',
  danger: 'border-ui-danger bg-transparent font-bold text-ui-danger enabled:hover:bg-ui-danger-bg',
  dangerSolid: 'border-transparent bg-ui-danger font-bold text-ui-surface enabled:hover:brightness-95',
};

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-11 px-4',
  lg: 'min-h-12 px-5',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    fullWidth = false,
    leadingIcon,
    loading = false,
    disabled,
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  const icon = loading ? (
    <LoaderCircle size={ICON_SIZE.md} className="animate-spin reduce-motion:animate-none" />
  ) : (
    leadingIcon
  );
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-ui border py-2 text-center font-ui text-base leading-tight',
        'transition-colors reduce-motion:transition-none',
        SIZES[size],
        VARIANTS[variant],
        fullWidth && 'w-full',
        FOCUS_RING,
        // A loading button is disabled but not dimmed: it is busy, not unavailable.
        loading ? 'cursor-progress' : DISABLED,
        className,
      )}
      {...rest}
    >
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
});
