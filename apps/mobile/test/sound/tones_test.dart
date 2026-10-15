import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/sound/tones.dart';

/// The power of [hz] in [samples] from [from] to [to] seconds (Goertzel).
double powerAt(Int16List samples, double hz, double from, double to) {
  final start = (from * toneSampleRate).round();
  final end = math.min(samples.length, (to * toneSampleRate).round());
  final coefficient = 2 * math.cos(2 * math.pi * hz / toneSampleRate);
  var (previous, beforePrevious) = (0.0, 0.0);
  for (var i = start; i < end; i++) {
    final current = samples[i] / 32767 + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
  }
  final n = end - start;
  return (previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious) / (n * n);
}

/// Which of [candidates] sounds loudest from [from] to [to] seconds.
double loudest(Int16List samples, List<double> candidates, double from, double to) =>
    candidates.reduce((a, b) => powerAt(samples, a, from, to) >= powerAt(samples, b, from, to) ? a : b);

int peakOf(Int16List samples, [int from = 0, int? to]) {
  var peak = 0;
  for (var i = from; i < (to ?? samples.length); i++) {
    peak = math.max(peak, samples[i].abs());
  }
  return peak;
}

int frameAt(double seconds) => (seconds * toneSampleRate).round();

const e5 = 659.25, g5 = 783.99, c6 = 1046.5, c5 = 523.25;
const marimbaNotes = [c5, e5, g5, c6];

/// The 16-bit value of a gain, as the tones write it.
int levelOf(double gain) => (gain * 32767).round();

