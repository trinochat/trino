// Pages slide in and out whole from the edge, as in Telegram and on the
// iPhone, with no fade; the page below moves a little. With less motion asked
// by the system, they just appear.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/theme.dart';

Future<void> pumpTwoPages(WidgetTester tester, {bool reduceMotion = false}) async {
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(disableAnimations: reduceMotion),
      child: MaterialApp(
        theme: buildTrinoTheme(TrinoStyle.calma, Brightness.light, TrinoAccent.verde),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () =>
                    Navigator.of(context)
                        .push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('Second')))),
                child: const Text('Open'),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open'));
  await tester.pump();
}

/// The opacity of every fade above [finder], multiplied.
double opacityOf(WidgetTester tester, Finder finder) => tester
    .widgetList<FadeTransition>(find.ancestor(of: finder, matching: find.byType(FadeTransition)))
    .fold(1.0, (opacity, fade) => opacity * fade.opacity.value);

void main() {
  testWidgets('a page slides in whole from the edge, without fading', (tester) async {
    await pumpTwoPages(tester);
    await tester.pump(const Duration(milliseconds: 150));
    final second = find.text('Second');
    expect(find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)), findsOneWidget);
    expect(opacityOf(tester, second), 1.0, reason: 'no fade while it moves');
    final width = tester.getSize(find.byType(MaterialApp)).width;
    final left = tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx;
    expect(left, greaterThan(width * 0.1), reason: 'mid-way it is well off to the side, not 6 %');
    await tester.pumpAndSettle();
    expect(tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx, 0);
  });

  testWidgets('closing slides it back out whole, without fading', (tester) async {
    await pumpTwoPages(tester);
    await tester.pumpAndSettle();
    tester.state<NavigatorState>(find.byType(Navigator)).pop();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 150));
    final second = find.text('Second');
    expect(opacityOf(tester, second), 1.0);
    final width = tester.getSize(find.byType(MaterialApp)).width;
    expect(
      tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx,
      greaterThan(width * 0.1),
    );
  });

  testWidgets('with less motion, the page just appears', (tester) async {
    await pumpTwoPages(tester, reduceMotion: true);
    await tester.pump(const Duration(milliseconds: 16));
    final second = find.text('Second');
    expect(find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)), findsNothing);
    expect(tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx, 0);
  });
}
