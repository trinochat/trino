// The call tones of the desktop (feat/rediseno: src/lib/sfx.ts), rendered to
// 16-bit PCM instead of played through Web Audio: the same notes, envelopes,
// timing and gains David chose on 12 Oct 2026. No audio files and no package:
// the phone plays the samples through a native channel (call_sounds.dart).
//
// - "Trino suave" (1A), the incoming call: a marimba, E5 G5 C6 G5, every
//   2.2 s; it starts at 40 % of the volume, then 70 %, then the volume.
// - The ringback (2A), while the other phone rings: 440 Hz and 480 Hz together
//   for 1 s every 3 s, soft.
// - When a call ends (3A): a marimba falling from G5 to C5.
import 'dart:math' as math;
import 'dart:typed_data';

/// Samples per second of every tone.
const toneSampleRate = 44100;

/// How loud a tone gets at volume 100: one note, or the notes it plays at once.
const maxToneGain = 0.2;

/// A volume of Ajustes › Notificaciones, from 0 to 100 like its slider, as the
/// gain of a tone. Anything else is bounded: never above [maxToneGain], and
/// silence for a value that is not a number.
double toneGain(num volume) {
  if (volume.isNaN || volume.isInfinite) return 0;
  return volume.clamp(0, 100) / 100 * maxToneGain;
}

/// How often "Trino suave" rings (1A).
const softRingEvery = Duration(milliseconds: 2200);

/// "Empieza suave y sube poco a poco": 40 %, then 70 %, then the chosen volume.
const _softRingSteps = [0.4, 0.7];

/// The gain of the n-th ring (from 0) of "Trino suave" at a volume.
double softRingGain(num volume, int ring) =>
    toneGain(volume) * (ring < _softRingSteps.length ? _softRingSteps[ring] : 1);

/// A note of a pattern: its pitch, and when it starts, in seconds from the
/// pattern's start.
typedef _Note = ({double hz, double at});

/// A marimba note: three sines, f, 4f and 10f, at 1, 0.35 and 0.15, after a
/// 4 ms linear attack, each decaying as exp(-(3.2 + extra) t), so the
/// overtones die first.
const _marimbaPartials = [
  (mult: 1, rel: 1.0, decay: 3.2),
  (mult: 4, rel: 0.35, decay: 3.2 + 14),
  (mult: 10, rel: 0.15, decay: 3.2 + 8),
];
const _marimbaAttackS = 0.004;

/// How long a marimba note rings, and the fade at its end so it stops without
/// a click.
const _marimbaRingS = 1.2;
const _marimbaFadeS = 0.03;

/// 1A: E5, G5, C6, G5.
const List<_Note> _ringNotes = [
  (hz: 659.25, at: 0),
  (hz: 783.99, at: 0.16),
  (hz: 1046.5, at: 0.32),
  (hz: 783.99, at: 0.48),
];

/// 3A: G5, then C5.
const List<_Note> _hangUpNotes = [(hz: 783.99, at: 0), (hz: 523.25, at: 0.18)];

/// Room left between the peak and the gain, as on the desktop.
const _peakHeadroom = 1.02;

/// The envelope of a marimba partial at [t] seconds from its note.
double _marimbaEnvelope(double t, double decay) {
  if (t < 0 || t >= _marimbaRingS) return 0;
  if (t < _marimbaAttackS) return t / _marimbaAttackS;
  double fall(double until) => math.exp(-decay * (until - _marimbaAttackS));
  const fadeAt = _marimbaRingS - _marimbaFadeS;
  if (t < fadeAt) return fall(t);
  return fall(fadeAt) * (_marimbaRingS - t) / _marimbaFadeS;
}

