/**
 * A call in a chat and in the call log (K13): the event, its text and its
 * icon. The only source of these texts, so the chat (W3) and the call log
 * (W2) always say the same thing. The words are the `callEvent.*` keys of
 * strings/common.ts.
 */
import { ArrowDownLeft, ArrowUpRight, PhoneMissed, type LucideIcon } from 'lucide-react';
import type { CallDirection, CallEventWire, CallOutcome } from './api';
import type { TFunction } from './i18n';

/** A call as the screens show it; `CallEventWire` is how the backend stores it. */
export interface CallEvent {
  /** The call's id: 16 to 64 characters of A-Z, a-z, 0-9, _ and -. */
  id: string;
  direction: CallDirection;
  video: boolean;
  outcome: CallOutcome;
  /** Seconds from connecting to hanging up; 0 unless answered. */
  durationSec: number;
}

/** Where the text goes: a line in the chat, or the detail of a row in the call log. */
export type CallEventForm = 'chat' | 'row';

/** What the icon of a call event shows. */
export type CallEventIcon = 'outgoing' | 'incoming' | 'missed';

/** The icons of the boards (PropLlamadas). The screens size them with `iconSize`. */
export const CALL_EVENT_ICONS: Readonly<Record<CallEventIcon, LucideIcon>> = {
  outgoing: ArrowUpRight,
  incoming: ArrowDownLeft,
  missed: PhoneMissed,
};

/** The event of a history item or a log entry. Its `ttl` belongs to the message, not here. */
export function fromWire(w: CallEventWire): CallEvent {
  return { id: w.id, direction: w.direction, video: w.video, outcome: w.outcome, durationSec: w.duration_sec };
}

/**
 * The outcome as this side lived it. A call nobody picked up is "missed" for
 * the one it rang for and "unanswered" for the caller, so it is read by its
 * direction: a record that uses the other word still reads right.
 */
function seenOutcome({ direction, outcome }: CallEvent): CallOutcome {
  if (outcome === 'missed' || outcome === 'unanswered') return direction === 'incoming' ? 'missed' : 'unanswered';
  return outcome;
}

/** An incoming call nobody answered here: it counts in "Llamadas · N" and shows in `danger`. */
export function isMissed(ev: CallEvent): boolean {
  return seenOutcome(ev) === 'missed';
}

/** Out for a call you made, in for one you got, or missed. */
export function callEventIcon(ev: CallEvent): CallEventIcon {
  return isMissed(ev) ? 'missed' : ev.direction;
}

const LABELS: Readonly<Record<CallEventForm | 'video', Readonly<Record<CallEventIcon, string>>>> = {
  chat: { outgoing: 'callEvent.outgoing', incoming: 'callEvent.incoming', missed: 'callEvent.missed' },
  row: { outgoing: 'callEvent.rowOutgoing', incoming: 'callEvent.rowIncoming', missed: 'callEvent.rowMissed' },
  // A video call says so in both forms: "Videollamada entrante · 25 min".
  video: { outgoing: 'callEvent.videoOutgoing', incoming: 'callEvent.videoIncoming', missed: 'callEvent.videoMissed' },
};

/** What happened to a call nobody talked in. A missed call says it in its label. */
const OUTCOMES: Readonly<Partial<Record<CallOutcome, string>>> = {
  declined: 'callEvent.declined',
  unanswered: 'callEvent.unanswered',
  cancelled: 'callEvent.cancelled',
  failed: 'callEvent.failed',
};

/** A call's length in whole units, rounded down: "45 s", "4 min", "1 h 5 min". */
function lengthText(durationSec: number, t: TFunction): string {
  const total = Number.isFinite(durationSec) && durationSec > 0 ? Math.floor(durationSec) : 0;
  if (total < 60) return t('callEvent.seconds', { n: total });
  const minutes = Math.floor((total % 3600) / 60);
  if (total < 3600) return t('callEvent.minutes', { n: minutes });
  const hours = t('callEvent.hours', { n: Math.floor(total / 3600) });
  return minutes > 0 ? `${hours} ${t('callEvent.minutes', { n: minutes })}` : hours;
}

/**
 * The text of a call event: always its direction first, then what happened.
 * "Llamada saliente · 4 min" and "Llamada perdida" in the chat, "Saliente ·
 * No contestó" in the call log.
 */
export function callEventText(ev: CallEvent, t: TFunction, form: CallEventForm): string {
  const label = t(LABELS[ev.video ? 'video' : form][callEventIcon(ev)]);
  const outcome = seenOutcome(ev);
  if (outcome === 'answered') return `${label} · ${lengthText(ev.durationSec, t)}`;
  const key = OUTCOMES[outcome];
  return key ? `${label} · ${t(key)}` : label;
}
