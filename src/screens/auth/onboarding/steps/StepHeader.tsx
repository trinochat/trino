/**
 * The heading and the text under it, as every step of Onboarding.dc.html
 * starts. The heading takes the focus when its step appears (OnboardingFlow),
 * so a screen reader reads where the person is; it is not a Tab stop.
 */
import { forwardRef, type ReactNode } from 'react';
import { cx } from '../../../../ui';

export interface StepHeaderProps {
  /** Names the card's landmark too. */
  id: string;
  title: string;
  body?: ReactNode;
  /** 28 px for the first and the last step, 26 px for the others (Onboarding:59, 77, 177). */
  large?: boolean;
}

export const StepHeader = forwardRef<HTMLHeadingElement, StepHeaderProps>(function StepHeader(
  { id, title, body, large = false },
  ref,
) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1
        ref={ref}
        id={id}
        tabIndex={-1}
        className={cx('m-0 font-ui-display font-bold leading-[1.2] outline-none', large ? 'text-[1.75rem]' : 'text-[1.625rem]')}
      >
        {title}
      </h1>
      {body ? <p className="m-0 text-ui-lg leading-[1.55] text-ui-muted">{body}</p> : null}
    </div>
  );
});
