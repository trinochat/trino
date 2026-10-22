// The chat's message field: a 40 dp pill to the eye, like Telegram's, while
// the place you can tap stays 48 dp tall.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/composer_field.dart';

import '../support/harness.dart';

Future<TextEditingController> pumpField(WidgetTester tester, {TrinoStyle style = TrinoStyle.calma}) async {
  final controller = TextEditingController();
  addTearDown(controller.dispose);
  await pumpThemed(
    tester,
    SizedBox(
      width: 300,
      child: ComposerField(controller: controller, hint: 'Mensaje', semanticLabel: 'Mensaje'),
    ),
    style: style,
  );
  return controller;
}

ShapeDecoration pillOf(WidgetTester tester) =>
    tester.widget<DecoratedBox>(find.byKey(ComposerField.pillKey)).decoration as ShapeDecoration;

void main() {
  testWidgets('one line is a 40 dp pill, with a 48 dp place to tap', (tester) async {
    await pumpField(tester);
    expect(tester.getSize(find.byKey(ComposerField.pillKey)).height, 40);
    expect(tester.getSize(find.byType(TextField)).height, greaterThanOrEqualTo(48));
    final shape = pillOf(tester).shape as RoundedRectangleBorder;
    expect(shape.borderRadius, BorderRadius.circular(20), reason: 'round ends in Calma');
    final t = tokensIn(tester);
    expect((shape.side.color, shape.side.width), (t.controlLine, 1), reason: 'a 3:1 boundary');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  });

  testWidgets('the field itself is not filled, so the pill under it shows', (tester) async {
    // The theme fills every text field; filled, this one covered the pill
    // with a square grey box (seen in the screenshots of 8ff88d9).
    await pumpField(tester);
    final decoration = tester.widget<InputDecorator>(find.byType(InputDecorator)).decoration;
    expect(decoration.filled, isFalse);
  });

  testWidgets('Terminal keeps its square corners', (tester) async {
    await pumpField(tester, style: TrinoStyle.terminal);
    final shape = pillOf(tester).shape as RoundedRectangleBorder;
    expect(shape.borderRadius, BorderRadius.circular(tokensIn(tester).radius));
  });

  testWidgets('focused, the edge turns into the 2 dp accent ring', (tester) async {
    await pumpField(tester);
    await tester.tap(find.byType(TextField));
    await tester.pump();
    final side = (pillOf(tester).shape as RoundedRectangleBorder).side;
    expect((side.color, side.width), (tokensIn(tester).accentText, 2));
  });

  testWidgets('it grows with the text, up to five lines', (tester) async {
    final controller = await pumpField(tester);
    controller.text = 'uno\ndos\ntres';
    await tester.pump();
    expect(tester.getSize(find.byKey(ComposerField.pillKey)).height, greaterThan(60));
    controller.text = List.filled(9, 'línea').join('\n');
    await tester.pump();
    final five = tester.getSize(find.byKey(ComposerField.pillKey)).height;
    controller.text = List.filled(12, 'línea').join('\n');
    await tester.pump();
    expect(tester.getSize(find.byKey(ComposerField.pillKey)).height, five, reason: 'then it scrolls');
  });
}
