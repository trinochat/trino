import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/appearance.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/screens/connection/connection_failed_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/swipe_actions.dart';
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

  testWidgets('a pinned chat goes first, with its pin', (tester) async {
    final app = await pumpApp(tester);
    await app.engine.setChatPinned('chat-lucia', true);
    await tester.pumpAndSettle();
    final rows = tester.widgetList<ChatRow>(find.byType(ChatRow)).toList();
    expect(rows.map((row) => row.name), ['Lucía', 'Ana Torres', 'Familia', 'Carlos Méndez']);
    expect(rows.map((row) => row.pinnedLabel), ['Fijado', null, null, null]);
  });

  testWidgets('a chat marked unread shows its mark and counts in "No leídos"; opening it clears it', (tester) async {
    final app = await pumpApp(tester);
    await app.engine.markUnread('chat-lucia');
    await tester.pumpAndSettle();
    final lucia = tester.widget<ChatRow>(rowOf('Lucía'));
    expect((lucia.markedUnreadLabel, lucia.unread), ('Marcado como no leído', null));
    await tester.tap(find.text('No leídos'));
    await tester.pumpAndSettle();
    expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name), ['Ana Torres', 'Familia', 'Lucía']);

    await tester.tap(rowOf('Lucía'));
    await tester.pumpAndSettle();
    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    expect(rowOf('Lucía'), findsNothing, reason: 'read now: out of "No leídos"');
  });

  group('the actions of a chat, without any gesture', () {
    Finder sheet() => find.byType(BottomSheet);
    Finder inSheet(String text) => find.descendant(of: sheet(), matching: find.text(text));
    Iterable<ListRow> sheetRows(WidgetTester tester) =>
        tester.widgetList<ListRow>(find.descendant(of: sheet(), matching: find.byType(ListRow)));
    List<String> sheetActions(WidgetTester tester) => [for (final row in sheetRows(tester)) row.title];
    // The long-press hint is an overriding action, without a label of its own.
    List<String> customActions(WidgetTester tester, String name) => [
      for (final id in tester.getSemantics(rowOf(name)).getSemanticsData().customSemanticsActionIds ?? const <int>[])
        ?CustomSemanticsAction.getAction(id)?.label,
    ];

    Future<void> longPress(WidgetTester tester, String name) async {
      await tester.longPress(rowOf(name));
      await tester.pumpAndSettle();
    }

    Future<void> choose(WidgetTester tester, String action) async {
      await tester.tap(inSheet(action));
      await tester.pumpAndSettle();
    }

    testWidgets('a long press opens a sheet with the avatar, the name, the kind and the actions of a group', (
      tester,
    ) async {
      await pumpApp(tester);
      await longPress(tester, 'Familia');
      expect(sheet(), findsOneWidget);
      expect(find.descendant(of: sheet(), matching: find.byType(TrinoAvatar)), findsOneWidget);
      expect(inSheet('Familia'), findsOneWidget);
      expect(tester.getSemantics(inSheet('Familia')), isSemantics(isHeader: true));
      expect(inSheet('Grupo · 3 miembros'), findsOneWidget);
      // Familia has an unread message.
      expect(sheetActions(tester), ['Fijar arriba', 'Marcar como leído', 'Silenciar', 'Borrar el chat']);
      final rows = sheetRows(tester);
      expect(rows.map((row) => row.icon), [TrinoIcons.pin, TrinoIcons.mailOpen, TrinoIcons.bellOff, TrinoIcons.trash]);
      expect(rows.map((row) => row.danger), [false, false, false, true]);
      for (final action in sheetActions(tester)) {
        expect(tester.getSemantics(inSheet(action)), isSemantics(isButton: true, hasTapAction: true), reason: action);
      }
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    });

    testWidgets('a contact cannot be muted yet: only pin, unread and delete', (tester) async {
      await pumpApp(tester);
      await longPress(tester, 'Lucía');
      expect(inSheet('Contacto · Sin verificar'), findsOneWidget);
      expect(sheetActions(tester), ['Fijar arriba', 'Marcar como no leído', 'Borrar el chat']);
      expect(sheetRows(tester).elementAt(1).icon, TrinoIcons.mail);
      await tester.tapAt(const Offset(195, 100));
      await tester.pumpAndSettle();
      await longPress(tester, 'Ana Torres');
      expect(inSheet('Contacto verificado'), findsOneWidget);
    });

    testWidgets('"Fijar arriba" pins the chat, and then the sheet offers "Desfijar"', (tester) async {
      final app = await pumpApp(tester);
      await longPress(tester, 'Lucía');
      await choose(tester, 'Fijar arriba');
      expect(sheet(), findsNothing);
      expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).first.name, 'Lucía');
      await longPress(tester, 'Lucía');
      expect(sheetActions(tester).first, 'Desfijar');
      await choose(tester, 'Desfijar');
      expect((await app.engine.chats.first).firstWhere((c) => c.id == 'chat-lucia').pinned, isFalse);
    });

    testWidgets('the sixth pin says so, and pins nothing', (tester) async {
      final engine = testEngine();
      final trabajo = engine.addGroup(title: 'Trabajo', memberIds: const ['carlos']);
      for (final id in ['chat-ana', 'chat-familia', 'chat-carlos', 'chat-lucia', trabajo]) {
        await engine.setChatPinned(id, true);
      }
      engine.addGroup(title: 'Vecinos', memberIds: const ['lucia']);
      await pumpApp(tester, engine: engine);
      await longPress(tester, 'Vecinos');
      await choose(tester, 'Fijar arriba');
      expect(find.text('Puedes fijar hasta 5 chats. Desfija uno para fijar este.'), findsOneWidget);
      expect(tester.widget<ChatRow>(rowOf('Vecinos')).pinnedLabel, isNull);
    });

    testWidgets('"Marcar como no leído" marks the chat; "Marcar como leído" clears it', (tester) async {
      await pumpApp(tester);
      await longPress(tester, 'Lucía');
      await choose(tester, 'Marcar como no leído');
      expect(tester.widget<ChatRow>(rowOf('Lucía')).markedUnreadLabel, 'Marcado como no leído');
      await longPress(tester, 'Lucía');
      await choose(tester, 'Marcar como leído');
      expect(tester.widget<ChatRow>(rowOf('Lucía')).markedUnreadLabel, isNull);
      // A chat with unread messages is read at once.
      await longPress(tester, 'Ana Torres');
      await choose(tester, 'Marcar como leído');
      expect(tester.widget<ChatRow>(rowOf('Ana Torres')).unread, isNull);
    });

    testWidgets('"Silenciar" mutes a group and says so; then the sheet offers "Activar sonido"', (tester) async {
      final app = await pumpApp(tester);
      await longPress(tester, 'Familia');
      await choose(tester, 'Silenciar');
      expect(find.text('Silenciaste Familia.'), findsOneWidget);
      expect((await app.engine.chats.first).firstWhere((c) => c.id == 'chat-familia').muted, isTrue);
      await longPress(tester, 'Familia');
      final unmute = sheetRows(tester).firstWhere((row) => row.title == 'Activar sonido');
      expect(unmute.icon, TrinoIcons.bell);
      await choose(tester, 'Activar sonido');
      expect(find.text('Activaste el sonido de Familia.'), findsOneWidget);
      expect((await app.engine.chats.first).firstWhere((c) => c.id == 'chat-familia').muted, isFalse);
    });

    testWidgets('"Borrar el chat" always asks first, with the honest copy', (tester) async {
      await pumpApp(tester);
      await longPress(tester, 'Lucía');
      await choose(tester, 'Borrar el chat');
      expect(find.text('¿Borrar el chat con Lucía?'), findsOneWidget);
      expect(
        find.text(
          'Los mensajes se borran solo de este celular. Lucía conserva los suyos, y tus otros dispositivos también.',
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();
      expect(rowOf('Lucía'), findsOneWidget);

      await longPress(tester, 'Lucía');
      await choose(tester, 'Borrar el chat');
      await tester.tap(find.widgetWithText(TrinoButton, 'Borrar el chat'));
      await tester.pumpAndSettle();
      expect(rowOf('Lucía'), findsNothing);
      expect(find.text('Se borró el chat.'), findsOneWidget);
    });

    testWidgets('deleting a group says the other members keep theirs', (tester) async {
      await pumpApp(tester);
      await longPress(tester, 'Familia');
      await choose(tester, 'Borrar el chat');
      expect(find.text('¿Borrar el chat con Familia?'), findsOneWidget);
      expect(
        find.text(
          'Los mensajes se borran solo de este celular. Los demás miembros conservan los suyos, '
          'y tus otros dispositivos también.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('screen readers get the same actions on the row, and its long press opens the sheet', (tester) async {
      final handle = tester.ensureSemantics();
      final app = await pumpApp(tester);
      // Flutter orders them by when each label was first seen, not as given.
      expect(
        customActions(tester, 'Familia'),
        unorderedEquals(['Fijar arriba', 'Marcar como leído', 'Silenciar', 'Borrar el chat']),
      );
      expect(
        customActions(tester, 'Lucía'),
        unorderedEquals(['Fijar arriba', 'Marcar como no leído', 'Borrar el chat']),
      );
      final node = tester.getSemantics(rowOf('Familia'));
      expect(node, isSemantics(isButton: true, hasTapAction: true, hasLongPressAction: true));
      final hint = node.getSemanticsData().customSemanticsActionIds!.map(CustomSemanticsAction.getAction);
      expect(hint.where((action) => action!.action == SemanticsAction.longPress).single!.hint, 'Más opciones');

      tester.semantics.customAction(
        find.semantics.byLabel(RegExp('^Familia')),
        const CustomSemanticsAction(label: 'Fijar arriba'),
      );
      await tester.pumpAndSettle();
      expect((await app.engine.chats.first).first.id, 'chat-familia');
      expect(customActions(tester, 'Familia'), contains('Desfijar'));

      final lucia = find.semantics.byLabel(RegExp('^Lucía'));
      tester.semantics.customAction(lucia, const CustomSemanticsAction(label: 'Borrar el chat'));
      await tester.pumpAndSettle();
      expect(find.text('¿Borrar el chat con Lucía?'), findsOneWidget, reason: 'it asks first here too');
      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();

      tester.semantics.longPress(lucia);
      await tester.pumpAndSettle();
      expect(inSheet('Lucía'), findsOneWidget);
      handle.dispose();
    });

    testWidgets('with a keyboard: the menu key, or Shift+F10, on a focused row opens the sheet', (tester) async {
      await pumpApp(tester);
      final inkWell = find.descendant(of: rowOf('Lucía'), matching: find.byType(InkWell));
      Focus.of(tester.element(find.descendant(of: inkWell, matching: find.byType(Row)).first)).requestFocus();
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.contextMenu);
      await tester.pumpAndSettle();
      expect(inSheet('Lucía'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(sheet(), findsNothing);

      Focus.of(tester.element(find.descendant(of: inkWell, matching: find.byType(Row)).first)).requestFocus();
      await tester.pumpAndSettle();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.f10);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
      await tester.pumpAndSettle();
      expect(inSheet('Lucía'), findsOneWidget);
    });
  });

  group('the list moves instead of jumping', () {
    double topOf(WidgetTester tester, String name) => tester.getTopLeft(rowOf(name)).dy;

    double opacityOfRow(WidgetTester tester, String name) => tester
        .widgetList<Opacity>(find.ancestor(of: rowOf(name), matching: find.byType(Opacity)))
        .fold(1.0, (opacity, fade) => opacity * fade.opacity);

    void useReduceMotion(WidgetTester tester) {
      tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(reduceMotion: true);
      addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    }

    Future<(double from, double to)> pinLucia(WidgetTester tester, {Appearance appearance = const Appearance()}) async {
      final app = await pumpApp(tester, appearance: appearance);
      final from = topOf(tester, 'Lucía');
      final to = topOf(tester, 'Ana Torres');
      await app.engine.setChatPinned('chat-lucia', true);
      await tester.pump();
      return (from, to);
    }

    testWidgets('Calma: a pinned chat slides up to its place, and the others make room', (tester) async {
      final (from, to) = await pinLucia(tester);
      final anaBefore = to;
      await tester.pump(const Duration(milliseconds: 100));
      expect(topOf(tester, 'Lucía'), inExclusiveRange(to, from), reason: 'on its way up');
      expect(topOf(tester, 'Ana Torres'), greaterThan(anaBefore), reason: 'on its way down');
      await tester.pumpAndSettle();
      expect(topOf(tester, 'Lucía'), moreOrLessEquals(to, epsilon: 0.01));
      expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).map((row) => row.name), [
        'Lucía',
        'Ana Torres',
        'Familia',
        'Carlos Méndez',
      ]);
    });

    testWidgets('Terminal: the same, short and crisp', (tester) async {
      final (from, to) = await pinLucia(tester, appearance: const Appearance(style: TrinoStyle.terminal));
      await tester.pump(const Duration(milliseconds: 60));
      expect(topOf(tester, 'Lucía'), inExclusiveRange(to, from));
      await tester.pump(const Duration(milliseconds: 110));
      expect(topOf(tester, 'Lucía'), to);
    });

    testWidgets('with Reduce Motion nothing slides: it is in its place at once', (tester) async {
      useReduceMotion(tester);
      final (_, to) = await pinLucia(tester);
      await tester.pump(const Duration(milliseconds: 16));
      expect(topOf(tester, 'Lucía'), to);
    });

    testWidgets('with Animaciones "Ninguna" it is in its place at once', (tester) async {
      final (_, to) = await pinLucia(tester, appearance: const Appearance(animations: AnimationsSetting.none));
      await tester.pump(const Duration(milliseconds: 16));
      expect(topOf(tester, 'Lucía'), to);
    });

    testWidgets('the pin fades in', (tester) async {
      await pinLucia(tester);
      await tester.pump(const Duration(milliseconds: 50));
      final pin = find.descendant(
        of: rowOf('Lucía'),
        matching: find.byWidgetPredicate((w) => w is TrinoIcon && w.icon == TrinoIcons.pin),
      );
      expect(pin, findsOneWidget);
      final opacity = tester
          .widgetList<FadeTransition>(
            find.descendant(
              of: rowOf('Lucía'),
              matching: find.ancestor(of: pin, matching: find.byType(FadeTransition)),
            ),
          )
          .fold(1.0, (opacity, fade) => opacity * fade.opacity.value);
      expect(opacity, inExclusiveRange(0, 1));
    });

    testWidgets('a deleted chat closes, neither read nor tappable, and the rows below move up', (tester) async {
      final app = await pumpApp(tester);
      final carlosFrom = topOf(tester, 'Carlos Méndez');
      final familiaTop = topOf(tester, 'Familia');
      await app.engine.deleteChat('chat-familia');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(rowOf('Familia'), findsOneWidget, reason: 'still closing');
      expect(find.text('Familia').hitTestable(), findsNothing);
      expect(
        find.ancestor(
          of: rowOf('Familia'),
          matching: find.byWidgetPredicate((w) => w is ExcludeSemantics && w.excluding),
        ),
        findsOneWidget,
        reason: 'not read',
      );
      expect(topOf(tester, 'Carlos Méndez'), inExclusiveRange(familiaTop, carlosFrom));
      await tester.pumpAndSettle();
      expect(rowOf('Familia'), findsNothing);
      expect(topOf(tester, 'Carlos Méndez'), familiaTop);
    });

    testWidgets('with Reduce Motion a deleted chat only fades out', (tester) async {
      useReduceMotion(tester);
      final app = await pumpApp(tester);
      final carlosFrom = topOf(tester, 'Carlos Méndez');
      await app.engine.deleteChat('chat-familia');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(opacityOfRow(tester, 'Familia'), inExclusiveRange(0, 1));
      expect(topOf(tester, 'Carlos Méndez'), carlosFrom, reason: 'no closing');
      await tester.pumpAndSettle();
      expect(rowOf('Familia'), findsNothing);
    });

    testWidgets('with Animaciones "Ninguna" a deleted chat is gone at once', (tester) async {
      final app = await pumpApp(tester, appearance: const Appearance(animations: AnimationsSetting.none));
      await app.engine.deleteChat('chat-familia');
      await tester.pump();
      expect(rowOf('Familia'), findsNothing);
    });

    testWidgets('a new filter shows its chats at once, without rows closing', (tester) async {
      await pumpApp(tester);
      await tester.tap(find.text('Grupos'));
      await tester.pump();
      expect(find.byType(ChatRow), findsOneWidget);
    });
  });

  group('swiping a chat', () {
    Finder action(String label) => find.bySemanticsLabel(label);
    Material materialOf(WidgetTester tester, String label) =>
        tester.widget<Material>(find.ancestor(of: find.text(label), matching: find.byType(Material)).first);

    Future<void> swipe(WidgetTester tester, String name, double dx) async {
      await tester.drag(rowOf(name), Offset(dx, 0));
      await tester.pumpAndSettle();
    }

    testWidgets('to the right: "No leído" in the soft accent and "Fijar" in grey', (tester) async {
      await pumpApp(tester);
      final t = tokensIn(tester);
      await swipe(tester, 'Lucía', 120);
      expect(tester.getSemantics(action('No leído')), isSemantics(isButton: true, hasTapAction: true));
      expect(tester.getSemantics(action('Fijar')), isSemantics(isButton: true, hasTapAction: true));
      expect(materialOf(tester, 'No leído').color, t.accentSoft);
      expect(colorOfText(tester, 'No leído'), t.accentText);
      expect(materialOf(tester, 'Fijar').color, t.raised);
      expect(colorOfText(tester, 'Fijar'), t.ink);
      expect(tester.getCenter(find.text('No leído')).dx, lessThan(tester.getCenter(find.text('Fijar')).dx));
      await tester.tap(find.text('Fijar'));
      await tester.pumpAndSettle();
      expect(tester.widgetList<ChatRow>(find.byType(ChatRow)).first.name, 'Lucía');
    });

    testWidgets('an unread chat says "Leído" with the open envelope, and a pinned one "Desfijar"', (tester) async {
      final app = await pumpApp(tester);
      await app.engine.setChatPinned('chat-ana', true);
      await tester.pumpAndSettle();
      await swipe(tester, 'Ana Torres', 120);
      expect(action('Leído'), findsOneWidget);
      expect(action('Desfijar'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.byWidgetPredicate((w) => w is TrinoIcon && w.icon == TrinoIcons.mailOpen),
          matching: find.byType(SwipeActions),
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('Leído'));
      await tester.pumpAndSettle();
      expect(tester.widget<ChatRow>(rowOf('Ana Torres')).unread, isNull);
    });

    testWidgets('to the left on a group: "Silenciar" in grey and "Borrar" in red, at the edge', (tester) async {
      final app = await pumpApp(tester);
      final t = tokensIn(tester);
      await swipe(tester, 'Familia', -120);
      expect(materialOf(tester, 'Silenciar').color, t.raised);
      expect(materialOf(tester, 'Borrar').color, t.dangerBg);
      expect(colorOfText(tester, 'Borrar'), t.danger);
      expect(tester.getCenter(find.text('Borrar')).dx, greaterThan(tester.getCenter(find.text('Silenciar')).dx));
      await tester.tap(find.text('Silenciar'));
      await tester.pumpAndSettle();
      expect((await app.engine.chats.first).firstWhere((c) => c.id == 'chat-familia').muted, isTrue);
      await swipe(tester, 'Familia', -120);
      expect(action('Activar sonido'), findsOneWidget);
    });

    testWidgets('to the left on a contact: only "Borrar", and it asks first', (tester) async {
      await pumpApp(tester);
      await swipe(tester, 'Lucía', -120);
      expect(find.text('Silenciar'), findsNothing);
      await tester.tap(find.text('Borrar'));
      await tester.pumpAndSettle();
      expect(find.text('¿Borrar el chat con Lucía?'), findsOneWidget);
      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();
      expect(rowOf('Lucía'), findsOneWidget);
    });

    testWidgets('a long swipe right marks unread; a long swipe left asks to delete', (tester) async {
      await pumpApp(tester);
      await swipe(tester, 'Lucía', 300);
      expect(tester.widget<ChatRow>(rowOf('Lucía')).markedUnreadLabel, 'Marcado como no leído');
      await swipe(tester, 'Lucía', -300);
      expect(find.text('¿Borrar el chat con Lucía?'), findsOneWidget);
    });

    testWidgets('one row open at a time, and a tap on the open row closes it without opening the chat', (tester) async {
      await pumpApp(tester);
      await swipe(tester, 'Lucía', 120);
      await swipe(tester, 'Familia', -120);
      expect(find.text('No leído'), findsNothing);
      expect(find.text('Borrar'), findsOneWidget);
      // The name slid off the screen; the rest of the row is still there.
      await tester.tap(rowOf('Familia'));
      await tester.pumpAndSettle();
      expect(find.text('Borrar'), findsNothing);
      expect(find.byType(ChatsScreen), findsOneWidget);
      expect(find.text('Mensaje'), findsNothing, reason: 'the chat did not open');
    });
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
