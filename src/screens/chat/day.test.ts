import { describe, expect, it } from 'vitest';
import { at, message, tFor } from './test-utils';
import { withDaySeparators, type LogItem } from './day';

// Sunday 11 October 2026, at six in the evening, local time.
const NOW = at(2026, 10, 11, 18, 0);

/** The log as text: a day's label in brackets, a message by its key. */
const shape = (items: readonly LogItem[]) => items.map(item => (item.type === 'day' ? `[${item.label}]` : item.msg.key));

describe('withDaySeparators', () => {
  it('puts a separator before the first message of each day: "Hoy" and "Ayer"', () => {
    const items = withDaySeparators(
      [message('a', at(2026, 10, 10, 9)), message('b', at(2026, 10, 10, 21)), message('c', at(2026, 10, 11, 8))],
      NOW,
      'es',
      tFor('es'),
    );
    expect(shape(items)).toEqual(['[Ayer]', 'a', 'b', '[Hoy]', 'c']);
  });

  it('names the other days of the last week, then the date, in the language of the app', () => {
    const messages = [message('friday', at(2026, 10, 9)), message('october', at(2026, 10, 1))];
    expect(shape(withDaySeparators(messages, NOW, 'es', tFor('es')))).toEqual([
      '[1 de octubre]',
      'october',
      '[Viernes]',
      'friday',
    ]);
    expect(shape(withDaySeparators(messages, NOW, 'en', tFor('en')))).toEqual([
      '[October 1]',
      'october',
      '[Friday]',
      'friday',
    ]);
  });

  it('adds the year to a day of another year', () => {
    const items = withDaySeparators([message('old', at(2025, 12, 31, 23, 50))], NOW, 'es', tFor('es'));
    expect(shape(items)).toEqual(['[31 de diciembre de 2025]', 'old']);
  });

  it('orders the messages by their time, and those of the same second as they came', () => {
    const items = withDaySeparators(
      [
        message('late', at(2026, 10, 11, 16, 46)),
        message('first', at(2026, 10, 11, 16, 32)),
        message('same-a', at(2026, 10, 11, 16, 40)),
        message('same-b', at(2026, 10, 11, 16, 40)),
      ],
      NOW,
      'es',
      tFor('es'),
    );
    expect(shape(items)).toEqual(['[Hoy]', 'first', 'same-a', 'same-b', 'late']);
  });

  it('counts a call like any message: a call on a new day brings its own separator', () => {
    const call = message('call:abcdefghijklmnop', at(2026, 10, 11, 7), {
      text: undefined,
      call: { id: 'abcdefghijklmnop', direction: 'incoming', video: false, outcome: 'missed', durationSec: 0 },
    });
    const items = withDaySeparators([message('a', at(2026, 10, 10, 22)), call], NOW, 'es', tFor('es'));
    expect(shape(items)).toEqual(['[Ayer]', 'a', '[Hoy]', 'call:abcdefghijklmnop']);
  });

  it('keeps the key of a day as the days go by, while its label changes', () => {
    const messages = [message('a', at(2026, 10, 11, 8))];
    const today = withDaySeparators(messages, NOW, 'es', tFor('es'))[0];
    const tomorrow = withDaySeparators(messages, at(2026, 10, 12, 9), 'es', tFor('es'))[0];
    expect(today).toMatchObject({ type: 'day', label: 'Hoy' });
    expect(tomorrow).toMatchObject({ type: 'day', label: 'Ayer' });
    expect(today?.type === 'day' && tomorrow?.type === 'day' && today.key === tomorrow.key).toBe(true);
  });

  it('gives an empty log for no messages, and does not change the list it gets', () => {
    expect(withDaySeparators([], NOW, 'es', tFor('es'))).toEqual([]);
    const messages = [message('b', at(2026, 10, 11, 9)), message('a', at(2026, 10, 11, 8))];
    withDaySeparators(messages, NOW, 'es', tFor('es'));
    expect(messages.map(m => m.key)).toEqual(['b', 'a']);
  });
});
