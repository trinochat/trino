import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/chats_screen.dart';
import 'package:trino_mobile/screens/requests_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/banner.dart';

import '../support/app_harness.dart';

Future<TestApp> pumpRequests(WidgetTester tester, {double textScale = 1}) async {
  final app = await pumpApp(tester, textScale: textScale);
  await tester.tap(find.byKey(ChatsScreen.requestsRowKey));
  await tester.pumpAndSettle();
  return app;
}

Future<TestApp> pumpRequest(WidgetTester tester, String name, {double textScale = 1}) async {
  final app = await pumpRequests(tester, textScale: textScale);
  await tester.tap(find.byWidgetPredicate((w) => w is RequestRow && w.request.claimedName == name));
  await tester.pumpAndSettle();
  return app;
}

/// The plain text of every rich text under [finder], in order.
List<String> textsUnder(WidgetTester tester, Finder finder) => [
  for (final widget in tester.widgetList<RichText>(find.descendant(of: finder, matching: find.byType(RichText))))
    widget.text.toPlainText(),
];

Finder rowOf(String name) => find.byWidgetPredicate((w) => w is RequestRow && w.request.claimedName == name);

void main() {
  group('the list', () {
    testWidgets('the grey row opens it: titled "Solicitudes", with the notice at the top', (tester) async {
      await pumpRequests(tester);
      expect(find.byType(RequestsScreen), findsOneWidget);
      expect(tester.getSemantics(find.text('Solicitudes')), isSemantics(isHeader: true));
      expect(find.text('No son tus contactos. Nada de aquí suena ni se descarga hasta que aceptes.'), findsOneWidget);
      expect(tester.widgetList<RequestRow>(find.byType(RequestRow)).map((row) => row.request.claimedName), [
        'ana',
        'mara',
        'julián',
      ]);
    });

    testWidgets('each row: initials, "dice llamarse" and the name in bold, how it came and when', (tester) async {
      await pumpRequests(tester);
      final ana = textsUnder(tester, rowOf('ana'));
      expect(ana, contains('dice llamarse ana'));
      expect(ana, contains('por tu @nombre · hace 2 h'));
      expect(
        ana,
        contains('Hola, soy Ana, la del taller de cerámica. Te mando las fotos de la clase: www.ejemplo.com/fotos'),
      );
      final avatar = tester.widget<TrinoAvatar>(find.descendant(of: rowOf('ana'), matching: find.byType(TrinoAvatar)));
      expect((avatar.name, avatar.kind), ('ana', AvatarKind.person));
      final name = find.descendant(
        of: rowOf('ana'),
        matching: find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('dice llamarse')),
      );
      final spans = leafSpans(tester.widget<RichText>(name).text);
      expect(spans.last.text, 'ana');
      expect(spans.last.style?.fontWeight, FontWeight.w700);

      expect(textsUnder(tester, rowOf('julián')), contains('usó tu código «Trabajo» · Lun'));
    });

    testWidgets('from a group: the name with "~", and that the admin set it', (tester) async {
      await pumpRequests(tester);
      final mara = textsUnder(tester, rowOf('mara'));
      expect(mara, contains('dice llamarse ~mara'));
      expect(mara, contains('está en «Familia» contigo · Ayer'));
      expect(mara, contains('nombre que puso el admin'));
    });

    testWidgets('a name like a contact\'s: a line in the warning colour', (tester) async {
      await pumpRequests(tester);
      const text = 'Se parece a Ana Torres. Revisa la huella.';
      expect(find.descendant(of: rowOf('ana'), matching: find.text(text)), findsOneWidget);
      expect(colorOfText(tester, text), tokensIn(tester).warn);
      expect(find.descendant(of: rowOf('mara'), matching: find.textContaining('Se parece')), findsNothing);
    });

    testWidgets('a link\'s request says the link', (tester) async {
      final engine = testEngine();
      engine.receiveRequest(
        MessageRequest(
          id: 'req-nico',
          claimedName: 'nico',
          origin: RequestOrigin.link,
          originLabel: 'Taller',
          fingerprint: '1111 2222 3333 4444',
          receivedAt: testNow.subtract(const Duration(minutes: 5)),
          messages: [RequestMessage(text: 'Hola', sentAt: testNow)],
        ),
      );
      await pumpApp(tester, engine: engine);
      await tester.tap(find.byKey(ChatsScreen.requestsRowKey));
      await tester.pumpAndSettle();
      expect(textsUnder(tester, rowOf('nico')), contains('usó tu enlace «Taller» · hace 5 min'));
    });

    testWidgets('rows are buttons of 48 dp and more; the list fits at twice the text size', (tester) async {
      await pumpRequests(tester);
      expect(tester.getSemantics(rowOf('ana')), isSemantics(isButton: true, hasTapAction: true));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('fits at twice the text size', (tester) async {
      await pumpRequests(tester, textScale: 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets('says so in words when none is left', (tester) async {
      final app = await pumpRequests(tester);
      for (final id in ['req-ana', 'req-mara', 'req-julian']) {
        await app.engine.deleteRequest(id);
      }
      await tester.pumpAndSettle();
      expect(find.text('No tienes solicitudes.'), findsOneWidget);
    });
  });

  group('one request', () {
    testWidgets('the header: "dice llamarse", how it came and the short fingerprint', (tester) async {
      await pumpRequest(tester, 'ana');
      expect(find.byType(RequestScreen), findsOneWidget);
      final header = find.byKey(RequestScreen.headerKey);
      expect(textsUnder(tester, header), containsAll(['dice llamarse ana', 'por tu @nombre · huella 9D2E 4B70']));
      expect(
        tester.getSemantics(find.descendant(of: header, matching: find.byType(RichText)).first),
        isSemantics(isHeader: true),
      );
    });

    testWidgets('the resemblance as a warning banner', (tester) async {
      await pumpRequest(tester, 'ana');
      final banner = tester.widget<TrinoBanner>(find.byType(TrinoBanner));
      expect(
        (banner.tone, banner.message),
        (BannerTone.warn, 'Se parece a Ana Torres. Revisa la huella antes de aceptar.'),
      );
    });

    testWidgets('the message as plain text: its link cannot be tapped', (tester) async {
      await pumpRequest(tester, 'ana');
      const text = 'Hola, soy Ana, la del taller de cerámica. Te mando las fotos de la clase: www.ejemplo.com/fotos';
      expect(find.text(text), findsOneWidget);
      for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
        rich.text.visitChildren((span) {
          expect(span is TextSpan ? span.recognizer : null, isNull);
          return true;
        });
      }
      expect(find.ancestor(of: find.text(text), matching: find.byType(InkWell)), findsNothing);
      expect(find.ancestor(of: find.text(text), matching: find.byType(GestureDetector)), findsNothing);
    });

    testWidgets('a file is only described, and a call attempt is said in words', (tester) async {
      await pumpRequest(tester, 'ana');
      expect(find.text('Mandó un archivo (foto, 1,2 MB). Se descarga si aceptas.'), findsOneWidget);
      expect(find.text('ana intentó llamarte.'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('a group request explains the "~"', (tester) async {
      await pumpRequest(tester, 'mara');
      final header = find.byKey(RequestScreen.headerKey);
      expect(
        textsUnder(tester, header),
        containsAll([
          'dice llamarse ~mara',
          'está en «Familia» contigo · huella 4F81 0C2D',
          'nombre que puso el admin',
        ]),
      );
      expect(find.byType(TrinoBanner), findsNothing);
    });

    testWidgets('the actions: Aceptar primary; Bloquear and Reportar in the danger colour', (tester) async {
      await pumpRequest(tester, 'ana');
      final t = tokensIn(tester);
      expect(fillOf(tester, find.text('Aceptar')), t.accent);
      expect(colorOfText(tester, 'Bloquear'), t.danger);
      expect(colorOfText(tester, 'Reportar'), t.danger);
      expect(colorOfText(tester, 'Eliminar'), t.ink);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('Aceptar adds the contact and opens the new chat with the messages', (tester) async {
      final app = await pumpRequest(tester, 'julián');
      await tester.tap(find.text('Aceptar'));
      await tester.pumpAndSettle();
      expect(find.byType(ChatScreen), findsOneWidget);
      expect(find.text('Buenas, te escribo por lo del contrato'), findsOneWidget);
      expect((await app.engine.contacts.first).map((c) => c.name), contains('julián'));
      expect((await app.engine.requests.first).map((r) => r.id), isNot(contains('req-julian')));
      // Back goes to the requests, not to the closed request.
      await tester.tap(find.bySemanticsLabel('Volver'));
      await tester.pumpAndSettle();
      expect(find.byType(RequestsScreen), findsOneWidget);
    });

    testWidgets('Eliminar removes it, says what it means, and goes back', (tester) async {
      final app = await pumpRequest(tester, 'mara');
      await tester.tap(find.text('Eliminar'));
      await tester.pumpAndSettle();
      expect(find.byType(RequestScreen), findsNothing);
      expect(find.byType(RequestsScreen), findsOneWidget);
      expect(
        find.text('Eliminaste la solicitud. Lo que mande en los próximos 30 días no te va a llegar.'),
        findsOneWidget,
      );
      expect((await app.engine.requests.first).map((r) => r.id), ['req-ana', 'req-julian']);
    });

    testWidgets('Bloquear asks first; cancelling keeps the request', (tester) async {
      final app = await pumpRequest(tester, 'mara');
      await tester.tap(find.text('Bloquear'));
      await tester.pumpAndSettle();
      expect(find.text('¿Bloquear a mara?'), findsOneWidget);
      await tester.tap(find.text('Cancelar'));
      await tester.pumpAndSettle();
      expect(find.byType(RequestScreen), findsOneWidget);
      expect(await app.engine.requests.first, hasLength(3));
    });

    testWidgets('Bloquear, confirmed, blocks and goes back', (tester) async {
      final app = await pumpRequest(tester, 'mara');
      await tester.tap(find.text('Bloquear'));
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('Bloquear')));
      await tester.pumpAndSettle();
      expect(find.byType(RequestScreen), findsNothing);
      expect(find.text('Bloqueaste a mara.'), findsOneWidget);
      expect((await app.engine.requests.first).map((r) => r.id), ['req-ana', 'req-julian']);
    });

    testWidgets('Reportar sends the report, says only that, and keeps the request', (tester) async {
      final app = await pumpRequest(tester, 'ana');
      await tester.tap(find.text('Reportar'));
      await tester.pumpAndSettle();
      expect(app.engine.reportedRequests, ['req-ana']);
      expect(
        find.text('Se envió tu reporte. La solicitud sigue aquí: puedes eliminarla o bloquearla.'),
        findsOneWidget,
      );
      expect(find.byType(RequestScreen), findsOneWidget);
    });

    testWidgets('fits at twice the text size', (tester) async {
      await pumpRequest(tester, 'ana', textScale: 2);
      expect(tester.takeException(), isNull);
      expect(find.text('Reportar'), findsOneWidget);
    });
  });
}
