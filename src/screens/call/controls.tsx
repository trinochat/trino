/**
 * The round controls of a call, on its screen (52 px, Call:156-162) and on
 * the bar over the chats (44 px, Main:51-64). A toggle shows its state with
 * its icon (Mic and MicOff, Video and VideoOff) and with `aria-pressed`, and
 * the pressed fill is drawn in system colours under forced colours, so the
 * state never rests on a colour alone. Hanging up is PhoneOff on `danger`,
 * drawn in `dangerBg`.
 */
import { PhoneOff, type LucideIcon } from 'lucide-react';
import { FOCUS_RING, cx, iconSize } from '../../ui';

export type CallControlSize = 'screen' | 'bar';

const BOX: Readonly<Record<CallControlSize, string>> = {
  screen: 'h-[3.25rem] w-[3.25rem]',
  bar: 'h-11 w-11',
};

const IDLE = 'border-ui-line bg-ui-surface text-ui-ink hover:bg-ui-raised';
const PRESSED =
  'border-ui-ink bg-ui-ink text-ui-surface forced-colors:border-[color:Highlight] forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:[forced-color-adjust:none]';

export interface CallToggleProps {
  /** The same name in both states: `aria-pressed` says which one it is in. */
  label: string;
  pressed: boolean;
  /** The icon while pressed, and while not. */
  icons: { pressed: LucideIcon; idle: LucideIcon };
  size: CallControlSize;
  onClick(): void;
}

export function CallToggle({ label, pressed, icons, size, onClick }: CallToggleProps) {
  const StateIcon = pressed ? icons.pressed : icons.idle;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full border transition-colors reduce-motion:transition-none',
        BOX[size],
        pressed ? PRESSED : IDLE,
        FOCUS_RING,
      )}
    >
      <StateIcon {...iconSize(size === 'screen' ? 'xl' : 'lg')} aria-hidden="true" />
    </button>
  );
}

export interface HangUpButtonProps {
  label: string;
  size: CallControlSize;
  onClick(): void;
}

export function HangUpButton({ label, size, onClick }: HangUpButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-transparent bg-ui-danger text-ui-danger-bg hover:brightness-95 forced-colors:border-[color:ButtonText]',
        size === 'screen' ? 'h-[3.25rem] w-16' : 'h-11 w-14',
        FOCUS_RING,
      )}
    >
      <PhoneOff {...iconSize(size === 'screen' ? 'xl' : 'lg')} aria-hidden="true" />
    </button>
  );
}
