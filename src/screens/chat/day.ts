/**
 * The log of a conversation: its messages in time order, with a separator
 * before the first message of each day ("Hoy", "Ayer", "Viernes",
 * "1 de octubre"). A call in the chat (K13) is a message like any other here,
 * so it counts for its day.
 */
import { dayLabel } from '../../lib/dates';
import type { Lang, TFunction } from '../../lib/i18n';
import type { Msg } from '../types';

export type LogItem = { type: 'day'; key: string; label: string } | { type: 'msg'; msg: Msg };

/** The local calendar day of a moment: the same for every message of that day, whatever `now` is. */
function dayKey(ts: number): string {
  const date = new Date(ts * 1000);
  return `day:${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/**
 * The messages in `ts` order, each day introduced by its separator. The sort
 * is stable, so messages of the same second keep the order they came in. A
 * separator keeps its key as the days go by ("Hoy" turns "Ayer"), so it is not
 * mounted again and the log does not read it out again.
 */
export function withDaySeparators(m: readonly Msg[], now: number, lang: Lang, t: TFunction): LogItem[] {
  const items: LogItem[] = [];
  let day = '';
  for (const msg of [...m].sort((a, b) => a.ts - b.ts)) {
    const key = dayKey(msg.ts);
    if (key !== day) {
      day = key;
      items.push({ type: 'day', key, label: dayLabel(msg.ts, now, lang, t) });
    }
    items.push({ type: 'msg', msg });
  }
  return items;
}
