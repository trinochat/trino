import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/ui/bottom_tabs.dart';

import '../support/app_harness.dart';

void main() {
  testWidgets('opens on Chats and moves between the bottom tabs', (tester) async {
    await pumpApp(tester);
    final tabs = find.byKey(const ValueKey('bottom-tabs'));
    for (final label in ['Chats', 'Llamadas', 'Contactos', 'Ajustes']) {
      expect(find.descendant(of: tabs, matching: find.text(label)), findsOneWidget);
    }
    expect(tester.widget<BottomTabs>(tabs).items.map((item) => item.icon), [
      TrinoIcons.chats,
      TrinoIcons.phone,
      TrinoIcons.contacts,
      TrinoIcons.settings,
    ]);
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsOneWidget);

    await openTab(tester, 'Contactos');
    expect(find.text('Agregar con código o QR'), findsOneWidget);
    expect(
      tester.getSemantics(find.descendant(of: tabs, matching: find.text('Contactos'))),
      isSemantics(isSelected: true),
    );

    await openTab(tester, 'Ajustes');
    expect(find.text('Tu nombre y tu código'), findsOneWidget);

    await openTab(tester, 'Llamadas');
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Llamadas')), findsOneWidget);

    await openTab(tester, 'Chats');
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('every tab meets the 48 dp target and labeling guidelines', (tester) async {
    await pumpApp(tester);
    for (final label in ['Chats', 'Llamadas', 'Contactos', 'Ajustes']) {
      await openTab(tester, label);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: label);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: label);
    }
  });

  testWidgets('the Llamadas tab counts the missed calls not seen yet; seeing the tab clears it', (tester) async {
    final app = await pumpApp(tester);
    final tabs = find.byKey(const ValueKey('bottom-tabs'));
    Finder badge(String count) => find.descendant(of: tabs, matching: find.text(count));
    expect(badge('1'), findsOneWidget);
    expect(
      tester.getSemantics(find.descendant(of: tabs, matching: find.text('Llamadas'))).label,
      contains('1 llamada perdida'),
    );

    app.engine.missCall('carlos');
    await tester.pumpAndSettle();
    expect(badge('2'), findsOneWidget);

    await openTab(tester, 'Llamadas');
    expect(badge('2'), findsNothing);
    expect(await app.engine.unseenMissedCalls.first, 0);

    // A call missed while looking at the tab is seen at once.
    app.engine.missCall('lucia');
    await tester.pumpAndSettle();
    expect(badge('1'), findsNothing);

    await openTab(tester, 'Chats');
    app.engine.missCall('lucia');
    await tester.pumpAndSettle();
    expect(badge('1'), findsOneWidget);
  });

  testWidgets('a fresh install starts at the first run', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    expect(find.text('Te damos la bienvenida a Trino'), findsOneWidget);
    expect(find.byKey(const ValueKey('bottom-tabs')), findsNothing);
  });

  testWidgets('a locked app starts at the unlock screen, showing no chats', (tester) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.text('Ana Torres'), findsNothing);
  });

  testWidgets('locking leaves no screen above the unlock screen', (tester) async {
    final app = await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    expect(find.text('Hoy'), findsOneWidget);
    // The app locks itself, as the auto-lock will.
    unawaited(app.engine.lock());
    await tester.pumpAndSettle();
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.text('Perfecto, nos vemos el jueves'), findsNothing);
  });
}
