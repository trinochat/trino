/**
 * An error of Settings or the contact details: an icon and the text, in
 * danger and semibold, read out at once (`role="alert"`). The icon means the
 * error is never told by colour alone.
 */
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { iconSize } from '../../ui';

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-0 flex items-start gap-1.5 font-ui text-ui-md font-semibold text-ui-danger">
      <CircleAlert {...iconSize('md', 'mt-0.5 shrink-0')} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
