import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/app_harness.dart';

Future<TestApp> pumpCall(WidgetTester tester) async {
  final app = await pumpApp(tester, engine: testEngine(callStartsAt: const Duration(minutes: 3, seconds: 21)));
  await openChat(tester, 'Ana Torres');
  await tester.tap(find.bySemanticsLabel('Llamar'));
  await tester.pumpAndSettle();
  return app;
}

Finder keyPill() => find.byKey(CallScreen.keyPillKey);

void main() {
  testWidgets('full screen: the key pill, the big avatar, the name, the time and "Conexión directa"', (tester) async {
    await pumpCall(tester);
    expect(find.byType(CallScreen), findsOneWidget);
    expect(find.byType(ChatScreen).hitTestable(), findsNothing, reason: 'it covers the chat');
    expect(find.descendant(of: keyPill(), matching: find.text('🦊')), findsOneWidget);
    expect(find.descendant(of: keyPill(), matching: find.textContaining(RegExp('[🦊🎸🌵⚓🍄🚲🔔]'))), findsNWidgets(7));
    expect(tester.getSemantics(keyPill()), isSemantics(isButton: true, hasExpandedState: true, isExpanded: false));
    expect(tester.getSemantics(keyPill()).label, 'Clave de la llamada. Tócala para compararla con Ana Torres');
    expect(tester.widget<TrinoAvatar>(find.byType(TrinoAvatar)).size, greaterThanOrEqualTo(96));
    expect(find.text('Ana Torres'), findsOneWidget);
    expect(find.text('03:21'), findsOneWidget);
    expect(find.text('Conexión directa'), findsOneWidget);
    // Plain text, not a coloured pill.
    expect(
      fillOf(tester, find.text('Conexión directa')),
      anyOf(isNull, Colors.transparent, tokensIn(tester, find.byType(CallScreen)).bg),
    );
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('03:22'), findsOneWidget);
  });

  testWidgets('the key pill opens the comparison, and "Coinciden" turns it into "Verificada"', (tester) async {
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    expect(find.text('Compara estos emojis con Ana Torres'), findsOneWidget);
    for (final word in ['Zorro', 'Guitarra', 'Cactus', 'Ancla', 'Hongo', 'Bicicleta', 'Campana']) {
      expect(find.text(word), findsOneWidget, reason: word);
    }
    expect(tester.getSemantics(keyPill()), isSemantics(isExpanded: true));

    await tester.tap(find.text('Coinciden'));
    await tester.pumpAndSettle();
    expect(find.text('Compara estos emojis con Ana Torres'), findsNothing);
    expect(find.descendant(of: keyPill(), matching: find.text('Verificada')), findsOneWidget);
    expect(find.descendant(of: keyPill(), matching: find.text('🦊')), findsNothing);
    expect(tester.getSemantics(keyPill()).label, 'Llamada verificada. Toca para ver la clave');
    final t = tokensIn(tester, find.byType(CallScreen));
    expect(colorOfText(tester, 'Verificada'), t.accentText);
  });

  testWidgets('"No coinciden" warns that someone may be in the middle', (tester) async {
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    await tester.tap(find.text('No coinciden'));
    await tester.pumpAndSettle();
    final alert = find.text(
      'Puede que alguien esté en medio. Cuelga y vuelve a llamar; si se repite, compárenlos en persona.',
    );
    expect(alert, findsOneWidget);
    expect(find.descendant(of: keyPill(), matching: find.text('Verificada')), findsNothing);
  });

  testWidgets('"Conexión directa" shows and hides the note about the IP', (tester) async {
    await pumpCall(tester);
    const note = 'Ana Torres puede ver tu IP mientras dure la llamada. Pronto podrás llamar sin mostrarla.';
    expect(find.text(note), findsNothing);
    final link = find.ancestor(of: find.text('Conexión directa'), matching: find.byKey(CallScreen.connectionKey));
    expect(tester.getSemantics(link), isSemantics(isButton: true, isExpanded: false));
    await tester.tap(find.text('Conexión directa'));
    await tester.pumpAndSettle();
    expect(find.text(note), findsOneWidget);
    expect(tester.getSemantics(link), isSemantics(isExpanded: true));
    await tester.tap(find.text('Conexión directa'));
    await tester.pumpAndSettle();
    expect(find.text(note), findsNothing);
  });

  testWidgets('Silenciar, Altavoz and Cámara are toggles; Colgar is the danger button', (tester) async {
    await pumpCall(tester);
    for (final label in ['Silenciar', 'Altavoz', 'Cámara']) {
      final control = find.bySemanticsLabel(label);
      expect(tester.getSemantics(control), isSemantics(hasToggledState: true, isToggled: false), reason: label);
      await tester.tap(control);
      await tester.pumpAndSettle();
      expect(tester.getSemantics(control), isSemantics(isToggled: true), reason: label);
    }
    final hangUp = tester.widget<TrinoIconButton>(
      find.ancestor(of: find.bySemanticsLabel('Colgar'), matching: find.byType(TrinoIconButton)).first,
    );
    expect(hangUp.variant, IconButtonVariant.dangerSolid);
    final t = tokensIn(tester, find.byType(CallScreen));
    final hangUpIcon = find.descendant(
      of: find.ancestor(of: find.bySemanticsLabel('Colgar'), matching: find.byType(TrinoIconButton)).first,
      matching: find.byType(TrinoIcon),
    );
    expect(painterOf<TrinoIconPainter>(tester, hangUpIcon).color, t.dangerBg);
    expect(fillOf(tester, hangUpIcon), t.danger);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('Colgar ends the call and goes back to the chat', (tester) async {
    await pumpCall(tester);
    await tester.tap(find.bySemanticsLabel('Colgar'));
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsNothing);
    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('fits at twice the text size, with the panel open', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
