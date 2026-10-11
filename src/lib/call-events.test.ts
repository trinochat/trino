import { ArrowDownLeft, ArrowUpRight, PhoneMissed } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import type { CallDirection, CallEventWire, CallOutcome } from './api';
import {
  CALL_EVENT_ICONS,
  callEventIcon,
  callEventText,
  fromWire,
  isMissed,
  type CallEvent,
  type CallEventForm,
} from './call-events';
import { LANGS, makeT } from './i18n';

// The texts of a call in its chat (W3) and in the call log (W2) come from
// here only, so the two never disagree (plan-cambios-11oct §2, PropLlamadas).

const DIRECTIONS: readonly CallDirection[] = ['outgoing', 'incoming'];
const OUTCOMES: readonly CallOutcome[] = ['answered', 'missed', 'declined', 'unanswered', 'cancelled', 'failed'];
const FORMS: readonly CallEventForm[] = ['chat', 'row'];

const call = (fields: Partial<CallEvent> = {}): CallEvent => ({
  id: 'c4ll-1d-0000000001',
  direction: 'outgoing',
  video: false,
  outcome: 'answered',
  durationSec: 0,
  ...fields,
});

/** Every call event there can be: each direction, outcome and medium. */
const EVENTS = DIRECTIONS.flatMap(direction =>
  OUTCOMES.flatMap(outcome =>
    [false, true].map(video => call({ direction, outcome, video, durationSec: outcome === 'answered' ? 90 : 0 })),
  ),
);

const es = makeT('es');

describe('fromWire', () => {
  it('turns the backend call into the one the screens use, without the ttl', () => {
    const wire: CallEventWire = {
      id: 'c4ll-1d-0000000001',
      direction: 'incoming',
      video: true,
      outcome: 'answered',
      duration_sec: 1500,
      ttl: 3600,
    };
    expect(fromWire(wire)).toEqual({
      id: 'c4ll-1d-0000000001',
      direction: 'incoming',
      video: true,
      outcome: 'answered',
      durationSec: 1500,
    });
  });
});

