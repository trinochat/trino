import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/calls_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/ui/call_row.dart';
import 'package:trino_mobile/ui/icon_button.dart';
import 'package:trino_mobile/ui/segmented.dart';

import '../support/app_harness.dart';

Future<TestApp> pumpCalls(WidgetTester tester, {FakeTrinoEngine? engine, double textScale = 1}) async {
  final app = await pumpApp(tester, engine: engine, textScale: textScale);
  await openTab(tester, 'Llamadas');
  return app;
}

List<(String, String)> rows(WidgetTester tester) => [
  for (final row in tester.widgetList<CallRow>(find.byType(CallRow))) (row.name, row.detail),
];

void main() {
  testWidgets('a large title and the Todas / Perdidas choice', (tester) async {
    await pumpCalls(tester);
    final title = find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Llamadas'));
    expect(tester.getSemantics(title), isSemantics(isHeader: true));
    final choice = tester.widget<TrinoSegmented<CallsFilter>>(find.byType(TrinoSegmented<CallsFilter>));
    expect(choice.options.map((option) => option.label), ['Todas', 'Perdidas']);
    expect(choice.selected, CallsFilter.all);
  });

  testWidgets('lists every call, the latest first, with the direction in words, duration and time', (tester) async {
    await pumpCalls(tester);
    expect(rows(tester), [
      ('Ana Torres', 'Perdida · 10:44'),
      ('Ana Torres', 'Saliente · 4 min · 10:36'),
      ('Carlos Méndez', 'Entrante · 12 min · Ayer'),
      ('Lucía', 'Perdida · Mar'),
      ('Mamá', 'Saliente · 25 min · Dom'),
    ]);
  });

  testWidgets('a missed call: the name in the danger colour and its own icon, beside the word', (tester) async {
    await pumpCalls(tester);
    final t = tokensIn(tester);
    final missed = find.byType(CallRow).at(0);
    final outgoing = find.byType(CallRow).at(1);
    final incoming = find.byType(CallRow).at(2);
    Color? nameColor(Finder row) => tester
        .widget<Text>(find.descendant(of: row, matching: find.text(tester.widget<CallRow>(row).name)))
        .style
        ?.color;
    expect(nameColor(missed), t.danger);
    expect(nameColor(outgoing), t.ink);
    TrinoIcons iconOf(Finder row) =>
        tester.widget<TrinoIcon>(find.descendant(of: row, matching: find.byType(TrinoIcon)).first).icon;
    expect(iconOf(missed), TrinoIcons.phoneMissed);
    expect(iconOf(outgoing), TrinoIcons.phoneOutgoing);
    expect(iconOf(incoming), TrinoIcons.phoneIncoming);
  });

  testWidgets('a screen reader hears the name and the detail together', (tester) async {
    await pumpCalls(tester);
    final label = tester.getSemantics(find.text('Perdida · 10:44')).label;
    expect(label, contains('Ana Torres'));
    expect(label, contains('Perdida · 10:44'));
  });

  testWidgets('Perdidas shows only the missed calls', (tester) async {
    await pumpCalls(tester);
    await tester.tap(find.text('Perdidas'));
    await tester.pumpAndSettle();
    expect(rows(tester), [('Ana Torres', 'Perdida · 10:44'), ('Lucía', 'Perdida · Mar')]);
  });

  testWidgets('the accent phone calls the person back', (tester) async {
    final app = await pumpCalls(tester);
    final back = find.bySemanticsLabel('Devolver la llamada a Carlos Méndez');
    expect(back, findsOneWidget);
    final button = tester.widget<TrinoIconButton>(
      find.ancestor(of: find.byType(TrinoIcon), matching: find.byType(TrinoIconButton)).at(2),
    );
    expect((button.icon, button.variant), (TrinoIcons.phone, IconButtonVariant.accent));
    await tester.tap(back);
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsOneWidget);
    expect((await app.engine.call.first)?.contactId, 'carlos');
  });

  testWidgets('says in words when there are no calls, or no missed ones', (tester) async {
    await pumpScreen(tester, const CallsScreen(), engine: testEngine(onboarded: false));
    expect(find.text('Aún no tienes llamadas.'), findsOneWidget);
    await tester.tap(find.text('Perdidas'));
    await tester.pumpAndSettle();
    expect(find.text('No tienes llamadas perdidas.'), findsOneWidget);
  });

  testWidgets('meets the 48 dp target and labeling guidelines', (tester) async {
    await pumpCalls(tester);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('fits at twice the text size', (tester) async {
    await pumpCalls(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    expect(find.byType(CallsScreen), findsOneWidget);
  });
}
