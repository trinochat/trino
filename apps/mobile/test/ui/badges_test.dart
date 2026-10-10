import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/trust_badge.dart';
import 'package:trino_mobile/ui/unread_badge.dart';

import '../support/harness.dart';

void main() {
  group('TrustBadge', () {
    testWidgets('compact: the verified shield alone, in the accent, named for screen readers', (tester) async {
      await pumpThemed(tester, const TrustBadge(kind: TrustKind.verified, label: 'Verificado', compact: true));
      final t = tokensIn(tester);
      final icon = tester.widget<TrinoIcon>(find.byType(TrinoIcon));
      expect(icon.icon, TrinoIcons.shieldCheck);
      expect(painterOf<TrinoIconPainter>(tester, find.byType(TrinoIcon)).color, t.accentText);
      expect(find.text('Verificado'), findsNothing);
      expect(tester.getSemantics(find.byType(TrustBadge)).label, 'Verificado');
    });

    testWidgets('full: the shield and the label', (tester) async {
      await pumpThemed(tester, const TrustBadge(kind: TrustKind.verified, label: 'Verificada'));
      final t = tokensIn(tester);
      expect(find.text('Verificada'), findsOneWidget);
      expect(colorOfText(tester, 'Verificada'), t.accentText);
      expect(find.byType(TrinoIcon), findsOneWidget);
    });

    testWidgets('a changed key warns; an unverified contact stays quiet', (tester) async {
      await pumpThemed(
        tester,
        const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TrustBadge(kind: TrustKind.keyChanged, label: 'La clave cambió'),
            TrustBadge(kind: TrustKind.unverified, label: 'Sin verificar'),
          ],
        ),
      );
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'La clave cambió'), t.warn);
      expect(tester.widget<TrinoIcon>(find.byType(TrinoIcon)).icon, TrinoIcons.shieldAlert);
      expect(colorOfText(tester, 'Sin verificar'), t.muted);
      // Only "verified" uses the accent, and only a change warns with an icon.
      expect(find.byType(TrinoIcon), findsOneWidget);
    });
  });

  group('UnreadBadge', () {
    testWidgets('shows nothing at zero', (tester) async {
      await pumpThemed(tester, const UnreadBadge(count: 0, semanticLabel: '0 sin leer'));
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('shows the count in the badge colours and reads it with its words', (tester) async {
      await pumpThemed(tester, const UnreadBadge(count: 3, semanticLabel: '3 sin leer'));
      final t = tokensIn(tester);
      expect(find.text('3'), findsOneWidget);
      expect(colorOfText(tester, '3'), t.badgeInk);
      expect(fillOf(tester, find.text('3')), t.badge);
      expect(tester.getSemantics(find.byType(UnreadBadge)).label, '3 sin leer');
      final size = tester.getSize(find.byType(UnreadBadge));
      expect(size.height, greaterThanOrEqualTo(20));
      expect(size.width, greaterThanOrEqualTo(20));
    });

    testWidgets('caps long counts at 99+', (tester) async {
      await pumpThemed(tester, const UnreadBadge(count: 120, semanticLabel: '120 sin leer'));
      expect(find.text('99+'), findsOneWidget);
      expect(tester.getSemantics(find.byType(UnreadBadge)).label, '120 sin leer');
    });
  });
}
