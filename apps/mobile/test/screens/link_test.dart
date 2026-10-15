// "Ya uso Trino en mi computador": linking this phone from the first run.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/switch_row.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/app_harness.dart';

Future<void> tapText(WidgetTester tester, String label) async {
  await tester.ensureVisible(find.text(label).last);
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Finder fieldLabeled(String label) =>
    find.descendant(of: find.widgetWithText(TrinoTextField, label), matching: find.byType(TextField));

/// From the welcome to the scanner.
Future<void> toScanner(WidgetTester tester) async {
  await tapText(tester, 'Ya uso Trino en mi computador');
  await tapText(tester, 'Escanear el código');
}

/// From the welcome to the code, waiting for the computer.
Future<void> toConfirm(WidgetTester tester) async {
  await toScanner(tester);
  await tapText(tester, 'Simular escaneo (demostración)');
}

const waiting = 'Esperando la confirmación en el computador…';

void main() {
  testWidgets('the instructions: the two devices, three steps, the note and one action', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await tapText(tester, 'Ya uso Trino en mi computador');
    expect(find.text('Vincular con tu computador'), findsOneWidget);
    expect(find.text('En el computador, abre Trino.'), findsOneWidget);
    expect(find.textContaining('Ajustes › Dispositivos › Vincular un celular', findRichText: true), findsOneWidget);
    expect(find.text('Escanea con este celular el código QR que aparece.'), findsOneWidget);
    expect(
      find.text(
        'Tus contactos y tus chats siguen viviendo en tu computador; este celular se vuelve otro dispositivo tuyo.',
      ),
      findsOneWidget,
    );
    expect(find.text('Escanear el código'), findsOneWidget);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));

    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    expect(find.text('Mensajes privados, sin número de teléfono'), findsOneWidget);
  });

  testWidgets('the scanner: where to point, the warning about codes sent by chat, and an honest demo', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await toScanner(tester);
    expect(find.text('Escanea el código'), findsOneWidget);
    expect(find.text('Apunta al código QR que muestra tu computador.'), findsOneWidget);
    expect(
      find.text(
        'Solo escanea un código de tu propio computador. Si alguien te manda uno por chat o por correo, no lo uses.',
      ),
      findsOneWidget,
    );
    expect(find.text('Esta versión de demostración no usa la cámara.'), findsOneWidget);
    expect(find.text('Simular escaneo (demostración)'), findsOneWidget);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));

    await tester.tap(find.bySemanticsLabel('Cerrar'));
    await tester.pumpAndSettle();
    expect(find.text('Vincular con tu computador'), findsOneWidget);
  });

  testWidgets('a code that is not for linking says so, and the scanner stays open', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await toScanner(tester);
    app.scanner.simulate('https://example.com/premio');
    await tester.pumpAndSettle();
    const invalid = 'Ese código no sirve para vincular. Escanea el que muestra Trino en tu computador.';
    expect(find.text(invalid), findsOneWidget);
    expect(tester.getSemantics(find.text(invalid)), isSemantics(isLiveRegion: true));
    expect(find.text('Escanea el código'), findsOneWidget);
  });

  testWidgets('the code: the same six digits, the switch to bring the chats, and waiting in words', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    expect(find.text('¿Tu computador muestra este código?'), findsOneWidget);
    expect(find.text(FakeTrinoEngine.demoLinkCode), findsOneWidget);
    expect(
      find.text('Confirma en el computador. Si el código no coincide, cancela: alguien más pudo ver tu QR.'),
      findsOneWidget,
    );
    expect(find.text('Traer los chats que ya tienes'), findsOneWidget);
    expect(find.text('Viajan cifrados de tu computador a este celular. Puede tardar unos minutos.'), findsOneWidget);
    final bring = find.byType(SwitchRow);
    expect(tester.getSemantics(bring), isSemantics(isToggled: true, isEnabled: true));
    expect(find.text(waiting), findsOneWidget);
    expect(tester.getSemantics(find.text(waiting)), isSemantics(isLiveRegion: true));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));

    await tester.tap(bring);
    await tester.pumpAndSettle();
    final session = await tester.runAsync(() => app.engine.linking.first);
    expect(session!.bringChats, isFalse);
    expect(tester.getSemantics(bring), isSemantics(isToggled: false, isEnabled: true));
  });

  testWidgets('the phone never confirms by itself: it waits for the computer', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    await tester.pump(const Duration(minutes: 1));
    await tester.pumpAndSettle();
    expect(find.text(waiting), findsOneWidget);
    expect(find.text('Listo, este celular quedó vinculado'), findsNothing);
  });

  testWidgets('cancelling says so and offers to start again', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    await tapText(tester, 'Cancelar');
    expect(find.text('Cancelaste la vinculación.'), findsOneWidget);
    expect(find.text(waiting), findsNothing);
    await tapText(tester, 'Empezar de nuevo');
    expect(find.text('Vincular con tu computador'), findsOneWidget);
    expect(find.text('Escanear el código'), findsOneWidget);
  });

  for (final (failure, words) in [
    (
      LinkFailure.expired,
      'El código QR venció: dura 2 minutos y sirve una sola vez. Muestra uno nuevo en el computador.',
    ),
    (LinkFailure.rejected, 'En el computador se rechazó la vinculación.'),
  ]) {
    testWidgets('a ${failure.name} link says why in words, and the switch no longer changes', (tester) async {
      final app = await pumpApp(tester, engine: testEngine(onboarded: false));
      await toConfirm(tester);
      app.engine.failLink(failure);
      await tester.pumpAndSettle();
      expect(find.text(words), findsOneWidget);
      expect(tester.getSemantics(find.text(words)), isSemantics(isLiveRegion: true));
      expect(tester.getSemantics(find.byType(SwitchRow)), isSemantics(isEnabled: false));
      expect(find.text('Empezar de nuevo'), findsOneWidget);
    });
  }

  testWidgets('confirmed on the computer: linked, the chats arriving, then this phone\'s password and the chats', (
    tester,
  ) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    app.engine.confirmLinkOnComputer();
    await tester.pumpAndSettle();
    expect(find.text('Listo, este celular quedó vinculado'), findsOneWidget);
    expect(
      find.text(
        'Tus contactos ya ven este celular como otro dispositivo tuyo. Tus demás dispositivos muestran un aviso de '
        '«nuevo dispositivo vinculado».',
      ),
      findsOneWidget,
    );
    app.engine.setLinkProgress(35);
    await tester.pumpAndSettle();
    expect(find.text('Trayendo tus chats… 35 %'), findsOneWidget);
    expect(tester.getSemantics(find.text('Trayendo tus chats… 35 %')), isSemantics(isLiveRegion: true));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await tapText(tester, 'Continuar');

    expect(find.text('Crea una contraseña para este celular'), findsOneWidget);
    expect(
      find.text('Si la olvidas, nadie la puede recuperar, ni siquiera nosotros. Guárdala en un lugar seguro.'),
      findsOneWidget,
    );
    expect(fieldLabeled('Nombre'), findsNothing);
    await tester.enterText(fieldLabeled('Contraseña'), 'otra frase larga y mía');
    await tester.enterText(fieldLabeled('Repítela'), 'otra frase larga y mía');
    await tapText(tester, 'Continuar');
    expect(find.text('Elige cómo se ve Trino'), findsOneWidget);
    await tapText(tester, 'Continuar');
    expect(find.text('Verificación en dos pasos (opcional)'), findsOneWidget);
    await tapText(tester, 'Ahora no');

    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
    expect(find.text('Ana Torres'), findsOneWidget);
    final devices = await tester.runAsync(() => app.engine.devices.first);
    expect(devices!.first.isThisDevice, isTrue);
    expect(devices.first.isPrimary, isFalse);
  });

  testWidgets('without bringing the chats there is no progress line', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    await tester.tap(find.byType(SwitchRow));
    await tester.pumpAndSettle();
    app.engine.confirmLinkOnComputer();
    await tester.pumpAndSettle();
    expect(find.text('Listo, este celular quedó vinculado'), findsOneWidget);
    expect(find.textContaining('Trayendo tus chats'), findsNothing);
  });

  testWidgets("this phone's 2FA: the right code finishes the link with it", (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await toConfirm(tester);
    app.engine.confirmLinkOnComputer();
    await tester.pumpAndSettle();
    await tapText(tester, 'Continuar');
    await tester.enterText(fieldLabeled('Contraseña'), 'otra frase larga y mía');
    await tester.enterText(fieldLabeled('Repítela'), 'otra frase larga y mía');
    await tapText(tester, 'Continuar');
    await tapText(tester, 'Continuar');
    await tapText(tester, 'Activar');
    await tester.enterText(fieldLabeled('Código de 6 dígitos'), FakeTrinoEngine.demoTotpCode);
    await tapText(tester, 'Comprobar');
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
    final info = await tester.runAsync(app.engine.unlockInfo);
    expect(info!.totpEnabled, isTrue);
  });
}
