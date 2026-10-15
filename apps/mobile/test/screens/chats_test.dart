import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/screens/connection/connection_failed_screen.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/text_field.dart';
import 'package:trino_mobile/ui/underline_tabs.dart';

import '../support/app_harness.dart';

Finder rowOf(String name) => find.ancestor(of: find.text(name), matching: find.byType(ChatRow));

void main() {
  testWidgets('a large title with the search and new chat buttons, and the text filters', (tester) async {
    await pumpApp(tester);
    final title = find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats'));
    expect(title, findsOneWidget);
    expect(tester.getSemantics(title), isSemantics(isHeader: true));
    expect(find.bySemanticsLabel('Buscar'), findsOneWidget);
    expect(find.bySemanticsLabel('Nuevo chat'), findsOneWidget);
    // The search field shows when asked for.
    expect(find.byType(TrinoTextField), findsNothing);
    final tabs = tester.widget<UnderlineTabs>(find.byType(UnderlineTabs));
    expect(tabs.labels, ['Todos', 'No leídos', 'Grupos']);
  });

  group('the network state, in one line of words under the title', () {
    Future<TestApp> pumpWith(WidgetTester tester, NetworkState state) async {
      final app = await pumpApp(tester);
      app.engine.setNetwork(state);
      await tester.pumpAndSettle();
      return app;
    }

    testWidgets('connecting, with the progress, as a polite live region; the title stays', (tester) async {
      await pumpWith(tester, const NetworkState.connecting(40));
      const text = 'Conectando de forma privada… 40 %';
      expect(find.text(text), findsOneWidget);
      expect(tester.getSemantics(find.text(text)), isSemantics(isLiveRegion: true));
      expect(colorOfText(tester, text), tokensIn(tester).muted);
      expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsOneWidget);
    });

    testWidgets('connecting from zero says no number', (tester) async {
      await pumpWith(tester, const NetworkState.connecting());
      expect(find.text('Conectando de forma privada…'), findsOneWidget);
    });

    testWidgets('trying another way says so', (tester) async {
      await pumpWith(tester, const NetworkState(status: NetworkStatus.failed, tryingAnotherWay: true));
      expect(find.text('Probando otra forma de conectarse…'), findsOneWidget);
      expect(find.text('Ver qué hacer'), findsNothing);
    });

    testWidgets('failed, with "Ver qué hacer" as a 48 dp button', (tester) async {
      await pumpWith(tester, const NetworkState.failed(NetworkProblem.blocked));
      expect(find.text('No se pudo conectar.'), findsOneWidget);
      expect(tester.getSemantics(find.text('Ver qué hacer')), isSemantics(isButton: true, hasTapAction: true));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await tester.tap(find.text('Ver qué hacer'));
      await tester.pumpAndSettle();
      expect(find.byType(ConnectionFailedScreen), findsOneWidget);
    });

    testWidgets('waiting for internet', (tester) async {
      await pumpWith(tester, const NetworkState.offline());
      expect(find.text('Esperando internet…'), findsOneWidget);
    });

    testWidgets('unprotected, in the warning colour and bold', (tester) async {
      await pumpWith(tester, const NetworkState.unprotected());
      const text = 'Sin protección hasta que cierres Trino';
      expect(find.text(text), findsOneWidget);
      expect(colorOfText(tester, text), tokensIn(tester).warn);
      expect(tester.widget<Text>(find.text(text)).style?.fontWeight, FontWeight.w700);
    });

    testWidgets('nothing once connected, and no pill or dot', (tester) async {
      await pumpWith(tester, const NetworkState.connected());
      expect(find.textContaining('Conect'), findsNothing);
      expect(find.textContaining('protección'), findsNothing);
    });
  });

  testWidgets('"Ver qué hacer" calls the inbox\'s callback when it has one', (tester) async {
    final engine = testEngine()..setNetwork(const NetworkState.failed());
    var asked = 0;
    await pumpScreen(tester, ChatsScreen(onNetworkHelp: () => asked++), engine: engine);
    await tester.tap(find.text('Ver qué hacer'));
    expect(asked, 1);
  });

  group('the grey row of requests', () {
    Finder row() => find.byKey(ChatsScreen.requestsRowKey);

    testWidgets('above the chats: an inbox icon, "Solicitudes (n)" and a chevron, in muted, no dot', (tester) async {
      await pumpApp(tester);
      expect(find.descendant(of: row(), matching: find.text('Solicitudes (3)')), findsOneWidget);
      expect(colorOfText(tester, 'Solicitudes (3)'), tokensIn(tester).muted);
      final icons = tester.widgetList<TrinoIcon>(find.descendant(of: row(), matching: find.byType(TrinoIcon)));
      expect(icons.map((icon) => icon.icon), [TrinoIcons.inbox, TrinoIcons.chevronRight]);
      expect(tester.getTopLeft(row()).dy, lessThan(tester.getTopLeft(find.byType(ChatRow).first).dy));
      expect(tester.getSemantics(row()), isSemantics(isButton: true, hasTapAction: true));
      expect(tester.getSize(row()).height, greaterThanOrEqualTo(48));
    });

    testWidgets('changes with the requests and hides without any', (tester) async {
      final app = await pumpApp(tester);
      await app.engine.deleteRequest('req-ana');
      await tester.pumpAndSettle();
      expect(find.text('Solicitudes (2)'), findsOneWidget);
      await app.engine.deleteRequest('req-mara');
      await app.engine.deleteRequest('req-julian');
      await tester.pumpAndSettle();
      expect(row(), findsNothing);
    });

    testWidgets('opens the requests', (tester) async {
      await pumpApp(tester);
      await tester.tap(row());
      await tester.pumpAndSettle();
      expect(find.text('No son tus contactos. Nada de aquí suena ni se descarga hasta que aceptes.'), findsOneWidget);
    });

    testWidgets('shows only in Todos, and not while searching', (tester) async {
      await pumpApp(tester);
      await tester.tap(find.text('No leídos'));
      await tester.pumpAndSettle();
      expect(row(), findsNothing);
      await tester.tap(find.text('Todos'));
      await tester.tap(find.bySemanticsLabel('Buscar'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'a');
      await tester.pumpAndSettle();
      expect(row(), findsNothing);
    });
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

  testWidgets('filters: unread and groups', (tester) async {
    await pumpApp(tester);
    List<String> names() => tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name).toList();

    await tester.tap(find.text('No leídos'));
    await tester.pumpAndSettle();
    expect(names(), ['Ana Torres', 'Familia']);

    await tester.tap(find.text('Grupos'));
    await tester.pumpAndSettle();
    expect(names(), ['Familia']);

    await tester.tap(find.text('Todos'));
    await tester.pumpAndSettle();
    expect(names(), hasLength(4));
  });

  testWidgets('search finds chats by name, ignoring case and accents', (tester) async {
    await pumpApp(tester);
    await tester.tap(find.bySemanticsLabel('Buscar'));
    await tester.pumpAndSettle();
    expect(tester.getSemantics(find.byType(TrinoTextField)).label, contains('Buscar chats'));
    await tester.enterText(find.byType(TextField), 'lucia');
    await tester.pumpAndSettle();
    expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name), ['Lucía']);
    await tester.enterText(find.byType(TextField), 'zz');
    await tester.pumpAndSettle();
    expect(find.text('Ningún chat coincide con tu búsqueda.'), findsOneWidget);

    // Closing the search clears it.
    await tester.tap(find.bySemanticsLabel('Cerrar la búsqueda'));
    await tester.pumpAndSettle();
    expect(find.byType(TrinoTextField), findsNothing);
    expect(find.byType(ChatRow), findsNWidgets(4));
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
    expect(find.text('Mensaje'), findsOneWidget);
    expect(find.text('Papá'), findsOneWidget);
  });

  testWidgets('fits at twice the text size', (tester) async {
    await pumpApp(tester, textScale: 2);
    expect(tester.takeException(), isNull);
    expect(find.byType(ChatsScreen), findsOneWidget);
  });
}
