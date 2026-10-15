import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/button.dart';

import '../support/harness.dart';

void main() {
  group('TrinoButton', () {
    testWidgets('primary fills with the accent and writes in accentInk', (tester) async {
      await pumpThemed(
        tester,
        TrinoButton(label: 'Desbloquear', variant: ButtonVariant.primary, onPressed: () {}),
        accent: TrinoAccent.azul,
      );
      final t = tokensIn(tester);
      expect(fillOf(tester, find.text('Desbloquear')), t.accent);
      expect(colorOfText(tester, 'Desbloquear'), t.accentInk);
    });

    testWidgets('secondary and ghost write in ink on no fill; quiet in muted; danger in danger', (tester) async {
      await pumpThemed(
        tester,
        Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TrinoButton(label: 'Cancelar', onPressed: () {}),
            TrinoButton(label: 'Ahora no', variant: ButtonVariant.ghost, onPressed: () {}),
            TrinoButton(label: 'No coinciden', variant: ButtonVariant.danger, onPressed: () {}),
            TrinoButton(label: 'Conectar sin protección…', variant: ButtonVariant.quiet, onPressed: () {}),
          ],
        ),
      );
      final t = tokensIn(tester);
      expect(colorOfText(tester, 'Cancelar'), t.ink);
      expect(colorOfText(tester, 'Ahora no'), t.ink);
      expect(colorOfText(tester, 'No coinciden'), t.danger);
      expect(colorOfText(tester, 'Conectar sin protección…'), t.muted);
      for (final label in ['Cancelar', 'Ahora no', 'No coinciden', 'Conectar sin protección…']) {
        expect(fillOf(tester, find.text(label)), anyOf(isNull, Colors.transparent), reason: label);
      }
    });

    testWidgets('is a labeled button of at least 48 dp that calls back on tap', (tester) async {
      var taps = 0;
      await pumpThemed(tester, TrinoButton(label: 'Coinciden', icon: TrinoIcons.check, onPressed: () => taps++));
      expect(tester.getSize(find.byType(TrinoButton)).height, greaterThanOrEqualTo(48));
      expect(
        tester.getSemantics(find.byType(TrinoButton)),
        isSemantics(label: 'Coinciden', isButton: true, isEnabled: true, hasTapAction: true),
      );
      await tester.tap(find.byType(TrinoButton));
      expect(taps, 1);
      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
    });

    testWidgets('without a callback it is disabled, dimmed and says so', (tester) async {
      await pumpThemed(tester, const TrinoButton(label: 'Continuar', onPressed: null));
      expect(tester.getSemantics(find.byType(TrinoButton)), isSemantics(isEnabled: false, hasEnabledState: true));
      expect(
        tester.widget<Opacity>(find.descendant(of: find.byType(TrinoButton), matching: find.byType(Opacity))).opacity,
        0.5,
      );
    });

    testWidgets('while loading it shows progress and ignores taps, without dimming', (tester) async {
      var taps = 0;
      await pumpThemed(
        tester,
        TrinoButton(label: 'Desbloqueando…', variant: ButtonVariant.primary, loading: true, onPressed: () => taps++),
      );
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.byType(TrinoButton));
      expect(taps, 0);
      expect(
        tester.widget<Opacity>(find.descendant(of: find.byType(TrinoButton), matching: find.byType(Opacity))).opacity,
        1,
      );
    });

    testWidgets('can fill the width', (tester) async {
      await pumpThemed(
        tester,
        SizedBox(
          width: 300,
          child: TrinoButton(label: 'Empezar', expand: true, onPressed: () {}),
        ),
      );
      expect(tester.getSize(find.byType(TrinoButton)).width, 300);
    });

    testWidgets('can say whether what it opens is expanded', (tester) async {
      await pumpThemed(tester, TrinoButton(label: '¿Olvidaste la contraseña?', expanded: false, onPressed: () {}));
      expect(tester.getSemantics(find.byType(TrinoButton)), isSemantics(hasExpandedState: true, isExpanded: false));
    });

    testWidgets('compact takes less room around the label, for buttons side by side, and keeps 48 dp', (tester) async {
      await pumpThemed(tester, TrinoButton(label: 'Eliminar', icon: TrinoIcons.trash, onPressed: () {}));
      final regular = tester.getSize(find.byType(TrinoButton)).width;
      await pumpThemed(tester, TrinoButton(label: 'Eliminar', icon: TrinoIcons.trash, compact: true, onPressed: () {}));
      final compact = tester.getSize(find.byType(TrinoButton));
      expect(compact.width, lessThan(regular - 10));
      expect(compact.height, greaterThanOrEqualTo(48));
    });
  });
}
