import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/add_contact_screen.dart';
import 'package:trino_mobile/screens/onboarding_screen.dart';
import 'package:trino_mobile/ui/text_field.dart';

import '../support/app_harness.dart';

Future<void> next(WidgetTester tester, [String label = 'Continuar']) async {
  await tester.tap(find.text(label));
  await tester.pumpAndSettle();
}

Finder fieldLabeled(String label) =>
    find.descendant(of: find.widgetWithText(TrinoTextField, label), matching: find.byType(TextField));

Future<void> throughPassword(WidgetTester tester) async {
  await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
  await tester.enterText(fieldLabeled('Repite la contraseña'), 'una frase larga y mía');
  await next(tester);
}

void main() {
  testWidgets('the first run: language, name, password, style, 2FA "Ahora no", "Todo listo", then the chats', (
    tester,
  ) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    expect(find.text('Te damos la bienvenida a Trino'), findsOneWidget);
    expect(
      find.text('Mensajes y llamadas cifrados de extremo a extremo, sin número de teléfono y sin cuenta.'),
      findsOneWidget,
    );
    expect(find.text('Paso 1 de 5'), findsOneWidget);
    await next(tester, 'Empezar');

    expect(find.text('¿Cómo quieres que te vean?'), findsOneWidget);
    await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
    await next(tester);

    expect(find.text('Crea una contraseña'), findsOneWidget);
    expect(find.text('Nadie puede recuperarla'), findsOneWidget);
    await throughPassword(tester);

    expect(find.text('Elige cómo se ve Trino'), findsOneWidget);
    await next(tester);

    expect(find.text('Verificación en dos pasos (opcional)'), findsOneWidget);
    await next(tester, 'Ahora no');

    expect(find.text('Todo listo'), findsOneWidget);
    expect(
      find.text(
        'Para empezar a hablar, las dos personas tienen que agregarse con su código. Comparte el tuyo y pide el de la otra persona.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('trino2:'), findsOneWidget);
    await next(tester, 'Ir a mis chats');
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
    expect(find.text('Ana Torres'), findsOneWidget);
  });

  testWidgets('asks for a name, and checks the password', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await next(tester, 'Empezar');
    await next(tester);
    expect(find.text('Escribe un nombre.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
    await next(tester);
    await tester.enterText(fieldLabeled('Contraseña'), 'corta');
    await tester.pumpAndSettle();
    expect(find.text('Fortaleza: débil'), findsOneWidget);
    await next(tester);
    expect(find.text('Usa al menos 10 caracteres.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'contraseña123');
    await next(tester);
    expect(find.text('Esa contraseña es muy común. Elige otra.'), findsOneWidget);

    await tester.enterText(fieldLabeled('Contraseña'), 'una frase larga y mía');
    await tester.enterText(fieldLabeled('Repite la contraseña'), 'una frase larga y tuya');
    await next(tester);
    expect(find.text('Las contraseñas no coinciden.'), findsOneWidget);
    expect(find.text('Elige cómo se ve Trino'), findsNothing);
  });

  testWidgets('choosing a language or a style applies it at once', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await tester.tap(find.text('English'));
    await tester.pumpAndSettle();
    expect(find.text('Welcome to Trino'), findsOneWidget);
    await tester.tap(find.text('Español'));
    await tester.pumpAndSettle();
    await next(tester, 'Empezar');
    await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
    await next(tester);
    await throughPassword(tester);

    expect(tester.getSemantics(find.text('Calma')), isSemantics(isChecked: true));
    await tester.tap(find.text('Terminal'));
    await tester.pumpAndSettle();
    expect(currentTheme(tester).style, TrinoStyle.terminal);
    expect(tester.getSemantics(find.text('Terminal')), isSemantics(isChecked: true));
  });

  testWidgets('2FA: a wrong code is refused and the right one turns it on', (tester) async {
    final app = await pumpApp(tester, engine: testEngine(onboarded: false));
    await next(tester, 'Empezar');
    await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
    await next(tester);
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
    await next(tester, 'Empezar');
    await tester.enterText(fieldLabeled('Nombre'), 'Sofía');
    await next(tester);
    await throughPassword(tester);
    await next(tester);
    await next(tester, 'Ahora no');
    await next(tester, 'Agregar un contacto');
    expect(find.byType(OnboardingScreen), findsNothing);
    expect(find.byType(AddContactScreen), findsOneWidget);
  });

  testWidgets('every step meets the 48 dp target and labeling guidelines', (tester) async {
    await pumpApp(tester, engine: testEngine(onboarded: false));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    await next(tester, 'Empezar');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });
}
