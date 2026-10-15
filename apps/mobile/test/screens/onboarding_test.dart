import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/add_contact_screen.dart';
import 'package:trino_mobile/screens/connection/bridges_screen.dart';
import 'package:trino_mobile/screens/onboarding_screen.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/app_harness.dart';

Future<void> next(WidgetTester tester, [String label = 'Continuar']) async {
  await tester.ensureVisible(find.text(label).last);
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Finder fieldLabeled(String label) =>
    find.descendant(of: find.widgetWithText(TrinoTextField, label), matching: find.byType(TextField));

/// From the welcome, through "Trino se conecta de forma privada", to the name.
Future<void> startCreating(WidgetTester tester) async {
  await next(tester, 'Crear una cuenta');
  await next(tester);
}

Future<void> throughName(WidgetTester tester) async {
  await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
  await next(tester);
}

Future<void> throughPassword(WidgetTester tester) async {
  await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
  await tester.enterText(fieldLabeled('Repítela'), 'una frase larga y mía');
  await next(tester);
}

void main() {
  testWidgets('the welcome: the wordmark, no phone number, two ways in and the language in words', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    expect(find.text('Trino'), findsOneWidget);
    expect(find.text('Mensajes privados, sin número de teléfono'), findsOneWidget);
    expect(
      find.text('Tus mensajes van cifrados de punta a punta. Para crear tu cuenta no necesitas número ni correo.'),
      findsOneWidget,
    );
    expect(find.text('Crear una cuenta'), findsOneWidget);
    expect(find.text('Ya uso Trino en mi computador'), findsOneWidget);
    expect(find.text('Español'), findsOneWidget);
    expect(find.textContaining('Paso'), findsNothing);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('the language opens a short list and applies at once', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await tester.tap(find.text('Español'));
    await tester.pumpAndSettle();
    expect(find.text('Idioma'), findsOneWidget);
    expect(tester.getSemantics(find.text('Español').last), isSemantics(isChecked: true));
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(find.text('Private messages, no phone number'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    expect(find.text('Create an account'), findsOneWidget);
  });

  testWidgets('creating an account: private connection, name, password, style, 2FA "Ahora no", then the chats', (
    tester,
  ) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await next(tester, 'Crear una cuenta');

    expect(find.text('Trino se conecta de forma privada'), findsOneWidget);
    expect(
      find.text(
        'Usa Tor: tus mensajes dan varias vueltas por internet antes de llegar, para que los servidores no vean '
        'desde dónde te conectas. La primera vez puede tardar un poco.',
      ),
      findsOneWidget,
    );
    expect(find.text('En mi red bloquean Tor'), findsOneWidget);
    await next(tester);

    expect(find.text('¿Cómo quieres que te vean?'), findsOneWidget);
    await throughName(tester);

    expect(find.text('Crea una contraseña'), findsOneWidget);
    expect(fieldLabeled('Repítela'), findsOneWidget);
    expect(
      find.text('Si la olvidas, nadie la puede recuperar, ni siquiera nosotros. Guárdala en un lugar seguro.'),
      findsOneWidget,
    );
    await throughPassword(tester);

    expect(find.text('Elige cómo se ve Trino'), findsOneWidget);
    await next(tester);

    expect(find.text('Verificación en dos pasos (opcional)'), findsOneWidget);
    await next(tester, 'Ahora no');

    expect(find.text('Todo listo'), findsOneWidget);
    expect(find.textContaining('trino2:'), findsOneWidget);
    await next(tester, 'Ir a mis chats');
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('"En mi red bloquean Tor" opens Otra forma de conectarse, and back returns to the step', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await next(tester, 'Crear una cuenta');
    await next(tester, 'En mi red bloquean Tor');
    expect(find.byType(BridgesScreen), findsOneWidget);
    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    expect(find.text('Trino se conecta de forma privada'), findsOneWidget);
  });

  testWidgets('back goes one step at a time, to the welcome', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await startCreating(tester);
    await next(tester, 'Atrás');
    expect(find.text('Trino se conecta de forma privada'), findsOneWidget);
    await next(tester, 'Atrás');
    expect(find.text('Mensajes privados, sin número de teléfono'), findsOneWidget);
  });

  testWidgets('asks for a name, and checks the password', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await startCreating(tester);
    await next(tester);
    expect(find.text('Escribe un nombre.'), findsOneWidget);

    await throughName(tester);
    await tester.enterText(fieldLabeled('Contraseña'), 'corta');
    await tester.pumpAndSettle();
    expect(find.text('Fortaleza: débil'), findsOneWidget);
    await next(tester);
    expect(find.text('Usa al menos 10 caracteres.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'contraseña123');
    await next(tester);
    expect(find.text('Esa contraseña es muy común. Elige otra.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
    await tester.enterText(fieldLabeled('Repítela'), 'una frase larga y tuya');
    await next(tester);
    expect(find.text('Las contraseñas no coinciden.'), findsOneWidget);
    expect(find.text('Elige cómo se ve Trino'), findsNothing);
  });

  testWidgets('choosing a style applies it at once', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await startCreating(tester);
    await throughName(tester);
    await throughPassword(tester);

    expect(tester.getSemantics(find.text('Calma')), isSemantics(isChecked: true));
    await tester.tap(find.text('Terminal'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).style, TrinoStyle.terminal);
    expect(tester.getSemantics(find.text('Terminal')), isSemantics(isChecked: true));
  });

  testWidgets('2FA: a wrong code is refused and the right one turns it on', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await startCreating(tester);
    await throughName(tester);
    await throughPassword(tester);
    await next(tester);
    await next(tester, 'Activar');
    expect(
      find.text('Agrega esta clave en tu app autenticadora y escribe el código de 6 dígitos para comprobarla.'),
      findsOneWidget,
    );
    expect(find.text('JBSW Y3DP EHPK 3PXP'), findsOneWidget);

    await tester.enterText(fieldLabeled('Código de 6 dígitos'), '000000');
    await next(tester, 'Comprobar');
    expect(find.text('El código no es correcto. Prueba con el que muestra ahora tu app.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Código de 6 dígitos'), FakeTrinoEngine.demoTotpCode);
    await next(tester, 'Comprobar');
    expect(find.text('Todo listo'), findsOneWidget);
    final info = await tester.runAsync(app.engine.unlockInfo);
    expect(info!.totpEnabled, isTrue);
  });

  testWidgets('"Agregar un contacto" ends the first run at the add contact screen', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await startCreating(tester);
    await throughName(tester);
    await throughPassword(tester);
    await next(tester);
    await next(tester, 'Ahora no');
    await next(tester, 'Agregar un contacto');
    expect(find.byType(OnboardingScreen), findsNothing);
    expect(find.byType(AddContactScreen), findsOneWidget);
  });

  testWidgets('every step meets the 48 dp target and labeling guidelines', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await next(tester, 'Crear una cuenta');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await next(tester);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await throughName(tester);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });
}
