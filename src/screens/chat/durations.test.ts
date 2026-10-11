import { describe, expect, it } from 'vitest';
import { exactDuration, remainingDuration } from './durations';

describe('exactDuration', () => {
  it('names a disappearing time by its largest whole unit', () => {
    expect(exactDuration(30, 'es')).toBe('30 segundos');
    expect(exactDuration(300, 'es')).toBe('5 minutos');
    expect(exactDuration(3600, 'es')).toBe('1 hora');
    expect(exactDuration(86_400, 'es')).toBe('1 día');
    expect(exactDuration(604_800, 'es')).toBe('1 semana');
  });

  it('keeps a smaller unit when the larger one is not whole', () => {
    expect(exactDuration(90, 'es')).toBe('90 segundos');
    expect(exactDuration(5400, 'es')).toBe('90 minutos');
  });

  it('speaks every language of the app', () => {
    expect(exactDuration(172_800, 'en')).toBe('2 days');
    expect(exactDuration(3600, 'pt')).toBe('1 hora');
    expect(exactDuration(1_209_600, 'pt')).toBe('2 semanas');
  });
});

describe('remainingDuration', () => {
  it('rounds seconds and minutes up, so the time left never reads as zero', () => {
    expect(remainingDuration(0, 'es')).toBe('1 segundo');
    expect(remainingDuration(-5, 'es')).toBe('1 segundo');
    expect(remainingDuration(45, 'es')).toBe('45 segundos');
    expect(remainingDuration(61, 'es')).toBe('2 minutos');
  });

  it('goes to hours and days near the next unit, never "60 minutos" or "24 horas"', () => {
    expect(remainingDuration(3570, 'es')).toBe('1 hora');
    expect(remainingDuration(3601, 'es')).toBe('1 hora');
    expect(remainingDuration(5400, 'es')).toBe('2 horas');
    expect(remainingDuration(86_399, 'es')).toBe('1 día');
    expect(remainingDuration(6 * 86_400 + 3600, 'en')).toBe('6 days');
  });
});
