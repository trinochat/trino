import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/text_field.dart';
import 'package:trino_mobile/ui/underline_tabs.dart';

import '../support/app_harness.dart';

Finder rowOf(String name) => find.ancestor(of: find.text(name), matching: find.byType(ChatRow));

void main() {
  testWidgets('a large title, the new chat button, the search field and the text filters', (tester) async {
    await pumpApp(tester);
    final title = find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats'));
    expect(title, findsOneWidget);
    expect(tester.getSemantics(title), isSemantics(isHeader: true));
    expect(find.bySemanticsLabel('Nuevo chat'), findsOneWidget);
    expect(tester.getSemantics(find.byType(TrinoTextField)).label, contains('Buscar chats'));
    final tabs = tester.widget<UnderlineTabs>(find.byType(UnderlineTabs));
    expect(tabs.labels, ['Todos', 'No leídos', 'Grupos', 'Solicitudes']);
  });

  testWidgets('says "Conectando…" in place of the title while not connected, with no status pill', (tester) async {
    final app = await pumpApp(tester);
    app.engine.setNetwork(const NetworkState.connecting());
    await tester.pumpAndSettle();
    final title = find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Conectando…'));
    expect(title, findsOneWidget);
    expect(tester.getSemantics(title), isSemantics(isLiveRegion: true));
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsNothing);
    expect(find.textContaining('Conectado'), findsNothing);

    app.engine.setNetwork(const NetworkState.connected());
    await tester.pumpAndSettle();
    expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsOneWidget);
  });

  testWidgets('lists the demo chats: shield, preview, draft prefix, time and unread count', (tester) async {
    await pumpApp(tester);
    final names = tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name);
    expect(names, ['Ana Torres', 'Familia', 'Carlos Méndez', 'Lucía']);

    final ana = tester.widget<ChatRow>(rowOf('Ana Torres'));
    expect(ana.trust?.label, 'Contacto verificado');
    expect(
      (ana.preview, ana.time, ana.unread?.count, ana.unread?.label),
      ('Perfecto, nos vemos el jueves', '10:42', 1, '1 sin leer'),
    );

    final familia = tester.widget<ChatRow>(rowOf('Familia'));
    expect((familia.preview, familia.time, familia.trust), ('Papá: Llego a las 7', '9:15', null));

    final carlos = tester.widget<ChatRow>(rowOf('Carlos Méndez'));
    expect((carlos.draftPrefix, carlos.preview, carlos.time), ('Borrador:', 'Mañana te confirmo la hora', 'Ayer'));

    final lucia = tester.widget<ChatRow>(rowOf('Lucía'));
    expect((lucia.time, lucia.trust), ('Mar', null));
  });

  testWidgets('filters: unread, groups, and requests (none yet)', (tester) async {
    await pumpApp(tester);
    List<String> names() => tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name).toList();

    await tester.tap(find.text('No leídos'));
    await tester.pumpAndSettle();
    expect(names(), ['Ana Torres', 'Familia']);

    await tester.tap(find.text('Grupos'));
    await tester.pumpAndSettle();
    expect(names(), ['Familia']);

    // The tabs scroll sideways when they do not fit.
    await tester.ensureVisible(find.text('Solicitudes'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Solicitudes'));
    await tester.pumpAndSettle();
    expect(names(), isEmpty);
    expect(find.text('No hay chats en este filtro.'), findsOneWidget);

    await tester.ensureVisible(find.text('Todos'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Todos'));
    await tester.pumpAndSettle();
    expect(names(), hasLength(4));
  });

  testWidgets('search finds chats by name, ignoring case and accents', (tester) async {
    await pumpApp(tester);
    await tester.enterText(find.byType(TextField), 'lucia');
    await tester.pumpAndSettle();
    expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name), ['Lucía']);
    await tester.enterText(find.byType(TextField), 'zz');
    await tester.pumpAndSettle();
    expect(find.text('Ningún chat coincide con tu búsqueda.'), findsOneWidget);
  });

  testWidgets('a new message moves its chat up and counts as unread', (tester) async {
    final app = await pumpApp(tester);
    app.engine.receive('chat-lucia', '¿Ya la tienes?');
    await tester.pumpAndSettle();
    final first = tester.widgetList<ChatRow>(find.byType(ChatRow)).first;
    expect((first.name, first.preview, first.unread?.count), ('Lucía', '¿Ya la tienes?', 1));
  });

  testWidgets('"Nuevo chat" lists the contacts and opens a chat with one', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.bySemanticsLabel('Nuevo chat'));
    await tester.pumpAndSettle();
    expect(find.text('Papá'), findsOneWidget);
    await tester.tap(find.text('Papá'));
    await tester.pumpAndSettle();
    expect(find.text('Escribe un mensaje'), findsOneWidget);
    expect(find.text('Papá'), findsOneWidget);
  });

  testWidgets('fits at twice the text size', (tester) async {
    await pumpApp(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    expect(find.byType(ChatsScreen), findsOneWidget);
  });
}
