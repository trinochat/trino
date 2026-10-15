import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/platform/biometrics.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/switch_row.dart';

import '../support/app_harness.dart';

const biometricTitle = 'Desbloquear con huella o Face ID';
const reaskTitle = 'Pedir la contraseña y el código';
const reaskTitleNoCode = 'Pedir la contraseña';
const reinforcedTitle = 'Protección reforzada';

/// A phone whose biometrics can be told what to answer, and that remembers
/// what it was asked.
class ScriptedBiometrics implements BiometricAuth {
  ScriptedBiometrics({this.available = true, this.confirms = true});

  final bool available;
  final bool confirms;
  final asked = <String>[];

  @override
  Future<bool> isAvailable() async => available;

  @override
  Future<bool> authenticate(String reason) async {
    asked.add(reason);
    return confirms;
  }
}

Future<TestApp> openAccountSecurity(WidgetTester tester, {FakeTrinoEngine? engine, BiometricAuth? biometrics}) async {
  final app = await pumpApp(tester, engine: engine, biometrics: biometrics);
  await openTab(tester, 'Ajustes');
  await tester.tap(find.text('Cuenta y seguridad'));
  await tester.pumpAndSettle();
  return app;
}

/// The demo identity with two-step verification on.
Future<FakeTrinoEngine> engineWithTwoStep() async {
  final engine = testEngine(onboarded: false);
  await engine.beginTotp();
  await engine.verifyTotp(FakeTrinoEngine.demoTotpCode);
  await engine.createIdentity(name: 'Sofía', passphrase: FakeTrinoEngine.demoPassphrase, withTotp: true);
  return engine;
}

ListRow rowOf(WidgetTester tester, String title) =>
    tester.widget<ListRow>(find.ancestor(of: find.text(title), matching: find.byType(ListRow)));

Finder switchOf(String title) => find.ancestor(of: find.text(title), matching: find.byType(SwitchRow));

Future<EngineSettings> settingsOf(WidgetTester tester, TestApp app) async =>
    (await tester.runAsync(() => app.engine.settings.first))!;