void main() {
  group('volume', () {
    test('0 to 100 maps to a gain up to MAX_TONE_GAIN, as on the desktop', () {
      expect(maxToneGain, 0.2);
      expect(toneGain(0), 0);
      expect(toneGain(50), closeTo(0.1, 1e-12));
      expect(toneGain(100), closeTo(0.2, 1e-12));
      expect(toneGain(140), closeTo(0.2, 1e-12), reason: 'bounded');
      expect(toneGain(-5), 0);
      expect(toneGain(double.nan), 0);
    });

    test('"Trino suave" starts at 40 %, then 70 %, then the chosen volume', () {
      expect(softRingGain(100, 0), closeTo(0.08, 1e-12));
      expect(softRingGain(100, 1), closeTo(0.14, 1e-12));
      expect(softRingGain(100, 2), closeTo(0.2, 1e-12));
      expect(softRingGain(100, 7), closeTo(0.2, 1e-12));
      expect(softRingGain(50, 0), closeTo(0.04, 1e-12));
    });
  });

  group('"Trino suave" (1A)', () {
    final tone = ringtone(100);

    test('rings every 2200 ms: two rings that rise, then one at the volume that loops', () {
      expect(softRingEvery, const Duration(milliseconds: 2200));
      expect(tone.intro.length, frameAt(4.4));
      expect(tone.loop.length, frameAt(2.2));
      // Each ring is over (1.68 s) well before the next starts.
      expect(peakOf(tone.intro, frameAt(1.7), frameAt(2.2)), 0);
      expect(peakOf(tone.intro, frameAt(3.9), frameAt(4.4)), 0);
      expect(peakOf(tone.loop, frameAt(1.7)), 0);
      // And each starts at once.
      expect(peakOf(tone.intro, frameAt(2.2), frameAt(2.21)), greaterThan(0));
      expect(peakOf(tone.loop, 0, frameAt(0.01)), greaterThan(0));
    });

    test('plays E5, G5, C6, G5, 160 ms apart', () {
      for (final ring in [tone.intro.sublist(0, frameAt(2.2)), tone.loop]) {
        expect(loudest(ring, marimbaNotes, 0.0, 0.15), e5);
        expect(loudest(ring, marimbaNotes, 0.17, 0.31), g5);
        expect(loudest(ring, marimbaNotes, 0.33, 0.47), c6);
        expect(loudest(ring, marimbaNotes, 0.49, 0.62), g5);
      }
    });

    test('a marimba: the fourth harmonic sounds at the start and dies first', () {
      final early = powerAt(tone.loop, e5 * 4, 0.0, 0.1);
      final late = powerAt(tone.loop, e5 * 4, 0.1, 0.16);
      expect(early, greaterThan(0));
      expect(late, lessThan(early / 4));
    });

    test('the peaks follow 40 %, 70 % and 100 % of the volume, never above MAX_TONE_GAIN', () {
      final first = peakOf(tone.intro, 0, frameAt(2.2));
      final second = peakOf(tone.intro, frameAt(2.2));
      final steady = peakOf(tone.loop);
      // The sum of the notes peaks at the gain, less the desktop's 2 % headroom.
      expect(steady, closeTo(levelOf(0.2 / 1.02), 1));
      expect(first, closeTo(levelOf(0.08 / 1.02), 1));
      expect(second, closeTo(levelOf(0.14 / 1.02), 1));
      expect(steady, lessThanOrEqualTo(levelOf(maxToneGain)));
      final half = ringtone(50);
      expect(peakOf(half.loop), closeTo(levelOf(0.1 / 1.02), 1));
    });

    test('volume 0 is silence', () {
      final silent = ringtone(0);
      expect(peakOf(silent.intro), 0);
      expect(peakOf(silent.loop), 0);
    });
  });

  group('ringback (2A)', () {
    final cycle = ringbackCycle(100);

    test('440 Hz and 480 Hz together for 1 s, every 3 s', () {
      expect(cycle.length, frameAt(3));
      expect(powerAt(cycle, 440, 0.1, 0.9), greaterThan(1e-4));
      expect(powerAt(cycle, 480, 0.1, 0.9), greaterThan(1e-4));
      expect(powerAt(cycle, 660, 0.1, 0.9), lessThan(1e-6));
      expect(peakOf(cycle, frameAt(1.0)), 0, reason: 'silent for 2 s');
    });

    test('fades in over 30 ms and out over the last 50 ms', () {
      expect(peakOf(cycle, 0, frameAt(0.005)), lessThan(peakOf(cycle, frameAt(0.1), frameAt(0.9)) / 4));
      expect(peakOf(cycle, frameAt(0.995), frameAt(1.0)), lessThan(peakOf(cycle, frameAt(0.1), frameAt(0.9)) / 4));
    });

    test('each tone at half the volume, so together they stay within it', () {
      expect(peakOf(cycle), lessThanOrEqualTo(levelOf(0.2)));
      expect(peakOf(cycle), greaterThan(levelOf(0.19)));
      expect(peakOf(ringbackCycle(0)), 0);
    });
  });

  group('when a call ends (3A)', () {
    final tone = endTone(100);

    test('a marimba falling from G5 to C5, 180 ms apart', () {
      expect(tone.length, frameAt(0.18 + 1.2));
      expect(loudest(tone, marimbaNotes, 0.0, 0.17), g5);
      expect(loudest(tone, marimbaNotes, 0.2, 0.4), c5);
    });

    test('at the volume, never above MAX_TONE_GAIN, and silent at 0', () {
      expect(peakOf(tone), closeTo(levelOf(0.2 / 1.02), 1));
      expect(peakOf(endTone(60)), closeTo(levelOf(0.12 / 1.02), 1));
      expect(peakOf(endTone(0)), 0);
    });
  });

  test('WAV: 16-bit PCM, mono, 44.1 kHz, with the samples after a 44-byte header', () {
    final samples = Int16List.fromList([0, 1000, -1000, 32767]);
    final bytes = wav(samples);
    final data = ByteData.sublistView(bytes);
    String tag(int at) => String.fromCharCodes(bytes.sublist(at, at + 4));
    expect(bytes.length, 44 + 8);
    expect((tag(0), tag(8), tag(12), tag(36)), ('RIFF', 'WAVE', 'fmt ', 'data'));
    expect(data.getUint32(4, Endian.little), 36 + 8);
    expect(data.getUint16(20, Endian.little), 1, reason: 'PCM');
    expect(data.getUint16(22, Endian.little), 1, reason: 'mono');
    expect(data.getUint32(24, Endian.little), 44100);
    expect(data.getUint32(28, Endian.little), 44100 * 2, reason: 'bytes per second');
    expect(data.getUint16(32, Endian.little), 2, reason: 'block align');
    expect(data.getUint16(34, Endian.little), 16);
    expect(data.getUint32(40, Endian.little), 8);
    expect([for (var i = 0; i < 4; i++) data.getInt16(44 + i * 2, Endian.little)], [0, 1000, -1000, 32767]);
  });
}
