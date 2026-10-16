import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/swipe_actions.dart';

import '../support/harness.dart';

void main() {
  group('SwipeActions', () {
    late List<String> done;
    setUp(() => done = []);

    SwipeAction action(String label, {Color background = Colors.green}) => SwipeAction(
      icon: TrinoIcons.pin,
      label: label,
      background: background,
      foreground: Colors.black,
      onPressed: () => done.add(label),
    );

    Widget row(String name, {bool start = true, bool end = true}) => SwipeActions(
      key: ValueKey(name),
      startActions: start ? [action('$name no leído'), action('$name fijar')] : const [],
      endActions: end ? [action('$name borrar'), action('$name silenciar')] : const [],
      child: SizedBox(
        height: 72,
        child: Material(
          type: MaterialType.transparency,
          child: InkWell(
            onTap: () => done.add('$name abierto'),
            child: Center(child: Text(name)),
          ),
        ),
      ),
    );

    Future<void> pumpRows(
      WidgetTester tester, {
      List<Widget>? rows,
      TextDirection direction = TextDirection.ltr,
      bool reduceMotion = false,
    }) async {
      await pumpThemed(
        tester,
        Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
            child: Directionality(
              textDirection: direction,
              child: SwipeGroup(
                child: ListView(
                  children: [
                    ...rows ?? [row('Ana'), row('Lucía')],
                    for (var i = 0; i < 20; i++) SizedBox(height: 72, child: Text('relleno $i')),
                  ],
                ),
              ),
            ),
          ),
        ),
        center: false,
      );
    }

    double shift(WidgetTester tester, String name) =>
        tester.getTopLeft(find.text(name)).dx - tester.getTopLeft(find.byKey(ValueKey(name))).dx;
    Finder button(String label) => find.bySemanticsLabel(label);

    testWidgets('closed, it shows no action, not even to screen readers', (tester) async {
      await pumpRows(tester);
      expect(button('Ana no leído'), findsNothing);
      expect(find.text('Ana borrar'), findsNothing);
    });

    testWidgets('swiping towards the end shows the start actions as named buttons, the first at the edge', (
      tester,
    ) async {
      await pumpRows(tester);
      final before = shift(tester, 'Ana');
      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pumpAndSettle();
      expect(shift(tester, 'Ana') - before, closeTo(2 * SwipeActions.actionWidth, 0.5));
      expect(tester.getSemantics(button('Ana no leído')), isSemantics(isButton: true, hasTapAction: true));
      expect(tester.getCenter(find.text('Ana no leído')).dx, lessThan(tester.getCenter(find.text('Ana fijar')).dx));
      expect(tester.getSize(button('Ana fijar')).width, closeTo(SwipeActions.actionWidth, 0.5));
      expect(tester.getSize(button('Ana fijar')).height, greaterThanOrEqualTo(48));

      await tester.tap(find.text('Ana fijar'));
      await tester.pumpAndSettle();
      expect(done, ['Ana fijar']);
      expect(shift(tester, 'Ana'), before, reason: 'it closes after the action');
    });

    testWidgets('swiping towards the start shows the end actions, the first at the edge', (tester) async {
      await pumpRows(tester);
      final before = shift(tester, 'Ana');
      await tester.drag(find.text('Ana'), const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(shift(tester, 'Ana') - before, closeTo(-2 * SwipeActions.actionWidth, 0.5));
      expect(
        tester.getCenter(find.text('Ana borrar')).dx,
        greaterThan(tester.getCenter(find.text('Ana silenciar')).dx),
      );
      await tester.tap(find.text('Ana borrar'));
      await tester.pumpAndSettle();
      expect(done, ['Ana borrar']);
    });

    testWidgets('a short swipe goes back closed and does nothing', (tester) async {
      await pumpRows(tester);
      final before = shift(tester, 'Ana');
      await tester.timedDrag(find.text('Ana'), const Offset(40, 0), const Duration(milliseconds: 600));
      await tester.pumpAndSettle();
      expect(shift(tester, 'Ana'), before);
      expect(done, isEmpty);
    });

    testWidgets('a long swipe does the first action of that side, and closes', (tester) async {
      await pumpRows(tester);
      final before = shift(tester, 'Ana');
      await tester.drag(find.text('Ana'), const Offset(300, 0));
      await tester.pumpAndSettle();
      expect(done, ['Ana no leído']);
      expect(shift(tester, 'Ana'), before);
      await tester.drag(find.text('Ana'), const Offset(-300, 0));
      await tester.pumpAndSettle();
      expect(done, ['Ana no leído', 'Ana borrar']);
    });

    testWidgets('a side without actions does not move', (tester) async {
      await pumpRows(tester, rows: [row('Ana', end: false)]);
      final before = shift(tester, 'Ana');
      await tester.drag(find.text('Ana'), const Offset(-300, 0));
      await tester.pumpAndSettle();
      expect(shift(tester, 'Ana'), before);
      expect(done, isEmpty);
    });

    testWidgets('only one row is open at a time', (tester) async {
      await pumpRows(tester);
      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pumpAndSettle();
      await tester.drag(find.text('Lucía'), const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(find.text('Ana no leído'), findsNothing);
      expect(find.text('Lucía borrar'), findsOneWidget);
    });

    testWidgets('a tap elsewhere closes it; a tap on the open row closes it instead of opening it', (tester) async {
      await pumpRows(tester);
      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.text('relleno 2'));
      await tester.pumpAndSettle();
      expect(find.text('Ana no leído'), findsNothing);

      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ana'));
      await tester.pumpAndSettle();
      expect(find.text('Ana no leído'), findsNothing);
      expect(done, isEmpty);
      await tester.tap(find.text('Ana'));
      expect(done, ['Ana abierto']);
    });

    testWidgets('scrolling closes it', (tester) async {
      await pumpRows(tester);
      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pumpAndSettle();
      await tester.drag(find.text('relleno 3'), const Offset(0, -100));
      await tester.pumpAndSettle();
      expect(find.text('Ana no leído'), findsNothing);
    });

    testWidgets('with reduced motion it snaps open and shut, without sliding', (tester) async {
      await pumpRows(tester, reduceMotion: true);
      final before = shift(tester, 'Ana');
      await tester.drag(find.text('Ana'), const Offset(120, 0));
      await tester.pump();
      expect(tester.hasRunningAnimations, isFalse);
      expect(shift(tester, 'Ana') - before, closeTo(2 * SwipeActions.actionWidth, 0.5));
      await tester.tap(find.text('relleno 2'));
      await tester.pump();
      expect(tester.hasRunningAnimations, isFalse);
      expect(shift(tester, 'Ana'), before);
    });

    testWidgets('right to left, swiping left shows the start actions', (tester) async {
      await pumpRows(tester, direction: TextDirection.rtl);
      await tester.drag(find.text('Ana'), const Offset(-120, 0));
      await tester.pumpAndSettle();
      expect(find.text('Ana no leído'), findsOneWidget);
      expect(
        tester.getCenter(find.text('Ana no leído')).dx,
        greaterThan(tester.getCenter(find.text('Ana fijar')).dx),
        reason: 'the first at the start edge, on the right',
      );
    });
  });
}
