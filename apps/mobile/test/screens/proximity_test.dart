// The screen turns off next to the face only during an audio call with the
// speaker and the camera off, connected or ringing out.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/app_harness.dart';

Future<(TestApp, DemoProximityScreen)> pumpWithSensor(
  WidgetTester tester, {
  Duration? answerAfter = Duration.zero,
}) async {
  final sensor = DemoProximityScreen();
  final app = await pumpApp(
    tester,
    engine: testEngine(answerAfter: answerAfter),
    proximity: sensor,
  );
  await openChat(tester, 'Ana Torres');
  return (app, sensor);
}

/// From Ana's chat, which [pumpWithSensor] opens.
Future<void> callAna(WidgetTester tester, {bool video = false}) async {
  await tester.tap(
    find.byWidgetPredicate((w) => w is TrinoIconButton && w.icon == (video ? TrinoIcons.video : TrinoIcons.phone)),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('an audio call turns it on; hanging up turns it off', (tester) async {
    final (_, sensor) = await pumpWithSensor(tester);
    expect(sensor.enabled, isFalse);
    await callAna(tester);
    expect(sensor.enabled, isTrue);
    await tester.tap(find.bySemanticsLabel('Colgar'));
    await tester.pumpAndSettle();
    expect(sensor.enabled, isFalse);
    expect(sensor.log, ['enable', 'disable'], reason: 'no repeated calls');
  });

  testWidgets('the speaker turns it off, and back on when it goes off', (tester) async {
    final (_, sensor) = await pumpWithSensor(tester);
    await callAna(tester);
    await tester.tap(find.bySemanticsLabel('Parlante'));
    await tester.pumpAndSettle();
    expect(sensor.enabled, isFalse);
    await tester.tap(find.bySemanticsLabel('Parlante'));
    await tester.pumpAndSettle();
    expect(sensor.enabled, isTrue);
  });

  testWidgets('the camera turns it off; a video call never turns it on', (tester) async {
    final (app, sensor) = await pumpWithSensor(tester);
    await callAna(tester);
    await tester.tap(find.bySemanticsLabel('Video'));
    await tester.pumpAndSettle();
    expect(sensor.enabled, isFalse);
    await app.engine.hangUp();
    await tester.pumpAndSettle();
    sensor.log.clear();
    await callAna(tester, video: true);
    expect(find.byType(CallScreen), findsOneWidget);
    expect(sensor.log, isEmpty);
  });

  testWidgets('on while ringing out ("Llamando…"), and it stays on once answered', (tester) async {
    final (app, sensor) = await pumpWithSensor(tester, answerAfter: null);
    await callAna(tester);
    expect(find.text('Llamando…'), findsOneWidget);
    expect(sensor.enabled, isTrue);
    app.engine.answerOutgoing();
    await tester.pumpAndSettle();
    expect(sensor.enabled, isTrue);
    expect(sensor.log, ['enable']);
  });

  testWidgets('off while a call rings in (you are looking at it); on once you answer it', (tester) async {
    final (app, sensor) = await pumpWithSensor(tester);
    app.engine.receiveCall('carlos');
    await tester.pumpAndSettle();
    expect(sensor.enabled, isFalse);
    await tester.tap(find.bySemanticsLabel('Contestar'));
    await tester.pumpAndSettle();
    expect(sensor.enabled, isTrue);
  });

  testWidgets('a video call that rings in and is answered keeps it off', (tester) async {
    final (app, sensor) = await pumpWithSensor(tester);
    app.engine.receiveCall('carlos', video: true);
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Contestar'));
    await tester.pumpAndSettle();
    expect(sensor.log, isEmpty);
  });

  testWidgets('pausing the app turns it off; coming back turns it on again', (tester) async {
    final (_, sensor) = await pumpWithSensor(tester);
    await callAna(tester);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    await tester.pump();
    expect(sensor.enabled, isFalse);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(sensor.enabled, isTrue);
  });

  testWidgets('leaving the screen turns it off: the other person hangs up, or Trino locks', (tester) async {
    final (app, sensor) = await pumpWithSensor(tester);
    await callAna(tester);
    app.engine.remoteHangUp();
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsNothing);
    expect(sensor.enabled, isFalse);

    await callAna(tester);
    expect(sensor.enabled, isTrue);
    await app.engine.lock();
    await tester.pumpAndSettle();
    expect(sensor.enabled, isFalse);
  });
}
