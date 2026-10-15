import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/day_separator.dart';
import 'package:trino_mobile/ui/icon_button.dart';
import 'package:trino_mobile/ui/message_bubble.dart';
import 'package:trino_mobile/ui/trust_badge.dart';

import '../support/app_harness.dart';

Finder bubbleWith(String text) => find.ancestor(of: find.text(text), matching: find.byKey(MessageBubble.bubbleKey));

TrinoIconButton sendButton(WidgetTester tester) => tester.widget<TrinoIconButton>(
  find.ancestor(of: find.bySemanticsLabel('Enviar'), matching: find.byType(TrinoIconButton)).first,
);

void main() {
  testWidgets('header: back, avatar, the name with its shield, and the call button', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    final header = find.byKey(ChatScreen.headerKey);
    expect(find.descendant(of: header, matching: find.bySemanticsLabel('Volver')), findsOneWidget);
    expect(find.descendant(of: header, matching: find.byType(TrinoAvatar)), findsOneWidget);
    expect(find.descendant(of: header, matching: find.text('Ana Torres')), findsOneWidget);
    expect(
      tester.widget<TrustBadge>(find.descendant(of: header, matching: find.byType(TrustBadge))).kind,
      TrustKind.verified,
    );
    expect(find.descendant(of: header, matching: find.bySemanticsLabel('Llamar')), findsOneWidget);
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('"Hoy", then the bubbles: mine in the accent bubble, with time and a check', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    final t = tokensIn(tester, find.byType(ChatScreen));
    expect(tester.widget<DaySeparator>(find.byType(DaySeparator)).label, 'Hoy');
    expect(fillOf(tester, find.text('¿Te llegó el documento que te mandé?')), t.bubbleMe);
    expect(fillOf(tester, find.text('Sí, ya lo revisé. Está todo bien.')), t.bubbleIn);
    expect(
      find.descendant(of: bubbleWith('¿Te llegó el documento que te mandé?'), matching: find.text('10:31')),
      findsOneWidget,
    );
    final ticks = tester.widget<StatusTicks>(
      find.descendant(of: bubbleWith('¿Te llegó el documento que te mandé?'), matching: find.byType(StatusTicks)),
    );
    expect((ticks.state, ticks.label), (DeliveryState.sent, 'Enviado'));
    expect(tester.getSemantics(bubbleWith('Perfecto, nos vemos el jueves')).label, contains('10:42'));
  });

  testWidgets('calls inside the chat never show as empty bubbles', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    expect(find.byKey(MessageBubble.bubbleKey), findsNWidgets(4));
  });

  testWidgets('a group shows who wrote each message', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Familia');
    expect(find.descendant(of: bubbleWith('Llego a las 7'), matching: find.text('Papá')), findsOneWidget);
    expect(find.text('3 miembros'), findsOneWidget);
    expect(find.bySemanticsLabel('Llamar'), findsNothing, reason: 'group calls do not exist yet');
  });

  testWidgets('the send button turns active with text, and sending adds the message', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Lucía');
    expect(sendButton(tester).onPressed, isNull);
    expect(sendButton(tester).variant, IconButtonVariant.muted);

    await tester.enterText(find.byType(TextField), '   ');
    await tester.pump();
    expect(sendButton(tester).onPressed, isNull, reason: 'spaces are not a message');

    await tester.enterText(find.byType(TextField), 'Te la mando ya');
    await tester.pump();
    expect(sendButton(tester).onPressed, isNotNull);
    expect(sendButton(tester).variant, IconButtonVariant.primary);

    await tester.tap(find.bySemanticsLabel('Enviar'));
    await tester.pumpAndSettle();
    expect(bubbleWith('Te la mando ya'), findsOneWidget);
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, isEmpty);
  });

  testWidgets('Enter writes a new line: the composer is multiline and sends only with its button', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Lucía');
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.keyboardType, TextInputType.multiline);
    expect(field.textInputAction, TextInputAction.newline);
    expect(field.maxLines, greaterThan(1));
    await tester.enterText(find.byType(TextField), 'Una\nDos');
    await tester.testTextInput.receiveAction(TextInputAction.newline);
    await tester.pumpAndSettle();
    expect(bubbleWith('Una\nDos'), findsNothing);
    await tester.tap(find.bySemanticsLabel('Enviar'));
    await tester.pumpAndSettle();
    expect(bubbleWith('Una\nDos'), findsOneWidget);
  });

  testWidgets('a failed message says so and retries', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Carlos Méndez');
    expect(find.text('No se envió.'), findsOneWidget);
    await tester.tap(find.text('Reintentar'));
    await tester.pumpAndSettle();
    expect(find.text('No se envió.'), findsNothing);
  });

  testWidgets('keeps a draft per chat', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Carlos Méndez');
    expect(tester.widget<TextField>(find.byType(TextField)).controller!.text, 'Mañana te confirmo la hora');

    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    await openChat(tester, 'Lucía');
    await tester.enterText(find.byType(TextField), 'Ya casi');
    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    final lucia = tester.widget<ChatRow>(find.ancestor(of: find.text('Lucía'), matching: find.byType(ChatRow)));
    expect((lucia.draftPrefix, lucia.preview), ('Borrador:', 'Ya casi'));
  });

  testWidgets('opening a chat reads it', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    await tester.tap(find.bySemanticsLabel('Volver'));
    await tester.pumpAndSettle();
    final ana = tester.widget<ChatRow>(find.ancestor(of: find.text('Ana Torres'), matching: find.byType(ChatRow)));
    expect(ana.unread?.count ?? 0, 0);
  });

  testWidgets('"+" and the emoji button say plainly that they are not here yet', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Lucía');
    for (final label in ['Adjuntar', 'Emojis y stickers']) {
      await tester.tap(find.bySemanticsLabel(label));
      await tester.pump();
      expect(find.text('Aún no está disponible en esta versión.'), findsOneWidget, reason: label);
      ScaffoldMessenger.of(tester.element(find.byType(ChatScreen))).removeCurrentSnackBar();
      await tester.pumpAndSettle();
    }
  });

  testWidgets('the call button opens the call', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    await tester.tap(find.bySemanticsLabel('Llamar'));
    await tester.pumpAndSettle();
    expect(find.byType(CallScreen), findsOneWidget);
  });
}
