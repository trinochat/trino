import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/app_harness.dart';

Finder fieldLabeled(String label) =>
    find.descendant(of: find.widgetWithText(TrinoTextField, label), matching: find.byType(TextField));

Future<TestApp> pumpLocked(WidgetTester tester, {bool withTotp = false}) async {
  final engine = testEngine(onboarded: false);
  final app = await pumpApp(tester, engine: engine);
  // Create an identity as the first run would, then lock it.
  await tester.runAsync(() async {
    if (withTotp) {
      await engine.beginTotp();
      await engine.verifyTotp(FakeTrinoEngine.demoTotpCode);
    }
    await engine.createIdentity(name: 'Sofía', passphrase: 'una frase larga y mía', withTotp: withTotp);
    await engine.lock();
  });
  await tester.pumpAndSettle();
  return app;
}

void main() {
  testWidgets('says the passphrase is asked again when the biometric interval passed', (tester) async {
    var time = testNow;
    final engine = FakeTrinoEngine(clock: () => time);
    await tester.runAsync(() async {
      await engine.updateSettings(const EngineSettings(biometricUnlock: true));
      await engine.lock();
    });
    time = testNow.add(const Duration(days: 3));
    await pumpApp(tester, engine: engine);
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.text('Por tu seguridad, Trino te pide la contraseña cada cierto tiempo.'), findsOneWidget);
  });

  testWidgets('greets without a name or a photo, and says why it is locked', (tester) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.textContaining('Sofía'), findsNothing);
    expect(find.byType(TrinoAvatar), findsNothing);
    expect(find.text('Escribe tu contraseña para abrir tus chats.'), findsOneWidget);
    expect(fieldLabeled('Contraseña'), findsOneWidget);
    expect(fieldLabeled('Código de tu app autenticadora'), findsNothing);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('a wrong password says so; the right one opens the chats', (tester) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    await tester.enterText(fieldLabeled('Contraseña'), 'otra cosa');
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('La contraseña no es correcta. Inténtalo de nuevo.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), FakeTrinoEngine.demoPassphrase);
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('with 2FA it asks for the code as well', (tester) async {
    await pumpLocked(tester, withTotp: true);
    expect(find.text('Bloqueaste Trino.'), findsOneWidget);
    expect(fieldLabeled('Código de tu app autenticadora'), findsOneWidget);
    expect(find.text('El código cambia cada 30 segundos.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('Escribe también el código de tu app autenticadora.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Código de tu app autenticadora'), '000000');
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(
      find.text('La contraseña o el código no son correctos. Revisa los dos e inténtalo de nuevo.'),
      findsOneWidget,
    );

    await tester.enterText(fieldLabeled('Código de tu app autenticadora'), FakeTrinoEngine.demoTotpCode);
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
  });

  testWidgets('a forgotten password: the honest explanation, and wiping after a confirmation', (tester) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    final forgot = find.text('¿Olvidaste la contraseña?');
    expect(tester.getSemantics(forgot), isSemantics(isExpanded: false));
    await tester.tap(forgot);
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Trino no puede recuperarla: nadie más tiene una copia. Si no la recuerdas, la única salida es borrar esta identidad y crear una nueva.',
      ),
      findsOneWidget,
    );

    await tester.tap(find.text('Borrar identidad y empezar de cero'));
    await tester.pumpAndSettle();
    expect(find.text('¿Borrar esta identidad?'), findsOneWidget);
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(find.text('Hola de nuevo'), findsOneWidget);

    await tester.tap(find.text('Borrar identidad y empezar de cero'));
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(of: find.byType(Dialog), matching: find.text('Borrar identidad y empezar de cero')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Mensajes privados, sin número de teléfono'), findsOneWidget);
  });
}
