import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/bottom_tabs.dart';
import 'package:trino_mobile/ui/segmented.dart';
import 'package:trino_mobile/ui/underline_tabs.dart';

import '../support/harness.dart';

void main() {
  group('TrinoSegmented', () {
    testWidgets('one choice of a group: the selected one is checked and filled with the accent', (tester) async {
      final picked = <TrinoStyle>[];
      await pumpThemed(
        tester,
        TrinoSegmented<TrinoStyle>(
          semanticLabel: 'Estilo',
          options: const [(value: TrinoStyle.calma, label: 'Calma'), (value: TrinoStyle.terminal, label: 'Terminal')],
          selected: TrinoStyle.calma,
          onChanged: picked.add,
        ),
      );
      final t = tokensIn(tester);
      expect(
        tester.getSemantics(find.text('Calma')),
        isSemantics(label: 'Calma', isInMutuallyExclusiveGroup: true, hasCheckedState: true, isChecked: true),
      );
      expect(tester.getSemantics(find.text('Terminal')), isSemantics(isChecked: false));
      expect(fillOf(tester, find.text('Calma')), t.accent);
      expect(colorOfText(tester, 'Calma'), t.accentInk);
      expect(colorOfText(tester, 'Terminal'), t.ink);
      await tester.tap(find.text('Terminal'));
      expect(picked, [TrinoStyle.terminal]);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
    });
  });

  group('UnderlineTabs', () {
    testWidgets('text tabs with an accent underline under the selected one', (tester) async {
      final picked = <int>[];
      await pumpThemed(
        tester,
        UnderlineTabs(
          labels: const ['Todos', 'No leídos', 'Grupos', 'Solicitudes'],
          selected: 0,
          onSelected: picked.add,
        ),
        center: false,
      );
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'Todos'), t.ink);
      expect(colorOfText(tester, 'No leídos'), t.muted);
      final indicator = tester.getRect(find.byKey(UnderlineTabs.indicatorKey));
      final todos = tester.getRect(find.text('Todos'));
      expect(indicator.left, lessThanOrEqualTo(todos.left));
      expect(indicator.right, greaterThanOrEqualTo(todos.right));
      expect(indicator.top, greaterThan(todos.bottom));
      expect(fillOf(tester, find.byKey(UnderlineTabs.indicatorKey)), t.accentText);
      await tester.tap(find.text('Grupos'));
      expect(picked, [2]);
    });

    testWidgets('reads as tabs, with the selected one and its place', (tester) async {
      await pumpThemed(
        tester,
        UnderlineTabs(labels: const ['Todos', 'No leídos', 'Grupos', 'Solicitudes'], selected: 1, onSelected: (_) {}),
        center: false,
      );
      final node = tester.getSemantics(find.text('No leídos'));
      expect(node, isSemantics(isSelected: true, hasSelectedState: true, hasTapAction: true));
      expect(node.label, contains('No leídos'));
      expect(node.label, contains('2'));
      expect(tester.getSemantics(find.text('Todos')), isSemantics(isSelected: false));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('the rule under the tabs spans the width, with the tabs from the start', (tester) async {
      await pumpThemed(
        tester,
        Column(
          children: [
            UnderlineTabs(labels: const ['Todos', 'Grupos'], selected: 0, onSelected: (_) {}),
          ],
        ),
        center: false,
      );
      expect(tester.getSize(find.byType(UnderlineTabs)).width, phoneSize.width);
      expect(tester.getTopLeft(find.text('Todos')).dx, lessThan(24));
    });

    testWidgets('scrolls instead of overflowing at a large text size', (tester) async {
      await pumpThemed(
        tester,
        UnderlineTabs(labels: const ['Todos', 'No leídos', 'Grupos', 'Solicitudes'], selected: 0, onSelected: (_) {}),
        textScale: 2,
        center: false,
      );
      expect(tester.takeException(), isNull);
    });
  });

  group('BottomTabs', () {
    const items = [
      (icon: TrinoIcons.chats, label: 'Chats'),
      (icon: TrinoIcons.contacts, label: 'Contactos'),
      (icon: TrinoIcons.settings, label: 'Ajustes'),
    ];

    testWidgets('the selected tab is in the accent with a bar; the rest in muted', (tester) async {
      final picked = <int>[];
      await pumpThemed(tester, BottomTabs(items: items, selected: 0, onSelected: picked.add), center: false);
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'Chats'), t.accentText);
      expect(colorOfText(tester, 'Ajustes'), t.muted);
      expect(find.byKey(BottomTabs.indicatorKey), findsOneWidget);
      await tester.tap(find.text('Ajustes'));
      expect(picked, [2]);
    });

    testWidgets('reads as tabs and gives each a 48 dp target', (tester) async {
      await pumpThemed(tester, BottomTabs(items: items, selected: 1, onSelected: (_) {}), center: false);
      final node = tester.getSemantics(find.text('Contactos'));
      expect(node, isSemantics(isSelected: true, hasTapAction: true));
      expect(node.label, contains('Contactos'));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('fits its labels at twice the text size', (tester) async {
      await pumpThemed(tester, BottomTabs(items: items, selected: 0, onSelected: (_) {}), textScale: 2, center: false);
      expect(tester.takeException(), isNull);
    });
  });
}
