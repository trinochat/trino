import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/advanced_section.dart';

import '../support/harness.dart';

void main() {
  testWidgets('starts closed, opens and closes on tap, and says whether it is open', (tester) async {
    await pumpThemed(
      tester,
      const AdvancedSection(title: 'Opciones avanzadas', children: [Text('Lo técnico')]),
      center: false,
    );
    final header = find.text('Opciones avanzadas');
    expect(find.text('Lo técnico'), findsNothing);
    expect(tester.getSemantics(header), isSemantics(isButton: true, hasExpandedState: true, isExpanded: false));
    expect(tester.getSize(find.byType(AdvancedSection)).height, greaterThanOrEqualTo(48));

    await tester.tap(header);
    await tester.pumpAndSettle();
    expect(find.text('Lo técnico'), findsOneWidget);
    expect(tester.getSemantics(header), isSemantics(isButton: true, hasExpandedState: true, isExpanded: true));

    await tester.tap(header);
    await tester.pumpAndSettle();
    expect(find.text('Lo técnico'), findsNothing);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  });

  testWidgets('can start open', (tester) async {
    await pumpThemed(
      tester,
      const AdvancedSection(title: 'Opciones avanzadas', initiallyOpen: true, children: [Text('Lo técnico')]),
      center: false,
    );
    expect(find.text('Lo técnico'), findsOneWidget);
  });
}
