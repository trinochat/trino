import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/icons.dart';

void expectBounds(Rect actual, Rect expected) {
  expect(actual.left, closeTo(expected.left, 0.01));
  expect(actual.top, closeTo(expected.top, 0.01));
  expect(actual.right, closeTo(expected.right, 0.01));
  expect(actual.bottom, closeTo(expected.bottom, 0.01));
}

void main() {
  group('parseSvgPath', () {
    test('draws absolute and relative lines', () {
      // The check mark of the prototype.
      expectBounds(parseSvgPath('M5 12.5l4.5 4.5L19 7.5').getBounds(), const Rect.fromLTRB(5, 7.5, 19, 17));
      expectBounds(parseSvgPath('M3 3h4v5H3z').getBounds(), const Rect.fromLTRB(3, 3, 7, 8));
      expectBounds(parseSvgPath('M3 3h4v5h-4z').getBounds(), const Rect.fromLTRB(3, 3, 7, 8));
    });

    test('repeats the last command for extra coordinates, as lines after a move', () {
      expectBounds(parseSvgPath('M2 2 10 2 10 10').getBounds(), const Rect.fromLTRB(2, 2, 10, 10));
      expectBounds(parseSvgPath('m2 2 8 0 0 8').getBounds(), const Rect.fromLTRB(2, 2, 10, 10));
    });

    test('reads numbers written together, as SVG minifiers do', () {
      // "1.5.5" is 1.5 and .5; "-3.5-1.5" is -3.5 and -1.5.
      expectBounds(parseSvgPath('M0 0l1.5.5').getBounds(), const Rect.fromLTRB(0, 0, 1.5, 0.5));
      expectBounds(parseSvgPath('M10 10l-3.5-1.5').getBounds(), const Rect.fromLTRB(6.5, 8.5, 10, 10));
    });

    test('reads arc flags packed against the next number', () {
      // A half circle of radius 4.5 from (8.5, 14.5) to (15.5, 14.5): "0 007 0" is
      // rotation 0, flags 0 and 0, then the point 7,0.
      final bounds = parseSvgPath('M8.5 14.5a4.5 4.5 0 007 0').getBounds();
      expect(bounds.left, closeTo(8.5, 0.01));
      expect(bounds.right, closeTo(15.5, 0.01));
      expect(bounds.top, closeTo(14.5, 0.01));
      expect(bounds.bottom, greaterThan(16));
    });

    test('draws cubic and quadratic curves, smooth ones included', () {
      expect(parseSvgPath('M0 0C0 10 10 10 10 0S20-10 20 0').getBounds().right, closeTo(20, 0.01));
      expect(parseSvgPath('M0 0Q5 10 10 0T20 0').getBounds().right, closeTo(20, 0.01));
    });

    test('rejects malformed data', () {
      expect(() => parseSvgPath('12 5'), throwsFormatException);
      expect(() => parseSvgPath('M5'), throwsFormatException);
      expect(() => parseSvgPath('M5 5 A2 2 0 2 0 9 9'), throwsFormatException);
    });
  });

  test('every icon of the set parses and stays inside its 24×24 box', () {
    for (final icon in TrinoIcons.values) {
      final bounds = icon.path.getBounds();
      expect(bounds.left, greaterThanOrEqualTo(0), reason: icon.name);
      expect(bounds.top, greaterThanOrEqualTo(0), reason: icon.name);
      expect(bounds.right, lessThanOrEqualTo(24), reason: icon.name);
      expect(bounds.bottom, lessThanOrEqualTo(24), reason: icon.name);
    }
  });

  testWidgets('an icon is decoration unless it is given a label', (tester) async {
    Widget row(List<Widget> children) => Directionality(
      textDirection: TextDirection.ltr,
      child: Center(
        child: Row(mainAxisSize: MainAxisSize.min, children: children),
      ),
    );
    await tester.pumpWidget(row(const [TrinoIcon(TrinoIcons.phone)]));
    expect(tester.getSize(find.byType(TrinoIcon)), const Size(24, 24));
    expect(tester.getSemantics(find.byType(TrinoIcon)).label, isEmpty);

    await tester.pumpWidget(
      row(const [
        TrinoIcon(TrinoIcons.phone),
        TrinoIcon(TrinoIcons.shieldCheck, size: 16, semanticLabel: 'Verificado'),
      ]),
    );
    expect(tester.getSize(find.byType(TrinoIcon).last), const Size(16, 16));
    expect(find.bySemanticsLabel('Verificado'), findsOneWidget);
  });

  testWidgets('an icon takes its colour from the icon theme', (tester) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: IconTheme(
          data: IconThemeData(color: Color(0xFF0F7B4A), size: 20),
          child: Center(child: TrinoIcon(TrinoIcons.send)),
        ),
      ),
    );
    expect(tester.getSize(find.byType(TrinoIcon)), const Size(20, 20));
    final paint = tester.widget<CustomPaint>(
      find.descendant(of: find.byType(TrinoIcon), matching: find.byType(CustomPaint)),
    );
    expect((paint.painter! as TrinoIconPainter).color, const Color(0xFF0F7B4A));
  });

  testWidgets('an icon in a larger box stays centred', (tester) async {
    await tester.pumpWidget(
      const Directionality(
        textDirection: TextDirection.ltr,
        child: Center(child: SizedBox.square(dimension: 40, child: TrinoIcon(TrinoIcons.search, size: 20))),
      ),
    );
    final box = tester.getRect(find.byType(SizedBox).first);
    final paint = tester.getRect(find.descendant(of: find.byType(TrinoIcon), matching: find.byType(CustomPaint)));
    expect(paint.size, const Size(20, 20));
    expect(paint.center, box.center);
  });
}
