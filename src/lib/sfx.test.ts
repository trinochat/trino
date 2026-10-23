// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Sfx = typeof import('./sfx');

/** What a tone's gain was told to do, in order. */
type GainEvent =
  | { kind: 'set'; value: number; time: number }
  | { kind: 'linear'; value: number; time: number }
  | { kind: 'target'; value: number; time: number; tau: number }
  | { kind: 'cancel'; time: number };

/** One oscillator: its wave, its pitch, when it starts and stops, and the envelope of its gain. */
interface Tone {
  type: OscillatorType;
  frequency: number;
  start: number | null;
  stops: number[];
  events: GainEvent[];
  /** The values its envelope reaches (set and ramped to). */
  levels: number[];
}

/** A Web Audio context that records the tones instead of playing them. */
class FakeAudioContext {
  static tones: Tone[] = [];
  static current: FakeAudioContext | null = null;
  currentTime = 0;
  state: AudioContextState = 'running';
  destination = {};
  resume = vi.fn(async () => {});

  constructor() {
    FakeAudioContext.current = this;
  }

  createOscillator() {
    const tone: Tone = { type: 'sine', frequency: 0, start: null, stops: [], events: [], levels: [] };
    FakeAudioContext.tones.push(tone);
    return {
      set type(value: OscillatorType) {
        tone.type = value;
      },
      frequency: {
        set value(hz: number) {
          tone.frequency = hz;
        },
      },
      // The envelope may be set before or after connecting: the tone shares the gain's events.
      connect: (gain: { events: GainEvent[]; levels: number[] }) => {
        tone.events = gain.events;
        tone.levels = gain.levels;
        return gain;
      },
      start: (at = 0) => {
        tone.start = at;
      },
      stop: (at = 0) => {
        tone.stops.push(at);
      },
    };
  }

  createGain() {
    const events: GainEvent[] = [];
    const levels: number[] = [];
    return {
      events,
      levels,
      gain: {
        setValueAtTime: (value: number, time: number) => {
          events.push({ kind: 'set', value, time });
          levels.push(value);
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          events.push({ kind: 'linear', value, time });
          levels.push(value);
        },
        setTargetAtTime: (value: number, time: number, tau: number) => {
          events.push({ kind: 'target', value, time, tau });
        },
        cancelScheduledValues: (time: number) => {
          events.push({ kind: 'cancel', time });
        },
      },
      connect: () => ({}),
    };
  }
}

const peak = (tone: Tone) => Math.max(...tone.levels);
const started = () => FakeAudioContext.tones.filter(tone => tone.start !== null);
const near = (a: number, b: number, digits = 3) => expect(a).toBeCloseTo(b, digits);
const firstStop = (tone: Tone) => Math.min(...tone.stops);

/**
 * The gain of a tone at `t`, as Web Audio plays the envelope it was given:
 * set values, linear ramps from the event before, exponential approaches.
 * It stops reading at a cancel: only the tests of stopping make one.
 */
function gainAt(tone: Tone, t: number): number {
  let value = 0;
  let at = 0;
  let target: { value: number; tau: number } | null = null;
  const approach = (until: number) =>
    target ? target.value + (value - target.value) * Math.exp(-(until - at) / target.tau) : value;
  for (const event of tone.events) {
    if (event.kind === 'cancel') break;
    if (event.time > t) {
      if (event.kind === 'linear' && !target) return value + ((event.value - value) * (t - at)) / (event.time - at);
      break;
    }
    value = approach(event.time);
    at = event.time;
    if (event.kind === 'target') {
      target = event;
    } else {
      target = null;
      value = event.value;
    }
  }
  return approach(t);
}

/** The loudest sample of the sum of the tones, sampled at 48 kHz from `from` to `to`. */
function wavePeak(tones: Tone[], from: number, to: number): number {
  let loudest = 0;
  for (let t = from; t <= to; t += 1 / 48_000) {
    let sum = 0;
    for (const tone of tones) {
      if (tone.start === null || t < tone.start || t >= firstStop(tone)) continue;
      sum += gainAt(tone, t) * Math.sin(2 * Math.PI * tone.frequency * (t - tone.start));
    }
    loudest = Math.max(loudest, Math.abs(sum));
  }
  return loudest;
}

let sfx: Sfx;

