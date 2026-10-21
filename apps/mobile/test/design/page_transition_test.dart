// Pages slide in and out whole from the edge, as in Telegram and on the
// iPhone, with no fade; the page below moves a little. With less motion asked
// by the system, they just appear. On Android, only while the system back
// gesture is being dragged, the page shrinks to preview the one below
// (predictive back), and commits or cancels with the gesture.
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/theme.dart';

Future<void> pumpTwoPages(WidgetTester tester, {bool reduceMotion = false}) async {
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData.fromView(tester.view).copyWith(disableAnimations: reduceMotion),
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
double opacityOf(WidgetTester tester, Finder finder) {
  final fades = tester
      .widgetList<FadeTransition>(find.ancestor(of: finder, matching: find.byType(FadeTransition)))
      .fold(1.0, (opacity, fade) => opacity * fade.opacity.value);
  return tester
      .widgetList<Opacity>(find.ancestor(of: finder, matching: find.byType(Opacity)))
      .fold(fades, (opacity, fade) => opacity * fade.opacity);
}

/// The page's box on screen, after any scaling or moving.
Rect pageRect(WidgetTester tester) =>
    tester.getRect(find.ancestor(of: find.text('Second'), matching: find.byType(Scaffold)).first);

double screenWidth(WidgetTester tester) => tester.getSize(find.byType(MaterialApp)).width;

/// Plays the system back gesture as Android 14+ sends it to Flutter.
Future<void> backGesture(WidgetTester tester, String method, [double? progress]) async {
  await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
    'flutter/backgesture',
    const StandardMethodCodec().encodeMethodCall(
      MethodCall(method, <String, Object?>{
        if (progress != null) ...{
          'touchOffset': <double>[progress * 400, 300],
          'progress': progress,
          'swipeEdge': 0, // left
        },
      }),
    ),
    (_) {},
  );
  await tester.pump();
}

/// Opens the second page, lets it settle, and drags the back gesture halfway.
Future<void> dragBackHalfway(WidgetTester tester, {bool reduceMotion = false}) async {
  await pumpTwoPages(tester, reduceMotion: reduceMotion);
  await tester.pumpAndSettle();
  await backGesture(tester, 'startBackGesture', 0);
  await backGesture(tester, 'updateBackGestureProgress', 0.5);
  await tester.pump(const Duration(milliseconds: 16));
}

