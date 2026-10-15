import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/ui/banner.dart';
import 'package:trino_mobile/ui/button.dart';
import 'package:trino_mobile/ui/day_separator.dart';

import '../support/harness.dart';

void main() {
  group('DaySeparator', () {
    testWidgets('a thin line on each side of the label, with no pill', (tester) async {
      await pumpThemed(tester, const DaySeparator(label: 'Hoy'), center: false);
      final t = tokensIn(tester);
      expect(fillOf(tester, find.text('Hoy')), isNull, reason: 'no pill behind the day');
      final lines = tester.widgetList<Container>(find.byKey(DaySeparator.lineKey)).toList();
      expect(lines, hasLength(2));
      for (final line in lines) {
        expect(line.constraints?.maxHeight, 1);
        expect(line.color, t.line);
      }
      expect(
        tester.getCenter(find.text('Hoy')).dx,
        closeTo(tester.getCenter(find.byType(DaySeparator)).dx, 1),
        reason: 'centred',
      );
      expect(colorOfText(tester, 'Hoy'), t.muted);
      expect(find.bySemanticsLabel('Hoy'), findsOneWidget);
    });

    testWidgets('in capitals in Terminal, read as written', (tester) async {
      await pumpThemed(tester, const DaySeparator(label: 'Hoy'), style: TrinoStyle.terminal, center: false);
      expect(find.text('HOY'), findsOneWidget);
      expect(find.bySemanticsLabel('Hoy'), findsOneWidget);
    });
  });

  group('TrinoBanner', () {
    for (final (tone, fill, icon) in [
      (BannerTone.info, 'accentSoft', 'accentText'),
      (BannerTone.warn, 'warnBg', 'warn'),
      (BannerTone.danger, 'dangerBg', 'danger'),
    ]) {
      testWidgets('${tone.name}: $icon icon on $fill', (tester) async {
        await pumpThemed(tester, TrinoBanner(tone: tone, message: 'El código de seguridad de Carlos cambió.'));
        final t = tokensIn(tester);
        expect(fillOf(tester, find.text('El código de seguridad de Carlos cambió.')), t.colors[fill]);
        expect(colorOfText(tester, 'El código de seguridad de Carlos cambió.'), t.ink);
        expect(painterOf<TrinoIconPainter>(tester, find.byType(TrinoIcon)).color, t.colors[icon]);
      });
    }

    testWidgets('danger interrupts as a live region; the others do not', (tester) async {
      await pumpThemed(tester, const TrinoBanner(tone: BannerTone.danger, message: 'Puede que alguien esté en medio.'));
      expect(
        tester.getSemantics(find.byType(TrinoBanner)),
        isSemantics(isLiveRegion: true, label: 'Puede que alguien esté en medio.'),
      );
      await pumpThemed(
        tester,
        const TrinoBanner(tone: BannerTone.info, message: 'Pronto podrás llamar sin mostrarla.'),
      );
      expect(tester.getSemantics(find.byType(TrinoBanner)), isSemantics(isLiveRegion: false));
    });

    testWidgets('can hold an action', (tester) async {
      var taps = 0;
      await pumpThemed(
        tester,
        TrinoBanner(
          tone: BannerTone.warn,
          message: 'El código de seguridad de Carlos cambió.',
          action: TrinoButton(label: 'Comprobar código', onPressed: () => taps++),
        ),
      );
      await tester.tap(find.text('Comprobar código'));
      expect(taps, 1);
    });

    testWidgets('can lead with a bold title', (tester) async {
      await pumpThemed(
        tester,
        const TrinoBanner(tone: BannerTone.warn, title: 'Nadie puede recuperarla', message: 'Ni siquiera nosotros.'),
      );
      final title = tester.widget<Text>(find.text('Nadie puede recuperarla'));
      expect(title.style!.fontWeight, FontWeight.w700);
      expect(
        tester.getTopLeft(find.text('Nadie puede recuperarla')).dy,
        lessThan(tester.getTopLeft(find.text('Ni siquiera nosotros.')).dy),
      );
      expect(tester.getSemantics(find.byType(TrinoBanner)).label, contains('Nadie puede recuperarla'));
    });
  });
}
