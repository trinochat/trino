/**
 * The bars under the header of the first run (Onboarding:48-53): one per
 * step, filled up to the current one. The header says "Paso n de 5" in words,
 * so the bars are decoration; under forced colours they go and the words stay.
 */
import { cx } from '../../../ui';

export interface StepProgressProps {
  current: number;
  total: number;
}

export function StepProgress({ current, total }: StepProgressProps) {
  return (
    <div aria-hidden="true" className="flex gap-1.5">
      {Array.from({ length: total }, (_, index) => {
        const filled = index < current;
        return (
          <span
            key={index}
            data-filled={filled ? '' : undefined}
            className={cx('h-1 flex-1 rounded-full', filled ? 'bg-ui-accent' : 'bg-ui-line')}
          />
        );
      })}
    </div>
  );
}