final android = TargetPlatformVariant.only(TargetPlatform.android);

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
  }, variant: const TargetPlatformVariant({TargetPlatform.android, TargetPlatform.iOS}));

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
  }, variant: const TargetPlatformVariant({TargetPlatform.android, TargetPlatform.iOS}));

  testWidgets('with Reduce Motion on the iPhone, the page fades in place instead of sliding', (tester) async {
    // iOS reports Reduce Motion apart from Android's "Remove animations"
    // (MediaQuery.disableAnimations stays false), so it is read on its own.
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    await pumpTwoPages(tester);
    await tester.pump(const Duration(milliseconds: 100));
    final second = find.text('Second');
    expect(find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)), findsNothing);
    expect(
      tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx,
      0,
      reason: 'no sliding',
    );
    expect(opacityOf(tester, second), lessThan(1.0), reason: 'a short fade');
    await tester.pumpAndSettle();
    expect(opacityOf(tester, second), 1.0);
  });

  testWidgets('with less motion, the page just appears', (tester) async {
    await pumpTwoPages(tester, reduceMotion: true);
    await tester.pump(const Duration(milliseconds: 16));
    final second = find.text('Second');
    expect(find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)), findsNothing);
    expect(tester.getTopLeft(find.ancestor(of: second, matching: find.byType(Scaffold)).first).dx, 0);
  });

  group('the Android back gesture', () {
    testWidgets('while dragged, the page shrinks to preview the one below instead of sliding', (tester) async {
      await dragBackHalfway(tester);
      final second = find.text('Second');
      expect(find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)), findsNothing);
      final page = pageRect(tester);
      final width = screenWidth(tester);
      expect(page.width, lessThan(width * 0.98), reason: 'scaled down, as Android previews back');
      expect(page.width, greaterThan(width * 0.89), reason: 'never below 90 %');
      expect(page.left, lessThan(width * 0.1), reason: 'shifted a little, not slid halfway out');
      expect(page.left, greaterThan(0), reason: 'towards the edge the gesture came from');
      expect(opacityOf(tester, second), 1.0, reason: 'no fade while it follows the finger');
      final below = find.ancestor(of: find.text('Open'), matching: find.byType(Scaffold)).first;
      expect(tester.getTopLeft(below), Offset.zero, reason: 'the page below waits in place, without the parallax');
    }, variant: android);

    testWidgets('releasing to commit closes the page, and later pages slide again', (tester) async {
      await dragBackHalfway(tester);
      await backGesture(tester, 'commitBackGesture');
      await tester.pump(const Duration(milliseconds: 100));
      final second = find.text('Second');
      expect(
        find.ancestor(of: second, matching: find.byType(CupertinoPageTransition)),
        findsNothing,
        reason: 'it leaves from the preview, as Android does, not with the slide',
      );
      expect(opacityOf(tester, second), lessThan(1.0), reason: 'fading out');
      await tester.pumpAndSettle();
      expect(find.text('Second'), findsNothing);
      expect(find.text('Open'), findsOneWidget);

      await tester.tap(find.text('Open'));
      await tester.pumpAndSettle();
      tester.state<NavigatorState>(find.byType(Navigator)).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      expect(find.ancestor(of: find.text('Second'), matching: find.byType(CupertinoPageTransition)), findsOneWidget);
      expect(pageRect(tester).left, greaterThan(screenWidth(tester) * 0.1), reason: 'the ordinary slide');
    }, variant: android);

    testWidgets('cancelling puts the page back whole, and closing it then slides', (tester) async {
      await dragBackHalfway(tester);
      await backGesture(tester, 'cancelBackGesture');
      await tester.pump(const Duration(milliseconds: 50));
      expect(pageRect(tester).width, lessThan(screenWidth(tester)), reason: 'it grows back from the preview');
      await tester.pumpAndSettle();
      expect(pageRect(tester), Offset.zero & tester.getSize(find.byType(MaterialApp)));
      expect(find.ancestor(of: find.text('Second'), matching: find.byType(CupertinoPageTransition)), findsOneWidget);

      tester.state<NavigatorState>(find.byType(Navigator)).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      expect(pageRect(tester).left, greaterThan(screenWidth(tester) * 0.1));
      expect(pageRect(tester).width, screenWidth(tester), reason: 'slid whole, not shrunk');
    }, variant: android);

    testWidgets('on the iPhone nothing previews: the Cupertino edge swipe is its back', (tester) async {
      await dragBackHalfway(tester);
      expect(pageRect(tester), Offset.zero & tester.getSize(find.byType(MaterialApp)));
    }, variant: TargetPlatformVariant.only(TargetPlatform.iOS));

    testWidgets('with Reduce Motion, the page fades with the finger instead of shrinking', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await dragBackHalfway(tester);
      expect(pageRect(tester), Offset.zero & tester.getSize(find.byType(MaterialApp)), reason: 'no moving');
      expect(opacityOf(tester, find.text('Second')), lessThan(1.0));
      await backGesture(tester, 'commitBackGesture');
      await tester.pumpAndSettle();
      expect(find.text('Second'), findsNothing);
    }, variant: android);

    testWidgets('with Remove animations, nothing previews and the gesture still goes back', (tester) async {
      await dragBackHalfway(tester, reduceMotion: true);
      expect(pageRect(tester), Offset.zero & tester.getSize(find.byType(MaterialApp)));
      expect(opacityOf(tester, find.text('Second')), 1.0);
      await backGesture(tester, 'commitBackGesture');
      await tester.pumpAndSettle();
      expect(find.text('Second'), findsNothing);
    }, variant: android);
  });
}
