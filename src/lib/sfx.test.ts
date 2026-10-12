// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Sfx = typeof import('./sfx');

/** One scheduled tone: its oscillator and the gains its envelope reaches. */
interface Tone {
  type: OscillatorType;
  frequency: number;
  levels: number[];
  started: boolean;
}

/** A Web Audio context that records the tones instead of playing them. */
class FakeAudioContext {
  static tones: Tone[] = [];
  currentTime = 0;
  state: AudioContextState = 'running';
  destination = {};
  resume = vi.fn(async () => {});

  createOscillator() {
    const tone: Tone = { type: 'sine', frequency: 0, levels: [], started: false };
    FakeAudioContext.tones.push(tone);
    const oscillator = {
      set type(value: OscillatorType) {
        tone.type = value;
      },
      frequency: {
        set value(hz: number) {
          tone.frequency = hz;
        },
      },
      // The envelope may be set before or after connecting: the tone shares the gain's levels.
      connect: (gain: { levels: number[] }) => {
        tone.levels = gain.levels;
        return gain;
      },
      start: () => {
        tone.started = true;
      },
      stop: () => {},
    };
    return oscillator;
  }

  createGain() {
    const levels: number[] = [];
    return {
      levels,
      gain: {
        setValueAtTime: (value: number) => levels.push(value),
        linearRampToValueAtTime: (value: number) => levels.push(value),
      },
      connect: () => ({}),
    };
  }
}

const peak = (tone: Tone) => Math.max(...tone.levels);
const started = () => FakeAudioContext.tones.filter(tone => tone.started);

let sfx: Sfx;

beforeEach(async () => {
  FakeAudioContext.tones = [];
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.resetModules();
  sfx = await import('./sfx');
});

afterEach(() => {
  sfx.stopRinging();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the volume of a tone', () => {
  it('goes from silence at 0 to the loudest tone at 100', () => {
    expect(sfx.toneGain(0)).toBe(0);
    expect(sfx.toneGain(50)).toBeCloseTo(sfx.MAX_TONE_GAIN / 2);
    expect(sfx.toneGain(100)).toBe(sfx.MAX_TONE_GAIN);
  });

  it('is bounded, whatever the setting says', () => {
    expect(sfx.toneGain(250)).toBe(sfx.MAX_TONE_GAIN);
    expect(sfx.toneGain(-20)).toBe(0);
    expect(sfx.toneGain(Number.NaN)).toBe(0);
    expect(sfx.toneGain(Number.POSITIVE_INFINITY)).toBe(0);
    expect(sfx.MAX_TONE_GAIN).toBeGreaterThan(0);
    expect(sfx.MAX_TONE_GAIN).toBeLessThanOrEqual(0.25);
  });
});

describe('the message tone', () => {
  // Until now the message "ding" played an empty WAV (App.tsx, `ding`).
  it('is a real tone: notes that play, at the chosen volume', () => {
    sfx.playMessageTone(60);
    expect(started().length).toBeGreaterThanOrEqual(2);
    for (const tone of started()) {
      expect(tone.frequency).toBeGreaterThan(0);
      expect(peak(tone)).toBeCloseTo(sfx.toneGain(60));
    }
  });

  it('never gets louder than the loudest tone', () => {
    sfx.playMessageTone(1000);
    expect(started().length).toBeGreaterThan(0);
    for (const tone of started()) expect(peak(tone)).toBeLessThanOrEqual(sfx.MAX_TONE_GAIN);
  });

  it('plays nothing at volume 0', () => {
    sfx.playMessageTone(0);
    expect(started()).toEqual([]);
  });
});

describe('the incoming call tones', () => {
  it('"Trino suave" starts soft and rises to the chosen volume, never above it', () => {
    const levels = [0, 1, 2, 3, 10].map(ring => sfx.softRingGain(60, ring));
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[0]).toBeLessThan(levels[1]!);
    expect(levels[1]).toBeLessThan(levels[2]!);
    expect(levels.slice(2)).toEqual([sfx.toneGain(60), sfx.toneGain(60), sfx.toneGain(60)]);
    expect(sfx.softRingGain(500, 10)).toBe(sfx.MAX_TONE_GAIN);
  });

  it('rings "Trino suave" with soft sine notes, louder ring after ring', async () => {
    vi.useFakeTimers();
    sfx.startRingtone({ tone: 'soft', volume: 80 });
    const first = started();
    expect(first.length).toBeGreaterThan(0);
    expect(first.every(tone => tone.type === 'sine')).toBe(true);
    const firstPeak = Math.max(...first.map(peak));
    expect(firstPeak).toBeCloseTo(sfx.softRingGain(80, 0));

    await vi.advanceTimersByTimeAsync(sfx.SOFT_RING_EVERY_MS * 2);
    const third = started().slice(first.length * 2);
    expect(Math.max(...third.map(peak))).toBeCloseTo(sfx.softRingGain(80, 2));
  });

  it('rings nothing in silence, and stops a ring that was playing', async () => {
    vi.useFakeTimers();
    sfx.startRingback({ volume: 60 });
    const before = started().length;
    expect(before).toBeGreaterThan(0);
    sfx.startRingtone({ tone: 'silent', volume: 80 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(before);
  });

  it('stops at once', async () => {
    vi.useFakeTimers();
    sfx.startRingtone({ tone: 'soft', volume: 60 });
    const before = started().length;
    sfx.stopRinging();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(before);
  });

  it('plays the ringback at the chosen volume when given one', () => {
    sfx.startRingback({ volume: 100 });
    const tones = started();
    expect(tones).toHaveLength(2);
    // Two notes at once: together they stay within the loudest tone.
    expect(tones.reduce((sum, tone) => sum + peak(tone), 0)).toBeCloseTo(sfx.MAX_TONE_GAIN);
  });
});
