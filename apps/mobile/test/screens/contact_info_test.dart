import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/info/contact_info_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/trust_badge.dart';

import '../support/app_harness.dart';

const blockBody =
    'No te va a llegar nada de Ana Torres: ni mensajes ni llamadas, y no se le avisa. El chat se queda en este '
    'celular, y puedes deshacerlo cuando quieras.';
const deleteBody =
    'Los mensajes se borran solo de este celular. Ana Torres conserva los suyos, y tus otros dispositivos también.';

/// Opens [name]'s chat and, from its header, the info.
Future<TestApp> openContactInfo(WidgetTester tester, {String name = 'Ana Torres', FakeTrinoEngine? engine}) async {
  final app = await pumpApp(tester, engine: engine);
  await openChat(tester, name);
  await tester.tap(find.descendant(of: find.byKey(ChatScreen.headerKey), matching: find.text(name)));
  await tester.pumpAndSettle();
  expect(find.byType(ContactInfoScreen), findsOneWidget);
  return app;
}

Future<void> tapText(WidgetTester tester, String text) async {
  await tester.ensureVisible(find.text(text).last);
  await tester.pumpAndSettle();
  await tester.tap(find.text(text).last);
  await tester.pumpAndSettle();
}

ListRow rowTitled(WidgetTester tester, String title) =>
    tester.widget<ListRow>(find.ancestor(of: find.text(title), matching: find.byType(ListRow)));

