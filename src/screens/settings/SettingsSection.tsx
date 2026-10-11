/**
 * The frame of every view of Settings: a section named by its h2 (22/700,
 * Settings.dc.html), at most 35 rem wide (560 px at 100 %, PropAjustes:124).
 * `autoFocus` moves the focus to the heading when the view opens from
 * somewhere that went away, such as a row of the list on one pane, so the
 * keyboard and the screen reader land on the new view. Through
 * `headingRef` a view gives the heading the focus later, when a control
 * that had it goes away.
 */
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { cx, FOCUS_RING } from '../../ui';

export interface SettingsSectionProps {
  title: ReactNode;
  /** Something before the heading on its row, such as a back button. */
  before?: ReactNode;
  autoFocus?: boolean;
  /** The heading, for the view to give it the focus later. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
  /** 38.75 rem (620 px) instead of 35, for the QR view (PropAjustes:169). */
  wide?: boolean;
  children?: ReactNode;
}

export function SettingsSection({
  title,
  before,
  autoFocus = false,
  headingRef,
  wide = false,
  children,
}: SettingsSectionProps) {
  const headingId = useId();
  const ownHeading = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? ownHeading;
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
    // Once, when the view opens.
  }, []);

  return (
    <section
      aria-labelledby={headingId}
      className={cx('flex w-full min-w-0 flex-col gap-5', wide ? 'max-w-[38.75rem]' : 'max-w-[35rem]')}
    >
      <div className="flex min-w-0 items-center gap-2">
        {before}
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className={cx('m-0 min-w-0 rounded-ui font-ui-display text-ui-title font-bold text-ui-ink', FOCUS_RING)}
        >
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}
