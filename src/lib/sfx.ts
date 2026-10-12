// sfx.ts — procedural call and message tones via the Web Audio API (no audio
// files). Synthesized square/sine tones for a retro-terminal feel; the
// redesign adds a bounded volume, the message tone and "Trino suave".

let ctx: AudioContext | null = null;
let ringTimer: number | null = null;

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

/** How often "Trino suave" rings. */
export const SOFT_RING_EVERY_MS = 2400;

/** "Suena suave y sube poco a poco": 40 %, then 70 %, then the chosen volume. */
const SOFT_RING_STEPS = [0.4, 0.7] as const;

/** The gain of the n-th ring (from 0) of "Trino suave" at a volume. */
export function softRingGain(volume: number, ring: number): number {
  const step = SOFT_RING_STEPS[ring] ?? 1;
  return toneGain(volume) * step;
}

/** A short trill of soft sine notes, like the bird the app is named after. */
function softTrill(gain: number): void {
  if (gain <= 0) return;
  const t = ac().currentTime;
  [784, 988, 784, 988, 1175].forEach((hz, i) => beep(hz, t + i * 0.11, 0.09, 'sine', gain));
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

/**
 * Caller side: soft dual-tone "ring… ring…" every 3s while waiting. Both
 * notes together reach the volume (0 to 100).
 */
export function startRingback(opts: { volume: number }): void {
  stopRinging();
  const gain = toneGain(opts.volume) / 2;
  const loop = () => {
    if (gain <= 0) return;
    const t = ac().currentTime;
    beep(440, t, 0.4, 'sine', gain);
    beep(480, t, 0.4, 'sine', gain);
  };
  loop();
  ringTimer = window.setInterval(loop, 3000);
}

/**
 * Callee side: the tone chosen in Settings. "Trino suave" starts soft and
 * rises to the volume; silence plays nothing (and stops any tone that was
 * playing).
 */
export function startRingtone(opts: RingtoneOptions): void {
  stopRinging();
  if (opts.tone === 'silent') return;
  let ring = 0;
  const soft = () => softTrill(softRingGain(opts.volume, ring++));
  soft();
  ringTimer = window.setInterval(soft, SOFT_RING_EVERY_MS);
}

export function stopRinging(): void {
  if (ringTimer !== null) {
    clearInterval(ringTimer);
    ringTimer = null;
  }
}

/** Short confirmation blip when a call connects. */
export function blipConnect(): void {
  const t = ac().currentTime;
  beep(520, t, 0.08, 'square', 0.12);
  beep(780, t + 0.1, 0.12, 'square', 0.12);
}

/** Descending blip when a call ends. */
export function blipEnd(): void {
  const t = ac().currentTime;
  beep(600, t, 0.1, 'sawtooth', 0.1);
  beep(360, t + 0.11, 0.16, 'sawtooth', 0.1);
}
