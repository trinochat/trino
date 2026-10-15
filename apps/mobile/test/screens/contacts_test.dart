import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/screens/contacts_screen.dart';
import 'package:trino_mobile/screens/share_code_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/icon_button.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/trust_badge.dart';

import '../support/app_harness.dart';

void main() {
  ListRow rowOf(WidgetTester tester, String title) =>
      tester.widget<ListRow>(find.ancestor(of: find.text(title), matching: find.byType(ListRow)));

  testWidgets('the shortcuts in the accent, then the contacts A to Z under their letters', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    for (final shortcut in ['Agregar con código o QR', 'Nuevo grupo', 'Buscar por @nombre']) {
      expect(rowOf(tester, shortcut).accent, isTrue, reason: shortcut);
    }
    expect(find.text('Compartir mi código'), findsNothing, reason: 'the QR button of the title shares it');
    final initials = tester.widgetList<Text>(
      find.descendant(of: find.byType(TrinoAvatar), matching: find.byType(Text)),
    );
    final order = [
      for (final text in tester.widgetList<Text>(find.byType(Text)).where((text) => !initials.contains(text)))
        if (['A', 'C', 'L', 'M', 'P', 'Ana Torres', 'Carlos Méndez', 'Lucía', 'Mamá', 'Papá'].contains(text.data))
          text.data,
    ];
    expect(order, ['A', 'Ana Torres', 'C', 'Carlos Méndez', 'L', 'Lucía', 'M', 'Mamá', 'P', 'Papá']);
    expect(tester.getSemantics(find.text('A')), isSemantics(isHeader: true));
    expect(rowOf(tester, 'Ana Torres').subtitle, 'Contacto verificado');
    expect(rowOf(tester, 'Lucía').subtitle, 'Sin verificar');
    final shields = find.descendant(
      of: find.ancestor(of: find.text('Ana Torres'), matching: find.byType(ListRow)),
      matching: find.byType(TrustBadge),
    );
    expect(tester.widget<TrustBadge>(shields).kind, TrustKind.verified);
    expect(
      find.descendant(
        of: find.ancestor(of: find.text('Lucía'), matching: find.byType(ListRow)),
        matching: find.byType(TrustBadge),
      ),
      findsNothing,
    );
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('the search finds contacts without accents, and says @nombre is not there yet', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    expect(find.text('Buscar o escribir un @nombre'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'luc');
    await tester.pumpAndSettle();
    expect(find.text('Lucía'), findsOneWidget);
    expect(find.text('Ana Torres'), findsNothing);
    expect(find.text('Nuevo grupo'), findsNothing, reason: 'the shortcuts step aside while searching');

    await tester.enterText(find.byType(TextField), 'zz');
    await tester.pumpAndSettle();
    expect(find.text('Ningún contacto coincide con tu búsqueda.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), '@ana');
    await tester.pumpAndSettle();
    expect(find.text('Buscar a @nombre aún no está disponible en esta versión.'), findsOneWidget);
  });

  testWidgets('"Nuevo grupo" and "Buscar por @nombre" say they are not in this version', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    for (final shortcut in ['Nuevo grupo', 'Buscar por @nombre']) {
      await tester.tap(find.text(shortcut));
      await tester.pump();
      expect(find.text('Aún no está disponible en esta versión.'), findsOneWidget, reason: shortcut);
      await tester.pumpAndSettle(const Duration(seconds: 5));
    }
  });

  testWidgets('the QR button of the title opens your code', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    final qr = find.descendant(of: find.byType(LargeTitleBar), matching: find.byType(TrinoIconButton));
    expect(
      (tester.widget<TrinoIconButton>(qr).icon, tester.widget<TrinoIconButton>(qr).label),
      (TrinoIcons.qr, 'Compartir mi código'),
    );
    await tester.tap(qr);
    await tester.pumpAndSettle();
    expect(find.byType(ShareCodeScreen), findsOneWidget);
  });

  testWidgets('adding by QR says the scanner is not in this version', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    await tester.tap(find.text('Agregar con código o QR'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Escanear un código QR'));
    await tester.pump();
    expect(find.text('Aún no está disponible en esta versión.'), findsOneWidget);
  });

  testWidgets('adds a contact from a code, and says when a code is wrong', (tester) async {
    await pumpApp(tester);
    await openTab(tester, 'Contactos');
    await tester.tap(find.text('Agregar con código o QR'));
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
    await tester.scrollUntilVisible(
      find.text('Valentina Gómez'),
      200,
      scrollable: find.descendant(of: find.byType(ContactsScreen), matching: find.byType(Scrollable)).last,
    );
    expect(find.text('V'), findsOneWidget, reason: 'under a letter of its own');
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
    await tester.tap(find.bySemanticsLabel('Compartir mi código'));
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

  test('a name goes under its letter without the accent, or under "#"', () {
    expect(
      [
        for (final name in ['Ángela', 'ñata', 'Óscar', '9 Lives', '  ', 'zoe']) initialOf(name),
      ],
      ['A', 'N', 'O', '#', '#', 'Z'],
    );
    final names = sortedByName([
      for (final name in ['Óscar', 'oliva', 'Ana'])
        Contact(id: name, name: name, trust: Trust.unverified, fingerprint: ''),
    ]).map((contact) => contact.name);
    expect(names, ['Ana', 'oliva', 'Óscar']);
  });
}
