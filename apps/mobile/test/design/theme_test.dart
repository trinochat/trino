import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:trino_mobile/design/theme.dart';

void main() {
  group('buildTrinoTheme', () {
    for (final style in TrinoStyle.values) {
      for (final brightness in Brightness.values) {
        for (final accent in TrinoAccent.values) {
          test('follows the tokens of ${style.name} ${brightness.name} ${accent.name}', () {
            final theme = buildTrinoTheme(style, brightness, accent);
            final tokens = resolveTokens(style, brightness, accent);
            final trino = theme.extension<TrinoTheme>()!;
            expect(trino.tokens, tokens);
            expect(trino.style, style);
            expect(theme.useMaterial3, isTrue);
            expect(theme.brightness, brightness);
            expect(theme.scaffoldBackgroundColor, tokens.surface);
            final scheme = theme.colorScheme;
            expect(scheme.primary, tokens.accent);
            expect(scheme.onPrimary, tokens.accentInk);
            expect(scheme.surface, tokens.surface);
            expect(scheme.onSurface, tokens.ink);
            expect(scheme.onSurfaceVariant, tokens.muted);
            expect(scheme.error, tokens.danger);
            expect(scheme.outline, tokens.controlLine);
            expect(scheme.outlineVariant, tokens.line);
            // No Material tint over the surfaces: the tokens are the colours.
            expect(scheme.surfaceTint, Colors.transparent);
            expect(theme.textSelectionTheme.cursorColor, tokens.accentText);
          });
        }
      }
    }

    test('drops the stock Material look: no ink sparkle, 48 dp targets, own page transitions', () {
      final theme = buildTrinoTheme(TrinoStyle.calma, Brightness.light, TrinoAccent.verde);
      expect(theme.splashFactory, isNot(InkSparkle.splashFactory));
      expect(theme.materialTapTargetSize, MaterialTapTargetSize.padded);
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        expect(theme.pageTransitionsTheme.builders[platform], isA<TrinoPageTransitionsBuilder>());
      }
    });
  });

  group('type', () {
    TrinoTextStyles textOf(TrinoStyle style) =>
        buildTrinoTheme(style, Brightness.light, TrinoAccent.verde).extension<TrinoTheme>()!.text;

    test('Calma reads in Atkinson Hyperlegible, with its mono for times and codes', () {
      final text = textOf(TrinoStyle.calma);
      expect(text.body.fontFamily, kAtkinson);
      expect(text.largeTitle.fontFamily, kAtkinson);
      expect(text.mono.fontFamily, kAtkinsonMono);
      expect(text.section.fontFamily, kAtkinson);
    });

    test('Terminal reads in IBM Plex Sans, with JetBrains Mono for headings, labels and codes', () {
      final text = textOf(TrinoStyle.terminal);
      expect(text.body.fontFamily, kPlexSans);
      expect(text.largeTitle.fontFamily, kJetBrainsMono);
      expect(text.mono.fontFamily, kJetBrainsMono);
      expect(text.section.fontFamily, kJetBrainsMono);
    });

    test('no text style is smaller than 12', () {
      for (final style in TrinoStyle.values) {
        final theme = buildTrinoTheme(style, Brightness.light, TrinoAccent.verde);
        final sizes = {
          ...theme.extension<TrinoTheme>()!.text.all.map((s) => s.fontSize),
          for (final s in [
            theme.textTheme.displayLarge,
            theme.textTheme.titleLarge,
            theme.textTheme.titleMedium,
            theme.textTheme.bodyLarge,
            theme.textTheme.bodyMedium,
            theme.textTheme.bodySmall,
            theme.textTheme.labelLarge,
            theme.textTheme.labelMedium,
            theme.textTheme.labelSmall,
          ])
            s?.fontSize,
        };
        expect(sizes, everyElement(greaterThanOrEqualTo(12)), reason: style.name);
      }
    });

    for (final (style, expected) in [(TrinoStyle.calma, 'Hoy'), (TrinoStyle.terminal, 'HOY')]) {
      testWidgets('labels are ${expected == 'Hoy' ? 'in sentence case' : 'in spaced capitals'} in ${style.name}', (
        tester,
      ) async {
        await tester.pumpWidget(
          MaterialApp(
            theme: buildTrinoTheme(style, Brightness.light, TrinoAccent.verde),
            home: const Scaffold(body: TrinoLabel('Hoy')),
          ),
        );
        final text = tester.widget<Text>(find.text(expected));
        expect(text.semanticsLabel ?? text.data, 'Hoy', reason: 'screen readers get the words');
        final spacing = text.style!.letterSpacing ?? 0;
        expect(spacing > 0, style == TrinoStyle.terminal);
      });
    }
  });

  group('bundled fonts', () {
    final pubspec = File('pubspec.yaml').readAsStringSync();
    final families = RegExp(r'^\s+- family: (.+)$', multiLine: true).allMatches(pubspec).map((m) => m[1]!.trim());
    final assets = RegExp(
      r'^\s+- asset: (assets/fonts/.+\.ttf)$',
      multiLine: true,
    ).allMatches(pubspec).map((m) => m[1]!.trim());

    test('declares the four families of the tokens', () {
      expect(families, unorderedEquals([kAtkinson, kAtkinsonMono, kPlexSans, kJetBrainsMono]));
    });

    test('ships every declared file with its OFL licence beside it', () {
      expect(assets, isNotEmpty);
      for (final asset in assets) {
        expect(File(asset).existsSync(), isTrue, reason: asset);
        final licence = File('${File(asset).parent.path}/OFL.txt');
        expect(licence.existsSync(), isTrue, reason: licence.path);
        expect(licence.readAsStringSync(), contains('SIL Open Font License'));
      }
    });

    testWidgets('a variable font takes its weight from FontWeight', (tester) async {
      final bytes = File('assets/fonts/atkinson-hyperlegible-next/AtkinsonHyperlegibleNext-VariableFont_wght.ttf')
          .readAsBytesSync();
      final loader = FontLoader('WeightProbe')..addFont(Future.value(ByteData.sublistView(bytes)));
      await tester.runAsync(loader.load);
      double widthAt(FontWeight weight) {
        final painter = TextPainter(
          text: TextSpan(
            text: 'Hola, ¿nos vemos el jueves?',
            style: TextStyle(fontFamily: 'WeightProbe', fontSize: 20, fontWeight: weight),
          ),
          textDirection: TextDirection.ltr,
        )..layout();
        final width = painter.width;
        painter.dispose();
        return width;
      }

      expect(widthAt(FontWeight.w700), greaterThan(widthAt(FontWeight.w400)));
    });
  });
}
