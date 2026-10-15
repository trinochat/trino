import 'package:flutter/widgets.dart';

import 'app/app.dart';
import 'engine/fake_engine.dart';
import 'platform/call_sounds.dart';
import 'platform/proximity.dart';

/// Trino on the in-memory demo engine until the Rust engine is wired in
/// (task M6): it starts at the first run, connects after a moment, and shows
/// messages as sending for a short while, as the real network would. Linking
/// is confirmed on the demo computer a few seconds after the code shows, and
/// the chats then arrive a quarter at a time. A call you make rings for a few
/// seconds before the demo contact answers. The call sounds and the proximity
/// sensor are the phone's.
/// To hear a call ring in, Ajustes › Notificaciones has "Simular una llamada
/// entrante (demostración)": Ana calls at once. Nothing rings by itself.
void main() {
  final engine = FakeTrinoEngine(
    onboarded: false,
    connectAfter: const Duration(seconds: 2),
    sendDelay: const Duration(milliseconds: 600),
    linkConfirmAfter: const Duration(seconds: 4),
    answerAfter: const Duration(seconds: 4),
  );
  runApp(
    TrinoApp(
      engine: engine,
      callSounds: PlatformCallSounds(),
      proximity: PlatformProximityScreen(),
      demoIncomingCall: () {
        engine.receiveCall('ana');
      },
    ),
  );
}
