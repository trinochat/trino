/**
 * The emoji picker of the composer: a short curated list, by group, with no
 * library (plan §1.2). The emoji are one Tab stop; the arrows, Home and End
 * move through them across the groups, and Enter, Space or a click puts one
 * in the message. Below, where the system has its own panel with every
 * emoji, it says how to open it: Win + . on Windows.
 */
import { useEffect, useId } from 'react';
import { useT } from '../../../lib/i18n';
import { FOCUS_RING, cx } from '../../../ui';
import { EMOJI_COLUMNS, EMOJI_GROUPS } from './emoji-data';
import { useGridFocus } from './grid-focus';

/** Which system emoji panel there is to mention. */
export type EmojiPlatform = 'windows' | 'mac' | 'other';

/** The platform of the webview, from its user agent. */
export function detectPlatform(nav: { userAgent: string }): EmojiPlatform {
  if (/Windows/i.test(nav.userAgent)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(nav.userAgent)) return 'mac';
  return 'other';
}

const HINTS: Readonly<Record<EmojiPlatform, string | null>> = {
  windows: 'emoji.hintWindows',
  mac: 'emoji.hintMac',
  other: null,
};

const COUNT = EMOJI_GROUPS.reduce((total, group) => total + group.emojis.length, 0);

export interface EmojiPickerProps {
  platform: EmojiPlatform;
  /** Puts the emoji in the message, where the cursor is. */
  onPick(emoji: string): void;
}

export function EmojiPicker({ platform, onPick }: EmojiPickerProps) {
  const t = useT();
  const baseId = useId();
  const grid = useGridFocus(COUNT, EMOJI_COLUMNS);
  const hint = HINTS[platform];

  // Open with the focus on the first emoji, once.
  useEffect(() => grid.focusCurrent(), []);

  let index = 0;
  return (
    <div className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {EMOJI_GROUPS.map(group => {
          const headingId = `${baseId}-${group.id}`;
          return (
            <section key={group.id} className="flex flex-col gap-1 pb-2">
              <h3 id={headingId} className="px-1 pt-1 text-ui-xs font-semibold text-ui-muted">
                {t(`emoji.group.${group.id}`)}
              </h3>
              <div role="group" aria-labelledby={headingId} className="grid grid-cols-6 gap-0.5">
                {group.emojis.map(emoji => {
                  const position = index;
                  index += 1;
                  return (
                    <button
                      key={emoji}
                      type="button"
                      {...grid.itemProps(position)}
                      onClick={() => onPick(emoji)}
                      className={cx(
                        'flex min-h-11 min-w-0 items-center justify-center rounded-ui text-ui-title leading-none hover:bg-ui-raised',
                        FOCUS_RING,
                      )}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {hint && <p className="border-t border-ui-line px-3 py-2 text-ui-sm text-ui-muted">{t(hint)}</p>}
    </div>
  );
}
