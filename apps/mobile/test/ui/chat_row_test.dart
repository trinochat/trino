import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/chat_row.dart';
import 'package:trino_mobile/ui/trust_badge.dart';

import '../support/harness.dart';

void main() {
  group('ChatRow', () {
    Widget ana({VoidCallback? onTap}) => ChatRow(
      name: 'Ana Torres',
      preview: 'Perfecto, nos vemos el jueves',
      time: '10:42',
      unread: (count: 1, label: '1 sin leer'),
      trust: (kind: TrustKind.verified, label: 'Verificado'),
      onTap: onTap ?? () {},
    );

    testWidgets('shows the name, the shield, the preview, the time and the unread count', (tester) async {
      await pumpThemed(tester, ana(), center: false);
      final t = tokensIn(tester);
      expect(find.text('Ana Torres'), findsOneWidget);
      expect(find.text('AT'), findsOneWidget);
      expect(tester.widget<TrinoIcon>(find.byType(TrinoIcon)).icon, TrinoIcons.shieldCheck);
      expect(find.text('Perfecto, nos vemos el jueves'), findsOneWidget);
      expect(colorOfText(tester, 'Perfecto, nos vemos el jueves'), t.muted);
      expect(find.text('10:42'), findsOneWidget);
      expect(tester.widget<Text>(find.text('10:42')).style!.fontFamily, t.mono);
      expect(find.text('1'), findsOneWidget);
    });

    testWidgets('puts the draft prefix before the preview, in the accent', (tester) async {
      await pumpThemed(
        tester,
        ChatRow(
          name: 'Carlos Méndez',
          preview: 'Mañana te confirmo la hora',
          draftPrefix: 'Borrador:',
          time: 'Ayer',
          onTap: () {},
        ),
        center: false,
      );
      final t = tokensIn(tester);
      final rich = tester.widget<RichText>(
        find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().startsWith('Borrador:')),
      );
      final spans = leafSpans(rich.text);
      expect(spans.first.text, 'Borrador: ');
      expect(spans.first.style!.color, t.accentText);
      expect(spans.last.text, 'Mañana te confirmo la hora');
    });

    testWidgets('is one button for screen readers, read in order', (tester) async {
      var taps = 0;
      await pumpThemed(tester, ana(onTap: () => taps++), center: false);
      final node = tester.getSemantics(find.byType(ChatRow));
      expect(node, isSemantics(isButton: true, hasTapAction: true));
      final label = node.label;
      final parts = ['Ana Torres', 'Verificado', 'Perfecto, nos vemos el jueves', '10:42', '1 sin leer'];
      final positions = parts.map(label.indexOf).toList();
      expect(positions, everyElement(greaterThanOrEqualTo(0)), reason: label);
      expect(positions, orderedEquals([...positions]..sort()), reason: label);
      await tester.tap(find.byType(ChatRow));
      expect(taps, 1);
      expect(tester.getSize(find.byType(ChatRow)).height, greaterThanOrEqualTo(64));
    });

    testWidgets('cuts long text to one line instead of overflowing, even at twice the text size', (tester) async {
      await pumpThemed(
        tester,
        SizedBox(
          width: 320,
          child: ChatRow(
            name: 'Una persona con un nombre larguísimo que no cabe',
            preview: 'Un mensaje muy largo que tampoco cabe en una sola línea de la bandeja de entrada',
            time: 'Ayer',
            unread: (count: 12, label: '12 sin leer'),
            onTap: () {},
          ),
        ),
        textScale: 2,
      );
      expect(tester.takeException(), isNull);
    });
  });
}
