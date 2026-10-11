// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { CallDirection, CallOutcome } from '../../lib/api';
import type { CallEvent } from '../../lib/call-events';
import { CallEventItem } from './CallEventItem';
import { at, classesOf, renderIn } from './test-utils';

afterEach(cleanup);

const STARTED = at(2026, 10, 11, 16, 40);

const call = (direction: CallDirection, outcome: CallOutcome, video = false, durationSec = 0): CallEvent => ({
  id: 'k13-call-0123456789',
  direction,
  video,
  outcome,
  durationSec,
});

const row = () => document.querySelector('[data-call-event]') as HTMLElement;
const icon = () => row().querySelector('svg')!;

/**
 * Every direction, outcome and kind of call, with the line the chat shows
 * and its icon. A call nobody picked up is "No contestó" for the caller and
 * "perdida" for the one it rang for, whichever word the record uses.
 */
const CASES: ReadonlyArray<readonly [CallDirection, CallOutcome, boolean, string, string]> = [
  ['outgoing', 'answered', false, 'Llamada saliente · 4 min', 'arrow-up-right'],
  ['outgoing', 'declined', false, 'Llamada saliente · Rechazada', 'arrow-up-right'],
  ['outgoing', 'unanswered', false, 'Llamada saliente · No contestó', 'arrow-up-right'],
  ['outgoing', 'missed', false, 'Llamada saliente · No contestó', 'arrow-up-right'],
  ['outgoing', 'cancelled', false, 'Llamada saliente · Cancelada', 'arrow-up-right'],
  ['outgoing', 'failed', false, 'Llamada saliente · No se pudo conectar', 'arrow-up-right'],
  ['outgoing', 'answered', true, 'Videollamada saliente · 4 min', 'arrow-up-right'],
  ['outgoing', 'declined', true, 'Videollamada saliente · Rechazada', 'arrow-up-right'],
  ['outgoing', 'unanswered', true, 'Videollamada saliente · No contestó', 'arrow-up-right'],
  ['outgoing', 'missed', true, 'Videollamada saliente · No contestó', 'arrow-up-right'],
  ['outgoing', 'cancelled', true, 'Videollamada saliente · Cancelada', 'arrow-up-right'],
  ['outgoing', 'failed', true, 'Videollamada saliente · No se pudo conectar', 'arrow-up-right'],
  ['incoming', 'answered', false, 'Llamada entrante · 4 min', 'arrow-down-left'],
  ['incoming', 'missed', false, 'Llamada perdida', 'phone-missed'],
  ['incoming', 'unanswered', false, 'Llamada perdida', 'phone-missed'],
  ['incoming', 'declined', false, 'Llamada entrante · Rechazada', 'arrow-down-left'],
  ['incoming', 'cancelled', false, 'Llamada entrante · Cancelada', 'arrow-down-left'],
  ['incoming', 'failed', false, 'Llamada entrante · No se pudo conectar', 'arrow-down-left'],
  ['incoming', 'answered', true, 'Videollamada entrante · 4 min', 'arrow-down-left'],
  ['incoming', 'missed', true, 'Videollamada perdida', 'phone-missed'],
  ['incoming', 'unanswered', true, 'Videollamada perdida', 'phone-missed'],
  ['incoming', 'declined', true, 'Videollamada entrante · Rechazada', 'arrow-down-left'],
  ['incoming', 'cancelled', true, 'Videollamada entrante · Cancelada', 'arrow-down-left'],
  ['incoming', 'failed', true, 'Videollamada entrante · No se pudo conectar', 'arrow-down-left'],
];

describe('CallEventItem', () => {
  it.each(CASES)('%s %s (video: %s) reads "%s" with its icon', (direction, outcome, video, text, iconName) => {
    renderIn(<CallEventItem call={call(direction, outcome, video, outcome === 'answered' ? 245 : 0)} ts={STARTED} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(classesOf(icon())).toContain(`lucide-${iconName}`);
    expect(icon().getAttribute('aria-hidden')).toBe('true');
  });

  it('gives the time the call started, in the mono font', () => {
    renderIn(<CallEventItem call={call('outgoing', 'answered', false, 245)} ts={STARTED} />);
    const time = row().querySelector('time')!;
    expect(time.textContent).toBe('16:40');
    expect(classesOf(time)).toEqual(expect.arrayContaining(['font-ui-mono', 'text-ui-xs']));
    expect(time.getAttribute('datetime')).toBe(new Date(STARTED * 1000).toISOString());
  });

  // Plan-cambios §6.5: a missed call is told by its icon, its words and its weight, not by colour alone.
  it('sets a missed call apart by its icon, its words and their weight, besides the colour', () => {
    renderIn(<CallEventItem call={call('incoming', 'missed')} ts={STARTED} />);
    const text = screen.getByText('Llamada perdida');
    expect(classesOf(text)).toEqual(expect.arrayContaining(['font-semibold', 'text-ui-danger']));
    expect(classesOf(icon().parentElement)).toContain('text-ui-danger');
    expect(classesOf(row().querySelector('time'))).not.toContain('text-ui-danger');
    cleanup();
    renderIn(<CallEventItem call={call('incoming', 'answered', false, 60)} ts={STARTED} />);
    expect(row().innerHTML).not.toContain('text-ui-danger');
    expect(row().innerHTML).not.toContain('font-semibold');
  });

  it('calls back a missed call with the voice, even a video one', () => {
    const onCall = vi.fn();
    renderIn(<CallEventItem call={call('incoming', 'missed', true)} ts={STARTED} onCall={onCall} />);
    const callBack = screen.getByRole('button', { name: 'Devolver llamada' });
    expect(callBack.querySelector('svg.lucide-phone')).not.toBeNull();
    expect(classesOf(callBack)).toContain('min-h-11');
    fireEvent.click(callBack);
    expect(onCall).toHaveBeenCalledWith(false);
  });

  it('offers no call back without a contact to call, nor for a call that was not missed', () => {
    renderIn(<CallEventItem call={call('incoming', 'missed')} ts={STARTED} />);
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    renderIn(<CallEventItem call={call('outgoing', 'unanswered')} ts={STARTED} onCall={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is a line of the chat, not a message: no bubble, no options and no delivery state', () => {
    renderIn(<CallEventItem call={call('outgoing', 'answered', false, 245)} ts={STARTED} onCall={() => {}} />);
    expect(document.querySelector('[data-direction]')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Opciones del mensaje' })).toBeNull();
    expect(screen.queryByText(/Enviado|Enviando/)).toBeNull();
  });
});
