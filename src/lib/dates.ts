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

/*
 * The sets of options, one object each: a formatter is built once per
 * language and set (FIX-2). Building one is slow, and every row of the
 * inbox, every separator of a chat and every call in the log asks for one
 * on each render.
 */
const CLOCK: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
const WEEKDAY_SHORT: Intl.DateTimeFormatOptions = { weekday: 'short' };
const WEEKDAY_LONG: Intl.DateTimeFormatOptions = { weekday: 'long' };
const DAY_MONTH_SHORT: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const DAY_MONTH_LONG: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };
const SHORT_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'numeric', year: '2-digit' };
const LONG_DATE: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };

/** The formatters built so far, by set of options and then by language. */
const formatters = new Map<Intl.DateTimeFormatOptions, Map<Lang, Intl.DateTimeFormat>>();
const relativeFormatters = new Map<Lang, Intl.RelativeTimeFormat>();

function format(ts: number, lang: Lang, options: Intl.DateTimeFormatOptions): string {
  let byLang = formatters.get(options);
  if (!byLang) {
    byLang = new Map();
    formatters.set(options, byLang);
  }
  let formatter = byLang.get(lang);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(lang, options);
    byLang.set(lang, formatter);
  }
  return formatter.format(dateOf(ts));
}

/** "Ayer", "Yesterday", "Ontem": the day before, in words. */
function yesterday(lang: Lang): string {
  let formatter = relativeFormatters.get(lang);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    relativeFormatters.set(lang, formatter);
  }
  return formatter.format(-1, 'day');
}

/** The day and the month in words: "17 de octubre", "October 17". */
export function dayMonth(ts: number, lang: Lang): string {
  return format(ts, lang, DAY_MONTH_LONG);
}

/** Hours and minutes: "09:05", "09:05 AM". */
export function clockTime(ts: number, lang: Lang): string {
  return format(ts, lang, CLOCK);
}

/**
 * The time of a row in the inbox: the time today, "Ayer", the short weekday
 * within the last week ("Lun"), then the day and month ("3 mar"), and the
 * short date for another year ("31/12/25").
 */
export function rowTime(ts: number, now: number, lang: Lang): string {
  const days = daysBefore(ts, now);
  if (days === 0) return clockTime(ts, lang);
  if (days === 1) return capitalize(yesterday(lang), lang);
  if (days > 1 && days < 7) return capitalize(format(ts, lang, WEEKDAY_SHORT), lang);
  if (dateOf(ts).getFullYear() === dateOf(now).getFullYear()) return format(ts, lang, DAY_MONTH_SHORT);
  return format(ts, lang, SHORT_DATE);
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
  if (days > 1 && days < 7) return capitalize(format(ts, lang, WEEKDAY_LONG), lang);
  if (dateOf(ts).getFullYear() === dateOf(now).getFullYear()) return format(ts, lang, DAY_MONTH_LONG);
  return format(ts, lang, LONG_DATE);
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
