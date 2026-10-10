/** Day separator in a conversation ("Hoy", "Ayer", a date): a centred pill in the label style. */
import { cx } from '../cx';
import { LABEL_TEXT } from './label';

export interface DaySeparatorProps {
  label: string;
  className?: string;
}

export function DaySeparator({ label, className }: DaySeparatorProps) {
  return (
    <div className={cx('flex justify-center', className)}>
      <span className={cx('rounded-full bg-ui-raised px-2.5 py-1 text-ui-muted', LABEL_TEXT)}>{label}</span>
    </div>
  );
}
