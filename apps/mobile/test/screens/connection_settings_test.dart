import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/connection/bridges_screen.dart';
import 'package:trino_mobile/screens/connection/connection_failed_screen.dart';
import 'package:trino_mobile/screens/connection/connection_screen.dart';
import 'package:trino_mobile/screens/connection/what_others_see_screen.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/switch_row.dart';

import '../support/app_harness.dart';

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.pumpAndSettle();
  await tester.tap(find.text(text));
  await tester.pumpAndSettle();
}

/// Ajustes › Privacidad › Conexión.
Future<TestApp> openConnection(WidgetTester tester, {FakeTrinoEngine? engine}) async {
  final app = await pumpApp(tester, engine: engine);
  await openTab(tester, 'Ajustes');
  await tapText(tester, 'Privacidad');
  await tapText(tester, 'Conexión');
  return app;
}

Finder switchOf(String title) => find.ancestor(of: find.text(title), matching: find.byType(SwitchRow));

ListRow rowOf(WidgetTester tester, String title) =>
    tester.widget<ListRow>(find.ancestor(of: find.text(title), matching: find.byType(ListRow)));

TrinoButton buttonOf(WidgetTester tester, String label) =>
    tester.widget<TrinoButton>(find.ancestor(of: find.text(label), matching: find.byType(TrinoButton)));

