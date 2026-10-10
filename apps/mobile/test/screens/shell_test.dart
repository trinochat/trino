import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/common.dart';

import '../support/app_harness.dart';

void main() {
  testWidgets('opens on Chats and moves between the bottom tabs', (tester) async {
    await pumpApp(tester);
    final tabs = find.byKey(const ValueKey('bottom-tabs'));
    for (final label in ['Chats', 'Contactos', 'Ajustes']) {
      expect(find.descendant(of: tabs, matching: find.text(label)), findsOneWidget);
    }
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsOneWidget);

    await openTab(tester, 'Contactos');
    expect(find.text('Agregar contacto'), findsOneWidget);
    expect(
      tester.getSemantics(find.descendant(of: tabs, matching: find.text('Contactos'))),
      isSemantics(isSelected: true),
    );

    await openTab(tester, 'Ajustes');
    expect(find.text('Tu nombre y tu código'), findsOneWidget);

    await openTab(tester, 'Chats');
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('every tab meets the 48 dp target and labeling guidelines', (tester) async {
    await pumpApp(tester);
    for (final label in ['Chats', 'Contactos', 'Ajustes']) {
      await openTab(tester, label);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline), reason: label);
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline), reason: label);
    }
  });

  testWidgets('a fresh install starts at the first run', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    expect(find.text('Te damos la bienvenida a Trino'), findsOneWidget);
    expect(find.byKey(const ValueKey('bottom-tabs')), findsNothing);
  });

  testWidgets('a locked app starts at the unlock screen, showing no chats', (tester) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    expect(find.text('Hola de nuevo, Sofía'), findsOneWidget);
    expect(find.text('Ana Torres'), findsNothing);
  });

  testWidgets('locking leaves no screen above the unlock screen', (tester) async {
    final app = await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    expect(find.text('Hoy'), findsOneWidget);
    // The app locks itself, as the auto-lock will.
    unawaited(app.engine.lock());
    await tester.pumpAndSettle();
    expect(find.text('Hola de nuevo, Sofía'), findsOneWidget);
    expect(find.text('Perfecto, nos vemos el jueves'), findsNothing);
  });
}
