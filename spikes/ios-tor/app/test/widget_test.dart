// The spike screen against a fake native side: the full run starts Tor,
// waits for ready, probes and shows the report. The real thing only runs on
// the iPhone (spikes/ios-tor/README.md).

import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tor_spike/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('org.trinochat.spike/tor');

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  testWidgets('the full cold run starts, waits for ready, probes and reports', (
    tester,
  ) async {
    final calls = <String>[];
    var polls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call.method);
          switch (call.method) {
            case 'start':
              expect(call.arguments, {'fresh': true, 'trustDirs': false});
              return jsonEncode({'ok': true});
            case 'status':
              polls++;
              return jsonEncode({
                'ok': true,
                'running': true,
                'status': polls < 2
                    ? {'state': 'starting', 'pct': 40}
                    : {'state': 'ready', 'transport': 'none'},
              });
            case 'probe':
              expect((call.arguments as Map)['url'], 'wss://nos.lol');
              return jsonEncode({
                'result': {'ok': true, 'eoseMs': 1200},
              });
            case 'report':
              return jsonEncode({'ok': true, 'spike': 'trino-ios-tor'});
          }
          return jsonEncode({'ok': true});
        });

    await tester.pumpWidget(const SpikeApp());
    await tester.tap(find.text('Prueba completa en frío'));
    await tester.pump();
    // One poll at 40 %, a second later the ready one.
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();

    expect(calls, ['start', 'status', 'status', 'probe', 'report']);
    expect(find.text('Listo: EOSE recibido (en frío)'), findsOneWidget);
    expect(find.textContaining('trino-ios-tor'), findsOneWidget);
  });

  testWidgets('a native error is shown, not thrown', (tester) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          throw PlatformException(code: 'rust', message: 'no library');
        });

    await tester.pumpWidget(const SpikeApp());
    await tester.tap(find.text('Estado'));
    await tester.pumpAndSettle();

    expect(find.textContaining('no library'), findsOneWidget);
  });
}
