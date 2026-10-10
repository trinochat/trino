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
 *
 * Forced colours drop backgrounds, so the track also has an outline, clear
 * until then, and the knob is drawn in the text colour: its place still says
 * on or off.
 */
const TRACK = { on: 'bg-ui-accent', off: 'bg-ui-muted' };
const KNOB = { on: 'translate-x-5 bg-ui-accent-ink', off: 'translate-x-0 bg-ui-surface' };
const TRACK_OUTLINE =
  'after:absolute after:inset-0 after:rounded-full after:border after:border-transparent forced-colors:after:border-[color:CanvasText]';
const KNOB_FORCED = 'forced-colors:bg-[color:CanvasText] forced-colors:[forced-color-adjust:none]';

/**
 * An on/off switch: a native button with `role="switch"`, so Space and Enter
 * toggle it. In rem, so it grows with the text and the parts always add up:
 * the track is 3×1.75 rem (48×28 px at 100 %), the knob 1.375 rem with a
 * margin of 0.1875 rem, and it travels 1.25 rem. Its hit area is 44 px tall
 * at 100 %. With `label`,
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
        'relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors reduce-motion:transition-none',
        // Grows the hit area to 44 px without growing the track.
        'before:absolute before:inset-x-0 before:-inset-y-2',
        TRACK_OUTLINE,
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
          'pointer-events-none absolute left-[0.1875rem] top-[0.1875rem] h-[1.375rem] w-[1.375rem] rounded-full',
          'transition-transform reduce-motion:transition-none',
          KNOB[state],
          KNOB_FORCED,
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
        <span id={labelId} className="text-ui-base font-semibold text-ui-ink">
          {label}
        </span>
        {hasDescription ? (
          <span id={descriptionId} className="text-ui-md text-ui-muted">
            {description}
          </span>
        ) : null}
      </label>
      {control}
    </div>
  );
});
