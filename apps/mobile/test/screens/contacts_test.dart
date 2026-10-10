import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/list_row.dart';

import '../support/app_harness.dart';

void main() {
  testWidgets('"Agregar contacto" in the accent, "Compartir mi código", and the contacts', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    final add = tester.widget<ListRow>(
      find.ancestor(of: find.text('Agregar contacto'), matching: find.byType(ListRow)),
    );
    expect(add.accent, isTrue);
    expect(find.text('Compartir mi código'), findsOneWidget);
    for (final name in ['Ana Torres', 'Carlos Méndez', 'Lucía', 'Mamá', 'Papá']) {
      expect(find.text(name), findsOneWidget, reason: name);
    }
    final ana = tester.widget<ListRow>(find.ancestor(of: find.text('Ana Torres'), matching: find.byType(ListRow)));
    expect(ana.subtitle, 'Contacto verificado');
    final lucia = tester.widget<ListRow>(find.ancestor(of: find.text('Lucía'), matching: find.byType(ListRow)));
    expect(lucia.subtitle, 'Sin verificar');
  });

  testWidgets('adds a contact from a code, and says when a code is wrong', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    await tester.tap(find.text('Agregar contacto'));
    await tester.pumpAndSettle();
    expect(find.text('Pega el código que te compartió la otra persona.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'hola');
    await tester.tap(find.text('Agregar'));
    await tester.pumpAndSettle();
    expect(find.text('Ese código no es válido. Revisa que esté completo.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'trino2:AQRBbmEgVG9ycmVzX2ZpZDQ2MWQ3YjBl');
    await tester.tap(find.text('Agregar'));
    await tester.pumpAndSettle();
    expect(find.text('Agregaste a Valentina Gómez.'), findsOneWidget);
    expect(find.text('Valentina Gómez'), findsOneWidget);
  });

  testWidgets('shares the code: the honest note, the code and the key, and copying', (tester) async {
    final copied = <String>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') copied.add((call.arguments as Map)['text'] as String);
      return null;
    });
    addTearDown(() => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform, null));

    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    await tester.tap(find.text('Compartir mi código'));
    await tester.pumpAndSettle();
    expect(
      find.text(
        'Para empezar a hablar, las dos personas tienen que agregarse con su código. Comparte el tuyo y pide el de la otra persona.',
      ),
      findsOneWidget,
    );
    expect(find.textContaining('trino2:'), findsOneWidget);
    expect(find.text('70A5 83C6 766D AAD7'), findsOneWidget);
    await tester.tap(find.text('Copiar código'));
    await tester.pumpAndSettle();
    expect(copied.single, startsWith('trino2:'));
    expect(find.text('Copiado'), findsOneWidget);
  });

  testWidgets('a contact opens its chat', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    await tester.tap(find.text('Ana Torres'));
    await tester.pumpAndSettle();
    expect(find.byType(ChatScreen), findsOneWidget);
    expect(find.text('Perfecto, nos vemos el jueves'), findsOneWidget);
  });
}
