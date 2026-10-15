import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/ui/avatar.dart';
import 'package:trino_mobile/ui/call_event_line.dart';
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
    // The state in words under the name, not a coloured label.
    expect(find.descendant(of: header, matching: find.text('Verificada')), findsOneWidget);
    expect(colorOfText(tester, 'Verificada'), tokensIn(tester, find.byType(ChatScreen)).muted);
    expect(tester.getSemantics(find.text('Ana Torres')).label, 'Ana Torres\nVerificada');
    await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
  });

  testWidgets('an unverified contact says so in words, and a changed key warns', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Carlos Méndez');
    final header = find.byKey(ChatScreen.headerKey);
    expect(find.descendant(of: header, matching: find.text('Sin verificar')), findsOneWidget);
    expect(find.descendant(of: header, matching: find.byType(TrustBadge)), findsNothing);

    await pumpScreen(
      tester,
      const ChatScreen(
        chat: ChatSummary(
          id: 'changed',
          kind: ChatKind.direct,
          title: 'Carlos Méndez',
          contactId: 'carlos',
          trust: Trust.keyChanged,
        ),
      ),
    );
    expect(find.text('Su clave cambió'), findsOneWidget);
    expect(colorOfText(tester, 'Su clave cambió'), tokensIn(tester, find.byType(ChatScreen)).warn);
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

  testWidgets('calls show as a centred line with icon, words and time, never as bubbles', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Ana Torres');
    expect(find.byKey(MessageBubble.bubbleKey), findsNWidgets(4));
    final t = tokensIn(tester, find.byType(ChatScreen));

    final outgoing = find.widgetWithText(CallEventLine, 'Llamada saliente · 4 min · 10:36');
    expect(outgoing, findsOneWidget);
    expect(tester.widget<CallEventLine>(outgoing).icon, TrinoIcons.phoneOutgoing);
    expect(colorOfText(tester, 'Llamada saliente · 4 min · 10:36'), t.muted);

    // Missed: the word and the icon say it; the danger colour only repeats it.
    final missed = find.widgetWithText(CallEventLine, 'Llamada perdida · 10:44');
    expect(missed, findsOneWidget);
    expect(tester.widget<CallEventLine>(missed).icon, TrinoIcons.phoneMissed);
    expect(colorOfText(tester, 'Llamada perdida · 10:44'), t.danger);
    expect(painterOf<TrinoIconPainter>(tester, missed).color, t.danger);
    expect(fillOf(tester, find.text('Llamada perdida · 10:44')), isNull, reason: 'a line, not a pill');
    expect(tester.getCenter(missed).dx, closeTo(tester.getCenter(find.byType(ChatScreen)).dx, 1), reason: 'centred');
    // In time order: the outgoing call (10:36) sits between the 10:35 and 10:38 messages.
    final y = tester.getCenter(outgoing).dy;
    expect(y, greaterThan(tester.getCenter(find.text('Sí, ya lo revisé. Está todo bien.')).dy));
    expect(y, lessThan(tester.getCenter(find.text('¿El jueves a las 6, entonces?')).dy));
  });

  testWidgets('an incoming call reads "Llamada entrante" with its length', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Carlos Méndez');
    expect(find.widgetWithText(CallEventLine, 'Llamada entrante · 12 min · 17:05'), findsOneWidget);
  });

  testWidgets('the composer: attach, "Mensaje", emoji and send', (tester) async {
    await pumpApp(tester);
    await openChat(tester, 'Lucía');
    expect(find.text('Mensaje'), findsOneWidget, reason: 'the hint of the field');
    final xs = [
      tester.getCenter(find.bySemanticsLabel('Adjuntar')).dx,
      tester.getCenter(find.byType(TextField)).dx,
      tester.getCenter(find.bySemanticsLabel('Emojis y stickers')).dx,
      tester.getCenter(find.bySemanticsLabel('Enviar')).dx,
    ];
    expect(xs, orderedEquals([...xs]..sort()), reason: 'in this order, left to right');
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
