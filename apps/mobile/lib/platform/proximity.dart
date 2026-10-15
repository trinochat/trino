// The screen next to the face, behind a small interface: during an audio call
// the proximity sensor turns the screen off so the cheek touches nothing. The
// call screen decides when (call_screen.dart); the platform only switches it,
// over one channel of the app's own (Kotlin's ProximityScreen with a
// PROXIMITY_SCREEN_OFF_WAKE_LOCK, Swift's isProximityMonitoringEnabled).
import 'package:flutter/services.dart';

abstract interface class ProximityScreen {
  /// The screen turns off while something is next to it.
  Future<void> enable();

  /// The screen stays on again.
  Future<void> disable();
}

/// Switches nothing: for the tests and for a phone without the native side.
class DemoProximityScreen implements ProximityScreen {
  DemoProximityScreen();

  bool enabled = false;

  /// What it was asked, oldest first: "enable", "disable".
  final log = <String>[];

  @override
  Future<void> enable() async {
    enabled = true;
    log.add('enable');
  }

  @override
  Future<void> disable() async {
    enabled = false;
    log.add('disable');
  }
}

/// The native side, over [channelName]. A phone without the sensor, or without
/// the native side, keeps the screen on.
class PlatformProximityScreen implements ProximityScreen {
  PlatformProximityScreen();

  static const channelName = 'org.trinochat.app/proximity';

  final _channel = const MethodChannel(channelName);

  Future<void> _invoke(String method) async {
    try {
      await _channel.invokeMethod<Object?>(method);
    } on MissingPluginException {
      // No native side: the screen stays on.
    } on PlatformException {
      // No sensor: the screen stays on.
    }
  }

  @override
  Future<void> enable() => _invoke('enable');

  @override
  Future<void> disable() => _invoke('disable');
}