void main() {
  testWidgets('the avatar, the name with its shield, the state in words and three actions', (tester) async {
    await openContactInfo(tester);
    expect(find.byType(TrinoAvatar), findsOneWidget);
    expect(tester.getSize(find.byType(TrinoAvatar)).width, greaterThanOrEqualTo(80));
    expect(find.text('Ana Torres'), findsOneWidget);
    expect(tester.widget<TrustBadge>(find.byType(TrustBadge)).kind, TrustKind.verified);
    expect(find.text('Verificada'), findsOneWidget);
    expect(find.textContaining('@'), findsNothing, reason: 'the engine has no @nombre yet');
    for (final label in ['Mensaje', 'Llamar', 'Video']) {
      expect(tester.getSemantics(find.bySemanticsLabel(label)), isSemantics(isButton: true, hasTapAction: true));
    }
    final xs = [
      for (final label in ['Mensaje', 'Llamar', 'Video']) tester.getCenter(find.text(label)).dx,
    ];
    expect(xs, orderedEquals([...xs]..sort()));
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('shows only what the engine has: no photos, no disappearing messages, no search', (tester) async {
    await openContactInfo(tester);
    for (final missing in ['Fotos y archivos', 'Mensajes temporales', 'Buscar', 'Silenciar']) {
      expect(find.text(missing), findsNothing, reason: missing);
    }
  });

  testWidgets('the key in groups of four with its state in words', (tester) async {
    await openContactInfo(tester);
    final key = rowTitled(tester, 'Clave');
    expect(key.subtitle, '7F3A 91C2 0B5E D4A8 · Coinciden');
    expect(key.onTap, isNull, reason: 'nothing to open: keys are compared in a call');
  });

  testWidgets('a contact not compared yet says so', (tester) async {
    await openContactInfo(tester, name: 'Carlos Méndez');
    expect(find.text('Sin verificar'), findsOneWidget);
    expect(rowTitled(tester, 'Clave').subtitle, '2B91 C0D4 77E1 5A06 · Sin comparar');
  });

  testWidgets('no groups in common: "Ninguno", and nothing to open', (tester) async {
    await openContactInfo(tester);
    final row = rowTitled(tester, 'Grupos en común');
    expect((row.value, row.onTap), ('Ninguno', null));
  });

  testWidgets('one group in common opens it', (tester) async {
    final engine = testEngine()..addGroup(title: 'Taller', memberIds: const ['ana']);
    await openContactInfo(tester, engine: engine);
    expect(rowTitled(tester, 'Grupos en común').value, '1');
    await tapText(tester, 'Grupos en común');
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen).last).chat.title, 'Taller');
  });

  testWidgets('several groups in common open their list', (tester) async {
    final engine = testEngine()
      ..addGroup(title: 'Taller', memberIds: const ['ana'])
      ..addGroup(title: 'Viaje', memberIds: const ['ana', 'lucia']);
    await openContactInfo(tester, engine: engine);
    expect(rowTitled(tester, 'Grupos en común').value, '2');
    await tapText(tester, 'Grupos en común');
    expect(find.byType(CommonGroupsScreen), findsOneWidget);
    expect(find.text('Taller'), findsOneWidget);
    expect(find.text('Viaje'), findsOneWidget);
    await tapText(tester, 'Viaje');
    expect(tester.widget<ChatScreen>(find.byType(ChatScreen).last).chat.title, 'Viaje');
  });

  testWidgets('"Mensaje" goes back to the chat', (tester) async {
    await openContactInfo(tester);
    await tester.tap(find.text('Mensaje'));
    await tester.pumpAndSettle();
    expect(find.byType(ContactInfoScreen), findsNothing);
    expect(find.byType(ChatScreen), findsOneWidget);
  });

  testWidgets('"Llamar" calls by audio and "Video" with the camera on', (tester) async {
    final app = await openContactInfo(tester);
    await tester.tap(find.text('Llamar'));
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsOneWidget);
    expect((await tester.runAsync(() => app.engine.call.first))!.camera, isFalse);
    await tester.tap(find.bySemanticsLabel('Colgar'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Video'));
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsOneWidget);
    final call = await tester.runAsync(() => app.engine.call.first);
    expect((call!.contactId, call.camera), ('ana', true));
  });

  testWidgets('blocking and deleting are at the end, in red', (tester) async {
    await openContactInfo(tester);
    final t = tokensIn(tester, find.byType(ContactInfoScreen));
    for (final title in ['Bloquear a Ana Torres', 'Borrar el chat']) {
      expect(rowTitled(tester, title).danger, isTrue, reason: title);
      expect(colorOfText(tester, title), t.danger);
    }
    expect(
      tester.getCenter(find.text('Bloquear a Ana Torres')).dy,
      greaterThan(tester.getCenter(find.text('Grupos en común')).dy),
    );
  });

  testWidgets('blocking asks first and says honestly what happens; then it can be undone', (tester) async {
    final app = await openContactInfo(tester);
    Future<bool> blocked() async =>
        (await tester.runAsync(() => app.engine.contacts.first))!.firstWhere((c) => c.id == 'ana').blocked;

    await tapText(tester, 'Bloquear a Ana Torres');
    expect(find.text('¿Bloquear a Ana Torres?'), findsOneWidget);
    expect(find.text(blockBody), findsOneWidget);
    await tapText(tester, 'Cancelar');
    expect(await blocked(), isFalse);

    await tapText(tester, 'Bloquear a Ana Torres');
    await tapText(tester, 'Bloquear');
    expect(await blocked(), isTrue);
    expect(find.text('Bloqueaste a Ana Torres.'), findsOneWidget);
    expect(find.text('Desbloquear a Ana Torres'), findsOneWidget);
    expect(rowTitled(tester, 'Desbloquear a Ana Torres').danger, isFalse);

    await tapText(tester, 'Desbloquear a Ana Torres');
    expect(await blocked(), isFalse);
    expect(find.text('Desbloqueaste a Ana Torres.'), findsOneWidget);
    expect(find.text('Bloquear a Ana Torres'), findsOneWidget);
  });

  testWidgets('deleting the chat asks first, says it is only this phone, and goes back to the chats', (tester) async {
    await openContactInfo(tester);
    await tapText(tester, 'Borrar el chat');
    expect(find.text('¿Borrar el chat con Ana Torres?'), findsOneWidget);
    expect(find.text(deleteBody), findsOneWidget);
    await tapText(tester, 'Cancelar');
    expect(find.byType(ContactInfoScreen), findsOneWidget);

    await tapText(tester, 'Borrar el chat');
    await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('Borrar el chat')));
    await tester.pumpAndSettle();
    expect(find.byType(ContactInfoScreen), findsNothing);
    expect(find.byType(ChatScreen), findsNothing);
    expect(find.byType(ChatsScreen), findsOneWidget);
    expect(find.text('Se borró el chat.'), findsOneWidget);
    expect(find.text('Ana Torres'), findsNothing);
  });
}
