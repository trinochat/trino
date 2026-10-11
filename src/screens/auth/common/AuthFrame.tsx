/**
 * The frame of the first run and the unlock screen (Onboarding:39-40,
 * Unlock:49-50): the theme's background, with Terminal's scan lines, and a
 * surface card in the middle. The whole screen scrolls, and the card is
 * centred in a box at least as tall as the screen, so a card taller than the
 * window (800×600, or 200 % text) scrolls from its top instead of losing it.
 */
import type { ReactNode } from 'react';
import { cx } from '../../../ui';

export interface AuthFrameProps {
  /** `wide` for the first run (560 px at 100 %), `narrow` to unlock (440 px). */
  width?: 'wide' | 'narrow';
  /** Id of the heading that names the card's landmark. */
  labelledBy?: string;
  children?: ReactNode;
}

/** The card's width and the gap between its parts, as on the boards. */
const WIDTHS = { wide: 'max-w-[35rem] gap-5', narrow: 'max-w-[27.5rem] gap-[1.125rem]' } as const;

export function AuthFrame({ width = 'wide', labelledBy, children }: AuthFrameProps) {
  return (
    <div className="h-full overflow-y-auto bg-ui-bg [background-image:var(--t-scan)] font-ui text-ui-ink">
      <div className="flex min-h-full items-center justify-center px-4 py-10">
        <main
          aria-labelledby={labelledBy}
          className={cx('flex w-full min-w-0 flex-col rounded-ui-lg border border-ui-line bg-ui-surface p-8', WIDTHS[width])}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
