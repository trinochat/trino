// Pumps the whole app on the fake engine, at a fixed time, in Spanish unless
// told otherwise.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/app/app.dart';
import 'package:trino_mobile/app/language.dart';
import 'package:trino_mobile/app/scope.dart';
import 'package:trino_mobile/design/appearance.dart';
import 'package:trino_mobile/engine/engine.dart';
import 'package:trino_mobile/engine/fake_engine.dart';
import 'package:trino_mobile/l10n/app_localizations.dart';
import 'package:trino_mobile/platform/biometrics.dart';
import 'package:trino_mobile/platform/call_sounds.dart';
import 'package:trino_mobile/platform/proximity.dart';
import 'package:trino_mobile/platform/qr_scanner.dart';

import 'harness.dart';

export 'package:trino_mobile/engine/engine.dart';
export 'package:trino_mobile/engine/fake_engine.dart';
export 'package:trino_mobile/platform/call_sounds.dart';
export 'package:trino_mobile/platform/proximity.dart';
export 'package:trino_mobile/platform/qr_scanner.dart';

export 'harness.dart';

/// 11:00 on Friday 9 October 2026: the demo's "10:42" is today.
final testNow = DateTime(2026, 10, 9, 11);

FakeTrinoEngine testEngine({
  bool onboarded = true,
  bool locked = false,
  Duration callStartsAt = Duration.zero,
  CallPath callPath = CallPath.relay,
  Duration? answerAfter = Duration.zero,
  Duration sendDelay = Duration.zero,
}) => FakeTrinoEngine(
  clock: () => testNow,
  onboarded: onboarded,
  locked: locked,
  callStartsAt: callStartsAt,
  callPath: callPath,
  answerAfter: answerAfter,
  sendDelay: sendDelay,
);

/// Around the whole app, so a test can capture what it shows.
const appBoundaryKey = ValueKey('app-boundary');

class TestApp {
  TestApp(this.engine, this.appearance, this.language, this.scanner, this.sounds);

  final FakeTrinoEngine engine;
  final AppearanceController appearance;
  final LanguageController language;

  /// The demo scanner: a test scans with [DemoQrScanner.simulate].
  final DemoQrScanner scanner;

  /// The demo call sounds: what the app asked to play, in [DemoCallSounds.log].
  final DemoCallSounds sounds;
}

Future<TestApp> pumpApp(
  WidgetTester tester, {
  FakeTrinoEngine? engine,
  Appearance appearance = const Appearance(),
  Locale locale = const Locale('es'),
  double textScale = 1,
  BiometricAuth? biometrics,
  DemoQrScanner? scanner,
  DemoCallSounds? sounds,
  VoidCallback? demoIncomingCall,
  ProximityScreen? proximity,
}) async {
  usePhone(tester);
  if (textScale != 1) {
    tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  final app = TestApp(
    engine ?? testEngine(),
    AppearanceController(appearance),
    LanguageController(locale),
    scanner ?? DemoQrScanner(),
    sounds ?? DemoCallSounds(),
  );
  // Not awaited: inside testWidgets nothing would run the future's completion.
  addTearDown(() => unawaited(app.engine.dispose()));
  addTearDown(app.appearance.dispose);
  addTearDown(app.language.dispose);
  await tester.pumpWidget(
    RepaintBoundary(
      key: appBoundaryKey,
      child: TrinoApp(
        engine: app.engine,
        appearance: app.appearance,
        language: app.language,
        clock: () => testNow,
        biometrics: biometrics ?? const DemoBiometricAuth(),
        scanner: app.scanner,
        callSounds: app.sounds,
        demoIncomingCall: demoIncomingCall,
        proximity: proximity,
      ),
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

/// Pumps one [screen] alone, with the app's scope, theme and language, for
/// what the whole app cannot reach yet, such as a callback no screen passes.
Future<FakeTrinoEngine> pumpScreen(WidgetTester tester, Widget screen, {FakeTrinoEngine? engine}) async {
  usePhone(tester);
  final fake = engine ?? testEngine();
  final appearance = AppearanceController(const Appearance());
  final language = LanguageController(const Locale('es'));
  addTearDown(() => unawaited(fake.dispose()));
  addTearDown(appearance.dispose);
  addTearDown(language.dispose);
  await tester.pumpWidget(
    AppScope(
      engine: fake,
      appearance: appearance,
      language: language,
      clock: () => testNow,
      child: MaterialApp(
        theme: appearance.lightTheme,
        locale: language.locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        home: Scaffold(body: screen),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return fake;
}