void main() {
  testWidgets('auto-lock "Al dejar de usar Trino" with its choices, 2FA in words, and "Bloquear ahora" locks', (
    tester,
  ) async {
    await openAccountSecurity(tester);
    expect(find.text('Seguridad'), findsNothing);
    final autoLock = rowOf(tester, 'Bloqueo automático');
    expect((autoLock.subtitle, autoLock.value), ('Al dejar de usar Trino', 'Tras 5 minutos'));
    expect(rowOf(tester, 'Verificación en dos pasos').value, 'Desactivada');

    await tester.tap(find.text('Bloqueo automático'));
    await tester.pumpAndSettle();
    expect(find.text('Nunca se bloquea durante una llamada.'), findsOneWidget);
    await tester.tap(find.text('Tras 15 minutos'));
    await tester.pumpAndSettle();
    expect(rowOf(tester, 'Bloqueo automático').value, 'Tras 15 minutos');

    final lockNow = find.ancestor(of: find.text('Bloquear ahora'), matching: find.byType(TrinoButton));
    expect(tester.widget<TrinoButton>(lockNow).variant, ButtonVariant.secondary);
    await tester.tap(lockNow);
    await tester.pumpAndSettle();
    expect(find.text('Hola de nuevo'), findsOneWidget);
  });

  testWidgets('the fingerprint is optional and off by default, and while off there is no interval to choose', (
    tester,
  ) async {
    await openAccountSecurity(tester, biometrics: ScriptedBiometrics());
    expect(tester.getSemantics(switchOf(biometricTitle)), isSemantics(isToggled: false, isEnabled: true));
    expect(find.text('Opcional. Trino igual te pide la contraseña de vez en cuando.'), findsOneWidget);
    expect(find.text(reaskTitleNoCode), findsNothing);
    expect(find.text(reaskTitle), findsNothing);
    expect(tester.getSemantics(switchOf(reinforcedTitle)), isSemantics(isToggled: false));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('turning it on asks the phone first; then the interval: every 3 days by default, of three choices', (
    tester,
  ) async {
    final phone = ScriptedBiometrics();
    final app = await openAccountSecurity(tester, engine: await engineWithTwoStep(), biometrics: phone);
    await tester.tap(switchOf(biometricTitle));
    await tester.pumpAndSettle();
    expect(phone.asked, hasLength(1));
    expect(tester.getSemantics(switchOf(biometricTitle)), isSemantics(isToggled: true));
    expect((await settingsOf(tester, app)).biometricUnlock, isTrue);

    final reask = rowOf(tester, reaskTitle);
    expect((reask.subtitle, reask.value), ('Y siempre que reinicies el celular', 'Cada 3 días'));

    await tester.tap(find.text(reaskTitle));
    await tester.pumpAndSettle();
    final sheet = find.byType(BottomSheet);
    final choices = tester
        .widgetList<ChoiceRow>(find.descendant(of: sheet, matching: find.byType(ChoiceRow)))
        .map((choice) => (choice.title, choice.subtitle, choice.selected))
        .toList();
    expect(choices, [
      ('Cada día', null, false),
      ('Cada 3 días', 'Recomendado', true),
      ('Cada semana', 'Lo máximo', false),
    ]);
    expect(
      find.descendant(
        of: sheet,
        matching: find.text(
          'Siempre se piden al reiniciar el celular. No hay opción de «nunca»: si pasa mucho tiempo podrías olvidar la '
          'contraseña, y sin ella no hay forma de recuperar tu cuenta.',
        ),
      ),
      findsOneWidget,
    );
    expect(find.descendant(of: sheet, matching: find.text('Nunca')), findsNothing);

    await tester.tap(find.text('Cada semana'));
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(rowOf(tester, reaskTitle).value, 'Cada semana');
    expect((await settingsOf(tester, app)).reaskInterval, ReaskInterval.week);
  });

  testWidgets('without two-step verification it asks only for the password', (tester) async {
    await openAccountSecurity(tester, biometrics: ScriptedBiometrics());
    await tester.tap(switchOf(biometricTitle));
    await tester.pumpAndSettle();
    expect(find.text(reaskTitle), findsNothing);
    await tester.tap(find.text(reaskTitleNoCode));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Siempre se pide al reiniciar el celular. No hay opción de «nunca»: si pasa mucho tiempo podrías olvidar la '
        'contraseña, y sin ella no hay forma de recuperar tu cuenta.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('when the phone does not confirm, the switch stays off and says why', (tester) async {
    final app = await openAccountSecurity(tester, biometrics: ScriptedBiometrics(confirms: false));
    await tester.tap(switchOf(biometricTitle));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(switchOf(biometricTitle)), isSemantics(isToggled: false));
    expect(find.text('El celular no confirmó tu huella ni tu cara, así que sigue apagado.'), findsOneWidget);
    expect((await settingsOf(tester, app)).biometricUnlock, isFalse);
  });

  testWidgets('a phone without fingerprint or Face ID says so, and the switch cannot turn on', (tester) async {
    final phone = ScriptedBiometrics(available: false);
    await openAccountSecurity(tester, biometrics: phone);
    expect(find.text('Este celular no tiene huella ni Face ID configurados.'), findsOneWidget);
    expect(tester.getSemantics(switchOf(biometricTitle)), isSemantics(isToggled: false, isEnabled: false));
    await tester.tap(switchOf(biometricTitle), warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(phone.asked, isEmpty);
  });

  testWidgets('with Protección reforzada the fingerprint and the interval are not offered, and say why', (
    tester,
  ) async {
    final app = await openAccountSecurity(tester, biometrics: ScriptedBiometrics());
    await tester.tap(switchOf(biometricTitle));
    await tester.pumpAndSettle();
    expect(find.text('Trino siempre pide la contraseña y no ofrece la huella ni Face ID.'), findsOneWidget);

    await tester.tap(switchOf(reinforcedTitle));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(switchOf(reinforcedTitle)), isSemantics(isToggled: true));
    expect(find.text(biometricTitle), findsNothing);
    expect(find.text(reaskTitleNoCode), findsNothing);
    expect(
      find.text('Con Protección reforzada, Trino siempre te pide la contraseña. La huella y Face ID no se ofrecen.'),
      findsOneWidget,
    );
    final settings = await settingsOf(tester, app);
    expect((settings.reinforcedProtection, settings.biometricUnlock), (true, false));

    await tester.tap(switchOf(reinforcedTitle));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(switchOf(biometricTitle)), isSemantics(isToggled: false));
  });

  test('the demo biometrics are there and confirm, unless told otherwise', () async {
    const demo = DemoBiometricAuth();
    expect((await demo.isAvailable(), await demo.authenticate('x')), (true, true));
    const none = DemoBiometricAuth(available: false);
    expect((await none.isAvailable(), await none.authenticate('x')), (false, false));
  });
}
