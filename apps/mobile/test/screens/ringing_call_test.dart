import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/app_harness.dart';

Finder button(String label) =>
    find.ancestor(of: find.bySemanticsLabel(label), matching: find.byType(TrinoIconButton)).first;

/// Rings this phone with a call from Carlos, over the tabs.
Future<TestApp> ringIn(WidgetTester tester, {bool video = false, Locale locale = const Locale('es')}) async {
  final app = await pumpApp(
    tester,
    engine: testEngine(callStartsAt: const Duration(seconds: 7)),
    locale: locale,
  );
  app.engine.receiveCall('carlos', video: video);
  await tester.pumpAndSettle();
  return app;
}

void main() {
  group('a call rings in', () {
    testWidgets('over whatever is open: the avatar, the name and "te está llamando por Trino", read out', (
      tester,
    ) async {
      await ringIn(tester);
      expect(find.byType(CallScreen), findsOneWidget);
      expect(tester.widget<TrinoAvatar>(find.byType(TrinoAvatar)).size, greaterThanOrEqualTo(96));
      expect(find.text('Carlos Méndez'), findsOneWidget);
      expect(find.text('te está llamando por Trino'), findsOneWidget);
      final status = find.ancestor(
        of: find.text('te está llamando por Trino'),
        matching: find.byWidgetPredicate((w) => w is Semantics && w.properties.liveRegion == true),
      );
      expect(status, findsOneWidget, reason: 'a live region');
      expect(
        tester.getSemantics(find.text('te está llamando por Trino')).label,
        'Carlos Méndez te está llamando por Trino',
      );
      // No key yet (it exists once the call connects), and no call controls.
      expect(find.byKey(CallScreen.keyPillKey), findsNothing);
      for (final label in ['Silenciar', 'Parlante', 'Video', 'Colgar']) {
        expect(find.bySemanticsLabel(label), findsNothing, reason: label);
      }
    });

    testWidgets('with video, it says so', (tester) async {
      await ringIn(tester, video: true);
      expect(find.text('te está haciendo una videollamada por Trino'), findsOneWidget);
    });

    testWidgets('Rechazar has the danger edge like Colgar; Contestar is filled with the accent', (tester) async {
      await ringIn(tester);
      final t = tokensIn(tester, find.byType(CallScreen));
      final reject = button('Rechazar');
      expect(tester.widget<TrinoIconButton>(reject).variant, IconButtonVariant.dangerSoft);
      expect(tester.widget<TrinoIconButton>(reject).icon, TrinoIcons.hangUp);
      final rejectShape =
          tester
                  .widgetList<DecoratedBox>(find.descendant(of: reject, matching: find.byType(DecoratedBox)))
                  .map((box) => box.decoration)
                  .whereType<ShapeDecoration>()
                  .single
                  .shape
              as CircleBorder;
      expect((rejectShape.side.color, rejectShape.side.width), (t.danger, 2));
      expect(colorOfText(tester, 'Rechazar'), t.danger);

      final answer = button('Contestar');
      expect(tester.widget<TrinoIconButton>(answer).variant, IconButtonVariant.primary);
      final answerIcon = find.descendant(of: answer, matching: find.byType(TrinoIcon));
      expect(painterOf<TrinoIconPainter>(tester, answerIcon).color, t.accentInk);
      expect(fillOf(tester, answerIcon), t.accent);
      expect(colorOfText(tester, 'Contestar'), t.accentText);

      for (final label in ['Rechazar', 'Contestar']) {
        expect(
          tester.getSemantics(find.bySemanticsLabel(label)),
          isSemantics(isButton: true, isFocusable: true, hasTapAction: true),
          reason: '$label is a real button',
        );
      }
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('rings and vibrates while it rings', (tester) async {
      final app = await ringIn(tester);
      expect(app.sounds.log, ['ringtone 60', 'vibrate']);
    });

    testWidgets('Contestar connects it: the controls, the time and the key', (tester) async {
      final app = await ringIn(tester);
      await tester.tap(find.bySemanticsLabel('Contestar'));
      await tester.pumpAndSettle();
      expect(find.text('te está llamando por Trino'), findsNothing);
      expect(find.bySemanticsLabel('Rechazar'), findsNothing);
      for (final label in ['Silenciar', 'Parlante', 'Video', 'Colgar']) {
        expect(find.bySemanticsLabel(label), findsOneWidget, reason: label);
      }
      expect(find.text('00:07'), findsOneWidget);
      expect(find.byKey(CallScreen.keyPillKey), findsOneWidget);
      expect(app.sounds.log.skip(2), ['stop', 'stopVibration'], reason: 'the ring stops');
    });

    testWidgets('Rechazar ends it and goes back to where you were; it stays as missed', (tester) async {
      final app = await ringIn(tester);
      await tester.tap(find.bySemanticsLabel('Rechazar'));
      await tester.pumpAndSettle();
      expect(find.byType(CallScreen), findsNothing);
      expect(find.text('Chats'), findsWidgets);
      expect((await app.engine.callHistory.first).first.direction, CallDirection.missed);
      expect(app.sounds.log, ['ringtone 60', 'vibrate', 'stop', 'stopVibration']);
    });

    testWidgets('if the caller gives up, the screen closes', (tester) async {
      final app = await ringIn(tester);
      app.engine.remoteHangUp();
      await tester.pumpAndSettle();
      expect(find.byType(CallScreen), findsNothing);
    });

    testWidgets('a blocked contact never shows up', (tester) async {
      final app = await pumpApp(tester);
      await app.engine.blockContact('carlos');
      app.engine.receiveCall('carlos');
      await tester.pumpAndSettle();
      expect(find.byType(CallScreen), findsNothing);
      expect(app.sounds.log, isEmpty);
    });

    testWidgets('in English and Portuguese', (tester) async {
      await ringIn(tester, locale: const Locale('en'));
      expect(find.text('is calling you on Trino'), findsOneWidget);
      expect(find.bySemanticsLabel('Decline'), findsOneWidget);
      expect(find.bySemanticsLabel('Answer'), findsOneWidget);
    });

    testWidgets('fits at twice the text size', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await ringIn(tester);
      expect(tester.takeException(), isNull);
    });
  });

  group('calling out', () {
    Future<TestApp> callOut(WidgetTester tester) async {
      final app = await pumpApp(tester, engine: testEngine(answerAfter: null));
      await openChat(tester, 'Ana Torres');
      await tester.tap(find.byWidgetPredicate((w) => w is TrinoIconButton && w.icon == TrinoIcons.phone));
      await tester.pumpAndSettle();
      return app;
    }

    testWidgets('"Llamando…" until they answer, read out, with the controls and without the time or the key', (
      tester,
    ) async {
      final app = await callOut(tester);
      expect(find.text('Llamando…'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('Llamando…'),
          matching: find.byWidgetPredicate((w) => w is Semantics && w.properties.liveRegion == true),
        ),
        findsOneWidget,
      );
      expect(find.text('00:00'), findsNothing);
      expect(find.byKey(CallScreen.keyPillKey), findsNothing);
      expect(find.bySemanticsLabel('Colgar'), findsOneWidget);
      expect(app.sounds.log, ['ringback 60']);

      app.engine.answerOutgoing();
      await tester.pumpAndSettle();
      expect(find.text('Llamando…'), findsNothing);
      expect(find.text('00:00'), findsOneWidget);
      expect(find.byKey(CallScreen.keyPillKey), findsOneWidget);
    });

    testWidgets('"Por el servidor de llamadas" waits at the bottom and does not change when they answer', (
      tester,
    ) async {
      final app = await callOut(tester);
      final path = find.text('Por el servidor de llamadas');
      expect(path, findsOneWidget);
      final before = tester.getRect(path);
      app.engine.answerOutgoing();
      await tester.pumpAndSettle();
      expect(path, findsOneWidget);
      expect(tester.getRect(path), before, reason: 'it stays where it was');
    });

    testWidgets('under the name, "Llamando…" fades into the time, and only one of them is read', (tester) async {
      final app = await callOut(tester);
      final calling = tester.getRect(find.text('Llamando…'));
      app.engine.answerOutgoing();
      await tester.pump();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 60));
      double opacityOf(String text) => tester
          .widget<FadeTransition>(find.ancestor(of: find.text(text), matching: find.byType(FadeTransition)).first)
          .opacity
          .value;
      expect(find.text('Llamando…'), findsOneWidget, reason: 'fading out');
      expect(find.text('00:00'), findsOneWidget, reason: 'fading in');
      expect(opacityOf('00:00'), inExclusiveRange(0, 1));
      expect(opacityOf('Llamando…'), inExclusiveRange(0, 1));
      expect(tester.getCenter(find.text('00:00')).dy, closeTo(calling.center.dy, 1), reason: 'in the same place');
      expect(
        find.ancestor(of: find.text('Llamando…'), matching: find.byType(ExcludeSemantics)),
        findsWidgets,
        reason: 'the leaving words are not read again',
      );
      await tester.pumpAndSettle();
      expect(find.text('Llamando…'), findsNothing);
      expect(opacityOf('00:00'), 1);
    });

    testWidgets('with Remove animations the time replaces "Llamando…" at once', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(
        disableAnimations: true,
      );
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      final app = await callOut(tester);
      app.engine.answerOutgoing();
      // The engine's news reaches the screen within a frame or two, with no
      // time passing.
      await tester.pump();
      await tester.pump();
      expect(find.text('Llamando…'), findsNothing);
      expect(find.text('00:00'), findsOneWidget);
    });

    testWidgets('Colgar while it rings goes back to the chat, with the end tone', (tester) async {
      final app = await callOut(tester);
      await tester.tap(find.bySemanticsLabel('Colgar'));
      await tester.pumpAndSettle();
      expect(find.byType(CallScreen), findsNothing);
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(app.sounds.log.last, 'end 60');
    });
  });
}