/// Marimba [notes] over [seconds], the peak of their sum at [gain] less the
/// headroom: the notes overlap, so the sum is what the volume bounds.
Int16List _marimba(List<_Note> notes, double gain, double seconds) {
  final frames = (seconds * toneSampleRate).round();
  if (gain <= 0) return Int16List(frames);
  final sum = Float64List(frames);
  for (final note in notes) {
    final first = (note.at * toneSampleRate).ceil();
    final last = math.min(frames, ((note.at + _marimbaRingS) * toneSampleRate).ceil());
    for (var i = first; i < last; i++) {
      final since = i / toneSampleRate - note.at;
      for (final p in _marimbaPartials) {
        sum[i] += p.rel * _marimbaEnvelope(since, p.decay) * math.sin(2 * math.pi * note.hz * p.mult * since);
      }
    }
  }
  var peak = 0.0;
  for (final value in sum) {
    peak = math.max(peak, value.abs());
  }
  return _quantize(sum, gain / (peak * _peakHeadroom));
}

Int16List _quantize(Float64List samples, double scale) {
  final out = Int16List(samples.length);
  for (var i = 0; i < samples.length; i++) {
    out[i] = (samples[i] * scale * 32767).round().clamp(-32768, 32767);
  }
  return out;
}

double _seconds(Duration duration) => duration.inMicroseconds / Duration.microsecondsPerSecond;

/// A tone that plays [intro] once and then [loop] until it is stopped.
typedef LoopingTone = ({Int16List intro, Int16List loop});

/// "Trino suave" at [volume]: the first two rings, softer, as the intro, then
/// a ring at the volume that loops, each 2.2 s long.
LoopingTone ringtone(num volume) {
  final every = _seconds(softRingEvery);
  Int16List ring(int n) => _marimba(_ringNotes, softRingGain(volume, n), every);
  return (intro: Int16List.fromList([...ring(0), ...ring(1)]), loop: ring(_softRingSteps.length));
}

/// 2A: how long the ringback sounds, its attack, its release and how often.
const _ringbackS = 1.0;
const _ringbackAttackS = 0.03;
const _ringbackReleaseS = 0.05;
const _ringbackEveryS = 3.0;

/// One cycle of the ringback at [volume]: 440 Hz and 480 Hz for 1 s, each at
/// half the gain, then 2 s of silence. It loops.
Int16List ringbackCycle(num volume) {
  final frames = (_ringbackEveryS * toneSampleRate).round();
  final level = toneGain(volume) / 2;
  final samples = Float64List(frames);
  if (level <= 0) return Int16List(frames);
  final sounding = (_ringbackS * toneSampleRate).round();
  for (var i = 0; i < sounding; i++) {
    final t = i / toneSampleRate;
    final envelope = t < _ringbackAttackS
        ? t / _ringbackAttackS
        : t < _ringbackS - _ringbackReleaseS
        ? 1.0
        : (_ringbackS - t) / _ringbackReleaseS;
    samples[i] = level * envelope * (math.sin(2 * math.pi * 440 * t) + math.sin(2 * math.pi * 480 * t));
  }
  return _quantize(samples, 1);
}

/// 3A at [volume]: G5 falling to C5.
Int16List endTone(num volume) => _marimba(_hangUpNotes, toneGain(volume), _hangUpNotes.last.at + _marimbaRingS);

/// [samples] as a WAV file: 16-bit PCM, mono, [toneSampleRate].
Uint8List wav(Int16List samples) {
  final dataBytes = samples.length * 2;
  final out = ByteData(44 + dataBytes);
  void tag(int at, String text) {
    for (var i = 0; i < 4; i++) {
      out.setUint8(at + i, text.codeUnitAt(i));
    }
  }

  tag(0, 'RIFF');
  out.setUint32(4, 36 + dataBytes, Endian.little);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  out.setUint32(16, 16, Endian.little);
  out.setUint16(20, 1, Endian.little);
  out.setUint16(22, 1, Endian.little);
  out.setUint32(24, toneSampleRate, Endian.little);
  out.setUint32(28, toneSampleRate * 2, Endian.little);
  out.setUint16(32, 2, Endian.little);
  out.setUint16(34, 16, Endian.little);
  tag(36, 'data');
  out.setUint32(40, dataBytes, Endian.little);
  for (var i = 0; i < samples.length; i++) {
    out.setInt16(44 + i * 2, samples[i], Endian.little);
  }
  return out.buffer.asUint8List();
}
