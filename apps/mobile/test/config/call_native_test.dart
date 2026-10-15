// The native halves of the call channels, read as text: `flutter test` cannot
// run Kotlin or Swift, so these check the essentials that would otherwise only
// fail on a phone. The APK build compiles the Kotlin; the Swift is first
// compiled by the TestFlight workflow.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/platform/call_sounds.dart';
import 'package:trino_mobile/platform/proximity.dart';

const kotlinDir = 'android/app/src/main/kotlin/app/trino/trino_mobile';

String read(String path) => File(path).readAsStringSync();

/// Every Kotlin file of the app, together.
String kotlin() => [
  for (final file in Directory(kotlinDir).listSync().whereType<File>())
    if (file.path.endsWith('.kt')) file.readAsStringSync(),
].join('\n');

/// The manifest without its comments, so a permission only mentioned in one
/// does not count.
String manifest() =>
    read('android/app/src/main/AndroidManifest.xml').replaceAll(RegExp('<!--.*?-->', dotAll: true), '');

const soundMethods = ['playLoop', 'playOnce', 'stop', 'vibrate', 'cancelVibration', 'ringerMode'];

void main() {
  group('Android', () {
    test('MainActivity opens the call sounds channel on the engine it configures', () {
      final activity = read('$kotlinDir/MainActivity.kt');
      expect(activity, contains('override fun configureFlutterEngine'));
      expect(activity, contains('super.configureFlutterEngine(flutterEngine)'), reason: 'keeps the plugins');
      expect(activity, contains('CallSounds('));
      expect(activity, contains('override fun cleanUpFlutterEngine'), reason: 'stops the sound with the engine');
    });

    test('the call sounds answer every method of the Dart side, on its channel', () {
      final code = kotlin();
      expect(code, contains('"${PlatformCallSounds.channelName}"'));
      for (final method in soundMethods) {
        expect(code, contains('"$method"'), reason: method);
      }
    });

    test('the ring plays as a ringtone, the ringback and the end tone on the voice stream', () {
      final code = kotlin();
      expect(code, contains('AudioAttributes.USAGE_NOTIFICATION_RINGTONE'));
      expect(code, contains('AudioAttributes.USAGE_VOICE_COMMUNICATION'));
      expect(code, contains('AudioTrack.MODE_STATIC'));
      expect(code, contains('setLoopPoints('), reason: 'the intro plays once, then the loop');
      expect(code, contains('44100'), reason: 'the rate of lib/sound/tones.dart');
    });

    test('reads the ringer mode and vibrates with the system vibrator', () {
      final code = kotlin();
      for (final mode in ['RINGER_MODE_SILENT', 'RINGER_MODE_VIBRATE']) {
        expect(code, contains('AudioManager.$mode'), reason: mode);
      }
      expect(code, contains('VibratorManager'), reason: 'Android 12 and later');
      expect(code, contains('VibrationEffect.createWaveform'));
    });

    test('the manifest asks for the vibration permission', () {
      expect(manifest(), contains('<uses-permission android:name="android.permission.VIBRATE"'));
    });

    test('the screen turns off next to the face with a proximity wake lock, where the phone has the sensor', () {
      final code = kotlin();
      expect(code, contains('"${PlatformProximityScreen.channelName}"'));
      expect(code, contains('"enable"'));
      expect(code, contains('"disable"'));
      expect(code, contains('PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK'));
      expect(code, contains('isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)'));
      expect(code, contains('"trino:call"'), reason: 'the wake lock tag, as the system lists it');
      expect(code, contains('.release('));
      final activity = read('$kotlinDir/MainActivity.kt');
      expect(activity, contains('ProximityScreen('));
      expect(activity, contains('proximity?.dispose()'), reason: 'released with the engine');
    });

    test('the manifest asks for the wake lock permission the proximity lock needs', () {
      expect(manifest(), contains('<uses-permission android:name="android.permission.WAKE_LOCK"'));
    });
  });

  group('iOS', () {
    final delegate = read('ios/Runner/AppDelegate.swift');

    test('the app delegate opens the call sounds channel once the engine is up, keeping the plugins', () {
      expect(delegate, contains('GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)'));
      expect(delegate, contains('registrar(forPlugin:'));
      expect(delegate, contains('"${PlatformCallSounds.channelName}"'));
      for (final method in soundMethods) {
        expect(delegate, contains('"$method"'), reason: method);
      }
    });

    test('plays the WAV with AVAudioPlayer; the ring mutes with the ring/silent switch', () {
      expect(delegate, contains('import AVFoundation'));
      expect(delegate, contains('AVAudioPlayer(data:'));
      expect(delegate, contains(RegExp(r'numberOfLoops = .*-1')), reason: 'loops until stopped');
      expect(delegate, contains('.soloAmbient'), reason: 'the category the switch silences');
      expect(delegate, contains('kSystemSoundID_Vibrate'));
      expect(delegate, contains('result("unknown")'), reason: 'iOS has no public API for the switch');
    });

    test('turns proximity monitoring on and off on its channel', () {
      expect(delegate, contains('"${PlatformProximityScreen.channelName}"'));
      expect(delegate, contains('UIDevice.current.isProximityMonitoringEnabled = true'));
      expect(delegate, contains('UIDevice.current.isProximityMonitoringEnabled = false'));
    });
  });
}
