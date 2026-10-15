import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/info/group_info_screen.dart';
import 'package:trino_mobile/ui/list_row.dart';

import '../support/app_harness.dart';

const membersNote =
    'Solo quien administra puede cambiar los miembros, y cada cambio va firmado: nadie puede agregar a alguien '
    'haciéndose pasar por otra persona.';

/// Opens [name]'s chat and, from its header, the group info.
Future<TestApp> openGroupInfo(WidgetTester tester, {String name = 'Familia', FakeTrinoEngine? engine}) async {
  final app = await pumpApp(tester, engine: engine);
  await openChat(tester, name);
  await tester.tap(find.descendant(of: find.byKey(ChatScreen.headerKey), matching: find.text(name)));
  await tester.pumpAndSettle();
  expect(find.byType(GroupInfoScreen), findsOneWidget);
  return app;
}

/// A group you administer, with Ana and Lucía.
FakeTrinoEngine engineWithOwnGroup() => testEngine()..addGroup(title: 'Taller', memberIds: const ['ana', 'lucia']);

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text).last);
  await tester.pumpAndSettle();
  await tester.tap(find.text(text).last);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('as a member: the name, the members and who administers, and Silenciar alone', (tester) async {
    await openGroupInfo(tester);
    expect(find.text('Familia'), findsOneWidget);
    expect(find.text('3 miembros · Administra Mamá'), findsOneWidget);
    expect(tester.getSemantics(find.bySemanticsLabel('Silenciar')), isSemantics(isButton: true, isToggled: false));
    for (final missing in ['Agregar', 'Editar', 'Buscar', 'Fotos y archivos', 'Mensajes temporales', 'Llamar']) {
      expect(find.text(missing), findsNothing, reason: missing);
    }
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('the members: "Administra" under who does, "(tú)" beside you, and the note under them', (tester) async {
    await openGroupInfo(tester);
    expect(find.text('Miembros'), findsOneWidget);
    final rows = tester.widgetList<ListRow>(find.byType(ListRow)).toList();
    expect(
      [for (final row in rows.take(3)) (row.title, row.subtitle, row.onTap)],
      [('Mamá', 'Administra', null), ('Papá', null, null), (FakeTrinoEngine.demoName, null, null)],
    );
    expect(find.text('(tú)'), findsOneWidget);
    expect(colorOfText(tester, '(tú)'), tokensIn(tester, find.byType(GroupInfoScreen)).muted);
    expect(
      tester.getCenter(find.text('(tú)')).dy,
      closeTo(tester.getCenter(find.text(FakeTrinoEngine.demoName)).dy, 2),
      reason: 'beside your name',
    );
    await tester.ensureVisible(find.text(membersNote));
    expect(
      tester.getCenter(find.text(membersNote)).dy,
      greaterThan(tester.getCenter(find.text(FakeTrinoEngine.demoName)).dy),
    );
  });

  testWidgets('Silenciar is a toggle that says its state in words', (tester) async {
    final app = await openGroupInfo(tester);
    Future<bool> muted() async =>
        (await tester.runAsync(() => app.engine.chats.first))!.firstWhere((c) => c.id == 'chat-familia').muted;

    await tester.tap(find.text('Silenciar'));
    await tester.pumpAndSettle();
    expect(await muted(), isTrue);
    expect(find.text('Silenciado'), findsOneWidget);
    expect(tester.getSemantics(find.bySemanticsLabel('Silenciado')), isSemantics(isButton: true, isToggled: true));

    await tester.tap(find.text('Silenciado'));
    await tester.pumpAndSettle();
    expect(await muted(), isFalse);
    expect(find.text('Silenciar'), findsOneWidget);
  });

  testWidgets('who administers: "Administras tú", with Agregar and Editar, honest that they are not here yet', (
    tester,
  ) async {
    await openGroupInfo(tester, name: 'Taller', engine: engineWithOwnGroup());
    expect(find.text('3 miembros · Administras tú'), findsOneWidget);
    final rows = tester.widgetList<ListRow>(find.byType(ListRow)).toList();
    expect(
      [for (final row in rows.take(3)) (row.title, row.subtitle)],
      [(FakeTrinoEngine.demoName, 'Administra'), ('Ana Torres', null), ('Lucía', null)],
    );
    for (final label in ['Agregar', 'Editar']) {
      expect(tester.getSemantics(find.bySemanticsLabel(label)), isSemantics(isButton: true, hasTapAction: true));
      await tester.tap(find.text(label));
      await tester.pump();
      expect(find.text('Aún no está disponible en esta versión.'), findsOneWidget, reason: label);
      ScaffoldMessenger.of(tester.element(find.byType(GroupInfoScreen))).removeCurrentSnackBar();
      await tester.pumpAndSettle();
    }
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('leaving is at the end, in red, asks first and goes back to the chats', (tester) async {
    await openGroupInfo(tester);
    await tester.ensureVisible(find.text('Salir del grupo'));
    final row = tester.widget<ListRow>(find.ancestor(of: find.text('Salir del grupo'), matching: find.byType(ListRow)));
    expect(row.danger, isTrue);
    expect(tester.getCenter(find.text('Salir del grupo')).dy, greaterThan(tester.getCenter(find.text(membersNote)).dy));

    await tapText(tester, 'Salir del grupo');
    expect(find.text('¿Salir de Familia?'), findsOneWidget);
    expect(
      find.text('Ya no te van a llegar los mensajes de Familia, y el chat se borra de este celular.'),
      findsOneWidget,
    );
    await tapText(tester, 'Cancelar');
    expect(find.byType(GroupInfoScreen), findsOneWidget);

    await tapText(tester, 'Salir del grupo');
    await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('Salir del grupo')));
    await tester.pumpAndSettle();
    expect(find.byType(ChatsScreen), findsOneWidget);
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.text('Saliste de Familia.'), findsOneWidget);
    expect(find.text('Familia'), findsNothing);
  });

  testWidgets('in English, the line under the name and "(you)"', (tester) async {
    final engine = engineWithOwnGroup();
    await pumpApp(tester, engine: engine, locale: const Locale('en'));
    await openChat(tester, 'Familia');
    await tester.tap(find.descendant(of: find.byKey(ChatScreen.headerKey), matching: find.text('Familia')));
    await tester.pumpAndSettle();
    expect(find.text('3 members · Mamá is the admin'), findsOneWidget);
    expect(find.text('(you)'), findsOneWidget);
  });
}
