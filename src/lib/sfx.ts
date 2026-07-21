// sfx.ts — procedural call tones via the Web Audio API (no audio files).
// Synthesized square/sine tones for a retro-terminal feel.

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

/** Caller side: soft dual-tone "ring… ring…" every 3s while waiting. */
export function startRingback(): void {
  stopRinging();
  const loop = () => {
    const t = ac().currentTime;
    beep(440, t, 0.4, 'sine', 0.1);
    beep(480, t, 0.4, 'sine', 0.1);
  };
  loop();
  ringTimer = window.setInterval(loop, 3000);
}

/** Callee side: insistent rising triple-blip every 1.6s. */
export function startRingtone(): void {
  stopRinging();
  const loop = () => {
    const t = ac().currentTime;
    beep(660, t, 0.18, 'square', 0.13);
    beep(660, t + 0.28, 0.18, 'square', 0.13);
    beep(990, t + 0.58, 0.24, 'square', 0.13);
  };
  loop();
  ringTimer = window.setInterval(loop, 1600);
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