beforeEach(async () => {
  FakeAudioContext.tones = [];
  FakeAudioContext.current = null;
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

// The call sounds David chose on 12 Oct 2026, out of nine previews: 1A (incoming, marimba), 2A
// (ringback, classic and soft) and 3A (hang-up, a falling marimba). A marimba note is three sines, f,
// 4f and 10f at 1, 0.35 and 0.15, after a 4 ms attack, each decaying as exp(-(3.2 + d)t) with d = 0,
// 14 and 8.
const MARIMBA = [
  { mult: 1, rel: 1, decay: 3.2 },
  { mult: 4, rel: 0.35, decay: 3.2 + 14 },
  { mult: 10, rel: 0.15, decay: 3.2 + 8 },
];

/** Checks that `tones` are marimba notes of `notes` (Hz, seconds from `t0`). */
function expectMarimba(tones: Tone[], notes: Array<[number, number]>, t0 = 0): void {
  expect(tones).toHaveLength(notes.length * 3);
  notes.forEach(([hz, at], n) => {
    const partials = tones.slice(n * 3, n * 3 + 3);
    const level = peak(partials[0]!);
    partials.forEach((tone, k) => {
      const { mult, rel, decay } = MARIMBA[k]!;
      expect(tone.type).toBe('sine');
      near(tone.frequency, hz * mult, 2);
      near(tone.start!, t0 + at);
      // From silence to its level in 4 ms, then an exponential decay with its own speed.
      expect(tone.events[0]).toEqual({ kind: 'set', value: 0, time: tone.start });
      expect(tone.events[1]!.kind).toBe('linear');
      near(tone.events[1]!.time, tone.start! + 0.004);
      near(peak(tone) / level, rel);
      const fall = tone.events.find(event => event.kind === 'target') as Extract<GainEvent, { kind: 'target' }>;
      expect(fall.value).toBe(0);
      near(fall.tau, 1 / decay, 6);
    });
  });
}

describe('the incoming call (1A)', () => {
  const RING: Array<[number, number]> = [
    [659.25, 0],
    [783.99, 0.16],
    [1046.5, 0.32],
    [783.99, 0.48],
  ];

  it('rings E5, G5, C6, G5 on a marimba, every 2.2 s', async () => {
    vi.useFakeTimers();
    expect(sfx.SOFT_RING_EVERY_MS).toBe(2200);
    sfx.startRingtone({ tone: 'soft', volume: 100 });
    expectMarimba(started(), RING);
    // Each note rings about 1.2 s, and the ring is over before the next one.
    for (const tone of started()) near(firstStop(tone) - tone.start!, 1.2, 2);

    FakeAudioContext.current!.currentTime = 2.2;
    await vi.advanceTimersByTimeAsync(sfx.SOFT_RING_EVERY_MS - 1);
    expect(started()).toHaveLength(12);
    await vi.advanceTimersByTimeAsync(1);
    expect(started()).toHaveLength(24);
    expectMarimba(started().slice(12), RING, 2.2);
  });

  it('peaks within the volume of its ring, and fills it', () => {
    sfx.startRingtone({ tone: 'soft', volume: 100 });
    // "Trino suave" starts at 40 %, so the first ring peaks at 40 % of the volume.
    const loudest = wavePeak(started(), 0, 1.7);
    expect(loudest).toBeLessThanOrEqual(sfx.softRingGain(100, 0) + 1e-9);
    expect(loudest).toBeGreaterThan(sfx.softRingGain(100, 0) * 0.9);
  });

  it('"Trino suave" starts soft and rises to the chosen volume, ring after ring', async () => {
    vi.useFakeTimers();
    const levels = [0, 1, 2, 3, 10].map(ring => sfx.softRingGain(60, ring));
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[0]).toBeLessThan(levels[1]!);
    expect(levels[1]).toBeLessThan(levels[2]!);
    expect(levels.slice(2)).toEqual([sfx.toneGain(60), sfx.toneGain(60), sfx.toneGain(60)]);
    expect(sfx.softRingGain(500, 10)).toBe(sfx.MAX_TONE_GAIN);

    sfx.startRingtone({ tone: 'soft', volume: 80 });
    await vi.advanceTimersByTimeAsync(sfx.SOFT_RING_EVERY_MS * 2);
    const rings = [0, 1, 2].map(ring => peak(started()[ring * 12]!));
    near(rings[1]! / rings[0]!, sfx.softRingGain(80, 1) / sfx.softRingGain(80, 0));
    near(rings[2]! / rings[0]!, sfx.softRingGain(80, 2) / sfx.softRingGain(80, 0));
  });

  it('scales with the volume', () => {
    sfx.startRingtone({ tone: 'soft', volume: 100 });
    const loud = started().map(peak);
    sfx.stopRinging();
    FakeAudioContext.tones = [];
    sfx.startRingtone({ tone: 'soft', volume: 50 });
    started()
      .map(peak)
      .forEach((level, i) => near(level, loud[i]! / 2, 6));
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

  // Answering cuts the ring at once, with a fade of a few ms so it does not click: no note rings on.
  it('stops at once and cleanly, the notes already sounding included', async () => {
    vi.useFakeTimers();
    sfx.startRingtone({ tone: 'soft', volume: 60 });
    const ringing = started();
    FakeAudioContext.current!.currentTime = 0.5;
    sfx.stopRinging();
    for (const tone of ringing) {
      expect(firstStop(tone)).toBeLessThanOrEqual(0.5 + 0.1);
      expect(tone.events.slice(-1)[0]).toEqual(expect.objectContaining({ kind: 'target', value: 0, time: 0.5 }));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(ringing.length);
  });
});

describe('the ringback (2A)', () => {
  it('is 440 Hz and 480 Hz together for 1 s, with a 30 ms attack and a 50 ms release, every 3 s', async () => {
    vi.useFakeTimers();
    sfx.startRingback({ volume: 100 });
    const tones = started();
    expect(tones.map(tone => tone.frequency)).toEqual([440, 480]);
    for (const tone of tones) {
      expect(tone.type).toBe('sine');
      expect(tone.start).toBe(0);
      expect(tone.events[0]).toEqual({ kind: 'set', value: 0, time: 0 });
      expect(tone.events[1]).toEqual(expect.objectContaining({ kind: 'linear', time: 0.03 }));
      near(gainAt(tone, 0.5), sfx.MAX_TONE_GAIN / 2);
      near(gainAt(tone, 0.95), sfx.MAX_TONE_GAIN / 2);
      near(gainAt(tone, 0.975), sfx.MAX_TONE_GAIN / 4);
      near(firstStop(tone), 1);
    }
    FakeAudioContext.current!.currentTime = 3;
    await vi.advanceTimersByTimeAsync(2999);
    expect(started()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(started().slice(2).map(tone => tone.start)).toEqual([3, 3]);
  });

  it('mixes both notes at half each, so together they stay within the volume', () => {
    sfx.startRingback({ volume: 100 });
    const tones = started();
    expect(tones.reduce((sum, tone) => sum + peak(tone), 0)).toBeCloseTo(sfx.MAX_TONE_GAIN);
    expect(wavePeak(tones, 0, 1)).toBeLessThanOrEqual(sfx.MAX_TONE_GAIN + 1e-9);
    sfx.stopRinging();
    FakeAudioContext.tones = [];
    sfx.startRingback({ volume: 30 });
    for (const tone of started()) near(peak(tone), sfx.toneGain(30) / 2, 6);
  });

  it('stops at once and cleanly when the call is answered', async () => {
    vi.useFakeTimers();
    sfx.startRingback({ volume: 60 });
    const ringing = started();
    FakeAudioContext.current!.currentTime = 0.4;
    sfx.stopRinging();
    for (const tone of ringing) {
      expect(firstStop(tone)).toBeLessThanOrEqual(0.4 + 0.1);
      expect(tone.events.slice(-1)[0]).toEqual(expect.objectContaining({ kind: 'target', value: 0, time: 0.4 }));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(ringing.length);
  });
});

// Approved by David on 23 Oct 2026: the mirror of the hang-up.
describe('the connect', () => {
  it('rises from C5 to G5 on the marimba, once, within the volume', async () => {
    vi.useFakeTimers();
    sfx.blipConnect(60);
    expectMarimba(started(), [
      [523.25, 0],
      [783.99, 0.18],
    ]);
    const loudest = wavePeak(started(), 0, 1.4);
    expect(loudest).toBeLessThanOrEqual(sfx.toneGain(60) + 1e-9);
    expect(loudest).toBeGreaterThan(sfx.toneGain(60) * 0.9);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(6);
  });

  it('follows the volume it is given, and has no square wave left', () => {
    sfx.blipConnect(100);
    const loud = wavePeak(started(), 0, 1.4);
    expect(loud).toBeLessThanOrEqual(sfx.MAX_TONE_GAIN + 1e-9);
    expect(loud).toBeGreaterThan(sfx.MAX_TONE_GAIN * 0.9);
    const before = started().length;
    sfx.blipConnect(30);
    const soft = started().slice(before);
    expect(wavePeak(soft, 0, 1.4)).toBeLessThanOrEqual(sfx.toneGain(30) + 1e-9);
    expect(wavePeak(soft, 0, 1.4)).toBeGreaterThan(sfx.toneGain(30) * 0.9);
    expect(started().every(tone => tone.type === 'sine')).toBe(true);
    const before0 = started().length;
    sfx.blipConnect(0);
    expect(wavePeak(started().slice(before0), 0, 1.4)).toBe(0);
  });
});

describe('the hang-up (3A)', () => {
  it('falls from G5 to C5 on the marimba, once, within the volume', async () => {
    vi.useFakeTimers();
    sfx.blipEnd();
    expectMarimba(started(), [
      [783.99, 0],
      [523.25, 0.18],
    ]);
    const loudest = wavePeak(started(), 0, 1.4);
    expect(loudest).toBeLessThanOrEqual(sfx.toneGain(60) + 1e-9);
    expect(loudest).toBeGreaterThan(sfx.toneGain(60) * 0.9);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started()).toHaveLength(6);
  });

  it('follows the volume it is given, and is not cut by the end of a ring', () => {
    sfx.startRingback({ volume: 60 });
    sfx.stopRinging();
    const before = started().length;
    sfx.blipEnd(100);
    const hangUp = started().slice(before);
    const loudest = wavePeak(hangUp, 0, 1.4);
    expect(loudest).toBeLessThanOrEqual(sfx.MAX_TONE_GAIN + 1e-9);
    expect(loudest).toBeGreaterThan(sfx.MAX_TONE_GAIN * 0.9);
    sfx.stopRinging();
    for (const tone of hangUp) expect(tone.stops).toHaveLength(1);
  });
});
