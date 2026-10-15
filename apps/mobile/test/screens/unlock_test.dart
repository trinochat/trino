import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/platform/biometrics.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/app_harness.dart';

Finder fieldLabeled(String label) =>
    find.descendant(of: find.widgetWithText(TrinoTextField, label), matching: find.byType(TextField));

/// Whether the field labelled [label] has the keyboard focus.
bool focused(WidgetTester tester, String label) => tester
    .widget<EditableText>(find.descendant(of: fieldLabeled(label), matching: find.byType(EditableText)))
    .focusNode
    .hasFocus;

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

/// An engine with biometric unlock on, locked by hand just now: the
/// fingerprint can open it. With [reinforced], reinforced protection too.
Future<FakeTrinoEngine> biometricEngine(WidgetTester tester, {bool reinforced = false}) async {
  final engine = testEngine();
  await tester.runAsync(() async {
    await engine.updateSettings(EngineSettings(biometricUnlock: true, reinforcedProtection: reinforced));
    await engine.lock();
  });
  return engine;
}

/// A phone with a fingerprint that answers [confirms], and remembers why it
/// was asked.
class FakeBiometrics implements BiometricAuth {
  FakeBiometrics({this.confirms = true});

  final bool confirms;
  final reasons = <String>[];

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<bool> authenticate(String reason) async {
    reasons.add(reason);
    return confirms;
  }
}

const biometricAction = 'Desbloquear con huella o Face ID';

void main() {
  testWidgets('greets without a name or a photo, says why it is locked, and offers no fingerprint after a restart', (
    tester,
  ) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    expect(find.text('Trino'), findsOneWidget);
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.textContaining('Sofía'), findsNothing);
    expect(find.byType(TrinoAvatar), findsNothing);
    expect(find.text('Escribe tu contraseña para abrir tus chats.'), findsOneWidget);
    expect(fieldLabeled('Contraseña'), findsOneWidget);
    expect(fieldLabeled('Código de tu app autenticadora'), findsNothing);
    expect(find.text(biometricAction), findsNothing);
    expect(find.text('Borrar todo y empezar de nuevo…'), findsOneWidget);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('says the passphrase is asked again when the biometric interval passed, without the fingerprint', (
    tester,
  ) async {
    var time = testNow;
    final engine = FakeTrinoEngine(clock: () => time);
    await tester.runAsync(() async {
      await engine.updateSettings(const EngineSettings(biometricUnlock: true));
      await engine.lock();
    });
    time = testNow.add(const Duration(days: 3));
    await pumpApp(tester, engine: engine, biometrics: FakeBiometrics());
    expect(find.text('Hola de nuevo'), findsOneWidget);
    expect(find.text('Por tu seguridad, Trino te pide la contraseña cada cierto tiempo.'), findsOneWidget);
    expect(find.text(biometricAction), findsNothing);
  });

  testWidgets('after an idle lock it says after how long', (tester) async {
    final engine = testEngine()..lockForIdle(5);
    await pumpApp(tester, engine: engine);
    expect(find.text('Trino se bloqueó porque no lo usaste en 5 minutos.'), findsOneWidget);
  });

  testWidgets('a wrong password says so under the field and keeps the focus there; the right one opens the chats', (
    tester,
  ) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    await tester.enterText(fieldLabeled('Contraseña'), 'otra cosa');
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('La contraseña no es correcta.'), findsOneWidget);
    expect(
      find.descendant(of: find.byType(TrinoTextField), matching: find.text('La contraseña no es correcta.')),
      findsOneWidget,
    );
    expect(focused(tester, 'Contraseña'), isTrue);

    await tester.enterText(fieldLabeled('Contraseña'), FakeTrinoEngine.demoPassphrase);
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('with 2FA it asks for the code as well, and the error goes where the problem is', (tester) async {
    await pumpLocked(tester, withTotp: true);
    expect(find.text('Bloqueaste Trino.'), findsOneWidget);
    expect(fieldLabeled('Código de tu app autenticadora'), findsOneWidget);
    expect(find.text('El código cambia cada 30 segundos.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.text('Escribe también el código de tu app autenticadora.'), findsOneWidget);
    expect(focused(tester, 'Código de tu app autenticadora'), isTrue);

    await tester.enterText(fieldLabeled('Código de tu app autenticadora'), '000000');
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(
      find.text('La contraseña o el código no son correctos. Revisa los dos e inténtalo de nuevo.'),
      findsOneWidget,
    );
    expect(focused(tester, 'Contraseña'), isTrue);

    await tester.enterText(fieldLabeled('Código de tu app autenticadora'), FakeTrinoEngine.demoTotpCode);
    await tester.tap(find.text('Desbloquear'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
  });

  testWidgets('the fingerprint, when allowed: the phone checks, then Trino opens', (tester) async {
    final biometrics = FakeBiometrics();
    await pumpApp(tester, engine: await biometricEngine(tester), biometrics: biometrics);
    expect(find.text('Bloqueaste Trino.'), findsOneWidget);
    await tester.tap(find.text(biometricAction));
    await tester.pumpAndSettle();
    expect(biometrics.reasons, ['Abrir Trino']);
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
  });

  testWidgets('a fingerprint the phone does not confirm says so, and Trino stays locked', (tester) async {
    await pumpApp(tester, engine: await biometricEngine(tester), biometrics: FakeBiometrics(confirms: false));
    await tester.tap(find.text(biometricAction));
    await tester.pumpAndSettle();
    expect(find.text('No se pudo comprobar que eres tú. Escribe tu contraseña.'), findsOneWidget);
    expect(find.text('Hola de nuevo'), findsOneWidget);
  });

  testWidgets('no fingerprint without one on the phone, or with reinforced protection', (tester) async {
    await pumpApp(tester, engine: await biometricEngine(tester), biometrics: const DemoBiometricAuth(available: false));
    expect(find.text(biometricAction), findsNothing);

    await pumpApp(tester, engine: await biometricEngine(tester, reinforced: true), biometrics: FakeBiometrics());
    expect(find.text(biometricAction), findsNothing);
  });

  testWidgets('"Borrar todo y empezar de nuevo…" says honestly what is lost, and wipes only after confirming', (
    tester,
  ) async {
    await pumpApp(tester, engine: testEngine(locked: true));
    await tester.tap(find.text('Borrar todo y empezar de nuevo…'));
    await tester.pumpAndSettle();
    expect(find.text('¿Borrar todo y empezar de nuevo?'), findsOneWidget);
    expect(
      find.text(
        'Trino no puede recuperar tu contraseña: nadie más tiene una copia. Si borras, se van de este celular tu '
        'cuenta, tus chats y tus contactos, y no se puede deshacer.',
      ),
      findsOneWidget,
    );
    expect(
      find.text(
        'Si este celular está vinculado a tu computador, allí siguen tus chats y tus contactos. Si no, tendrás que '
        'crear una cuenta nueva y agregar otra vez a cada persona.',
      ),
      findsOneWidget,
    );
    await tester.tap(find.text('Cancelar'));
    await tester.pumpAndSettle();
    expect(find.text('Hola de nuevo'), findsOneWidget);

    await tester.tap(find.text('Borrar todo y empezar de nuevo…'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Borrar todo'));
    await tester.pumpAndSettle();
    expect(find.text('Mensajes privados, sin número de teléfono'), findsOneWidget);
  });
}
