import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';
import 'package:trino_mobile/platform/call_sounds.dart';
import 'package:trino_mobile/sound/call_alerts.dart';

final now = DateTime(2026, 10, 9, 11);

void main() {
  late FakeTrinoEngine engine;
  late DemoCallSounds sounds;
  late CallAlerts alerts;

  Future<void> start({RingerMode mode = RingerMode.normal, Duration? answerAfter = Duration.zero}) async {
    engine = FakeTrinoEngine(clock: () => now, answerAfter: answerAfter);
    sounds = DemoCallSounds(mode: mode);
    alerts = CallAlerts(engine: engine, sounds: sounds)..start();
    addTearDown(() async {
      await alerts.dispose();
      await engine.dispose();
    });
    await pumpEventQueue();
  }

  Future<void> settings(EngineSettings Function(EngineSettings) change) async {
    await engine.updateSettings(change(await engine.settings.first));
    await pumpEventQueue();
  }

  test('the settings start as on the desktop: "Trino suave" at 60, and vibrating', () {
    const defaults = EngineSettings();
    expect((defaults.ringtone, defaults.ringVolume, defaults.vibrateOnRing), (Ringtone.soft, 60, true));
  });

  test('the engine keeps the volume between 0 and 100', () async {
    await start();
    await settings((s) => s.copyWith(ringVolume: 140));
    expect((await engine.settings.first).ringVolume, 100);
    await settings((s) => s.copyWith(ringVolume: -3));
    expect((await engine.settings.first).ringVolume, 0);
  });

  group('calling out', () {
    test('the ringback plays until they answer; hanging up plays the end tone', () async {
      await start(answerAfter: null);
      await engine.startCall('ana');
      await pumpEventQueue();
      expect(sounds.log, ['ringback 60']);
      engine.answerOutgoing();
      await pumpEventQueue();
      expect(sounds.log, ['ringback 60', 'stop', 'stopVibration']);
      sounds.log.clear();
      await engine.hangUp();
      await pumpEventQueue();
      expect(sounds.log, ['stop', 'stopVibration', 'end 60']);
    });

    test('hanging up while it still rings stops the ringback and plays the end tone', () async {
      await start(answerAfter: null);
      await engine.startCall('ana');
      await engine.hangUp();
      await pumpEventQueue();
      expect(sounds.log, ['ringback 60', 'stop', 'stopVibration', 'end 60']);
    });

    test('the ringback follows the volume, even with the ringtone off', () async {
      await start(answerAfter: null);
      await settings((s) => s.copyWith(ringVolume: 25, ringtone: Ringtone.silent));
      await engine.startCall('ana');
      await pumpEventQueue();
      expect(sounds.log, ['ringback 25']);
    });
  });

  group('a call comes in', () {
    test('rings "Trino suave" at the volume and vibrates; answering stops both', () async {
      await start();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, ['ringtone 60', 'vibrate']);
      await engine.answerCall();
      await pumpEventQueue();
      expect(sounds.log.skip(2), ['stop', 'stopVibration']);
      sounds.log.clear();
      await engine.hangUp();
      await pumpEventQueue();
      expect(sounds.log, ['stop', 'stopVibration', 'end 60']);
    });

    test('rejecting stops the ring, with no end tone', () async {
      await start();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      await engine.rejectCall();
      await pumpEventQueue();
      expect(sounds.log, ['ringtone 60', 'vibrate', 'stop', 'stopVibration']);
    });

    test('when the caller gives up, the ring stops too', () async {
      await start();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      engine.remoteHangUp();
      await pumpEventQueue();
      expect(sounds.log, ['ringtone 60', 'vibrate', 'stop', 'stopVibration']);
    });

    test('with "Vibrar" off it only rings; with "Silencio" it only vibrates', () async {
      await start();
      await settings((s) => s.copyWith(vibrateOnRing: false, ringVolume: 35));
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, ['ringtone 35']);
      await engine.rejectCall();
      await settings((s) => s.copyWith(vibrateOnRing: true, ringtone: Ringtone.silent));
      sounds.log.clear();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, ['vibrate']);
    });

    test('with the phone on vibrate it only vibrates, and only if "Vibrar" is on', () async {
      await start(mode: RingerMode.vibrate);
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, ['vibrate']);
      await engine.rejectCall();
      await settings((s) => s.copyWith(vibrateOnRing: false));
      sounds.log.clear();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, isEmpty);
    });

    test('with the phone on silent nothing sounds or vibrates', () async {
      await start(mode: RingerMode.silent);
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, isEmpty);
    });

    test('where the mode cannot be read (iPhone), it rings: the system mutes it with the switch', () async {
      await start(mode: RingerMode.unknown);
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, ['ringtone 60', 'vibrate']);
    });

    test('a blocked contact never rings', () async {
      await start();
      await engine.blockContact('carlos');
      engine.receiveCall('carlos');
      await pumpEventQueue();
      expect(sounds.log, isEmpty);
    });

    test('a call answered while the mode was being read does not start ringing', () async {
      await start();
      sounds.modeDelay = Completer<void>();
      engine.receiveCall('carlos');
      await pumpEventQueue();
      await engine.answerCall();
      await pumpEventQueue();
      sounds.modeDelay!.complete();
      await pumpEventQueue();
      expect(sounds.log.where((entry) => entry.startsWith('ringtone') || entry == 'vibrate'), isEmpty);
    });
  });

  test('stopping the alerts silences what was ringing', () async {
    await start();
    engine.receiveCall('carlos');
    await pumpEventQueue();
    await alerts.dispose();
    expect(sounds.log.skip(2), ['stop', 'stopVibration']);
  });
}
