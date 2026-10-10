import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/icon_button.dart';

import '../support/harness.dart';

void main() {
  group('TrinoIconButton', () {
    testWidgets('is named by its label, is 48 dp, and calls back on tap', (tester) async {
      var taps = 0;
      await pumpThemed(tester, TrinoIconButton(icon: TrinoIcons.phone, label: 'Llamar', onPressed: () => taps++));
      expect(tester.getSize(find.byType(TrinoIconButton)), const Size(48, 48));
      expect(
        tester.getSemantics(find.byType(TrinoIconButton)),
        isSemantics(label: 'Llamar', isButton: true, isEnabled: true, hasTapAction: true),
      );
      await tester.tap(find.byType(TrinoIconButton));
      expect(taps, 1);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('primary fills with the accent and draws in accentInk', (tester) async {
      await pumpThemed(
        tester,
        TrinoIconButton(icon: TrinoIcons.send, label: 'Enviar', variant: IconButtonVariant.primary, onPressed: () {}),
      );
      final t = tokensIn(tester);
      expect(fillOf(tester, find.byType(TrinoIcon)), t.accent);
      expect(painterOf<TrinoIconPainter>(tester, find.byType(TrinoIcon)).color, t.accentInk);
    });

    testWidgets('as a toggle it reports its state and turns accent when pressed', (tester) async {
      await pumpThemed(
        tester,
        TrinoIconButton(icon: TrinoIcons.mic, label: 'Silenciar', pressed: true, onPressed: () {}),
      );
      final t = tokensIn(tester);
      expect(
        tester.getSemantics(find.byType(TrinoIconButton)),
        isSemantics(label: 'Silenciar', hasToggledState: true, isToggled: true),
      );
      expect(fillOf(tester, find.byType(TrinoIcon)), t.accentSoft);
      expect(painterOf<TrinoIconPainter>(tester, find.byType(TrinoIcon)).color, t.accentText);
    });

    testWidgets('without a callback it is disabled', (tester) async {
      await pumpThemed(tester, const TrinoIconButton(icon: TrinoIcons.send, label: 'Enviar', onPressed: null));
      expect(
        tester.getSemantics(find.byType(TrinoIconButton)),
        isSemantics(label: 'Enviar', isEnabled: false, hasEnabledState: true),
      );
    });

    testWidgets('can be a larger circle, as the call controls are', (tester) async {
      await pumpThemed(
        tester,
        TrinoIconButton(icon: TrinoIcons.hangUp, label: 'Colgar', size: 64, circle: true, onPressed: () {}),
      );
      expect(tester.getSize(find.byType(TrinoIconButton)), const Size(64, 64));
    });
  });
}
