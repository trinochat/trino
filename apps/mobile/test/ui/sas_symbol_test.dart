import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/sas_symbol.dart';

import '../support/harness.dart';

void main() {
  testWidgets('loads the table from the app bundle and draws each symbol as an outline with its word', (tester) async {
    await pumpThemed(
      tester,
      SasTableBuilder(
        builder: (context, table) => Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final index in [0, 9, 17]) SasSymbolTile(symbol: table.symbol(index)),
          ],
        ),
      ),
    );
    await tester.pumpAndSettle();
    for (final word in ['Gato', 'Pluma', 'Sol']) {
      expect(find.text(word), findsOneWidget, reason: word);
    }
    final painter = painterOf<SasIconPainter>(tester, find.byType(SasIcon).first);
    expect(painter.symbol.lucide, 'Cat');
    expect(painter.color, tokensIn(tester).accentText, reason: 'the theme colour, not an emoji');
    expect(painter.strokeWidth, 2);
  });

  testWidgets('the word follows the app language, and screen readers hear the word, not the drawing', (tester) async {
    final handle = tester.ensureSemantics();
    await pumpThemed(
      tester,
      SasTableBuilder(builder: (context, table) => SasSymbolTile(symbol: table.symbol(1))),
      locale: const Locale('pt'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Cachorro'), findsOneWidget);
    expect(find.bySemanticsLabel('Cachorro'), findsOneWidget);
    expect(find.descendant(of: find.byType(SasIcon), matching: find.byType(Semantics)), findsNothing);
    handle.dispose();
  });

  testWidgets('an icon takes the colour it is given, at the size it is given', (tester) async {
    await pumpThemed(
      tester,
      SasTableBuilder(
        builder: (context, table) => SasIcon(symbol: table.symbol(23), size: 16, color: const Color(0xFF123456)),
      ),
      style: TrinoStyle.terminal,
      brightness: Brightness.dark,
    );
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byType(SasIcon)), const Size(16, 16));
    expect(painterOf<SasIconPainter>(tester, find.byType(SasIcon)).color, const Color(0xFF123456));
  });
}
