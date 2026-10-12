// sfx.ts — procedural call and message tones via the Web Audio API (no audio
// files). The redesign adds a bounded volume, the message tone and the call
// sounds David chose on 12 Oct 2026 out of nine previews: a marimba for an
// incoming call (1A), a soft classic ringback (2A) and a falling marimba
// when a call ends (3A).

let ctx: AudioContext | null = null;
let ringTimer: number | null = null;

/** A sounding oscillator of the ring in progress, so stopping can silence it. */
interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  /** When it stops by itself, in the context's time. */
  end: number;
}
let ringing: Voice[] = [];

function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function beep(
  freq: number,
  at: number,
  dur: number,
  type: OscillatorType = 'sine',
  vol = 0.14,
): void {
  const c = ac();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.02);
  gain.gain.setValueAtTime(vol, at + Math.max(0.03, dur - 0.05));
  gain.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

// ── volume (the redesign) ───────────────────────────────────────────────────

/** How loud a tone gets at volume 100: one note, or the notes it plays at once. */
export const MAX_TONE_GAIN = 0.2;

/**
 * A volume of Settings > Notificaciones, from 0 to 100 like its slider, as
 * the gain of a tone. Anything else is bounded: never above MAX_TONE_GAIN,
 * and silence for a value that is not a number.
 */
export function toneGain(volume: number): number {
  if (!Number.isFinite(volume)) return 0;
  return (Math.min(100, Math.max(0, volume)) / 100) * MAX_TONE_GAIN;
}

/** The incoming call tones of Settings: "Trino suave", or none. */
export type RingtoneName = 'soft' | 'silent';

export interface RingtoneOptions {
  tone: RingtoneName;
  /** From 0 to 100. */
  volume: number;
}

/** How often "Trino suave" rings (1A). */
export const SOFT_RING_EVERY_MS = 2200;

/** "Suena suave y sube poco a poco": 40 %, then 70 %, then the chosen volume. */
const SOFT_RING_STEPS = [0.4, 0.7] as const;

/** The gain of the n-th ring (from 0) of "Trino suave" at a volume. */
export function softRingGain(volume: number, ring: number): number {
  const step = SOFT_RING_STEPS[ring] ?? 1;
  return toneGain(volume) * step;
}

/**
 * A new message: two rising notes at the chosen volume (0 to 100). Volume 0
 * plays nothing. The redesign's message sound; the old screen's `ding`
 * played an empty WAV.
 */
export function playMessageTone(volume = 60): void {
  const gain = toneGain(volume);
  if (gain <= 0) return;
  const t = ac().currentTime;
  beep(880, t, 0.09, 'sine', gain);
  beep(1320, t + 0.1, 0.14, 'sine', gain);
}

// ── call tones ──────────────────────────────────────────────────────────────

/** A note of a pattern: its pitch, and when it starts, in seconds from the pattern's start. */
interface Note {
  hz: number;
  at: number;
}

/**
 * A marimba note: three sines, f, 4f and 10f, at 1, 0.35 and 0.15, after a
 * 4 ms linear attack, each decaying as exp(-(3.2 + extra) t), so the
 * overtones die first:
 * amp e^(-3.2t) (sin 2πft + 0.35 e^(-14t) sin 2π4ft + 0.15 e^(-8t) sin 2π10ft).
 */
const MARIMBA_PARTIALS = [
  { mult: 1, rel: 1, decay: 3.2 },
  { mult: 4, rel: 0.35, decay: 3.2 + 14 },
  { mult: 10, rel: 0.15, decay: 3.2 + 8 },
] as const;
const MARIMBA_ATTACK_S = 0.004;
/** How long a marimba note rings, and the fade at its end so it stops without a click. */
const MARIMBA_RING_S = 1.2;
const MARIMBA_FADE_S = 0.03;

/** 1A: E5, G5, C6, G5. */
const RING_NOTES: readonly Note[] = [
  { hz: 659.25, at: 0 },
  { hz: 783.99, at: 0.16 },
  { hz: 1046.5, at: 0.32 },
  { hz: 783.99, at: 0.48 },
];
/** 3A: G5, then C5. */
const HANG_UP_NOTES: readonly Note[] = [
  { hz: 783.99, at: 0 },
  { hz: 523.25, at: 0.18 },
];

/** The envelope of a marimba partial at `t` seconds from its note, as playMarimba schedules it. */
function marimbaEnvelope(t: number, decay: number): number {
  if (t < 0 || t >= MARIMBA_RING_S) return 0;
  if (t < MARIMBA_ATTACK_S) return t / MARIMBA_ATTACK_S;
  const fadeAt = MARIMBA_RING_S - MARIMBA_FADE_S;
  const fall = (until: number) => Math.exp(-decay * (until - MARIMBA_ATTACK_S));
  if (t < fadeAt) return fall(t);
  return (fall(fadeAt) * (MARIMBA_RING_S - t)) / MARIMBA_FADE_S;
}

const PEAKS = new Map<readonly Note[], number>();

/**
 * The loudest sample of a pattern at amplitude 1, its notes summed, sampled
 * at 48 kHz once and kept: the notes overlap, so the peak of the sum is what
 * the volume must bound, not the peak of one note.
 */
