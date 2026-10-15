import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/connection/connection_failed_screen.dart';
import 'package:trino_mobile/ui/button.dart';

import '../support/app_harness.dart';

/// Opens "No se pudo conectar" from the inbox's "Ver qué hacer".
Future<TestApp> openHelp(
  WidgetTester tester, {
  NetworkProblem? problem,
  Duration? connectAfter,
  bool keepConnected = false,
}) async {
  final engine = FakeTrinoEngine(clock: () => testNow, connectAfter: connectAfter);
  final app = await pumpApp(tester, engine: engine);
  final settings = await tester.runAsync(() => engine.settings.first);
  await engine.updateSettings(settings!.copyWith(keepConnectedInBackground: keepConnected));
  engine.setNetwork(NetworkState.failed(problem));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Ver qué hacer'));
  await tester.pumpAndSettle();
  return app;
}

TrinoButton buttonOf(WidgetTester tester, String label) =>
    tester.widget<TrinoButton>(find.ancestor(of: find.text(label), matching: find.byType(TrinoButton)));

void main() {
  testWidgets('"Ver qué hacer" opens it: the title, the reason in words and what still works', (tester) async {
    await openHelp(tester, problem: NetworkProblem.blocked);
    expect(find.byType(ConnectionFailedScreen), findsOneWidget);
    expect(find.text('Conexión'), findsOneWidget);
    final title = find.text('No se pudo conectar');
    expect(tester.getSemantics(title), isSemantics(isHeader: true, isLiveRegion: true));
    expect(find.text('Parece que la red donde estás no deja usar Tor.'), findsOneWidget);
    expect(
      find.text('Puedes leer tus chats. Lo que envíes sale cuando se conecte, si dejas Trino abierto.'),
      findsOneWidget,
    );
    expect(buttonOf(tester, 'Probar otra forma de conectarse').variant, ButtonVariant.primary);
    expect(buttonOf(tester, 'Volver a intentar').variant, ButtonVariant.secondary);
    final unprotected = buttonOf(tester, 'Conectar sin protección…');
    expect(unprotected.variant, ButtonVariant.quiet);
    expect(colorOfText(tester, 'Conectar sin protección…'), tokensIn(tester).muted);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });

  testWidgets('with Trino staying connected while closed, what you send goes out even if you close it', (tester) async {
    await openHelp(tester, problem: NetworkProblem.blocked, keepConnected: true);
    expect(
      find.text('Puedes leer tus chats. Lo que envíes sale cuando se conecte, aunque cierres Trino.'),
      findsOneWidget,
    );
  });

  testWidgets('a wrong clock sends you to the phone\'s settings, with only "Volver a intentar"', (tester) async {
    await openHelp(tester, problem: NetworkProblem.clock);
    expect(
      find.text('La hora de tu celular está mal. Corrígela en los ajustes del celular y vuelve a intentar.'),
      findsOneWidget,
    );
    expect(buttonOf(tester, 'Volver a intentar').variant, ButtonVariant.primary);
    expect(find.text('Probar otra forma de conectarse'), findsNothing);
    expect(find.text('Conectar sin protección…'), findsNothing);
  });

  testWidgets('an unknown reason is said honestly', (tester) async {
    await openHelp(tester);
    expect(find.text('Trino no pudo saber por qué. Puede ser la red donde estás.'), findsOneWidget);
    expect(find.text('Probar otra forma de conectarse'), findsOneWidget);
  });

  testWidgets('trying another way says so as a live region, then says it connected', (tester) async {
    await openHelp(tester, problem: NetworkProblem.blocked, connectAfter: const Duration(seconds: 2));
    await tester.tap(find.text('Probar otra forma de conectarse'));
    await tester.pump();
    final trying = find.text('Probando otra forma de conectarse…');
    expect(trying, findsOneWidget);
    expect(tester.getSemantics(trying), isSemantics(isLiveRegion: true));
    expect(buttonOf(tester, 'Probar otra forma de conectarse').loading, isTrue);
    expect(buttonOf(tester, 'Volver a intentar').onPressed, isNull);

    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    final connected = find.text('Conectado de forma privada');
    expect(tester.getSemantics(connected), isSemantics(isHeader: true, isLiveRegion: true));
    expect(find.text('Parece que la red donde estás no deja usar Tor.'), findsNothing);
    await tester.tap(find.text('Volver a los chats'));
    await tester.pumpAndSettle();
    expect(find.byType(ConnectionFailedScreen), findsNothing);
  });

  testWidgets('"Volver a intentar" shows the progress in words', (tester) async {
    await openHelp(tester, problem: NetworkProblem.blocked, connectAfter: const Duration(seconds: 2));
    await tester.tap(find.text('Volver a intentar'));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.text('Conectando de forma privada… 50 %'), findsOneWidget);
    await tester.pump(const Duration(seconds: 1));
    await tester.pumpAndSettle();
    expect(find.text('Conectado de forma privada'), findsOneWidget);
  });

  group('"Conectar sin protección…"', () {
    testWidgets('asks first, with Cancelar as the primary button, and cancelling keeps it private', (tester) async {
      final app = await openHelp(tester, problem: NetworkProblem.blocked);
      await tester.tap(find.text('Conectar sin protección…'));
      await tester.pumpAndSettle();
      expect(tester.getSemantics(find.text('¿Conectar sin protección?')), isSemantics(isHeader: true));
      expect(
        find.text(
          'Solo hasta que cierres Trino. Tu proveedor de internet y los servidores verán desde dónde te conectas, '
          'y tu proveedor verá que usas Trino.',
        ),
        findsOneWidget,
      );
      expect(buttonOf(tester, 'Cancelar').variant, ButtonVariant.primary);
      expect(buttonOf(tester, 'Conectar sin protección').variant, isNot(ButtonVariant.primary));

      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();
      final state = await tester.runAsync(() => app.engine.network.first);
      expect(state!.status, NetworkStatus.failed);
      expect(find.byType(ConnectionFailedScreen), findsOneWidget);
    });

    testWidgets('confirming connects without Tor and goes back to the chats, which say so', (tester) async {
      final app = await openHelp(tester, problem: NetworkProblem.blocked);
      await tester.tap(find.text('Conectar sin protección…'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Conectar sin protección'));
      await tester.pumpAndSettle();
      final state = await tester.runAsync(() => app.engine.network.first);
      expect(state!.status, NetworkStatus.unprotected);
      expect(find.byType(ConnectionFailedScreen), findsNothing);
      expect(find.text('Sin protección hasta que cierres Trino'), findsOneWidget);
    });

    testWidgets('asks again every time: nothing is remembered', (tester) async {
      final app = await openHelp(tester, problem: NetworkProblem.blocked);
      for (var i = 0; i < 2; i++) {
        await tester.tap(find.text('Conectar sin protección…'));
        await tester.pumpAndSettle();
        expect(find.text('¿Conectar sin protección?'), findsOneWidget, reason: 'time ${i + 1}');
        await tester.tap(find.text('Cancelar'));
        await tester.pumpAndSettle();
      }
      final state = await tester.runAsync(() => app.engine.network.first);
      expect(state!.status, NetworkStatus.failed);
    });
  });
}
