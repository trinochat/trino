import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/connection/bridges_screen.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/list_row.dart';

import '../support/app_harness.dart';

Future<FakeTrinoEngine> pumpBridges(WidgetTester tester, {FakeTrinoEngine? engine}) =>
    pumpScreen(tester, const BridgesScreen(), engine: engine);

Finder choice(String title) => find.ancestor(of: find.text(title), matching: find.byType(ChoiceRow));

Future<void> tapVisible(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text));
  await tester.pumpAndSettle();
  await tester.tap(find.text(text));
  await tester.pumpAndSettle();
}

Future<void> openAdvanced(WidgetTester tester) async {
  await tester.tap(find.text('Opciones avanzadas'));
  await tester.pumpAndSettle();
}

Future<BridgeSettings> bridgesOf(WidgetTester tester, FakeTrinoEngine engine) async =>
    (await tester.runAsync(() => engine.bridges.first))!;

void main() {
  testWidgets('one action, the automatic search, with what the Tor Project sees; the rest stays closed', (
    tester,
  ) async {
    await pumpBridges(tester);
    expect(find.text('Otra forma de conectarse'), findsOneWidget);
    expect(find.text('Si en tu red bloquean Tor, Trino puede entrar por otra puerta.'), findsOneWidget);
    final search = find.ancestor(
      of: find.text('Buscar una forma que funcione aquí'),
      matching: find.byType(TrinoButton),
    );
    expect(tester.widget<TrinoButton>(search).variant, ButtonVariant.primary);
    expect(
      find.text(
        'Trino le pregunta al Proyecto Tor qué funciona en tu país. Ellos ven desde dónde te conectas, '
        'pero no se les dice que usas Trino.',
      ),
      findsOneWidget,
    );
    expect(tester.getSemantics(find.text('Opciones avanzadas')), isSemantics(isExpanded: false, isButton: true));
    expect(find.text('Snowflake (integrado)'), findsNothing);
    expect(find.text('Pega aquí el código'), findsNothing);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await expectLater(tester, meetsGuideline(textContrastGuideline));
  });

  testWidgets('the search goes back to automatic, says it is trying as a live region, then that it connected', (
    tester,
  ) async {
    final engine = FakeTrinoEngine(clock: () => testNow, connectAfter: const Duration(seconds: 2))
      ..setNetwork(const NetworkState.failed(NetworkProblem.blocked));
    await engine.setBridgeMode(BridgeMode.snowflake);
    await pumpBridges(tester, engine: engine);
    await tester.tap(find.text('Buscar una forma que funcione aquí'));
    await tester.pump();
    final trying = find.text('Probando otra forma de conectarse…');
    expect(trying, findsOneWidget);
    expect(tester.getSemantics(trying), isSemantics(isLiveRegion: true));
    expect((await bridgesOf(tester, engine)).mode, BridgeMode.automatic);

    await tester.pump(const Duration(seconds: 2));
    await tester.pumpAndSettle();
    expect(find.text('Conectado de forma privada'), findsOneWidget);
  });

  testWidgets('Opciones avanzadas: the four ways, automatic chosen, and what the built-in ones do not hide', (
    tester,
  ) async {
    final engine = await pumpBridges(tester);
    await openAdvanced(tester);
    final titles = tester.widgetList<ChoiceRow>(find.byType(ChoiceRow)).map((row) => row.title);
    expect(titles, [
      'Automático (recomendado)',
      'Snowflake (integrado)',
      'obfs4 (integrado)',
      'Tengo un código que me dieron',
    ]);
    expect(tester.getSemantics(choice('Automático (recomendado)')), isSemantics(isChecked: true));
    expect(
      find.text(
        'Las formas que trae Trino las conoce cualquiera: sirven si bloquean Tor, pero no esconden que lo usas.',
      ),
      findsOneWidget,
    );

    await tester.tap(choice('Snowflake (integrado)'));
    await tester.pumpAndSettle();
    expect((await bridgesOf(tester, engine)).mode, BridgeMode.snowflake);
    expect(tester.getSemantics(choice('Snowflake (integrado)')), isSemantics(isChecked: true));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
  });

  testWidgets('a code someone gave you: the field, its help, errors in words, then saved', (tester) async {
    final engine = await pumpBridges(tester);
    await openAdvanced(tester);
    await tester.tap(choice('Tengo un código que me dieron'));
    await tester.pumpAndSettle();
    expect(find.text('Pega aquí el código'), findsOneWidget);
    expect(
      find.text(
        'Te lo puede dar alguien de confianza, o lo pides en bridges.torproject.org. '
        'Se guarda protegido con tu contraseña.',
      ),
      findsOneWidget,
    );
    expect((await bridgesOf(tester, engine)).mode, BridgeMode.automatic, reason: 'nothing changes without a code');

    await tester.enterText(find.byType(TextField), 'esto no es un código');
    await tapVisible(tester, 'Guardar el código');
    expect(find.text('Ese código no sirve. Revisa que lo copiaste completo, tal como te lo dieron.'), findsOneWidget);
    expect((await bridgesOf(tester, engine)).hasCustomBridge, isFalse);

    await tester.enterText(find.byType(TextField), 'obfs4 192.0.2.10:443 0123456789ABCDEF cert=abc iat-mode=0');
    await tapVisible(tester, 'Guardar el código');
    final saved = await bridgesOf(tester, engine);
    expect((saved.mode, saved.hasCustomBridge), (BridgeMode.custom, true));
    expect(find.byType(TextField), findsNothing, reason: 'the app never reads the code back');
    expect(find.text('Tienes un código guardado, protegido con tu contraseña.'), findsOneWidget);
    final settings = await tester.runAsync(() => engine.settings.first);
    expect(settings!.connectAfterUnlockOnly, isTrue);
  });

  testWidgets('with a code stored, the options show open, and the code can be removed', (tester) async {
    final engine = testEngine();
    await engine.setCustomBridge('192.0.2.10:443');
    await pumpBridges(tester, engine: engine);
    expect(tester.getSemantics(find.text('Opciones avanzadas')), isSemantics(isExpanded: true, isButton: true));
    expect(tester.getSemantics(choice('Tengo un código que me dieron')), isSemantics(isChecked: true));

    await tapVisible(tester, 'Quitar el código');
    final removed = await bridgesOf(tester, engine);
    expect((removed.mode, removed.hasCustomBridge), (BridgeMode.automatic, false));
    expect(find.text('Se quitó el código.'), findsOneWidget);
    expect(tester.getSemantics(choice('Automático (recomendado)')), isSemantics(isChecked: true));
  });
}
