// Pumps the whole app on the fake engine, at a fixed time, in Spanish unless
// told otherwise.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/app/app.dart';
import 'package:trino_mobile/app/language.dart';
import 'package:trino_mobile/design/appearance.dart';
import 'package:trino_mobile/engine/fake_engine.dart';

import 'harness.dart';

export 'package:trino_mobile/engine/engine.dart';
export 'package:trino_mobile/engine/fake_engine.dart';

export 'harness.dart';

/// 11:00 on Friday 9 October 2026: the demo's "10:42" is today.
final testNow = DateTime(2026, 10, 9, 11);

FakeTrinoEngine testEngine({bool onboarded = true, bool locked = false, Duration callStartsAt = Duration.zero}) =>
    FakeTrinoEngine(clock: () => testNow, onboarded: onboarded, locked: locked, callStartsAt: callStartsAt);

/// Around the whole app, so a test can capture what it shows.
const appBoundaryKey = ValueKey('app-boundary');

class TestApp {
  TestApp(this.engine, this.appearance, this.language);

  final FakeTrinoEngine engine;
  final AppearanceController appearance;
  final LanguageController language;
}

Future<TestApp> pumpApp(
  WidgetTester tester, {
  FakeTrinoEngine? engine,
  Appearance appearance = const Appearance(),
  Locale locale = const Locale('es'),
  double textScale = 1,
}) async {
  usePhone(tester);
  if (textScale != 1) {
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  final app = TestApp(engine ?? testEngine(), AppearanceController(appearance), LanguageController(locale));
  // Not awaited: inside testWidgets nothing would run the future's completion.
  addTearDown(() => unawaited(app.engine.dispose()));
  addTearDown(app.appearance.dispose);
  addTearDown(app.language.dispose);
  await tester.pumpWidget(
    RepaintBoundary(
      key: appBoundaryKey,
      child: TrinoApp(engine: app.engine, appearance: app.appearance, language: app.language, clock: () => testNow),
    ),
  );
  await tester.pumpAndSettle();
  return app;
}

/// The theme the app shows right now.
TrinoTheme currentTheme(WidgetTester tester) =>
    Theme.of(tester.element(find.byType(Scaffold).last)).extension<TrinoTheme>()!;

/// Taps the bottom tab with [label].
Future<void> openTab(WidgetTester tester, String label) async {
  await tester.tap(find.descendant(of: find.byKey(const ValueKey('bottom-tabs')), matching: find.text(label)));
  await tester.pumpAndSettle();
}

/// Opens the chat whose row shows [name].
Future<void> openChat(WidgetTester tester, String name) async {
  await tester.tap(find.text(name).first);
  await tester.pumpAndSettle();
}
