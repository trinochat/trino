import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/list_row.dart';
import 'package:trino_mobile/ui/switch_row.dart';

import '../support/harness.dart';

/// A switch row that keeps its own state, as a settings screen would.
class _Toggle extends StatefulWidget {
  const _Toggle({this.enabled = true});
  final bool enabled;
  @override
  State<_Toggle> createState() => _ToggleState();
}

class _ToggleState extends State<_Toggle> {
  bool value = false;
  @override
  Widget build(BuildContext context) => SwitchRow(
    title: 'Sonido de mensajes',
    description: 'Un sonido corto cuando llega un mensaje.',
    value: value,
    onChanged: widget.enabled ? (next) => setState(() => value = next) : null,
  );
}

void main() {
  group('SwitchRow', () {
    testWidgets('is one switch for screen readers, named by its title and description', (tester) async {
      await pumpThemed(tester, const _Toggle(), center: false);
      final node = tester.getSemantics(find.byType(SwitchRow));
      expect(node, isSemantics(hasToggledState: true, isToggled: false, isEnabled: true, hasTapAction: true));
      expect(node.label, contains('Sonido de mensajes'));
      expect(node.label, contains('Un sonido corto cuando llega un mensaje.'));
      expect(tester.getSize(find.byType(SwitchRow)).height, greaterThanOrEqualTo(56));
    });

    testWidgets('toggles from the row and from the switch', (tester) async {
      await pumpThemed(tester, const _Toggle(), center: false);
      await tester.tap(find.text('Sonido de mensajes'));
      await tester.pumpAndSettle();
      expect(tester.getSemantics(find.byType(SwitchRow)), isSemantics(isToggled: true));
      await tester.tap(find.byType(TrinoSwitch));
      await tester.pumpAndSettle();
      expect(tester.getSemantics(find.byType(SwitchRow)), isSemantics(isToggled: false));
    });

    testWidgets('stays put while disabled', (tester) async {
      await pumpThemed(tester, const _Toggle(enabled: false), center: false);
      await tester.tap(find.byType(SwitchRow));
      await tester.pumpAndSettle();
      expect(
        tester.getSemantics(find.byType(SwitchRow)),
        isSemantics(isToggled: false, isEnabled: false, hasEnabledState: true),
      );
    });

    testWidgets('draws the tracks and knobs of the desktop switch', (tester) async {
      await pumpThemed(tester, const _Toggle(), center: false);
      final t = tokensIn(tester);
      var painter = painterOf<SwitchPainter>(tester, find.byType(TrinoSwitch));
      expect((painter.track, painter.knob), (t.muted, t.surface));
      await tester.tap(find.byType(TrinoSwitch));
      await tester.pumpAndSettle();
      painter = painterOf<SwitchPainter>(tester, find.byType(TrinoSwitch));
      expect((painter.track, painter.knob), (t.accent, t.accentInk));
      expect(painter.position, 1);
    });
  });

  group('ListRow', () {
    testWidgets('shows its title, subtitle and value, with a chevron when it opens something', (tester) async {
      var taps = 0;
      await pumpThemed(
        tester,
        ListRow(
          icon: TrinoIcons.lock,
          title: 'Bloqueo automático',
          subtitle: 'Nunca se bloquea durante una llamada.',
          value: 'Tras 5 minutos',
          onTap: () => taps++,
        ),
        center: false,
      );
      expect(find.text('Bloqueo automático'), findsOneWidget);
      expect(find.text('Nunca se bloquea durante una llamada.'), findsOneWidget);
      expect(find.text('Tras 5 minutos'), findsOneWidget);
      expect(
        tester.widgetList<TrinoIcon>(find.byType(TrinoIcon)).map((icon) => icon.icon),
        containsAll([TrinoIcons.lock, TrinoIcons.chevronRight]),
      );
      final node = tester.getSemantics(find.byType(ListRow));
      expect(node, isSemantics(isButton: true, hasTapAction: true));
      expect(node.label, allOf(contains('Bloqueo automático'), contains('Tras 5 minutos')));
      await tester.tap(find.byType(ListRow));
      expect(taps, 1);
      expect(tester.getSize(find.byType(ListRow)).height, greaterThanOrEqualTo(56));
    });

    testWidgets('keeps the value and the chevron at the end of the row', (tester) async {
      await pumpThemed(
        tester,
        ListRow(icon: TrinoIcons.globe, title: 'Idioma', value: 'Español', onTap: () {}),
        center: false,
      );
      final chevron = tester.getRect(find.byType(TrinoIcon).last);
      expect(chevron.right, closeTo(phoneSize.width - 16, 1));
      expect(tester.getRect(find.text('Español')).right, closeTo(chevron.left - 6, 1));
    });

    testWidgets('an accent row writes its title and icon in the accent', (tester) async {
      await pumpThemed(
        tester,
        ListRow(icon: TrinoIcons.userPlus, title: 'Agregar contacto', accent: true, chevron: false, onTap: () {}),
        center: false,
      );
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'Agregar contacto'), t.accentText);
      expect(painterOf<TrinoIconPainter>(tester, find.byType(TrinoIcon)).color, t.accentText);
      expect(find.byType(TrinoIcon), findsOneWidget, reason: 'no chevron');
    });
  });

  group('ChoiceRow', () {
    testWidgets('one option of a group: checked, with its title and description, as one item', (tester) async {
      var taps = 0;
      await pumpThemed(
        tester,
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ChoiceRow(
              title: 'Solo el nombre (recomendado)',
              subtitle: 'Se ve quién escribe.',
              selected: true,
              onTap: () {},
            ),
            ChoiceRow(title: 'Nada', selected: false, onTap: () => taps++),
          ],
        ),
        center: false,
      );
      final checked = tester.getSemantics(find.text('Solo el nombre (recomendado)'));
      expect(checked, isSemantics(isInMutuallyExclusiveGroup: true, hasCheckedState: true, isChecked: true));
      expect(checked.label, contains('Se ve quién escribe.'));
      expect(tester.getSemantics(find.text('Nada')), isSemantics(isChecked: false, hasTapAction: true));
      await tester.tap(find.text('Nada'));
      expect(taps, 1);
      final t = tokensIn(tester);
      final radio = painterOf<RadioPainter>(tester, find.byType(ChoiceRow).first);
      expect((radio.ring, radio.selected), (t.accentText, true));
      expect(painterOf<RadioPainter>(tester, find.byType(ChoiceRow).last).ring, t.muted);
      expect(tester.getSize(find.byType(ChoiceRow).last).height, greaterThanOrEqualTo(56));
    });

    testWidgets('can follow the padding of the page it sits in', (tester) async {
      await pumpThemed(
        tester,
        ChoiceRow(title: 'Español', selected: true, padding: const EdgeInsets.symmetric(vertical: 10), onTap: () {}),
        center: false,
      );
      expect(tester.getTopLeft(find.byType(CustomPaint).last).dx, 0);
    });
  });
}
