// An iOS app answers App Store Connect's export compliance question in its
// Info.plist (ITSAppUsesNonExemptEncryption). The demo answers "no": its
// engine lives in memory and encrypts nothing, and the system's HTTPS is
// exempt. Trino's real engine brings its own end-to-end encryption, so the
// answer has to change with it.
//
// These tests start the app as main() does and look at the engine it got, so
// wiring in the real engine while the plist still says "no" fails here, instead
// of shipping a false declaration. They read the wiring rather than a flag
// such as kIsDemoEngine because a flag can be forgotten just like the plist.
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/app/app.dart';
import 'package:trino_mobile/engine/fake_engine.dart';
import 'package:trino_mobile/main.dart' as app;

import '../support/native_config.dart';

const key = 'ITSAppUsesNonExemptEncryption';

bool? declaresEncryption() => Plist.read('ios/Runner/Info.plist').boolean(key);

void main() {
  test('Info.plist answers the encryption question, so App Store Connect does not hold each build for it', () {
    expect(declaresEncryption(), isNotNull, reason: '$key is missing from ios/Runner/Info.plist');
  });

  testWidgets('answers "no encryption" only while the app runs on the demo engine', (tester) async {
    // Declaring encryption is always allowed.
    if (declaresEncryption() != false) return;

    app.main();
    // Lets the demo engine connect, so none of its timers is left pending.
    await tester.pump(const Duration(seconds: 3));

    // The exact type: an engine built on top of the demo one counts as another.
    final engine = tester.widget<TrinoApp>(find.byType(TrinoApp)).engine;
    expect(
      engine.runtimeType,
      FakeTrinoEngine,
      reason:
          'main() no longer runs on the demo engine, and the end-to-end encryption of Trino is not exempt: '
          'set $key to <true/> in ios/Runner/Info.plist and answer the export compliance questions in '
          'App Store Connect (see apps/mobile/README.md).',
    );
  });
}
