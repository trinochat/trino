import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/icon_button.dart';
import 'package:trino_mobile/ui/sas_symbol.dart';

import '../support/app_harness.dart';

Future<TestApp> pumpCall(WidgetTester tester, {FakeTrinoEngine? engine, Locale locale = const Locale('es')}) async {
  final app = await pumpApp(
    tester,
    engine: engine ?? testEngine(callStartsAt: const Duration(minutes: 3, seconds: 21)),
    locale: locale,
  );
  await openChat(tester, 'Ana Torres');
  // The phone button of the chat header, in any language.
  await tester.tap(find.byWidgetPredicate((w) => w is TrinoIconButton && w.icon == TrinoIcons.phone));
  await tester.pumpAndSettle();
  return app;
}

Finder keyPill() => find.byKey(CallScreen.keyPillKey);
Finder keyDialog() => find.byKey(CallScreen.keyDialogKey);

/// The symbols of the fake call, as in the mock: Gato, Pluma, Sol, Rayo,
/// Café, Avión, Castillo.
const mockWords = ['Gato', 'Pluma', 'Sol', 'Rayo', 'Café', 'Avión', 'Castillo'];

void main() {
  testWidgets('full screen: the small key, the big avatar, the name, the time and "Por el servidor de llamadas"', (
    tester,
  ) async {
    await pumpCall(tester);
    expect(find.byType(CallScreen), findsOneWidget);
    expect(find.byType(ChatScreen).hitTestable(), findsNothing, reason: 'it covers the chat');
    expect(find.descendant(of: keyPill(), matching: find.text('Clave')), findsOneWidget);
    final icons = tester.widgetList<SasIcon>(find.descendant(of: keyPill(), matching: find.byType(SasIcon))).toList();
    expect([for (final icon in icons) icon.symbol.lucide], ['Cat', 'Feather', 'Sun', 'Zap'], reason: 'the first four');
    expect(icons.every((icon) => icon.size <= 18), isTrue, reason: 'small');
    expect(find.textContaining(RegExp('[🦊🎸🌵⚓🍄🚲🔔]')), findsNothing, reason: 'no colour emojis any more');
    expect(tester.getSemantics(keyPill()), isSemantics(isButton: true));
    expect(
      tester.getSemantics(keyPill()).label,
      'Clave de la llamada: Gato, Pluma, Sol, Rayo, Café, Avión, Castillo. Tócala para compararla con Ana Torres',
    );
    expect(tester.widget<TrinoAvatar>(find.byType(TrinoAvatar)).size, greaterThanOrEqualTo(96));
    expect(find.text('Ana Torres'), findsOneWidget);
    expect(find.text('03:21'), findsOneWidget);
    expect(find.text('Por el servidor de llamadas'), findsOneWidget);
    expect(find.text('Conexión directa'), findsNothing);
    expect(find.textContaining('IP'), findsNothing, reason: 'the server passes the audio: no IP note');
    // Plain text, not a coloured pill, and nothing to tap.
    expect(
      fillOf(tester, find.text('Por el servidor de llamadas')),
      anyOf(isNull, Colors.transparent, tokensIn(tester, find.byType(CallScreen)).bg),
    );
    expect(find.ancestor(of: find.text('Por el servidor de llamadas'), matching: find.byType(InkWell)), findsNothing);
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('03:22'), findsOneWidget);
  });

  testWidgets('the key opens "Comparen la clave" with the 7 symbols and their words', (tester) async {
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    expect(keyDialog(), findsOneWidget);
    expect(find.descendant(of: keyDialog(), matching: find.text('Comparen la clave')), findsOneWidget);
    expect(
      find.text('Léanse las palabras en voz alta. Si son las mismas, nadie se metió en la llamada.'),
      findsOneWidget,
    );
    final tiles = tester.widgetList<SasSymbolTile>(
      find.descendant(of: keyDialog(), matching: find.byType(SasSymbolTile)),
    );
    expect(tiles, hasLength(7));
    for (final word in mockWords) {
      expect(
        find.descendant(of: keyDialog(), matching: find.text(word)),
        findsOneWidget,
        reason: word,
      );
    }
    final t = tokensIn(tester, find.byType(CallScreen));
    final icon = find.descendant(of: keyDialog(), matching: find.byType(SasIcon)).first;
    expect(painterOf<SasIconPainter>(tester, icon).color, t.accentText, reason: 'outline in the theme colour');
    expect(tester.getSemantics(find.text('Comparen la clave')), isSemantics(isHeader: true));
  });

  testWidgets('"Coinciden" closes the dialog and the key reads "Verificada", in words', (tester) async {
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    await tester.tap(find.text('Coinciden'));
    await tester.pumpAndSettle();
    expect(keyDialog(), findsNothing);
    expect(find.descendant(of: keyPill(), matching: find.text('Verificada')), findsOneWidget);
    expect(find.descendant(of: keyPill(), matching: find.byType(SasIcon)), findsNothing);
    expect(tester.getSemantics(keyPill()).label, 'Llamada verificada. Toca para ver la clave');
    final t = tokensIn(tester, find.byType(CallScreen));
    expect(colorOfText(tester, 'Verificada'), t.accentText);
  });

  testWidgets('"No coinciden" keeps the dialog open and warns that someone may be in the middle', (tester) async {
    await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    await tester.tap(find.text('No coinciden'));
    await tester.pumpAndSettle();
    final alert = find.text(
      'Puede que alguien esté en medio. Cuelga y vuelve a llamar; si se repite, compárenlos en persona.',
    );
    expect(alert, findsOneWidget);
    expect(keyDialog(), findsOneWidget);
    // Closing it leaves the call unverified.
    await tester.tapAt(const Offset(8, 8));
    await tester.pumpAndSettle();
    expect(keyDialog(), findsNothing);
    expect(find.descendant(of: keyPill(), matching: find.text('Verificada')), findsNothing);
    expect(find.descendant(of: keyPill(), matching: find.text('Clave')), findsOneWidget);
  });

  testWidgets('a direct call says so, and only then explains that the other person sees your IP', (tester) async {
    await pumpCall(tester, engine: testEngine(callPath: CallPath.direct));
    expect(find.text('Por el servidor de llamadas'), findsNothing);
    const note = 'Ana Torres puede ver tu IP mientras dure la llamada.';
    final link = find.ancestor(of: find.text('Conexión directa'), matching: find.byKey(CallScreen.connectionKey));
    expect(tester.getSemantics(link), isSemantics(isButton: true, isExpanded: false));
    await tester.tap(find.text('Conexión directa'));
    await tester.pumpAndSettle();
    expect(find.text(note), findsOneWidget);
    await tester.tap(find.text('Conexión directa'));
    await tester.pumpAndSettle();
    expect(find.text(note), findsNothing);
  });

  testWidgets('Silenciar, Parlante and Video are toggles; Colgar is soft red with a red icon', (tester) async {
    await pumpCall(tester);
    for (final label in ['Silenciar', 'Parlante', 'Video']) {
      final control = find.bySemanticsLabel(label);
      expect(tester.getSemantics(control), isSemantics(hasToggledState: true, isToggled: false), reason: label);
      expect(find.text(label), findsOneWidget, reason: 'its word under it');
      await tester.tap(control);
      await tester.pumpAndSettle();
      expect(tester.getSemantics(control), isSemantics(isToggled: true), reason: label);
    }
    final hangUpButton = find
        .ancestor(of: find.bySemanticsLabel('Colgar'), matching: find.byType(TrinoIconButton))
        .first;
    expect(tester.widget<TrinoIconButton>(hangUpButton).variant, IconButtonVariant.dangerSoft);
    final t = tokensIn(tester, find.byType(CallScreen));
    final hangUpIcon = find.descendant(of: hangUpButton, matching: find.byType(TrinoIcon));
    expect(painterOf<TrinoIconPainter>(tester, hangUpIcon).color, t.danger);
    expect(fillOf(tester, hangUpIcon), t.dangerBg);
    expect(colorOfText(tester, 'Colgar'), t.danger);
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

  testWidgets('a call that ends with the dialog open closes both', (tester) async {
    final app = await pumpCall(tester);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    await app.engine.hangUp();
    await tester.pumpAndSettle();
    expect(keyDialog(), findsNothing);
    expect(find.byType(CallScreen), findsNothing);
    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('in English and Portuguese the words come from the same table', (tester) async {
    await pumpCall(tester, locale: const Locale('pt'));
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    expect(find.text('Comparem a chave'), findsOneWidget);
    for (final word in ['Gato', 'Pena', 'Sol', 'Raio', 'Café', 'Avião', 'Castelo']) {
      expect(
        find.descendant(of: keyDialog(), matching: find.text(word)),
        findsOneWidget,
        reason: word,
      );
    }
  });

  testWidgets('fits at twice the text size, with the dialog open', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 2;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await pumpCall(tester);
    expect(tester.takeException(), isNull);
    await tester.tap(keyPill());
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.ensureVisible(find.text('No coinciden'));
    await tester.tap(find.text('No coinciden'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
