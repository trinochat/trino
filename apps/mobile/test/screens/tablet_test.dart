// The tablet: from 600 dp wide a rail of the four sections on the left and two
// panes, the list and what was opened from it; from 1200 dp the info of a
// chat as a third pane. Under 600 dp the phone app, which the other tests
// cover, stays as it is.
import 'dart:ui' show SemanticsRole;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/screens/call_screen.dart';
import 'package:trino_mobile/screens/chat_screen.dart';
import 'package:trino_mobile/screens/common.dart';
import 'package:trino_mobile/screens/info/contact_info_screen.dart';
import 'package:trino_mobile/screens/info/group_info_screen.dart';
import 'package:trino_mobile/ui/chat_row.dart';

import '../support/app_harness.dart';

const rail = ValueKey('nav-rail');
const listPane = ValueKey('list-pane');
const detailPane = ValueKey('detail-pane');
const infoPane = ValueKey('info-pane');

Finder inRail(String label) => find.descendant(of: find.byKey(rail), matching: find.text(label));
Finder inList(Finder finder) => find.descendant(of: find.byKey(listPane), matching: finder);
Finder rowOf(String name) => find.ancestor(of: inList(find.text(name)), matching: find.byType(ChatRow));

Finder inDetail(Finder finder) => find.descendant(of: find.byKey(detailPane), matching: finder);
Finder inInfo(Finder finder) => find.descendant(of: find.byKey(infoPane), matching: finder);

Future<void> openInPane(WidgetTester tester, String name) async {
  await tester.tap(inList(find.text(name)));
  await tester.pumpAndSettle();
}

/// The chat header's avatar and name: one button.
Future<void> tapHeader(WidgetTester tester, String name) async {
  await tester.tap(inDetail(find.text(name)).first);
  await tester.pumpAndSettle();
}

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

  group('from 1200 dp, the info as a third pane', () {
    testWidgets('the header opens it beside the chat, and the toggle shows it and hides it', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await openInPane(tester, 'Ana Torres');
      final toggle = find.byKey(ChatScreen.infoToggleKey);
      expect(
        tester.getSemantics(toggle),
        isSemantics(label: 'Info', isButton: true, hasToggledState: true, isToggled: false),
      );
      expect(find.byKey(infoPane), findsNothing);

      await tapHeader(tester, 'Ana Torres');
      expect(find.byKey(infoPane), findsOneWidget);
      expect(inInfo(find.byType(ContactInfoScreen)), findsOneWidget);
      expect(tester.getSize(find.byKey(infoPane)).width, 320);
      expect(tester.getTopRight(find.byKey(infoPane)).dx, tabletWide.width);
      expect(Navigator.of(tester.element(find.byType(ContactInfoScreen))).canPop(), isFalse, reason: 'not a page');
      expect(tester.getSemantics(toggle), isSemantics(isToggled: true, hasToggledState: true));
      expect(tester.getSemantics(find.byKey(infoPane)), isSemantics(role: SemanticsRole.complementary, label: 'Info'));
      // Beside the chat there is nothing to go back to: it closes instead.
      expect(inInfo(find.bySemanticsLabel('Volver')), findsNothing);
      expect(inInfo(find.bySemanticsLabel('Cerrar la info')), findsOneWidget);
      // The chat is still there, narrower.
      expect(inDetail(find.text('Perfecto, nos vemos el jueves')), findsOneWidget);

      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsNothing);
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsOneWidget);
      await tester.tap(inInfo(find.bySemanticsLabel('Cerrar la info')));
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsNothing);
    });

    testWidgets('a group shows its info, and switching chats keeps the pane open', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await openInPane(tester, 'Ana Torres');
      await tapHeader(tester, 'Ana Torres');
      await openInPane(tester, 'Familia');
      expect(inInfo(find.byType(GroupInfoScreen)), findsOneWidget);
      expect(inInfo(find.byType(ContactInfoScreen)), findsNothing);
    });

    testWidgets('"Mensaje" in the pane closes it, back to the chat', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await openInPane(tester, 'Ana Torres');
      await tapHeader(tester, 'Ana Torres');
      await tester.tap(inInfo(find.text('Mensaje')));
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsNothing);
      expect(inDetail(find.byType(ChatScreen)), findsOneWidget);
    });

    testWidgets('deleting the chat from the pane closes the chat and its info', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await openInPane(tester, 'Ana Torres');
      await tapHeader(tester, 'Ana Torres');
      await tester.tap(inInfo(find.text('Borrar el chat')));
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(of: find.byType(Dialog), matching: find.text('Borrar el chat')));
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsNothing);
      expect(find.byType(ChatScreen), findsNothing);
      expect(find.text('Elige un chat para leerlo aquí'), findsOneWidget);
      expect(find.text('Se borró el chat.'), findsOneWidget);
    });

    testWidgets('Escape closes the info pane', (tester) async {
      await pumpApp(tester, size: tabletWide);
      await openInPane(tester, 'Ana Torres');
      await tapHeader(tester, 'Ana Torres');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byKey(infoPane), findsNothing);
      expect(inDetail(find.byType(ChatScreen)), findsOneWidget);
    });

    testWidgets('under 1200 dp there is no toggle, and the header opens the info as a page', (tester) async {
      await pumpApp(tester, size: tabletLandscape);
      await openInPane(tester, 'Ana Torres');
      expect(find.byKey(ChatScreen.infoToggleKey), findsNothing);
      await tapHeader(tester, 'Ana Torres');
      expect(find.byKey(infoPane), findsNothing);
      expect(Navigator.of(tester.element(find.byType(ContactInfoScreen))).canPop(), isTrue);
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
