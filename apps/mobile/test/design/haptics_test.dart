import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/haptics.dart';

import '../support/haptics_log.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('each moment has its own pattern from the system, by meaning', () async {
    final log = HapticsLog.start();
    addTearDown(log.stop);
    await TrinoHaptics.threshold();
    await TrinoHaptics.toggled();
    await TrinoHaptics.destructiveConfirmed();
    await TrinoHaptics.callAnswered();
    await TrinoHaptics.callEnded();
    expect(log.patterns, [
      'HapticFeedbackType.selectionClick',
      'HapticFeedbackType.selectionClick',
      'HapticFeedbackType.heavyImpact',
      'HapticFeedbackType.mediumImpact',
      'HapticFeedbackType.mediumImpact',
    ]);
  });

  test('never the long vibration: only HapticFeedback, which follows the phone\'s settings', () async {
    final log = HapticsLog.start();
    addTearDown(log.stop);
    await TrinoHaptics.destructiveConfirmed();
    expect(log.calls.map((call) => call.method), everyElement('HapticFeedback.vibrate'));
    expect(log.patterns, isNot(contains(isNull)), reason: 'HapticFeedback.vibrate() alone is the long press buzz');
    expect(SystemChannels.platform.name, 'flutter/platform');
  });
}
