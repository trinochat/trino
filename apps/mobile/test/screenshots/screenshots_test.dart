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
import 'package:trino_mobile/ui/swipe_actions.dart';

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

/// Without [settle], as it is now, such as while a button's spinner turns.
Future<void> shot(WidgetTester tester, String name, {bool settle = true}) async {
  if (settle) await tester.pumpAndSettle();
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
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cuenta y seguridad'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Desbloquear con huella o Face ID'));
      await shot(tester, '$name-15-security');
      await tester.tap(find.text('Pedir la contraseña'));
      await shot(tester, '$name-16-security-reask');
      await tester.tap(find.text('Cada 3 días').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Protección reforzada'));
      await shot(tester, '$name-17-security-reinforced');
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Dispositivos'));
      await shot(tester, '$name-18-devices');
    }, skip: skip != false);

    testWidgets('the connection screens in $name', (tester) async {
      Future<void> tapText(String text) async {
        await tester.ensureVisible(find.text(text).last);
        await tester.pumpAndSettle();
        await tester.tap(find.text(text).last);
        await tester.pumpAndSettle();
      }

      Future<void> back() async {
        await tester.tap(find.bySemanticsLabel('Volver').last);
        await tester.pumpAndSettle();
      }

      final engine = FakeTrinoEngine(clock: () => testNow, connectAfter: const Duration(seconds: 2))
        ..setNetwork(const NetworkState.failed(NetworkProblem.blocked));
      await pumpApp(tester, engine: engine, appearance: appearance);
      await tapText('Ver qué hacer');
      await shot(tester, '$name-19-net-failed');
      await tapText('Conectar sin protección…');
      await shot(tester, '$name-20-net-unprotected-ask');
      await tapText('Cancelar');
      await tester.tap(find.text('Probar otra forma de conectarse'));
      await tester.pump();
      await shot(tester, '$name-21-net-trying', settle: false);
      await tester.pump(const Duration(seconds: 2));
      await shot(tester, '$name-22-net-connected');
      await tapText('Volver a los chats');
      engine.setNetwork(const NetworkState.failed(NetworkProblem.clock));
      await tester.pumpAndSettle();
      await tapText('Ver qué hacer');
      await shot(tester, '$name-23-net-clock');
      await back();
      engine.setNetwork(const NetworkState.connected());

      await openTab(tester, 'Ajustes');
      await tapText('Privacidad');
      await shot(tester, '$name-24-privacy');
      await tapText('Conexión');
      await shot(tester, '$name-25-connection');
      await tapText('Opciones avanzadas');
      await shot(tester, '$name-26-connection-advanced');
      await tapText('Si en tu red bloquean Tor');
      await shot(tester, '$name-27-bridges');
      await tapText('Opciones avanzadas');
      await tapText('Tengo un código que me dieron');
      await tester.enterText(find.byType(TextField), 'esto no es un código');
      await tapText('Guardar el código');
      await shot(tester, '$name-28-bridges-code');
      await back();
      await tapText('Qué ven los demás');
      await tapText('Opciones avanzadas');
      await shot(tester, '$name-29-what-others-see');
      await back();
      await tapText('Conectar sin protección (solo esta vez)…');
      await tapText('Conectar sin protección');
      await tester.scrollUntilVisible(find.text('Sin protección hasta que cierres Trino'), -200);
      await shot(tester, '$name-30-connection-unprotected');
    }, skip: skip != false);

    testWidgets('the first run in $name', (tester) async {
      await pumpApp(tester, engine: testEngine(onboarded: false), appearance: appearance);
      await shot(tester, '$name-09-welcome');
      await tester.tap(find.text('Español'));
      await shot(tester, '$name-39-onb-language');
      await tester.tapAt(const Offset(195, 100));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Crear una cuenta'));
      await tester.pumpAndSettle();
      await shot(tester, '$name-31-onb-tor');
      await tester.tap(find.text('Continuar'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'Sofía');
      await tester.tap(find.text('Continuar'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).first, 'una frase larga y mía');
      await shot(tester, '$name-10-password');
    }, skip: skip != false);

    testWidgets('linking this phone in $name', (tester) async {
      Future<void> tapText(String text) async {
        await tester.ensureVisible(find.text(text).last);
        await tester.pumpAndSettle();
        await tester.tap(find.text(text).last);
        await tester.pumpAndSettle();
      }

      final app = await pumpApp(tester, engine: testEngine(onboarded: false), appearance: appearance);
      await tapText('Ya uso Trino en mi computador');
      await shot(tester, '$name-32-link-intro');
      await tapText('Escanear el código');
      await shot(tester, '$name-33-link-scan');
      app.scanner.simulate('https://example.com/premio');
      await shot(tester, '$name-34-link-scan-invalid');
      await tapText('Simular escaneo (demostración)');
      await shot(tester, '$name-35-link-confirm');
      app.engine.failLink(LinkFailure.expired);
      await shot(tester, '$name-36-link-expired');
      await tapText('Empezar de nuevo');
      await tapText('Escanear el código');
      await tapText('Simular escaneo (demostración)');
      app.engine
        ..confirmLinkOnComputer()
        ..setLinkProgress(35);
      await shot(tester, '$name-37-link-done');
      await tapText('Continuar');
      await tester.enterText(find.byType(TextField).first, 'otra frase larga y mía');
      await shot(tester, '$name-38-link-password');
    }, skip: skip != false);

    testWidgets('the unlock screen in $name', (tester) async {
      await pumpApp(tester, engine: testEngine(locked: true), appearance: appearance);
      await shot(tester, '$name-11-unlock');
      await tester.enterText(find.byType(TextField), 'otra cosa');
      await tester.tap(find.text('Desbloquear'));
      await shot(tester, '$name-40-unlock-error');
      await tester.tap(find.text('Borrar todo y empezar de nuevo…'));
      await shot(tester, '$name-42-unlock-wipe');
    }, skip: skip != false);

    testWidgets('the contact and group info in $name', (tester) async {
      Future<void> tapText(String text) async {
        await tester.ensureVisible(find.text(text).last);
        await tester.pumpAndSettle();
        await tester.tap(find.text(text).last);
        await tester.pumpAndSettle();
      }

      Future<void> back() async {
        await tester.tap(find.bySemanticsLabel('Volver').last);
        await tester.pumpAndSettle();
      }

      // A group you administer, which Ana is also in.
      final engine = testEngine()..addGroup(title: 'Taller de cerámica', memberIds: const ['ana', 'lucia']);
      await pumpApp(tester, engine: engine, appearance: appearance);
      await openChat(tester, 'Ana Torres');
      await tester.tap(find.bySemanticsLabel('Ver la info de Ana Torres'));
      await tester.pumpAndSettle();
      await shot(tester, '$name-43-contact-info');
      await tapText('Bloquear a Ana Torres');
      await shot(tester, '$name-44-contact-block');
      await tapText('Cancelar');
      await tapText('Borrar el chat');
      await shot(tester, '$name-45-contact-delete');
      await tapText('Cancelar');
      await back();
      await back();

      await openChat(tester, 'Familia');
      await tester.tap(find.bySemanticsLabel('Ver la info de Familia'));
      await tester.pumpAndSettle();
      await shot(tester, '$name-46-group-member');
      await tapText('Salir del grupo');
      await shot(tester, '$name-47-group-leave');
      await tapText('Cancelar');
      await back();
      await back();

      await openChat(tester, 'Taller de cerámica');
      await tester.tap(find.bySemanticsLabel('Ver la info de Taller de cerámica'));
      await tester.pumpAndSettle();
      await tapText('Silenciar');
      await shot(tester, '$name-48-group-admin-muted');
    }, skip: skip != false);

    testWidgets('the calls that ring and the call settings in $name', (tester) async {
      Future<void> tapText(String text) async {
        await tester.ensureVisible(find.text(text).last);
        await tester.pumpAndSettle();
        await tester.tap(find.text(text).last);
        await tester.pumpAndSettle();
      }

      final app = await pumpApp(tester, engine: testEngine(answerAfter: null), appearance: appearance);
      app.engine.receiveCall('ana');
      await shot(tester, '$name-49-call-incoming');
      await tester.tap(find.bySemanticsLabel('Rechazar'));
      await tester.pumpAndSettle();

      await openChat(tester, 'Ana Torres');
      await tester.tap(find.bySemanticsLabel('Llamar'));
      await tester.pumpAndSettle();
      await shot(tester, '$name-50-call-calling');
      await tester.tap(find.bySemanticsLabel('Colgar'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();

      await openTab(tester, 'Ajustes');
      await tapText('Notificaciones');
      await shot(tester, '$name-51-notif-calls');
      await tapText('Tono de llamada');
      await shot(tester, '$name-52-notif-ringtone');
    }, skip: skip != false);

    testWidgets('pinning, swiping and the actions of a chat in $name', (tester) async {
      final engine = testEngine();
      await engine.setChatPinned('chat-lucia', true);
      await engine.markUnread('chat-carlos');
      await pumpApp(tester, engine: engine, appearance: appearance);
      await shot(tester, '$name-53-chats-pinned');
      Finder row(String name) => find.ancestor(of: find.text(name), matching: find.byType(SwipeActions));
      await tester.drag(row('Ana Torres'), const Offset(120, 0));
      await shot(tester, '$name-54-chat-swiped-right');
      await tester.drag(row('Familia'), const Offset(-120, 0));
      await shot(tester, '$name-55-chat-swiped-left');
      await tester.tapAt(const Offset(195, 700));
      await tester.pumpAndSettle();
      await tester.longPress(row('Familia'));
      await shot(tester, '$name-56-chat-actions-sheet');
    }, skip: skip != false);

    testWidgets('the unlock screen with the fingerprint in $name', (tester) async {
      final engine = testEngine();
      await tester.runAsync(() => engine.updateSettings(const EngineSettings(biometricUnlock: true)));
      engine.lockForIdle(5);
      await pumpApp(tester, engine: engine, appearance: appearance);
      await shot(tester, '$name-41-unlock-biometric');
    }, skip: skip != false);
  }
}
