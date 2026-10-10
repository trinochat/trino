import { CircleAlert } from 'lucide-react';
import { useId, useMemo, type ReactNode } from 'react';
import { ICON_SIZE } from '../../design/type';
import { cx } from '../cx';
import { hasContent, joinIds } from './aria';
import { FieldContext, type FieldControl } from './field-context';

export interface FieldProps {
  label: ReactNode;
  /** Help below the control, such as the expected format. */
  hint?: ReactNode;
  /** The validation message; while present the control is invalid. */
  error?: ReactNode;
  /** id of the control; generated when absent. */
  id?: string;
  className?: string;
  /** One control: Input, PasswordInput, Textarea or Select. */
  children: ReactNode;
}

/**
 * A labelled form control: renders the label, the hint and the error, and
 * passes their ids to the control inside (`htmlFor`, `aria-describedby`,
 * `aria-invalid`). The error has an icon, so it is not told by colour alone.
 */
export function Field({ label, hint, error, id, className, children }: FieldProps) {
  const generated = useId();
  const controlId = id ?? `${generated}control`;
  const hintId = hasContent(hint) ? `${controlId}-hint` : undefined;
  const errorId = hasContent(error) ? `${controlId}-error` : undefined;
  const control = useMemo<FieldControl>(
    () => ({ id: controlId, describedBy: joinIds(hintId, errorId), invalid: errorId !== undefined }),
    [controlId, hintId, errorId],
  );
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      <label htmlFor={controlId} className="font-ui text-ui-base font-semibold text-ui-ink">
        {label}
      </label>
      <FieldContext.Provider value={control}>{children}</FieldContext.Provider>
      {hintId ? (
        <p id={hintId} className="m-0 font-ui text-ui-md text-ui-muted">
          {hint}
        </p>
      ) : null}
      {errorId ? (
        <p id={errorId} className="m-0 flex items-start gap-1.5 font-ui text-ui-md font-semibold text-ui-danger">
          <CircleAlert aria-hidden="true" size={ICON_SIZE.md} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
