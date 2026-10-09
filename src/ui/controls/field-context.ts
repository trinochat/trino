/**
 * How a Field hands its ids to the control inside it: Input, PasswordInput,
 * Textarea and Select read this context, so the label, the hint and the error
 * are wired without the screen passing ids around.
 */
import { createContext, useContext, type AriaAttributes } from 'react';
import { joinIds } from './aria';

export interface FieldControl {
  /** id of the control, the target of the label. */
  id: string;
  /** ids of the hint and the error, space-separated. */
  describedBy: string | undefined;
  /** True while the Field shows an error. */
  invalid: boolean;
}

export const FieldContext = createContext<FieldControl | null>(null);

export interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: AriaAttributes['aria-invalid'];
}

/**
 * The id, aria-describedby and aria-invalid a control renders. Inside a Field
 * the Field's id wins, so the label always points at the control; its hint and
 * error come before the control's own description; and an error makes the
 * control invalid unless the control says otherwise.
 */
export function useFieldControl(own: FieldControlProps): { controlProps: FieldControlProps; invalid: boolean } {
  const field = useContext(FieldContext);
  const ariaInvalid = own['aria-invalid'] ?? (field?.invalid ? true : undefined);
  return {
    controlProps: {
      id: field?.id ?? own.id,
      'aria-describedby': joinIds(field?.describedBy, own['aria-describedby']),
      'aria-invalid': ariaInvalid,
    },
    invalid: ariaInvalid === true || ariaInvalid === 'true',
  };
}
