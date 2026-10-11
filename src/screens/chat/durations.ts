/**
 * Lengths of time in words, in the language of the app: how long the new
 * messages of a chat last ("Temporales: 1 día") and how long one has left
 * ("Se borra en 2 horas"). `Intl` names the units and their plurals.
 */
import type { Lang } from '../../lib/i18n';

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week';

const SECONDS: Readonly<Record<Unit, number>> = { second: 1, minute: 60, hour: 3600, day: 86_400, week: 604_800 };

function words(amount: number, unit: Unit, lang: Lang): string {
  return new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'long' }).format(amount);
}

/** A set time, such as a chat's disappearing messages, in its largest whole unit: "1 semana", "90 minutos". */
export function exactDuration(seconds: number, lang: Lang): string {
  const total = Math.max(1, Math.round(seconds));
  const unit = (['week', 'day', 'hour', 'minute'] as const).find(u => total % SECONDS[u] === 0) ?? 'second';
  return words(total / SECONDS[unit], unit, lang);
}

/**
 * The time a message has left. Seconds and minutes round up, so it never
 * reads as zero; from 60 minutes on it counts hours, and from 24 hours days,
 * to the nearest one.
 */
export function remainingDuration(seconds: number, lang: Lang): string {
  const secondsLeft = Math.max(1, Math.ceil(seconds));
  if (secondsLeft < 60) return words(secondsLeft, 'second', lang);
  const minutes = Math.ceil(seconds / SECONDS.minute);
  if (minutes < 60) return words(minutes, 'minute', lang);
  const hours = Math.max(1, Math.round(seconds / SECONDS.hour));
  if (hours < 24) return words(hours, 'hour', lang);
  return words(Math.max(1, Math.round(seconds / SECONDS.day)), 'day', lang);
}
