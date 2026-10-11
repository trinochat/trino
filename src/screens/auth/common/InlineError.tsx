/**
 * An error on a line of its own, with an icon and its words, read at once
 * (role="alert"): the two boxes of the welcome step, a picture that cannot be
 * used. Errors of a single field go in that Field instead.
 */
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { iconSize } from '../../../ui';

export interface InlineErrorProps {
  /** For the aria-describedby of the controls it is about. */
  id?: string;
  children: ReactNode;
}

export function InlineError({ id, children }: InlineErrorProps) {
  return (
    <p id={id} role="alert" className="m-0 flex items-start gap-1.5 font-ui text-ui-md font-semibold text-ui-danger">
      <CircleAlert aria-hidden="true" {...iconSize('md', 'mt-0.5 shrink-0')} />
      <span>{children}</span>
    </p>
  );
}
