// The tablet: from 600 dp wide a rail of the four sections on the left and two
// panes, the list and what was opened from it; from 1200 dp the info of a
// chat as a third pane. Under 600 dp the phone app, which the other tests
// cover, stays as it is.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/ui/chat_row.dart';

import '../support/app_harness.dart';

const rail = ValueKey('nav-rail');
const listPane = ValueKey('list-pane');
const detailPane = ValueKey('detail-pane');

Finder inRail(String label) => find.descendant(of: find.byKey(rail), matching: find.text(label));
Finder inList(Finder finder) => find.descendant(of: find.byKey(listPane), matching: finder);
Finder rowOf(String name) => find.ancestor(of: inList(find.text(name)), matching: find.byType(ChatRow));

Future<void> tapRail(WidgetTester tester, String label) async {
  await tester.tap(inRail(label));
  await tester.pumpAndSettle();
}

void main() {
  group('from 600 dp', () {
    testWidgets('a rail of the four sections takes the place of the bottom tabs', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      expect(find.byKey(const ValueKey('bottom-tabs')), findsNothing);
      expect(find.byKey(rail), findsOneWidget);
      expect(tester.getSize(find.byKey(rail)).width, 76);
      expect(tester.getTopLeft(find.byKey(rail)).dx, 0);
      for (final label in ['Llamadas', 'Chats', 'Contactos', 'Ajustes']) {
        expect(inRail(label), findsOneWidget);
      }
      expect(tester.getSemantics(find.byKey(rail)), isSemantics(role: SemanticsRole.navigation, label: 'Secciones'));
      // Each section is a real button that says whether it is the one shown.
      expect(tester.getSemantics(inRail('Chats')), isSemantics(isButton: true, isSelected: true, hasTapAction: true));
      expect(tester.getSemantics(inRail('Contactos')), isSemantics(isButton: true, isSelected: false));
      final t = tokensIn(tester);
      expect(fillOf(tester, inRail('Chats')), t.accentSoft);
      expect(colorOfText(tester, 'Ajustes'), t.muted);

      await tapRail(tester, 'Contactos');
      expect(find.text('Agregar con código o QR'), findsOneWidget);
      expect(tester.getSemantics(inRail('Contactos')), isSemantics(isSelected: true));
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('the rail counts the missed calls on Llamadas', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      expect(find.descendant(of: find.byKey(rail), matching: find.text('1')), findsOneWidget);
      expect(tester.getSemantics(inRail('Llamadas')).label, contains('1 llamada perdida'));
      await tapRail(tester, 'Llamadas');
      expect(find.descendant(of: find.byKey(rail), matching: find.text('1')), findsNothing);
      expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Llamadas')), findsOneWidget);
    });

    testWidgets('lying down: the list is 340 dp, and with no chat chosen the right pane says so', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      expect(tester.getSize(find.byKey(listPane)).width, 340);
      expect(tester.getTopLeft(find.byKey(listPane)).dx, 76);
      expect(find.text('Elige un chat para leerlo aquí'), findsOneWidget);
      expect(
        find.descendant(of: find.byKey(detailPane), matching: find.byType(TrinoIcon)),
        findsOneWidget,
        reason: 'the outline chats icon above the words',
      );
      // Landmarks, list first, for screen readers and the keyboard.
      expect(tester.getSemantics(find.byKey(listPane)), isSemantics(role: SemanticsRole.region, label: 'Chats'));
      expect(tester.getSemantics(find.byKey(detailPane)), isSemantics(role: SemanticsRole.region));
      expect(
        tester.getTopLeft(find.byKey(detailPane)).dx,
        greaterThanOrEqualTo(tester.getTopRight(find.byKey(listPane)).dx),
      );
    });

    testWidgets('standing up: the list narrows to about 300 dp and both panes still fit', (tester) async {
      await pumpApp(tester, size: tabletPortrait);
      expect(tester.getSize(find.byKey(listPane)).width, closeTo(300, 4));
      expect(find.text('Elige un chat para leerlo aquí'), findsOneWidget);
    });

    testWidgets('a chat opens in the right pane, without its back button, highlighted in the list', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      await tester.tap(inList(find.text('Ana Torres')));
      await tester.pumpAndSettle();
      expect(find.text('Elige un chat para leerlo aquí'), findsNothing);
      final chat = find.descendant(of: find.byKey(detailPane), matching: find.byType(ChatScreen));
      expect(chat, findsOneWidget);
      expect(find.descendant(of: chat, matching: find.text('Perfecto, nos vemos el jueves')), findsOneWidget);
      // Not pushed: the list is still beside it.
      expect(Navigator.of(tester.element(chat)).canPop(), isFalse);
      expect(find.descendant(of: find.byType(LargeTitleBar), matching: find.text('Chats')), findsOneWidget);
      expect(find.bySemanticsLabel('Volver'), findsNothing);
      // The open chat stands out in the list, and says so.
      final t = tokensIn(tester);
      final highlight = find.descendant(of: rowOf('Ana Torres'), matching: find.byKey(ChatRow.highlightKey));
      expect((tester.widget<DecoratedBox>(highlight).decoration as BoxDecoration).color, t.accentSoft);
      expect(find.descendant(of: rowOf('Lucía'), matching: find.byKey(ChatRow.highlightKey)), findsNothing);
      expect(tester.getSemantics(inList(find.text('Ana Torres'))), isSemantics(isSelected: true));
      expect(tester.getSemantics(inList(find.text('Lucía'))), isSemantics(isSelected: false));

      await tester.tap(inList(find.text('Familia')));
      await tester.pumpAndSettle();
      expect(find.descendant(of: find.byKey(detailPane), matching: find.byType(ChatScreen)), findsOneWidget);
      expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).chat.title, 'Familia');
      expect(tester.getSemantics(inList(find.text('Ana Torres'))), isSemantics(isSelected: false));
      expect(tester.getSemantics(inList(find.text('Familia'))), isSemantics(isSelected: true));
    });

    testWidgets('the conversation keeps a readable width, centred in its pane', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await tester.tap(inList(find.text('Ana Torres')));
      await tester.pumpAndSettle();
      final pane = tester.getRect(find.byKey(detailPane));
      expect(pane.width, greaterThan(800));
      final list = tester.getRect(find.bySemanticsLabel('Mensajes'));
      expect(list.width, 720);
      expect(list.center.dx, closeTo(pane.center.dx, 1));
    });

    testWidgets('a call from the pane still opens full screen', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      await tester.tap(inList(find.text('Ana Torres')));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Llamar'));
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(CallScreen)), tabletLandscape);
    });

    testWidgets('a chat opened from Contactos shows in the pane, on Chats', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      await tapRail(tester, 'Contactos');
      await tester.tap(find.text('Carlos Méndez'));
      await tester.pumpAndSettle();
      expect(tester.widget<ChatScreen>(find.byType(ChatScreen)).chat.title, 'Carlos Méndez');
      expect(Navigator.of(tester.element(find.byType(ChatScreen))).canPop(), isFalse);
      expect(tester.getSemantics(inRail('Chats')), isSemantics(isSelected: true));
      expect(tester.getSemantics(inList(find.text('Carlos Méndez'))), isSemantics(isSelected: true));
    });
  });

  testWidgets('a phone keeps the bottom tabs and pushes the chat', (tester) async {
    await pumpApp(tester);
    expect(find.byKey(rail), findsNothing);
    expect(find.byKey(const ValueKey('bottom-tabs')), findsOneWidget);
    await openChat(tester, 'Ana Torres');
    expect(Navigator.of(tester.element(find.byType(ChatScreen))).canPop(), isTrue);
    expect(find.bySemanticsLabel('Volver'), findsOneWidget);
  });
}
