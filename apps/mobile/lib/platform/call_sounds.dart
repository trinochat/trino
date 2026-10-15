// The phone's speaker and vibrator for calls, behind a small interface: the
// tones are rendered in Dart (lib/sound/tones.dart) and the platform only
// plays the samples, over one channel of the app's own (Kotlin in
// MainActivity's CallSounds, Swift in AppDelegate). No package.
import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import '../sound/tones.dart';

/// What the phone is set to for calls and notifications.
enum RingerMode {
  normal,

  /// Only vibrates.
  vibrate,
  silent,

  /// The phone does not say. iPhones have no public way to read the
  /// ring/silent switch: there the ring uses a sound category the switch
  /// mutes, so it still respects it.
  unknown,
}

abstract interface class CallSounds {
  /// "Trino suave" at [volume] (0 to 100), rising, until [stop].
  Future<void> startRingtone(int volume);

  /// The ringback while the other phone rings, until [stop].
  Future<void> startRingback(int volume);

  /// The falling marimba when a call ends, once.
  Future<void> playEndTone(int volume);

  /// One ring of "Trino suave" at [volume], to hear it from Ajustes.
  Future<void> previewRingtone(int volume);

  /// Stops the ring or the ringback at once.
  Future<void> stop();

  /// Vibrates with each ring until [stopVibration].
  Future<void> startVibration();
  Future<void> stopVibration();
  Future<RingerMode> ringerMode();
}

/// Plays nothing: for the tests and for a phone without the native side. It
/// keeps what it was asked in [log], and answers [mode].
class DemoCallSounds implements CallSounds {
  DemoCallSounds({this.mode = RingerMode.normal});

  RingerMode mode;

  /// What it was asked, oldest first: "ringtone 60", "ringback 60", "end 60",
  /// "preview 60", "stop", "vibrate", "stopVibration".
  final log = <String>[];

  /// For the tests: [ringerMode] waits for it.
  @visibleForTesting
  Completer<void>? modeDelay;

  @override
  Future<void> startRingtone(int volume) async => log.add('ringtone $volume');

  @override
  Future<void> startRingback(int volume) async => log.add('ringback $volume');

  @override
  Future<void> playEndTone(int volume) async => log.add('end $volume');

  @override
  Future<void> previewRingtone(int volume) async => log.add('preview $volume');

  @override
  Future<void> stop() async => log.add('stop');

  @override
  Future<void> startVibration() async => log.add('vibrate');

  @override
  Future<void> stopVibration() async => log.add('stopVibration');

  @override
  Future<RingerMode> ringerMode() async {
    await modeDelay?.future;
    return mode;
  }
}

/// The native side, over [channelName]. A phone without it (or failing) plays
/// nothing and answers [RingerMode.unknown]: a missing sound never breaks a
/// call.
class PlatformCallSounds implements CallSounds {
  PlatformCallSounds();

  static const channelName = 'org.trinochat.app/call_sounds';

  /// Wait, vibrate, pause, in ms: once per ring of "Trino suave".
  static const vibrationPattern = [0, 800, 1400];

  final _channel = const MethodChannel(channelName);

  /// The rendered tones by volume: rendering a ring takes a moment.
  final _ringtones = <int, ({Uint8List intro, Uint8List loop})>{};
  final _ringbacks = <int, Uint8List>{};
  final _endTones = <int, Uint8List>{};

  ({Uint8List intro, Uint8List loop}) _ringtone(int volume) => _ringtones.putIfAbsent(volume, () {
    final tone = ringtone(volume);
    return (intro: wav(tone.intro), loop: wav(tone.loop));
  });

  Future<T?> _invoke<T>(String method, [Map<String, Object?>? arguments]) async {
    try {
      return await _channel.invokeMethod<T>(method, arguments);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    }
  }

  @override
  Future<void> startRingtone(int volume) {
    final tone = _ringtone(volume);
    return _invoke<void>('playLoop', {'usage': 'ringtone', 'intro': tone.intro, 'loop': tone.loop});
  }

  @override
  Future<void> startRingback(int volume) => _invoke<void>('playLoop', {
    'usage': 'voice',
    'intro': null,
    'loop': _ringbacks.putIfAbsent(volume, () => wav(ringbackCycle(volume))),
  });

  @override
  Future<void> playEndTone(int volume) =>
      _invoke<void>('playOnce', {'usage': 'voice', 'wav': _endTones.putIfAbsent(volume, () => wav(endTone(volume)))});

  @override
  Future<void> previewRingtone(int volume) =>
      _invoke<void>('playOnce', {'usage': 'ringtone', 'wav': _ringtone(volume).loop});

  @override
  Future<void> stop() => _invoke<void>('stop');

  @override
  Future<void> startVibration() => _invoke<void>('vibrate', {'pattern': vibrationPattern});

  @override
  Future<void> stopVibration() => _invoke<void>('cancelVibration');

  @override
  Future<RingerMode> ringerMode() async => switch (await _invoke<String>('ringerMode')) {
    'normal' => RingerMode.normal,
    'vibrate' => RingerMode.vibrate,
    'silent' => RingerMode.silent,
    _ => RingerMode.unknown,
  };
}
