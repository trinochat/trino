/**
 * The round controls of a call, on its screen (52 px, Call:156-162) and on
 * the bar over the chats (44 px, Main:51-64). A toggle shows its state with
 * its icon (Mic and MicOff, Video and VideoOff) and with `aria-pressed`, and
 * the pressed fill is drawn in system colours under forced colours, so the
 * state never rests on a colour alone. Hanging up is PhoneOff on `danger`,
 * drawn in `dangerBg`.
 *
 * On the call screen a control whose device can be chosen is a pill
 * (David, 12 Oct 2026, as in Zoom or Meet): its button, and a chevron that
 * opens a menu of its own devices, the one in use checked. The speaker has
 * nothing to switch, so its pill is the menu's button itself.
 */
import { ChevronUp, PhoneOff, Volume2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { FOCUS_RING, Menu, cx, iconSize, type MenuItem } from '../../ui';

export type CallControlSize = 'screen' | 'bar';

const BOX: Readonly<Record<CallControlSize, string>> = {
  screen: 'h-[3.25rem] w-[3.25rem]',
  bar: 'h-11 w-11',
};

const IDLE = 'border-ui-line bg-ui-surface text-ui-ink hover:bg-ui-raised';
/** Inside a pill, whose border is the control's. */
const IDLE_IN_PILL = 'border-transparent text-ui-ink hover:bg-ui-raised';
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
  /** Drawn inside a CallControlPill, which has the border. */
  inPill?: boolean;
}

export function CallToggle({ label, pressed, icons, size, onClick, inPill = false }: CallToggleProps) {
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
        pressed ? PRESSED : inPill ? IDLE_IN_PILL : IDLE,
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

/** A device in a menu: its id, and its name as the system gives it, or a fallback. */
export interface DeviceChoice {
  id: string;
  label: string;
}

/**
 * The devices of a kind as a menu shows them: by their real names, or by
 * their kind and place ("Micrófono 1") where the system gives no name.
 */
export function deviceChoices(devices: readonly MediaDeviceInfo[], unnamed: (n: number) => string): DeviceChoice[] {
  return devices.map((device, i) => ({ id: device.deviceId, label: device.label || unnamed(i + 1) }));
}

/** The pill of a control on the call screen: 52 px tall, with one border around its parts. */
export function CallControlPill({ children }: { children: ReactNode }) {
  return (
    <div
      data-call-pill=""
      className="inline-flex h-[3.25rem] shrink-0 items-stretch rounded-full border border-ui-line bg-ui-surface"
    >
      {children}
    </div>
  );
}

export interface DeviceMenuProps {
  /** "Elegir micrófono": names the chevron and its menu. */
  label: string;
  devices: readonly DeviceChoice[];
  /** The device in use; none is checked while it is not known. */
  selectedId: string | undefined;
  onSelect(deviceId: string): void;
  /** What the button shows before the chevron, such as the speaker. */
  icon?: LucideIcon;
}

/** The chevron of a pill and its menu of devices (src/ui Menu), 44 px wide at least. */
export function DeviceMenu({ label, devices, selectedId, onSelect, icon: Icon }: DeviceMenuProps) {
  const items: MenuItem[] = devices.map(device => ({
    id: device.id,
    label: device.label,
    checked: device.id === selectedId,
    onSelect: () => onSelect(device.id),
  }));
  return (
    <Menu
      label={label}
      items={items}
      align="start"
      triggerStyle="bare"
      triggerClassName={cx(
        'rounded-full hover:bg-ui-raised',
        Icon ? 'gap-1.5 px-3.5 text-ui-ink' : 'px-2 text-ui-muted hover:text-ui-ink',
      )}
      trigger={
        <>
          {Icon && <Icon {...iconSize('xl')} aria-hidden="true" />}
          <ChevronUp {...iconSize('md')} aria-hidden="true" />
        </>
      }
    />
  );
}

/** The speaker's pill: one button, the speaker and its chevron, that opens the outputs. */
export function SpeakerControl(props: Omit<DeviceMenuProps, 'icon'>) {
  return (
    <CallControlPill>
      <DeviceMenu {...props} icon={Volume2} />
    </CallControlPill>
  );
}
