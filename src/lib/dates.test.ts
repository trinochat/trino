import { afterEach, describe, expect, it, vi } from 'vitest';
import { clockTime, dayLabel, durationLabel, rowTime } from './dates';
import { makeT, type Lang } from './i18n';

// Times are local, like the clock people read. The dates are built from local
// parts so these tests pass in any time zone. Friday 9 October 2026, 18:30.
const NOW = at(2026, 10, 9, 18, 30);

/** Epoch seconds of a local date and time; month is 1-based. */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime() / 1000;
}

/** Some engines put a narrow no-break space before AM and PM. */
const spaces = (text: string) => text.replace(/\s/g, ' ');

describe('clockTime', () => {
  it('gives hours and minutes in the language of the app', () => {
    expect(clockTime(at(2026, 10, 9, 9, 5), 'es')).toBe('09:05');
    expect(clockTime(at(2026, 10, 9, 21, 5), 'pt')).toBe('21:05');
    expect(spaces(clockTime(at(2026, 10, 9, 21, 5), 'en'))).toBe('09:05 PM');
  });
});

describe('rowTime', () => {
  it('shows the time for today', () => {
    expect(rowTime(at(2026, 10, 9, 9, 5), NOW, 'es')).toBe('09:05');
    expect(rowTime(at(2026, 10, 9, 0, 0), NOW, 'es')).toBe('00:00');
  });

  it('says yesterday for the day before, however late it was', () => {
    expect(rowTime(at(2026, 10, 8, 23, 59), NOW, 'es')).toBe('Ayer');
    expect(rowTime(at(2026, 10, 8, 0, 0), NOW, 'en')).toBe('Yesterday');
    expect(rowTime(at(2026, 10, 8, 7, 0), NOW, 'pt')).toBe('Ontem');
  });

  it('shows the short weekday for the rest of the last week', () => {
    expect(rowTime(at(2026, 10, 5), NOW, 'es')).toBe('Lun');
    expect(rowTime(at(2026, 10, 5), NOW, 'en')).toBe('Mon');
    expect(rowTime(at(2026, 10, 3), NOW, 'es')).toBe('Sáb');
  });

  it('shows the day and month from a week back, and the year from another year', () => {
    expect(rowTime(at(2026, 10, 2), NOW, 'es')).toBe('2 oct');
    expect(rowTime(at(2026, 3, 3), NOW, 'es')).toBe('3 mar');
    expect(rowTime(at(2026, 3, 3), NOW, 'en')).toBe('Mar 3');
    expect(rowTime(at(2025, 12, 31), NOW, 'es')).toBe('31/12/25');
    expect(rowTime(at(2025, 12, 31), NOW, 'en')).toBe('12/31/25');
  });

  it('shows the date for a time on a later day, from a clock that is ahead', () => {
    expect(rowTime(at(2026, 10, 10, 8, 0), NOW, 'es')).toBe('10 oct');
  });
});

describe('dayLabel', () => {
  const label = (ts: number, lang: Lang) => dayLabel(ts, NOW, lang, makeT(lang));

  it('says today and yesterday with the shared words', () => {
    expect(label(at(2026, 10, 9, 0, 1), 'es')).toBe('Hoy');
    expect(label(at(2026, 10, 8, 23, 0), 'es')).toBe('Ayer');
    expect(label(at(2026, 10, 9), 'en')).toBe('Today');
    expect(label(at(2026, 10, 8), 'pt')).toBe('Ontem');
  });

  it('gives the weekday for the rest of the last week, with a capital', () => {
    expect(label(at(2026, 10, 5), 'es')).toBe('Lunes');
    expect(label(at(2026, 10, 5), 'en')).toBe('Monday');
    expect(label(at(2026, 10, 5), 'pt')).toBe('Segunda-feira');
  });

  it('gives the full date from a week back, with the year from another year', () => {
    expect(label(at(2026, 3, 3), 'es')).toBe('3 de marzo');
    expect(label(at(2026, 3, 3), 'en')).toBe('March 3');
    expect(label(at(2025, 12, 31), 'es')).toBe('31 de diciembre de 2025');
    expect(label(at(2025, 12, 31), 'pt')).toBe('31 de dezembro de 2025');
  });
});

describe('durationLabel', () => {
  it('counts minutes and seconds, like the call bar', () => {
    expect(durationLabel(0)).toBe('00:00');
    expect(durationLabel(201)).toBe('03:21');
    expect(durationLabel(3599)).toBe('59:59');
  });

  it('adds the hours from one hour on', () => {
    expect(durationLabel(3600)).toBe('1:00:00');
    expect(durationLabel(3723)).toBe('1:02:03');
  });

  it('drops fractions and shows nothing negative or invalid', () => {
    expect(durationLabel(61.9)).toBe('01:01');
    expect(durationLabel(-5)).toBe('00:00');
    expect(durationLabel(Number.NaN)).toBe('00:00');
  });
});

// FIX-2: every row of the inbox built its own Intl.DateTimeFormat on every
// render, and the inbox rendered again on each switch between sections of
// Settings. A formatter is built once per language and set of options.
describe('the formatters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /** dates.ts afresh, with nothing built yet. */
  const fresh = async () => {
    vi.resetModules();
    return import('./dates');
  };

  it('builds one Intl.DateTimeFormat per language and options, and reuses it', async () => {
    const dates = await fresh();
    const built = vi.spyOn(Intl, 'DateTimeFormat');
    const today = at(2026, 10, 9, 9, 5);
    expect(dates.clockTime(today, 'es')).toBe('09:05');
    expect(dates.clockTime(at(2026, 10, 9, 10, 15), 'es')).toBe('10:15');
    expect(dates.rowTime(today, NOW, 'es')).toBe('09:05');
    expect(built).toHaveBeenCalledTimes(1);

    // Another language, or other options, is another formatter, once.
    expect(dates.clockTime(at(2026, 10, 9, 21, 5), 'pt')).toBe('21:05');
    expect(dates.rowTime(at(2026, 10, 5), NOW, 'es')).toBe('Lun');
    expect(dates.rowTime(at(2026, 10, 3), NOW, 'es')).toBe('Sáb');
    expect(dates.rowTime(at(2026, 3, 3), NOW, 'es')).toBe('3 mar');
    expect(dates.rowTime(at(2026, 3, 4), NOW, 'es')).toBe('4 mar');
    expect(built).toHaveBeenCalledTimes(4);
    expect(dates.dayLabel(at(2026, 3, 3), NOW, 'es', makeT('es'))).toBe('3 de marzo');
    expect(dates.dayLabel(at(2026, 3, 4), NOW, 'es', makeT('es'))).toBe('4 de marzo');
    expect(built).toHaveBeenCalledTimes(5);
  });

  it('builds one Intl.RelativeTimeFormat per language for "Ayer"', async () => {
    const dates = await fresh();
    const built = vi.spyOn(Intl, 'RelativeTimeFormat');
    expect(dates.rowTime(at(2026, 10, 8, 23, 59), NOW, 'es')).toBe('Ayer');
    expect(dates.rowTime(at(2026, 10, 8, 7, 0), NOW, 'es')).toBe('Ayer');
    expect(built).toHaveBeenCalledTimes(1);
    expect(dates.rowTime(at(2026, 10, 8, 7, 0), NOW, 'en')).toBe('Yesterday');
    expect(built).toHaveBeenCalledTimes(2);
  });
});
