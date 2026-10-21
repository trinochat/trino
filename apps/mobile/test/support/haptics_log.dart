// Records the vibrations the app asks the phone for, through Flutter's
// HapticFeedback (the platform channel), so tests can check which ones.
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

class HapticsLog {
  HapticsLog._();

  /// Starts listening on the platform channel; [stop] in a tear-down.
  factory HapticsLog.start() {
    final log = HapticsLog._();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'HapticFeedback.vibrate') log.calls.add(call);
        return null;
      },
    );
    return log;
  }

  final calls = <MethodCall>[];

  /// The pattern of each vibration, such as "HapticFeedbackType.mediumImpact".
  List<String?> get patterns => [for (final call in calls) call.arguments as String?];

  void stop() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(
    SystemChannels.platform,
    null,
  );
}
