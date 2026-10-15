import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/onboarding_screen.dart';
import 'package:trino_mobile/screens/settings/devices_screen.dart';
import 'package:trino_mobile/ui/list_row.dart';

import '../support/app_harness.dart';

const unlinkBody =
    'Este celular vuelve al inicio y deja de recibir tus mensajes. Se borran de aquí tus chats y tus contactos; en '
    'tu computador siguen. Para volver a usarlo, vincúlalo otra vez con el código QR de tu computador.';
const noteSelf =
    'Cada aparato puede desvincularse solo. Tu computador, que guarda la llave de la cuenta, puede quitar a cualquiera.';
const noteLost =
    'Si pierdes este celular, desvincúlalo desde tu computador. Quien lo tenga deja de recibir tus mensajes nuevos, '
    'pero los que ya estaban en el celular siguen ahí.';

Future<TestApp> openDevices(WidgetTester tester, {FakeTrinoEngine? engine}) async {
  final app = await pumpApp(tester, engine: engine);
  await openTab(tester, 'Ajustes');
  await tester.tap(find.text('Dispositivos'));
  await tester.pumpAndSettle();
  return app;
}

List<(String, String?)> rowsOf(WidgetTester tester) =>
    tester.widgetList<ListRow>(find.byType(ListRow)).map((row) => (row.title, row.subtitle)).toList();

void main() {
  testWidgets('this phone first, then the computer, in words; "Desvincular" only on this phone', (tester) async {
    await openDevices(tester);
    expect(rowsOf(tester), [
      ('Este celular', 'Pixel 8 · vinculado hoy'),
      ('Computador de la casa', 'Windows · activo hace 5 min'),
    ]);
    expect(find.text('Desvincular'), findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const ValueKey('device-this')), matching: find.text('Desvincular')),
      findsOneWidget,
    );
    expect(colorOfText(tester, 'Desvincular'), tokensIn(tester).danger);
    expect(find.text(noteSelf), findsOneWidget);
    expect(find.text(noteLost), findsOneWidget);
    expect(find.textContaining('Vincular'), findsNothing, reason: 'linking only happens at the first run');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('unlinking asks first, says what happens, and takes this phone back to the start', (tester) async {
    final app = await openDevices(tester);
    await tester.tap(find.text('Desvincular'));
    await tester.pumpAndSettle();
    expect(find.text('¿Desvincular este celular?'), findsOneWidget);
    expect(find.text(unlinkBody), findsOneWidget);
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(find.text('Este celular'), findsOneWidget);
    expect(await tester.runAsync(() => app.engine.identityState.first), IdentityState.unlocked);

    await tester.tap(find.text('Desvincular'));
    await tester.pumpAndSettle();
    await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('Desvincular')));
    await tester.pumpAndSettle();
    expect(await tester.runAsync(() => app.engine.identityState.first), IdentityState.needsOnboarding);
    expect(find.byType(OnboardingScreen), findsOneWidget);
  });

  testWidgets('a phone that created the account holds its key: no unlink, and it says why', (tester) async {
    final engine = testEngine(onboarded: false);
    await engine.createIdentity(name: 'Sofía', passphrase: FakeTrinoEngine.demoPassphrase, withTotp: false);
    await openDevices(tester, engine: engine);
    expect(rowsOf(tester), [('Este celular', 'Pixel 8 · guarda la llave de la cuenta')]);
    expect(find.text('Desvincular'), findsNothing);
    expect(
      find.text('Este celular creó tu cuenta y guarda su llave, por eso no se puede desvincular.'),
      findsOneWidget,
    );
    expect(find.text(noteSelf), findsNothing, reason: 'there is no computer to remove anyone');
    expect(find.text(noteLost), findsNothing);
  });

  testWidgets('when it was linked and last seen, in words, past today too', (tester) async {
    await pumpApp(tester);
    final context = tester.element(find.byType(Scaffold).first);
    expect(linkedLabel(context, testNow.subtract(const Duration(days: 1)), testNow), 'vinculado ayer');
    expect(linkedLabel(context, DateTime(2026, 9, 2), testNow), 'vinculado el 2 sept');
    expect(lastSeenLabel(context, testNow.subtract(const Duration(seconds: 20)), testNow), 'activo ahora');
    expect(lastSeenLabel(context, testNow.subtract(const Duration(hours: 2)), testNow), 'activo hace 2 h');
    expect(lastSeenLabel(context, testNow.subtract(const Duration(days: 1)), testNow), 'activo ayer');
    expect(lastSeenLabel(context, DateTime(2026, 8, 30), testNow), 'activo el 30 ago');
  });
}
