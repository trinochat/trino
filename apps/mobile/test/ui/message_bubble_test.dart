import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/message_bubble.dart';

import '../support/harness.dart';

void main() {
  group('MessageBubble', () {
    testWidgets('incoming: its own bubble tokens, with the time in muted', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(direction: BubbleDirection.incoming, text: 'Sí, ya lo revisé.', time: '10:35'),
        center: false,
      );
      final t = tokensIn(tester);
      expect(fillOf(tester, find.text('Sí, ya lo revisé.')), t.bubbleIn);
      expect(colorOfText(tester, 'Sí, ya lo revisé.'), t.bubbleInInk);
      expect(colorOfText(tester, '10:35'), t.muted);
      expect(find.byType(StatusTicks), findsNothing);
    });

    testWidgets('outgoing: the accent bubble, the time and a check once sent', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(
          direction: BubbleDirection.outgoing,
          text: '¿Te llegó el documento?',
          time: '10:31',
          status: (state: DeliveryState.sent, label: 'Enviado'),
        ),
        accent: TrinoAccent.azul,
        center: false,
      );
      final t = tokensIn(tester);
      expect(t.bubbleMe, isNot(kThemes[ThemeId.calmaLight]!.bubbleMe), reason: 'your bubbles follow the accent');
      expect(fillOf(tester, find.text('¿Te llegó el documento?')), t.bubbleMe);
      expect(colorOfText(tester, '¿Te llegó el documento?'), t.bubbleMeInk);
      expect(colorOfText(tester, '10:31'), t.bubbleMeMuted);
      expect(tester.widget<TrinoIcon>(find.byType(TrinoIcon)).icon, TrinoIcons.check);
    });

    testWidgets('a clock while sending', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(
          direction: BubbleDirection.outgoing,
          text: '¿El jueves a las 6?',
          time: '10:38',
          status: (state: DeliveryState.sending, label: 'Enviando'),
        ),
        center: false,
      );
      expect(tester.widget<TrinoIcon>(find.byType(TrinoIcon)).icon, TrinoIcons.clock);
    });

    testWidgets('a failed message says so under the bubble, with the retry button', (tester) async {
      var retries = 0;
      await pumpThemed(
        tester,
        MessageBubble(
          direction: BubbleDirection.outgoing,
          text: 'Te paso la dirección luego',
          time: '18:30',
          status: (state: DeliveryState.failed, label: 'No se envió'),
          failure: (text: 'No se envió.', retry: TrinoButton(label: 'Reintentar', onPressed: () => retries++)),
        ),
        center: false,
      );
      final t = tokensIn(tester);
      expect(tester.widget<TrinoIcon>(find.byType(TrinoIcon).first).icon, TrinoIcons.alertCircle);
      expect(colorOfText(tester, 'No se envió.'), t.danger);
      await tester.tap(find.text('Reintentar'));
      expect(retries, 1);
    });

    testWidgets('in a group, the sender goes on top in the accent', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(
          direction: BubbleDirection.incoming,
          sender: 'Mamá',
          text: '¿Quién trae el pan?',
          time: '08:50',
        ),
        center: false,
      );
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'Mamá'), t.accentText);
      expect(tester.getTopLeft(find.text('Mamá')).dy, lessThan(tester.getTopLeft(find.text('¿Quién trae el pan?')).dy));
    });

    testWidgets('keeps line breaks and leaves room on the other side', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(
          direction: BubbleDirection.incoming,
          text: 'Una línea\nOtra línea, y un texto bastante más largo para que la burbuja quiera ocupar todo el ancho',
          time: '10:35',
        ),
        center: false,
      );
      final screen = tester.getSize(find.byType(Scaffold)).width;
      final bubble = tester.getSize(find.byKey(MessageBubble.bubbleKey));
      expect(bubble.width, lessThanOrEqualTo(screen * 0.8));
      expect(tester.getSize(find.textContaining('Una línea')).height, greaterThan(40));
    });

    testWidgets('sit on their side, with the time at the end, even in a centred column', (tester) async {
      await pumpThemed(
        tester,
        const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            MessageBubble(
              direction: BubbleDirection.incoming,
              text: 'Sí, ya lo revisé. Está todo bien.',
              time: '10:35',
            ),
            MessageBubble(direction: BubbleDirection.outgoing, text: 'Hola', time: '10:36'),
          ],
        ),
      );
      final screen = tester.getSize(find.byType(Scaffold)).width;
      final incoming = tester.getRect(find.byKey(MessageBubble.bubbleKey).first);
      final outgoing = tester.getRect(find.byKey(MessageBubble.bubbleKey).last);
      expect(incoming.left, 0);
      expect(outgoing.right, screen);
      // The time ends where the text's room ends, not after the text.
      expect(tester.getRect(find.text('10:35')).right, closeTo(incoming.right - 12, 1));
      expect(tester.getRect(find.text('10:36')).right, lessThan(outgoing.right - 12 + 1));
    });

    testWidgets('reads as one item: sender, text, time and state', (tester) async {
      await pumpThemed(
        tester,
        const MessageBubble(
          direction: BubbleDirection.outgoing,
          text: 'Yo lo compro de camino',
          time: '08:55',
          status: (state: DeliveryState.sent, label: 'Enviado'),
        ),
        center: false,
      );
      final label = tester.getSemantics(find.byKey(MessageBubble.bubbleKey)).label;
      expect(label, contains('Yo lo compro de camino'));
      expect(label, contains('08:55'));
      expect(label, contains('Enviado'));
    });
  });
}
