import { forwardRef, useId, type ButtonHTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { cx } from '../cx';
import { FOCUS_RING } from '../focus';
import { hasContent, joinIds } from './aria';
import { DISABLED } from './styles';

/** A switch needs an accessible name: a visible label, an aria-label or an aria-labelledby. */
type SwitchName =
  | { label: ReactNode; description?: ReactNode; 'aria-label'?: never; 'aria-labelledby'?: never }
  | { 'aria-label': string; label?: never; description?: never; 'aria-labelledby'?: never }
  | { 'aria-labelledby': string; label?: never; description?: never; 'aria-label'?: never };

export type SwitchProps = SwitchName &
  Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'type' | 'role' | 'children' | 'onChange' | 'value' | 'aria-checked' | 'aria-label' | 'aria-labelledby'
  > & {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  };

/**
 * Track and knob colours, chosen for WCAG 1.4.11 (3:1): `muted` keeps the off
 * track visible on every surface (the decorative `line` is ~1.3:1), and each
 * knob contrasts with its own track. Switch.test.tsx checks all 16 appearances.
 */
const TRACK = { on: 'bg-ui-accent', off: 'bg-ui-muted' };
const KNOB = { on: 'translate-x-5 bg-ui-accent-ink', off: 'translate-x-0 bg-ui-surface' };

/**
 * An on/off switch: a native button with `role="switch"`, so Space and Enter
 * toggle it. The track is 48×28 px and its hit area 48×44 px. With `label`,
 * it renders a row: the label (and description) on the left, which also
 * toggles it, and the switch on the right; `className` goes to that row.
 */
export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  {
    checked,
    onCheckedChange,
    label,
    description,
    id,
    className,
    disabled,
    onClick,
    'aria-describedby': ownDescribedBy,
    ...rest
  },
  ref,
) {
  const generated = useId();
  const switchId = id ?? `${generated}switch`;
  const labelId = `${switchId}-label`;
  const descriptionId = `${switchId}-description`;
  const hasLabel = hasContent(label);
  const hasDescription = hasLabel && hasContent(description);
  const state = checked ? 'on' : 'off';

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) onCheckedChange(!checked);
  };

  const control = (
    <button
      ref={ref}
      type="button"
      role="switch"
      id={switchId}
      aria-checked={checked}
      aria-labelledby={hasLabel ? labelId : undefined}
      aria-describedby={joinIds(hasDescription && descriptionId, ownDescribedBy)}
      disabled={disabled}
      onClick={toggle}
      className={cx(
        'relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors motion-reduce:transition-none',
        // Grows the hit area to 44 px without growing the track.
        'before:absolute before:inset-x-0 before:-inset-y-2',
        TRACK[state],
        FOCUS_RING,
        DISABLED,
        !hasLabel && className,
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        data-part="knob"
        className={cx(
          'pointer-events-none absolute left-[3px] top-[3px] h-[22px] w-[22px] rounded-full',
          'transition-transform motion-reduce:transition-none',
          KNOB[state],
        )}
      />
    </button>
  );

  if (!hasLabel) return control;
  return (
    <div className={cx('flex items-center justify-between gap-4', className)}>
      <label
        htmlFor={switchId}
        className={cx('flex min-w-0 flex-col gap-0.5 font-ui', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}
      >
        <span id={labelId} className="text-[15px] font-semibold text-ui-ink">
          {label}
        </span>
        {hasDescription ? (
          <span id={descriptionId} className="text-sm text-ui-muted">
            {description}
          </span>
        ) : null}
      </label>
      {control}
    </div>
  );
});