describe('the text of a call event', () => {
  it('reads as the boards show it', () => {
    expect(callEventText(call({ durationSec: 240 }), es, 'chat')).toBe('Llamada saliente · 4 min');
    expect(callEventText(call({ direction: 'incoming', outcome: 'missed' }), es, 'chat')).toBe('Llamada perdida');
    expect(callEventText(call({ outcome: 'unanswered' }), es, 'row')).toBe('Saliente · No contestó');
    expect(callEventText(call({ direction: 'incoming', video: true, durationSec: 1500 }), es, 'chat')).toBe(
      'Videollamada entrante · 25 min',
    );
    expect(callEventText(call({ direction: 'incoming', video: true, durationSec: 1500 }), es, 'row')).toBe(
      'Videollamada entrante · 25 min',
    );
    expect(callEventText(call({ durationSec: 240 }), es, 'row')).toBe('Saliente · 4 min');
    expect(callEventText(call({ direction: 'incoming', durationSec: 720 }), es, 'row')).toBe('Entrante · 12 min');
    expect(callEventText(call({ direction: 'incoming', outcome: 'missed' }), es, 'row')).toBe('Perdida');
    expect(es('callEvent.callBack')).toBe('Devolver llamada');
  });

  it('says what happened to a call that was not answered, after its direction', () => {
    expect(callEventText(call({ outcome: 'declined' }), es, 'row')).toBe('Saliente · Rechazada');
    expect(callEventText(call({ outcome: 'cancelled' }), es, 'chat')).toBe('Llamada saliente · Cancelada');
    expect(callEventText(call({ outcome: 'failed', video: true }), es, 'chat')).toBe(
      'Videollamada saliente · No se pudo conectar',
    );
    expect(callEventText(call({ direction: 'incoming', outcome: 'declined' }), es, 'chat')).toBe(
      'Llamada entrante · Rechazada',
    );
    expect(callEventText(call({ direction: 'incoming', outcome: 'missed', video: true }), es, 'row')).toBe(
      'Videollamada perdida',
    );
  });

  it.each([
    [0, '0 s'],
    [59, '59 s'],
    [60, '1 min'],
    [119, '1 min'],
    [3599, '59 min'],
    [3600, '1 h'],
    [3660, '1 h 1 min'],
    [5400, '1 h 30 min'],
    [86400, '24 h'],
  ])('writes an answered call of %i s as "%s"', (durationSec, length) => {
    expect(callEventText(call({ durationSec }), es, 'row')).toBe(`Saliente · ${length}`);
  });

  it('writes a length that is not a positive number as 0 s, and drops a fraction of a second', () => {
    for (const durationSec of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(callEventText(call({ durationSec }), es, 'row'), String(durationSec)).toBe('Saliente · 0 s');
    }
    expect(callEventText(call({ durationSec: 61.9 }), es, 'row')).toBe('Saliente · 1 min');
  });

  // The caller records a call nobody picked up as unanswered and the one it
  // rang for as missed. Read by direction, the other word reads the same.
  it('reads a call nobody picked up by its direction', () => {
    expect(callEventText(call({ direction: 'incoming', outcome: 'unanswered' }), es, 'chat')).toBe('Llamada perdida');
    expect(callEventText(call({ direction: 'outgoing', outcome: 'missed' }), es, 'row')).toBe('Saliente · No contestó');
  });

  describe.each(LANGS.map(lang => lang.code))('in %s', lang => {
    const t = makeT(lang);
    const words = (keys: readonly string[]) => keys.map(key => t(`callEvent.${key}`));
    const OUTGOING = words(['outgoing', 'rowOutgoing', 'videoOutgoing']);
    const INCOMING = words(['incoming', 'rowIncoming', 'videoIncoming', 'missed', 'rowMissed', 'videoMissed']);
    const VIDEO = words(['videoOutgoing', 'videoIncoming', 'videoMissed']);
    const CASES = EVENTS.flatMap(ev =>
      FORMS.map(form => ({ ev, form, name: `${ev.direction} ${ev.outcome}${ev.video ? ' video' : ''}` })),
    );

    it.each(CASES)('always names the direction: $name, in the $form', ({ ev, form }) => {
      const text = callEventText(ev, t, form);
      expect(text).not.toMatch(/callEvent\.|[{}]/);
      expect((ev.direction === 'outgoing' ? OUTGOING : INCOMING).some(word => text.startsWith(word))).toBe(true);
      expect((ev.direction === 'outgoing' ? INCOMING : OUTGOING).some(word => text.startsWith(word))).toBe(false);
      expect(VIDEO.some(word => text.startsWith(word))).toBe(ev.video);
    });

    it('never gives the two directions the same text', () => {
      for (const form of FORMS) {
        for (const ev of EVENTS.filter(e => e.direction === 'outgoing')) {
          const incoming = callEventText({ ...ev, direction: 'incoming' }, t, form);
          expect(callEventText(ev, t, form), `${ev.outcome} ${form}`).not.toBe(incoming);
        }
      }
    });

    it('names the outcome of a call that was not answered', () => {
      for (const outcome of ['declined', 'cancelled', 'failed'] as const) {
        for (const ev of EVENTS.filter(e => e.outcome === outcome)) {
          for (const form of FORMS) expect(callEventText(ev, t, form)).toContain(t(`callEvent.${outcome}`));
        }
      }
      expect(callEventText(call({ outcome: 'unanswered' }), t, 'row')).toContain(t('callEvent.unanswered'));
    });
  });
});

describe('isMissed', () => {
  it('is an incoming call nobody answered here, with or without video', () => {
    expect(isMissed(call({ direction: 'incoming', outcome: 'missed' }))).toBe(true);
    expect(isMissed(call({ direction: 'incoming', outcome: 'missed', video: true }))).toBe(true);
    expect(isMissed(call({ direction: 'incoming', outcome: 'unanswered' }))).toBe(true);
  });

  it('is never a call I made, nor one answered, declined, canceled or failed', () => {
    for (const outcome of OUTCOMES) expect(isMissed(call({ direction: 'outgoing', outcome })), outcome).toBe(false);
    for (const outcome of ['answered', 'declined', 'cancelled', 'failed'] as const) {
      expect(isMissed(call({ direction: 'incoming', outcome })), outcome).toBe(false);
    }
  });
});

describe('the icon of a call event', () => {
  it('points out for a call I made and in for one I got, and marks a missed one', () => {
    expect(callEventIcon(call({ outcome: 'unanswered' }))).toBe('outgoing');
    expect(callEventIcon(call({ direction: 'incoming' }))).toBe('incoming');
    expect(callEventIcon(call({ direction: 'incoming', outcome: 'declined' }))).toBe('incoming');
    expect(callEventIcon(call({ direction: 'incoming', outcome: 'missed', video: true }))).toBe('missed');
  });

  it('is the lucide icon of the boards', () => {
    expect(CALL_EVENT_ICONS).toEqual({ outgoing: ArrowUpRight, incoming: ArrowDownLeft, missed: PhoneMissed });
  });

  it('is the missed one exactly when the call is missed', () => {
    for (const ev of EVENTS) expect(callEventIcon(ev) === 'missed', `${ev.direction} ${ev.outcome}`).toBe(isMissed(ev));
  });
});
