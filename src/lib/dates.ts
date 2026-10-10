/**
 * Times and dates in the language of the app, with `Intl`. Timestamps are
 * epoch seconds, as the backend sends them; days are local calendar days.
 */
import type { Lang, TFunction } from './i18n';

const DAY_MS = 86_400_000;

function dateOf(ts: number): Date {
  return new Date(ts * 1000);
}

/** Calendar days from `ts` to `now`: 0 is the same day, 1 the day before; negative is later. */
function daysBefore(ts: number, now: number): number {
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // Rounded, because a day across a daylight saving change is 23 or 25 hours.
  return Math.round((day(dateOf(now)) - day(dateOf(ts))) / DAY_MS);
}

function capitalize(text: string, lang: Lang): string {
  return text.charAt(0).toLocaleUpperCase(lang) + text.slice(1);
}

function format(ts: number, lang: Lang, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(lang, options).format(dateOf(ts));
}

/** Hours and minutes: "09:05", "09:05 AM". */
export function clockTime(ts: number, lang: Lang): string {
  return format(ts, lang, { hour: '2-digit', minute: '2-digit' });
}

/**
 * The time of a row in the inbox: the time today, "Ayer", the short weekday
 * within the last week ("Lun"), then the day and month ("3 mar"), and the
 * short date for another year ("31/12/25").
 */
export function rowTime(ts: number, now: number, lang: Lang): string {
  const days = daysBefore(ts, now);
  if (days === 0) return clockTime(ts, lang);
  if (days === 1) return capitalize(new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-1, 'day'), lang);
  if (days > 1 && days < 7) return capitalize(format(ts, lang, { weekday: 'short' }), lang);
  if (dateOf(ts).getFullYear() === dateOf(now).getFullYear()) return format(ts, lang, { day: 'numeric', month: 'short' });
  return format(ts, lang, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/**
 * The label of a day separator in a chat: "Hoy", "Ayer", the weekday within
 * the last week ("Lunes"), then the date ("3 de marzo", with the year for
 * another year).
 */
export function dayLabel(ts: number, now: number, lang: Lang, t: TFunction): string {
  const days = daysBefore(ts, now);
  if (days === 0) return t('time2.today');
  if (days === 1) return t('time2.yesterday');
  if (days > 1 && days < 7) return capitalize(format(ts, lang, { weekday: 'long' }), lang);
  if (dateOf(ts).getFullYear() === dateOf(now).getFullYear()) return format(ts, lang, { day: 'numeric', month: 'long' });
  return format(ts, lang, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** A call's length: "03:21", and "1:02:03" from one hour on. */
export function durationLabel(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${two(minutes)}:${two(rest)}`;
}