void main() {
  testWidgets('Ajustes › Privacidad leads to Conexión, with the state in words; no switches of its own', (
    tester,
  ) async {
    await pumpApp(tester);
    await openTab(tester, 'Ajustes');
    expect(rowOf(tester, 'Privacidad').subtitle, 'Cómo se conecta Trino');
    await tapText(tester, 'Privacidad');
    expect(rowOf(tester, 'Conexión').subtitle, 'Conectado de forma privada');
    expect(find.byType(SwitchRow), findsNothing, reason: 'they live in Conexión now');
    await tapText(tester, 'Conexión');
    expect(find.byType(ConnectionScreen), findsOneWidget);
  });

  testWidgets('Conexión: the state, the two rows, staying connected on with its cost, the rest closed', (tester) async {
    await openConnection(tester);
    final status = find.text('Conectado de forma privada');
    expect(status, findsOneWidget);
    expect(tester.getSemantics(status), isSemantics(isLiveRegion: true));
    expect(colorOfText(tester, 'Conectado de forma privada'), tokensIn(tester).muted);
    expect(rowOf(tester, 'Qué ven los demás').icon, TrinoIcons.eye);
    expect(rowOf(tester, 'Si en tu red bloquean Tor').value, 'Automático');
    expect(tester.getSemantics(switchOf('Seguir conectado con Trino cerrado')), isSemantics(isToggled: true));
    expect(
      find.text(
        'Así te llegan los mensajes con la app cerrada. Android muestra una notificación fija, '
        'y gasta más batería y datos.',
      ),
      findsOneWidget,
    );
    expect(find.text('Conectarse solo después de desbloquear'), findsNothing);
    expect(buttonOf(tester, 'Conectar sin protección (solo esta vez)…').variant, ButtonVariant.quiet);
    expect(find.text('Volver a conectarse de forma privada'), findsNothing);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });

  testWidgets('staying connected can be turned off, and connecting after unlocking waits in the options', (
    tester,
  ) async {
    final app = await openConnection(tester);
    await tester.tap(switchOf('Seguir conectado con Trino cerrado'));
    await tester.pumpAndSettle();
    await tapText(tester, 'Opciones avanzadas');
    expect(find.text('Trino tarda un poco más al abrir, pero no se conecta mientras está bloqueado.'), findsOneWidget);
    final afterUnlock = switchOf('Conectarse solo después de desbloquear');
    expect(tester.getSemantics(afterUnlock), isSemantics(isToggled: false));
    await tester.tap(afterUnlock);
    await tester.pumpAndSettle();
    final settings = await tester.runAsync(() => app.engine.settings.first);
    expect((settings!.keepConnectedInBackground, settings.connectAfterUnlockOnly), (false, true));
  });

  testWidgets('with a code stored, connecting after unlocking stays on and says why', (tester) async {
    final engine = testEngine();
    await engine.setCustomBridge('192.0.2.10:443');
    await openConnection(tester, engine: engine);
    expect(rowOf(tester, 'Si en tu red bloquean Tor').value, 'Un código que te dieron');
    await tapText(tester, 'Opciones avanzadas');
    final afterUnlock = switchOf('Conectarse solo después de desbloquear');
    expect(tester.getSemantics(afterUnlock), isSemantics(isToggled: true, hasEnabledState: true, isEnabled: false));
    expect(
      find.text(
        'Va encendido mientras tengas un código guardado: el código está protegido con tu contraseña, '
        'y Trino solo lo puede usar desbloqueado.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('"Si en tu red bloquean Tor" opens the ways to connect, and shows the one chosen', (tester) async {
    await openConnection(tester);
    await tapText(tester, 'Si en tu red bloquean Tor');
    expect(find.byType(BridgesScreen), findsOneWidget);
    await tapText(tester, 'Opciones avanzadas');
    await tapText(tester, 'obfs4 (integrado)');
    await tester.tap(find.bySemanticsLabel('Volver').first);
    await tester.pumpAndSettle();
    expect(rowOf(tester, 'Si en tu red bloquean Tor').value, 'obfs4');
  });

  testWidgets('connecting without protection asks, Cancelar first; then the warning and the way back', (tester) async {
    final app = await openConnection(tester);
    await tapText(tester, 'Conectar sin protección (solo esta vez)…');
    expect(find.text('¿Conectar sin protección?'), findsOneWidget);
    expect(buttonOf(tester, 'Cancelar').variant, ButtonVariant.primary);
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect((await tester.runAsync(() => app.engine.network.first))!.status, NetworkStatus.connected);

    await tapText(tester, 'Conectar sin protección (solo esta vez)…');
    await tester.tap(find.text('Conectar sin protección'));
    await tester.pumpAndSettle();
    expect((await tester.runAsync(() => app.engine.network.first))!.status, NetworkStatus.unprotected);
    const warning = 'Sin protección hasta que cierres Trino';
    expect(colorOfText(tester, warning), tokensIn(tester).warn);
    expect(tester.widget<Text>(find.text(warning)).style?.fontWeight, FontWeight.w700);
    expect(buttonOf(tester, 'Volver a conectarse de forma privada').variant, ButtonVariant.primary);
    expect(find.text('Conectar sin protección (solo esta vez)…'), findsNothing);

    await tapText(tester, 'Volver a conectarse de forma privada');
    expect((await tester.runAsync(() => app.engine.network.first))!.status, NetworkStatus.connected);
    expect(find.text('Conectado de forma privada'), findsOneWidget);
  });

  testWidgets('when it could not connect, Conexión says so and leads to what to do', (tester) async {
    final engine = testEngine()..setNetwork(const NetworkState.failed(NetworkProblem.blocked));
    await openConnection(tester, engine: engine);
    await tapText(tester, 'Ver qué hacer');
    expect(find.byType(ConnectionFailedScreen), findsOneWidget);
  });

  group('Qué ven los demás', () {
    Future<TestApp> openWhatOthersSee(WidgetTester tester, {FakeTrinoEngine? engine}) async {
      final app = await openConnection(tester, engine: engine);
      await tapText(tester, 'Qué ven los demás');
      expect(find.byType(WhatOthersSeeScreen), findsOneWidget);
      return app;
    }

    testWidgets('three short lines and one that promises nothing more; the phone\'s part stays closed', (tester) async {
      await openWhatOthersSee(tester);
      expect(
        find.text('Los servidores no ven desde dónde te conectas, pero sí a quién le escribes y cuándo.'),
        findsOneWidget,
      );
      expect(find.text('Tu proveedor de internet ve que usas Tor.'), findsOneWidget);
      expect(
        find.text(
          'En las llamadas, Cloudflare —la empresa que pasa el audio— ve desde dónde te conectas. '
          'Al abrir un enlace, la página también.',
        ),
        findsOneWidget,
      );
      const promise = 'Trino protege desde dónde te conectas, pero no te hace invisible.';
      expect(tester.widget<Text>(find.text(promise)).style?.fontWeight, FontWeight.w700);
      expect(find.text('Google, Apple o el fabricante de tu celular saben qué apps tienes instaladas.'), findsNothing);
      await expectLater(tester, meetsGuideline(textContrastGuideline));

      await tapText(tester, 'Opciones avanzadas');
      expect(
        find.text('Google, Apple o el fabricante de tu celular saben qué apps tienes instaladas.'),
        findsOneWidget,
      );
      expect(find.text('Las notificaciones de Trino no llevan el contenido de tus mensajes.'), findsOneWidget);
      expect(
        find.text(
          'Un código de conexión que te dieron hace más difícil ver que usas Tor; las formas que trae Trino '
          'son conocidas.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('if you chose to show the messages in notifications, it says so instead', (tester) async {
      final engine = testEngine();
      await engine.updateSettings(const EngineSettings(notificationPreview: NotificationPreview.nameAndMessage));
      await openWhatOthersSee(tester, engine: engine);
      await tapText(tester, 'Opciones avanzadas');
      expect(find.text('Las notificaciones de Trino no llevan el contenido de tus mensajes.'), findsNothing);
      expect(
        find.text(
          'Elegiste que las notificaciones muestren tus mensajes: quien vea la pantalla de tu celular puede '
          'leerlos. Lo cambias en Notificaciones.',
        ),
        findsOneWidget,
      );
    });
  });
}
