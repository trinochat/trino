import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/avatar.dart';

import '../support/harness.dart';

BoxDecoration decorationOf(WidgetTester tester) =>
    tester
            .widget<DecoratedBox>(
              find.descendant(of: find.byType(TrinoAvatar), matching: find.byType(DecoratedBox)).first,
            )
            .decoration
        as BoxDecoration;

void main() {
  test('initials are the first letters of the first two words', () {
    expect(initialsOf('Ana Torres'), 'AT');
    expect(initialsOf('Familia'), 'F');
    expect(initialsOf('carlos méndez'), 'CM');
    expect(initialsOf('  Lucía  '), 'L');
    expect(initialsOf('Ñandú Pérez Gómez'), 'ÑP');
    expect(initialsOf(''), '');
  });

  group('TrinoAvatar', () {
    testWidgets('follows the accent: accentText initials on accentSoft', (tester) async {
      await pumpThemed(tester, const TrinoAvatar(name: 'Ana Torres'), accent: TrinoAccent.morado);
      final t = tokensIn(tester);
      expect(find.text('AT'), findsOneWidget);
      expect(decorationOf(tester).color, t.accentSoft);
      expect(colorOfText(tester, 'AT'), t.accentText);
    });

    testWidgets('people are round in Calma and take the avatar radius in Terminal', (tester) async {
      await pumpThemed(tester, const TrinoAvatar(name: 'Ana Torres'));
      expect(decorationOf(tester).shape, BoxShape.circle);
      await pumpThemed(tester, const TrinoAvatar(name: 'Ana Torres'), style: TrinoStyle.terminal);
      expect(decorationOf(tester).borderRadius, BorderRadius.circular(4));
    });

    testWidgets('groups are squared with the theme radius', (tester) async {
      await pumpThemed(tester, const TrinoAvatar(name: 'Familia', kind: AvatarKind.group));
      expect(decorationOf(tester).borderRadius, BorderRadius.circular(10));
      await pumpThemed(tester, const TrinoAvatar(name: 'Familia', kind: AvatarKind.group, size: 96));
      expect(decorationOf(tester).borderRadius, BorderRadius.circular(14));
    });

    testWidgets('a message request shows "?" in the warning colours', (tester) async {
      await pumpThemed(tester, const TrinoAvatar(name: 'Desconocido', kind: AvatarKind.request));
      final t = tokensIn(tester);
      expect(find.text('?'), findsOneWidget);
      expect(decorationOf(tester).color, t.warnBg);
      expect(colorOfText(tester, '?'), t.warn);
    });

    testWidgets('is decoration beside a visible name, unless it gets a label', (tester) async {
      await pumpThemed(
        tester,
        const Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TrinoAvatar(name: 'Ana Torres'),
            TrinoAvatar(name: 'Lucía', semanticLabel: 'Foto de Lucía'),
          ],
        ),
      );
      expect(find.bySemanticsLabel('AT'), findsNothing);
      expect(find.bySemanticsLabel('Foto de Lucía'), findsOneWidget);
      expect(tester.getSize(find.byType(TrinoAvatar).first), const Size(48, 48));
    });

    testWidgets('keeps its initials inside at a large text scale', (tester) async {
      await pumpThemed(tester, const TrinoAvatar(name: 'Carlos Méndez', size: 40), textScale: 2);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.text('CM')).width, lessThanOrEqualTo(40));
    });
  });
}
