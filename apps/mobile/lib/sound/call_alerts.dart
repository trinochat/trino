// What a call sounds like, as the engine's call changes: the ringback while
// the other phone rings, "Trino suave" and the vibration while a call rings
// in, silence once someone answers, and the falling marimba when a call that
// was ringing out or talking ends. The rules of Ajustes › Notificaciones ›
// Llamadas and of the phone's ringer mode live here, not in the screens.
//
// A call ringing in, by the phone's mode:
// - normal (or unknown, on an iPhone): the tone, unless "Silencio", and the
//   vibration if "Vibrar" is on;
// - vibrate: only the vibration, if "Vibrar" is on;
// - silent: nothing.
// The engine never rings a blocked contact or a message request.
import 'dart:async';

import '../engine/engine.dart';
import '../platform/call_sounds.dart';

class CallAlerts {
  CallAlerts({required this.engine, required this.sounds});

  final TrinoEngine engine;
  final CallSounds sounds;

  /// The desktop plays the end tone at its default volume, whatever the
  /// ringtone's: the slider is the ringtone's (sfx.ts blipEnd()).
  static const endToneVolume = 60;

  StreamSubscription<CallSession?>? _calls;
  StreamSubscription<EngineSettings>? _settingsSubscription;
  var _settings = const EngineSettings();

  /// The call as the engine last said, at once; [_phase] and [_callId] are
  /// what the alerts handled, in order.
  CallSession? _latest;
  CallPhase? _phase;
  String? _callId;

  /// Each change waits for the one before, so sounds never overlap.
  Future<void> _queue = Future.value();

  void start() {
    _settingsSubscription ??= engine.settings.listen((settings) => _settings = settings);
    _calls ??= engine.call.listen((call) {
      _latest = call;
      _queue = _queue.then((_) => _handle(call));
    });
  }

  Future<void> _handle(CallSession? call) async {
    final previous = _phase;
    if (call?.id == _callId && call?.phase == previous) return;
    _phase = call?.phase;
    _callId = call?.id;
    if (previous != null) await _silence();
    switch (call?.phase) {
      case CallPhase.calling:
        await sounds.startRingback(_settings.ringVolume);
      case CallPhase.incoming:
        await _ringIn(call!);
      case CallPhase.connected:
        break;
      case null:
        if (previous == CallPhase.calling || previous == CallPhase.connected) {
          await sounds.playEndTone(endToneVolume);
        }
    }
  }

  Future<void> _ringIn(CallSession call) async {
    final mode = await sounds.ringerMode();
    // Answered, rejected or given up while the phone answered.
    if (_latest?.id != call.id || _latest?.phase != CallPhase.incoming) return;
    final settings = _settings;
    final ring = (mode == RingerMode.normal || mode == RingerMode.unknown) && settings.ringtone == Ringtone.soft;
    final vibrate = mode != RingerMode.silent && settings.vibrateOnRing;
    if (ring) await sounds.startRingtone(settings.ringVolume);
    if (vibrate) await sounds.startVibration();
  }

  Future<void> _silence() async {
    await sounds.stop();
    await sounds.stopVibration();
  }

  /// Stops listening, and whatever was ringing.
  Future<void> dispose() async {
    await _calls?.cancel();
    await _settingsSubscription?.cancel();
    _calls = _settingsSubscription = null;
    await _queue;
    if (_phase != null) await _silence();
    _phase = _callId = null;
  }
}
