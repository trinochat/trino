// Renders the main screens to PNG files for review, on a 390×844 phone at
// 3× in Calma light and Terminal dark, with the bundled fonts:
//
//   flutter test test/screenshots --dart-define=TRINO_SHOTS_DIR=<folder>
//
// Skipped without the folder. It asserts nothing about how the screens look;
// the other tests do that in words.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/appearance.dart';

import '../support/app_harness.dart';

const shotsDir = String.fromEnvironment('TRINO_SHOTS_DIR');

const fonts = {
  kAtkinson: ['assets/fonts/atkinson-hyperlegible-next/AtkinsonHyperlegibleNext-VariableFont_wght.ttf'],
  kAtkinsonMono: ['assets/fonts/atkinson-hyperlegible-mono/AtkinsonHyperlegibleMono-VariableFont_wght.ttf'],
  kPlexSans: [
    'assets/fonts/ibm-plex-sans/IBMPlexSans-Regular.ttf',
    'assets/fonts/ibm-plex-sans/IBMPlexSans-Medium.ttf',
    'assets/fonts/ibm-plex-sans/IBMPlexSans-SemiBold.ttf',
    'assets/fonts/ibm-plex-sans/IBMPlexSans-Bold.ttf',
  ],
  kJetBrainsMono: ['assets/fonts/jetbrains-mono/JetBrainsMono-VariableFont_wght.ttf'],
};

Future<void> loadFonts() async {
  for (final MapEntry(key: family, value: files) in fonts.entries) {
    final loader = FontLoader(family);
    for (final file in files) {
      loader.addFont(rootBundle.load(file));
    }
    await loader.load();
  }
  // Phones have their own emoji font; on a Windows machine, this one.
  final emoji = File(r'C:\Windows\Fonts\seguiemj.ttf');
  if (emoji.existsSync()) {
    await (FontLoader('Segoe UI Emoji')..addFont(Future.value(ByteData.sublistView(emoji.readAsBytesSync())))).load();
  }
}

Future<void> shot(WidgetTester tester, String name) async {
  await tester.pumpAndSettle();
  final boundary = tester.renderObject<RenderRepaintBoundary>(find.byKey(appBoundaryKey));
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 3);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    File('$shotsDir/$name.png')
      ..createSync(recursive: true)
      ..writeAsBytesSync(png!.buffer.asUint8List());
  });
}

void main() {
  final skip = shotsDir.isEmpty ? 'needs --dart-define=TRINO_SHOTS_DIR=<folder>' : false;

  setUpAll(() async {
    if (skip != false) return;
    TestWidgetsFlutterBinding.ensureInitialized();
    await loadFonts();
  });

  for (final (name, appearance) in [
    ('calma-light', const Appearance()),
    ('terminal-dark', const Appearance(style: TrinoStyle.terminal, mode: AppearanceMode.dark)),
  ]) {
    testWidgets('the main screens in $name', (tester) async {
      await pumpApp(
        tester,
        engine: testEngine(callStartsAt: const Duration(minutes: 3, seconds: 21)),
        appearance: appearance,
      );
      await shot(tester, '$name-01-chats');

      await openChat(tester, 'Ana Torres');
      await shot(tester, '$name-02-chat');

      await tester.tap(find.bySemanticsLabel('Llamar'));
      await tester.pumpAndSettle();
      await shot(tester, '$name-03-call');
      await tester.tap(find.byKey(const ValueKey('call-key-pill')));
      await shot(tester, '$name-04-call-key');
      await tester.tap(find.text('Coinciden'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Conexión directa'));
      await shot(tester, '$name-05-call-verified');
      await tester.tap(find.bySemanticsLabel('Colgar'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();

      await openTab(tester, 'Llamadas');
      await shot(tester, '$name-12-calls');
      await openTab(tester, 'Chats');
      await tester.tap(find.text('Solicitudes (3)'));
      await shot(tester, '$name-13-requests');
      await tester.tap(find.textContaining('Hola, soy Ana'));
      await shot(tester, '$name-14-request');
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();
      await openTab(tester, 'Contactos');
      await shot(tester, '$name-06-contacts');
      await openTab(tester, 'Ajustes');
      await shot(tester, '$name-07-settings');
      await tester.tap(find.text('Apariencia'));
      await shot(tester, '$name-08-appearance');
    }, skip: skip != false);

    testWidgets('the first run in $name', (tester) async {
      await pumpApp(tester, engine: testEngine(onboarded: false), appearance: appearance);
      await shot(tester, '$name-09-welcome');
      await tester.tap(find.text('Empezar'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Sofía');
      await tester.tap(find.text('Continuar'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'una frase larga y mía');
      await shot(tester, '$name-10-password');
    }, skip: skip != false);

    testWidgets('the unlock screen in $name', (tester) async {
      await pumpApp(tester, engine: testEngine(locked: true), appearance: appearance);
      await shot(tester, '$name-11-unlock');
    }, skip: skip != false);
  }
}
