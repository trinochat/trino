import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/app_harness.dart';
import '../support/haptics_log.dart';

Finder rowOf(String name) => find.ancestor(of: find.text(name), matching: find.byType(ChatRow));

Future<void> chooseFromSheet(WidgetTester tester, String name, String action) async {
  await tester.longPress(rowOf(name));
  await tester.pumpAndSettle();
  await tester.tap(find.text(action));
  await tester.pumpAndSettle();
}

void main() {
  late HapticsLog log;
  setUp(() => log = HapticsLog.start());
  tearDown(() => log.stop());

  testWidgets('pinning and unpinning a chat ticks', (tester) async {
    await pumpApp(tester);
    await chooseFromSheet(tester, 'Lucía', 'Fijar arriba');
    expect(log.patterns.last, 'HapticFeedbackType.selectionClick');
    log.calls.clear();
    await chooseFromSheet(tester, 'Lucía', 'Desfijar');
    expect(log.patterns.last, 'HapticFeedbackType.selectionClick');
  });

  testWidgets('a swipe ticks as it crosses the long-swipe point', (tester) async {
    await pumpApp(tester);
    await tester.drag(rowOf('Lucía'), const Offset(300, 0));
    await tester.pumpAndSettle();
    expect(log.patterns.first, 'HapticFeedbackType.selectionClick');
  });

  testWidgets('a pin that is refused does not tick', (tester) async {
    final engine = testEngine();
    final trabajo = engine.addGroup(title: 'Trabajo', memberIds: const ['carlos']);
    for (final id in ['chat-ana', 'chat-familia', 'chat-carlos', 'chat-lucia', trabajo]) {
      await engine.setChatPinned(id, true);
    }
    engine.addGroup(title: 'Vecinos', memberIds: const ['lucia']);
    await pumpApp(tester, engine: engine);
    await tester.longPress(rowOf('Vecinos'));
    await tester.pumpAndSettle();
    log.calls.clear();
    await tester.tap(find.text('Fijar arriba'));
    await tester.pumpAndSettle();
    expect(log.patterns, isNot(contains('HapticFeedbackType.selectionClick')));
  });

  testWidgets('confirming a delete gives a firm tap; cancelling gives nothing', (tester) async {
    await pumpApp(tester);
    await chooseFromSheet(tester, 'Lucía', 'Borrar el chat');
    log.calls.clear();
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(log.calls, isEmpty);
    await chooseFromSheet(tester, 'Lucía', 'Borrar el chat');
    log.calls.clear();
    await tester.tap(find.widgetWithText(TrinoButton, 'Borrar el chat'));
    await tester.pumpAndSettle();
    expect(log.patterns, ['HapticFeedbackType.heavyImpact']);
  });

  testWidgets('sending a message does not vibrate', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Lucía');
    await tester.enterText(find.byType(TextField), 'Hola');
    await tester.pumpAndSettle();
    log.calls.clear();
    await tester.tap(find.bySemanticsLabel('Enviar'));
    await tester.pumpAndSettle();
    expect(log.calls, isEmpty);
  });

  testWidgets('answering a call and hanging up each give a medium tap', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(callStartsAt: const Duration(seconds: 7)));
    app.engine.receiveCall('carlos');
    await tester.pumpAndSettle();
    log.calls.clear();
    await tester.tap(find.bySemanticsLabel('Contestar'));
    await tester.pumpAndSettle();
    expect(log.patterns, ['HapticFeedbackType.mediumImpact']);
    log.calls.clear();
    await tester.tap(find.bySemanticsLabel('Colgar'));
    await tester.pumpAndSettle();
    expect(log.patterns, ['HapticFeedbackType.mediumImpact']);
  });

  testWidgets('rejecting a call that rings in is hanging up too', (tester) async {
    final app = await pumpApp(tester);
    app.engine.receiveCall('carlos');
    await tester.pumpAndSettle();
    log.calls.clear();
    await tester.tap(find.bySemanticsLabel('Rechazar'));
    await tester.pumpAndSettle();
    expect(log.patterns, ['HapticFeedbackType.mediumImpact']);
  });

  testWidgets('a call you make: Colgar while it rings gives the same tap', (tester) async {
    await pumpApp(tester, engine: testEngine(answerAfter: null));
    await openChat(tester, 'Ana Torres');
    await tester.tap(find.byWidgetPredicate((w) => w is TrinoIconButton && w.icon == TrinoIcons.phone));
    await tester.pumpAndSettle();
    log.calls.clear();
    await tester.tap(find.bySemanticsLabel('Colgar'));
    await tester.pumpAndSettle();
    expect(log.patterns, ['HapticFeedbackType.mediumImpact']);
  });
}