function patternPeak(notes: readonly Note[]): number {
  const known = PEAKS.get(notes);
  if (known !== undefined) return known;
  const length = Math.max(...notes.map(note => note.at)) + MARIMBA_RING_S;
  let loudest = 0;
  for (let i = 0; i < length * 48_000; i++) {
    const t = i / 48_000;
    let sum = 0;
    for (const note of notes) {
      const since = t - note.at;
      if (since < 0 || since >= MARIMBA_RING_S) continue;
      for (const p of MARIMBA_PARTIALS) {
        sum += p.rel * marimbaEnvelope(since, p.decay) * Math.sin(2 * Math.PI * note.hz * p.mult * since);
      }
    }
    loudest = Math.max(loudest, Math.abs(sum));
  }
  PEAKS.set(notes, loudest);
  return loudest;
}

/** Room left between the sampled peak and the gain, for what falls between samples. */
const PEAK_HEADROOM = 1.02;

/** Schedules a sine at `hz` from `start` to `end`, its gain shaped by `shape`. */
function voice(hz: number, start: number, end: number, shape: (gain: AudioParam) => void): Voice {
  const c = ac();
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;
  shape(gain.gain);
  osc.connect(gain).connect(c.destination);
  osc.start(start);
  osc.stop(end);
  return { osc, gain, end };
}

/** Plays marimba notes from `at`, the peak of their sum at `gain`. */
function playMarimba(notes: readonly Note[], gain: number, at: number): Voice[] {
  if (gain <= 0) return [];
  const scale = gain / (patternPeak(notes) * PEAK_HEADROOM);
  const voices: Voice[] = [];
  for (const note of notes) {
    const start = at + note.at;
    const end = start + MARIMBA_RING_S;
    const fadeAt = end - MARIMBA_FADE_S;
    for (const p of MARIMBA_PARTIALS) {
      const level = scale * p.rel;
      voices.push(
        voice(note.hz * p.mult, start, end, param => {
          param.setValueAtTime(0, start);
          param.linearRampToValueAtTime(level, start + MARIMBA_ATTACK_S);
          param.setTargetAtTime(0, start + MARIMBA_ATTACK_S, 1 / p.decay);
          param.setValueAtTime(level * marimbaEnvelope(fadeAt - start, p.decay), fadeAt);
          param.linearRampToValueAtTime(0, end);
        }),
      );
    }
  }
  return voices;
}

/** 2A: how long the ringback sounds, its attack and its release. */
const RINGBACK_S = 1;
const RINGBACK_ATTACK_S = 0.03;
const RINGBACK_RELEASE_S = 0.05;
/** How often the ringback sounds. */
const RINGBACK_EVERY_MS = 3000;

/** Keeps the voices of the ring in progress, dropping the ones already over. */
function hold(voices: Voice[]): void {
  const now = ac().currentTime;
  ringing = ringing.filter(v => v.end > now).concat(voices);
}

/**
 * Caller side (2A): the classic ringback, soft. 440 Hz and 480 Hz together
 * for 1 s every 3 s, each at half the volume (0 to 100), so together they
 * stay within it.
 */
export function startRingback(opts: { volume: number }): void {
  stopRinging();
  const level = toneGain(opts.volume) / 2;
  const loop = () => {
    if (level <= 0) return;
    const t = ac().currentTime;
    const end = t + RINGBACK_S;
    hold(
      [440, 480].map(hz =>
        voice(hz, t, end, param => {
          param.setValueAtTime(0, t);
          param.linearRampToValueAtTime(level, t + RINGBACK_ATTACK_S);
          param.setValueAtTime(level, end - RINGBACK_RELEASE_S);
          param.linearRampToValueAtTime(0, end);
        }),
      ),
    );
  };
  loop();
  ringTimer = window.setInterval(loop, RINGBACK_EVERY_MS);
}

/**
 * Callee side: the tone chosen in Settings. "Trino suave" (1A) is a marimba,
 * E5 G5 C6 G5, every 2.2 s; it starts soft and rises to the volume. Silence
 * plays nothing (and stops any tone that was playing).
 */
export function startRingtone(opts: RingtoneOptions): void {
  stopRinging();
  if (opts.tone === 'silent') return;
  let ring = 0;
  const soft = () => hold(playMarimba(RING_NOTES, softRingGain(opts.volume, ring++), ac().currentTime));
  soft();
  ringTimer = window.setInterval(soft, SOFT_RING_EVERY_MS);
}

/** How fast a stopped ring fades out: a few ms, so it is cut at once without a click. */
const STOP_FADE_TAU_S = 0.01;
const STOP_AFTER_S = 0.06;

/** Stops the ring at once: no more rings, and the notes still sounding fade out in a few ms. */
export function stopRinging(): void {
  if (ringTimer !== null) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
  const voices = ringing;
  ringing = [];
  if (!ctx || voices.length === 0) return;
  const now = ctx.currentTime;
  for (const { osc, gain, end } of voices) {
    if (end <= now) continue;
    try {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, STOP_FADE_TAU_S);
      osc.stop(now + STOP_AFTER_S);
    } catch {
      /* already stopped */
    }
  }
}

/** Short confirmation blip when a call connects. */
export function blipConnect(): void {
  const t = ac().currentTime;
  beep(520, t, 0.08, 'square', 0.12);
  beep(780, t + 0.1, 0.12, 'square', 0.12);
}

/** When a call ends (3A): a marimba falling from G5 to C5, at the volume (0 to 100). */
export function blipEnd(volume = 60): void {
  playMarimba(HANG_UP_NOTES, toneGain(volume), ac().currentTime);
}
