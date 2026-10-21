import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/app/system_bars.dart';
import 'package:trino_mobile/design/appearance.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/ui/bottom_tabs.dart';
import 'package:trino_mobile/ui/composer_field.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/app_harness.dart';

SystemUiOverlayStyle appBarsStyle(WidgetTester tester) => tester
    .widget<AnnotatedRegion<SystemUiOverlayStyle>>(find.byType(AnnotatedRegion<SystemUiOverlayStyle>).first)
    .value;

/// A phone with a 24 dp status bar and a 34 dp gesture bar, drawn behind both.
void useInsets(WidgetTester tester) {
  tester.view.padding = const FakeViewPadding(top: 24 * 3, bottom: 34 * 3);
  tester.view.viewPadding = const FakeViewPadding(top: 24 * 3, bottom: 34 * 3);
  addTearDown(tester.view.resetPadding);
  addTearDown(tester.view.resetViewPadding);
}

void main() {
  group('the system bars, drawn over by the app', () {
    test('clear, with no scrim, and dark icons on a light theme', () {
      final style = systemBarsFor(Brightness.light);
      expect(style.statusBarColor, const Color(0x00000000));
      expect(style.systemNavigationBarColor, const Color(0x00000000));
      expect(style.systemNavigationBarDividerColor, const Color(0x00000000));
      expect(style.systemStatusBarContrastEnforced, isFalse);
      expect(style.systemNavigationBarContrastEnforced, isFalse);
      expect(style.statusBarIconBrightness, Brightness.dark, reason: 'Android: dark icons');
      expect(style.systemNavigationBarIconBrightness, Brightness.dark);
      expect(style.statusBarBrightness, Brightness.light, reason: 'iPhone: a light bar, so dark text');
    });

    test('light icons on a dark theme', () {
      final style = systemBarsFor(Brightness.dark);
      expect(style.statusBarColor, const Color(0x00000000));
      expect(style.systemNavigationBarColor, const Color(0x00000000));
      expect(style.statusBarIconBrightness, Brightness.light);
      expect(style.systemNavigationBarIconBrightness, Brightness.light);
      expect(style.statusBarBrightness, Brightness.dark);
    });

    testWidgets('the app asks for them by theme: Calma light', (tester) async {
      await pumpApp(tester);
      expect(appBarsStyle(tester), systemBarsFor(Brightness.light));
    });

    testWidgets('the app asks for them by theme: Terminal dark', (tester) async {
      await pumpApp(
        tester,
        appearance: const Appearance(style: TrinoStyle.terminal, mode: AppearanceMode.dark),
      );
      expect(appBarsStyle(tester), systemBarsFor(Brightness.dark));
    });

    testWidgets('the app draws edge to edge from the start', (tester) async {
      final calls = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        calls.add(call);
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));
      await pumpApp(tester);
      expect(
        calls.where((call) => call.method == 'SystemChrome.setEnabledSystemUIMode').map((call) => call.arguments),
        contains('SystemUiMode.edgeToEdge'),
      );
    });
  });

  group('nothing important under the bars', () {
    testWidgets('the tabs: the title below the status bar, the tabs above the gesture bar', (tester) async {
      useInsets(tester);
      await pumpApp(tester);
      expect(tester.getRect(find.text('Chats').first).top, greaterThanOrEqualTo(24));
      final tabs = find.byType(BottomTabs);
      expect(
        tester.getRect(find.descendant(of: tabs, matching: find.text('Ajustes'))).bottom,
        lessThanOrEqualTo(844 - 34),
      );
      expect(tester.getRect(tabs).bottom, 844, reason: 'its background still reaches the edge, behind the gesture bar');
    });

    testWidgets('a chat: the header below the status bar, the composer above the gesture bar', (tester) async {
      useInsets(tester);
      await pumpApp(tester);
      await openChat(tester, 'Lucía');
      expect(tester.getRect(find.bySemanticsLabel('Volver').first).top, greaterThanOrEqualTo(24));
      expect(tester.getRect(find.byType(ComposerField)).bottom, lessThanOrEqualTo(844 - 34));
    });

    testWidgets('a call: the key below the status bar, the buttons above the gesture bar', (tester) async {
      useInsets(tester);
      await pumpApp(tester, engine: testEngine(callStartsAt: const Duration(minutes: 1)));
      await openChat(tester, 'Ana Torres');
      await tester.tap(find.byWidgetPredicate((w) => w is TrinoIconButton && w.icon == TrinoIcons.phone));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.byKey(CallScreen.keyPillKey)).top, greaterThanOrEqualTo(24));
      expect(tester.getRect(find.text('Colgar')).bottom, lessThanOrEqualTo(844 - 34));
    });
  });
}
